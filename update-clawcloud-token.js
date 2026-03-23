const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
require('dotenv').config();

// 使用 stealth 插件避免被检测
puppeteer.use(StealthPlugin());

// ==================== 配置区域 ====================
const CLAWCLOUD_HOME_URL = 'https://ap-northeast-1.run.claw.cloud/';
const GET_INIT_DATA_URL = 'https://applaunchpad.ap-northeast-1.run.claw.cloud/api/getApps';

// GitHub 登录凭据（通过环境变量传入）
const USERNAME_GITHUB = process.env.USERNAME_GITHUB;
const PASSWORD_GITHUB = process.env.PASSWORD_GITHUB;

// Supabase 配置（通过环境变量传入）
const SUPABASE_PROJECT_REF = process.env.SUPABASE_PROJECT_REF;
const ACCESS_TOKEN_SUPABASE = process.env.ACCESS_TOKEN_SUPABASE; // 你的管理令牌

// 浏览器无头模式配置（默认 true，生产环境建议 true）
const HEADLESS = process.env.HEADLESS !== 'false';
// ==================================================

async function updateSupabaseSecrets(authHeader, cookie) {
    const finalCookie = cookie || '';
    const secretsPayload = [
        { name: 'CLAWCLOUD_AUTH_HEADER', value: authHeader },
        { name: 'CLAWCLOUD_COOKIE', value: finalCookie }
    ];
    const url = `https://api.supabase.com/v1/projects/${SUPABASE_PROJECT_REF}/secrets`;
    console.log(`Updating project secrets via POST to ${url}`);

    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${ACCESS_TOKEN_SUPABASE}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(secretsPayload)
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Failed to update secrets: ${response.status} - ${errorText}`);
    }
    console.log(`✅ Updated project secrets successfully`);
}

async function logout(page) {
    console.log('执行退出登录流程...');
    await page.waitForSelector('button[id="menu-button-:rd:"]', { timeout: 5000 });
    await page.click('button[id="menu-button-:rd:"]');

    await page.waitForSelector('p.chakra-text.css-bg3st0', { timeout: 5000 });
    await page.$$eval('p.chakra-text.css-bg3st0',
        elements => elements.find(el => el.textContent.trim() === 'Log Out')?.click()
    );

    await page.waitForFunction(
        url => window.location.href === url,
        { timeout: 10000 },
        'https://ap-northeast-1.run.claw.cloud/signin'
    );
    console.log('已退出登录，回到登录页');
}

async function handleGitHubAuth(authPage) {
    // 给页面一点加载时间
    await new Promise(r => setTimeout(r, 2000));

    // 1. 处理登录表单（如果需要）
    if (await authPage.$('#login_field')) {
        console.log('需要输入 GitHub 凭据');
        await authPage.type('#login_field', USERNAME_GITHUB);
        await authPage.type('#password', PASSWORD_GITHUB);
        await authPage.click('input[type="submit"]');
        await authPage.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 });
    }

    // 2. 处理授权按钮（无论之前是否登录，都可能出现）
    try {
        console.log('检查授权按钮...');
        await authPage.waitForSelector('button[type="submit"]', { timeout: 10000 });
        console.log('点击授权按钮');
        await authPage.click('button[type="submit"]');
        await authPage.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 });
    } catch (e) {
        console.log('没有授权按钮或已自动跳转');
    }

    // 注意：最终跳转回 ClawCloud 主页由外层 loginWithGitHub 中的 
    // await page.waitForSelector('div.apps-container.css-1stzn3a', { timeout: 30000 }) 保证
}

async function loginWithGitHub(page) {
    console.log('开始 GitHub 登录流程...');
    await page.waitForSelector('button.chakra-button.css-1ggp06u', { timeout: 10000 });
    await page.click('button.chakra-button.css-1ggp06u');

    const popupPromise = new Promise(resolve => {
        page.once('popup', (popup) => resolve({ type: 'popup', page: popup }));
    });
    const navigationPromise = page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 90000 })
        .then(() => ({ type: 'navigation', page: page }))
        .catch(() => null);

    const result = await Promise.race([popupPromise, navigationPromise]);
    if (!result) {
        throw new Error('GitHub 登录超时，未出现弹窗或导航');
    }
    console.log(`GitHub 登录触发方式: ${result.type}`);
    await handleGitHubAuth(result.page);
    if (result.type === 'popup') {
        await page.waitForNavigation({ waitUntil: 'networkidle2' });
    }
    await page.waitForSelector('div.apps-container.css-1stzn3a', { timeout: 30000 });
    console.log('GitHub 登录完成，已回到 ClawCloud 主页');
}

async function main() {
    if (!USERNAME_GITHUB || !PASSWORD_GITHUB) {
        throw new Error('请设置环境变量 USERNAME_GITHUB 和 PASSWORD_GITHUB');
    }
    if (!ACCESS_TOKEN_SUPABASE) {
        throw new Error('请设置环境变量 ACCESS_TOKEN_SUPABASE');
    }

    // ========== 生产环境浏览器配置 ==========
    const browserOptions = {
        headless: HEADLESS, // 由环境变量 HEADLESS 控制，默认 true
        defaultViewport: null,
        // 可执行路径，可由环境变量 PUPPETEER_EXECUTABLE_PATH 覆盖
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--disable-gpu',
            ...(HEADLESS ? [] : ['--window-size=1366,768']), // 非无头模式设置窗口大小
            '--disable-webgl',
            '--disable-canvas-aa',
            '--disable-2d-canvas-clip-aa',
            '--use-gl=swiftshader',
            '--disk-cache-size=52428800',
            '--aggressive-cache-discard',
            '--disable-features=IsolateOrigins,site-per-process,BlockInsecurePrivateNetworkRequests',
            '--disable-blink-features=AutomationControlled',
            '--disable-sync',
            '--no-default-browser-check',
            '--disable-notifications',
            '--disable-save-password-bubble',
            '--disable-features=PasswordLeakDetection,PasswordManager,SavePassword',
            '--password-store=basic',
            '--deny-permission-prompts',
            '--disable-blink-features=RelatedApps'
        ],
        ignoreDefaultArgs: ['--enable-automation', '--disable-extensions'],
        userDataDir: './puppeteer-user-data', // 持久化会话（可选）
    };
    // =========================================

    const browser = await puppeteer.launch(browserOptions);

    try {
        const page = await browser.newPage();

        // 使用 CDP 最大化窗口（参照 pdd 脚本）
        const session = await page.target().createCDPSession();
        const { windowId } = await session.send('Browser.getWindowForTarget');
        await session.send('Browser.setWindowBounds', {
            windowId,
            bounds: { windowState: 'maximized' }
        });
        await session.detach();

        // 注入反检测脚本
        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => false });
            Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
            Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh'] });
        });

        let resolveRequest;
        const requestPromise = new Promise((resolve) => {
            resolveRequest = resolve;
        });

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
                if (resolveRequest) {
                    resolveRequest();
                    resolveRequest = null;
                }
            }
            request.continue();
        });

        console.log('访问主页，检测登录状态...');
        await page.goto(CLAWCLOUD_HOME_URL, { waitUntil: 'networkidle2' });

        const loginSelector = 'button.chakra-button.css-1ggp06u';
        const menuSelector = 'button[id="menu-button-:rd:"]';

        const detected = await Promise.race([
            page.waitForSelector(menuSelector, { visible: true, timeout: 10000 }).then(() => 'menu'),
            page.waitForSelector(loginSelector, { visible: true, timeout: 10000 }).then(() => 'login')
        ]).catch(() => null);

        if (detected === 'menu') {
            console.log('✅ 检测到已登录状态，准备退出并重新登录...');
            await logout(page);
            await loginWithGitHub(page);
        } else if (detected === 'login') {
            console.log('⏳ 检测到登录页，直接执行登录流程...');
            await loginWithGitHub(page);
        } else {
            throw new Error('无法检测到页面状态，可能页面结构已变化');
        }

        await page.waitForSelector('div.system-applaunchpad.css-y0ay84', { timeout: 10000 });
        await page.click('div.system-applaunchpad.css-y0ay84');

        console.log('等待 getApps 请求...');
        await Promise.race([
            requestPromise,
            new Promise((_, reject) => setTimeout(() => reject(new Error('等待 getApps 请求超时')), 15000))
        ]);
        console.log('getApps 请求已发生');

        await new Promise(resolve => setTimeout(resolve, 1000));

        if (!authHeader) {
            throw new Error('未捕获到 Authorization 头');
        }

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