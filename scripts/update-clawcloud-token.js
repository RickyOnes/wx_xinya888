const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fetch = require('node-fetch');

// 使用 stealth 插件避免被检测
puppeteer.use(StealthPlugin());

// ==================== 配置区域 ====================
const CLAWCLOUD_HOME_URL = 'https://ap-northeast-1.run.claw.cloud/';
const CLAWCLOUD_SIGNIN_URL = 'https://ap-northeast-1.run.claw.cloud/signin';
const GET_INIT_DATA_URL = 'https://applaunchpad.ap-northeast-1.run.claw.cloud/api/platform/getInitData';

// GitHub 登录凭据（建议通过环境变量传入）
const GITHUB_USERNAME = process.env.GITHUB_USERNAME;      // 你的 GitHub 用户名/邮箱
const GITHUB_PASSWORD = process.env.GITHUB_PASSWORD;      // 你的 GitHub 密码

// Supabase 配置
const SUPABASE_PROJECT_REF = 'iglmqwpagzjadwauvchh';
const SUPABASE_FUNCTION_NAME = 'clawcloud-scheduler';
const SUPABASE_MANAGEMENT_TOKEN = process.env.SUPABASE_MANAGEMENT_TOKEN; // 你的管理令牌
// ==================================================

async function updateSupabaseSecrets(authHeader, cookie) {
    // 如果 cookie 为空，则设置为空字符串
    const finalCookie = cookie || '';
    
    const secrets = [
        { name: 'CLAWCLOUD_AUTH_HEADER', value: authHeader },
        { name: 'CLAWCLOUD_COOKIE', value: finalCookie }
    ];

    for (const secret of secrets) {
        const url = `https://api.supabase.com/v1/projects/${SUPABASE_PROJECT_REF}/functions/${SUPABASE_FUNCTION_NAME}/secrets/${secret.name}`;
        console.log(`Updating ${secret.name}...`);
        
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${SUPABASE_MANAGEMENT_TOKEN}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ value: secret.value })
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Failed to update ${secret.name}: ${response.status} - ${errorText}`);
        }
        console.log(`✅ Updated ${secret.name}`);
    }
}

async function ensureLoggedOut(page) {
    // 检查是否已登录（是否跳转到主页而非登录页）
    const currentUrl = page.url();
    if (currentUrl === CLAWCLOUD_HOME_URL) {
        console.log('已登录状态，准备退出...');
        
        // 点击菜单按钮（使用你提供的选择器）
        await page.waitForSelector('button[id="menu-button-:re:"]', { timeout: 5000 });
        await page.click('button[id="menu-button-:re:"]');
        
        // 等待菜单展开，并查找“Log Out”选项
        await page.waitForSelector('p.chakra-text.css-bg3st0', { timeout: 5000 });
        const logOutElement = await page.$$eval('p.chakra-text.css-bg3st0', 
            elements => elements.find(el => el.textContent.trim() === 'Log Out')?.click()
        );
        
        if (!logOutElement) {
            throw new Error('未找到 Log Out 按钮');
        }
        
        // 等待退出完成，跳转到登录页
        await page.waitForFunction(
            url => window.location.href === url,
            { timeout: 10000 },
            CLAWCLOUD_SIGNIN_URL
        );
        console.log('已退出登录，回到登录页');
    } else {
        console.log('当前处于登录页，无需退出');
    }
}

async function handleGitHubAuth(authPage) {
    // 等待 GitHub 登录页面加载
    await authPage.waitForSelector('#login_field', { timeout: 30000 }).catch(() => null);

    // 如果存在登录字段，说明需要输入凭据
    if (await authPage.$('#login_field')) {
        console.log('需要输入 GitHub 凭据');
        await authPage.type('#login_field', GITHUB_USERNAME);
        await authPage.type('#password', GITHUB_PASSWORD);
        await authPage.click('input[type="submit"]');

        // 等待导航（可能是两步验证或授权确认）
        await authPage.waitForNavigation({ waitUntil: 'networkidle2' });
    } else {
        console.log('GitHub 已登录，等待自动跳转');
        // 等待最终跳转回 ClawCloud
        await authPage.waitForNavigation({ waitUntil: 'networkidle2' });
    }

    // 处理可能出现的授权确认页（例如 "Authorize application"）
    try {
        await authPage.waitForSelector('button[type="submit"]', { timeout: 5000 });
        await authPage.click('button[type="submit"]');
        await authPage.waitForNavigation({ waitUntil: 'networkidle2' });
    } catch (e) {
        // 没有授权步骤，忽略
    }
}

async function loginWithGitHub(page) {
    console.log('开始 GitHub 登录流程...');

    // 点击 GitHub 登录按钮
    await page.waitForSelector('button.chakra-button.css-1ggp06u', { timeout: 10000 });
    await page.click('button.chakra-button.css-1ggp06u');

    // 同时监听弹窗和导航
    const popupPromise = new Promise(resolve => {
        page.once('popup', (popup) => resolve({ type: 'popup', page: popup }));
    });
    const navigationPromise = page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 })
        .then(() => ({ type: 'navigation', page: page }))
        .catch(() => null);

    // 等待任一事件发生
    const result = await Promise.race([popupPromise, navigationPromise]);

    if (!result) {
        throw new Error('GitHub 登录超时，未出现弹窗或导航');
    }

    console.log(`GitHub 登录触发方式: ${result.type}`);

    // 统一处理授权页
    await handleGitHubAuth(result.page);

    // 处理完毕后，回到主页面
    if (result.type === 'popup') {
        // 弹窗场景：主页面需要等待导航回 ClawCloud
        await page.waitForNavigation({ waitUntil: 'networkidle2' });
    }

    // 确认已回到 ClawCloud 主页并出现目标元素
    await page.waitForSelector('div.apps-container.css-1stzn3a', { timeout: 30000 });
    console.log('GitHub 登录完成，已回到 ClawCloud 主页');
}
async function main() {
    if (!GITHUB_USERNAME || !GITHUB_PASSWORD) {
        throw new Error('请设置环境变量 GITHUB_USERNAME 和 GITHUB_PASSWORD');
    }
    if (!SUPABASE_MANAGEMENT_TOKEN) {
        throw new Error('请设置环境变量 SUPABASE_MANAGEMENT_TOKEN');
    }

    const browser = await puppeteer.launch({ 
        headless: false, // 调试时可设为 false，生产环境建议 true
        defaultViewport: null,
        args: ['--start-maximized']
    });
    
    try {
        const page = await browser.newPage();
        
        // 设置请求拦截以捕获目标 API
        let authHeader = null;
        let cookieString = null;
        
        await page.setRequestInterception(true);
        page.on('request', (request) => {
            const url = request.url();
            if (url === GET_INIT_DATA_URL) {
                const headers = request.headers();
                if (headers['authorization']) {
                    authHeader = headers['authorization'];
                    console.log('✅ 捕获到 Authorization 头');
                }
                if (headers['cookie']) {
                    cookieString = headers['cookie'];
                    console.log('✅ 捕获到 Cookie');
                }
            }
            request.continue();
        });

        // 第一步：访问主页
        console.log(`访问主页: ${CLAWCLOUD_HOME_URL}`);
        await page.goto(CLAWCLOUD_HOME_URL, { waitUntil: 'networkidle2' });
        
        // 第二步：检查是否需要退出
        await ensureLoggedOut(page);
        
        // 第三步：登录（现在应该在登录页）
        await loginWithGitHub(page);
        
        // 第四步：验证登录成功（检查主页上的指定元素）
        await page.waitForSelector('div.apps-container.css-1stzn3a', { timeout: 30000 });
        console.log('✅ 登录成功，已检测到 apps-container 元素');
        
        // 第五步：点击进入应用面板
        await page.waitForSelector('div.system-applaunchpad.css-y0ay84', { timeout: 10000 });
        await page.click('div.system-applaunchpad.css-y0ay84');
        
        // 第六步：等待 getInitData 请求发生
        console.log('等待 getInitData 请求...');
        await page.waitForFunction(
            (url) => performance.getEntries().some(entry => entry.name === url),
            { timeout: 15000 },
            GET_INIT_DATA_URL
        );
        
        // 额外等待一小段时间确保请求被拦截到
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        if (!authHeader) {
            throw new Error('未捕获到 Authorization 头');
        }
        
        // 第七步：更新 Supabase Secrets
        console.log('开始更新 Supabase Secrets...');
        await updateSupabaseSecrets(authHeader, cookieString);
        console.log('🎉 所有操作完成！');
        
    } catch (error) {
        console.error('❌ 脚本执行出错:', error.message);
        process.exit(1);
    } finally {
        await browser.close();
    }
}

main();