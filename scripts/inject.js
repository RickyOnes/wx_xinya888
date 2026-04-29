const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const path = require('path');

puppeteer.use(StealthPlugin());

// ========== 浏览器配置（与 update-pdd-local.js 完全一致） ==========
const CONFIG = {
    browserOptions: {
        headless: false, // 允许打开浏览器窗口
        defaultViewport: null,          // 允许窗口自适应
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--disable-gpu',
            '--window-size=1366,768',
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
        ignoreDefaultArgs: ['--enable-automation', '--disable-extensions']
    },
    chromePath: '/usr/bin/google-chrome'
};

// 反检测固定参数
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';
const ACCEPT_LANGUAGE = 'zh,en-US;q=0.9,en;q=0.8,zh-CN;q=0.7';
const NAV_LANGUAGES = ['zh', 'en-US', 'en', 'zh-CN'];

// ========== 从环境变量获取账号列表 ==========
const accountsJson = process.env.PDD_ACCOUNTS_JSON;
if (!accountsJson) {
    console.log('❌ PDD_ACCOUNTS_JSON环境变量未设置');
    process.exit(1);
}

let accounts;
try {
    const parsed = JSON.parse(accountsJson);
    accounts = parsed.accounts;
    if (!Array.isArray(accounts)) {
        throw new Error('accounts 字段不是数组');
    }
} catch (error) {
    console.log('❌ 解析 PDD_ACCOUNTS_JSON 失败:', error.message);
    process.exit(1);
}

(async () => {
    for (const account of accounts) {
        const username = account.username;
        if (!username) {
            console.log('❌ 账号缺少 username，跳过');
            continue;
        }

        // 使用用户持久化目录中的 Cookie 文件注入Cookie，以便移植登录状态到新的浏览器实例
        const cookieFile = `./puppeteer_user_data/cookie_${username}.json`;

        if (!fs.existsSync(cookieFile)) {
            console.log(`❌ 未找到 ${cookieFile}，跳过账号 ${username}`);
            continue;
        }

        console.log(`\n🔄 正在处理账号: ${username}`);
        const cookies = JSON.parse(fs.readFileSync(cookieFile, 'utf8'));

        //目标用户数据目录，测试环境可改为 ./puppeteer_user_data/test/${username}
        const userDataDir = `./puppeteer_user_data/${username}`; //生产环境使用

        // 创建用户目录
        await fs.promises.mkdir(userDataDir, { recursive: true });
        console.log('   ✅ 用户目录已就绪');

        // 组装浏览器启动选项
        const launchOptions = {
            ...CONFIG.browserOptions,
            userDataDir: userDataDir
        };

        // 优先使用系统 Chrome，若不存在则回退
        if (fs.existsSync(CONFIG.chromePath)) {
            launchOptions.executablePath = CONFIG.chromePath;
            console.log('   ✅ 使用系统 Chrome');
        } else {
            console.log('   ℹ️ 系统 Chrome 未找到，使用内置 Chromium');
        }

        const browser = await puppeteer.launch(launchOptions);
        console.log(`📊 浏览器版本: ${await browser.version()}`);

        const page = await browser.newPage();

        // 反检测设置
        await page.setUserAgent(UA);
        await page.setExtraHTTPHeaders({
            'Accept-Language': ACCEPT_LANGUAGE,
            'Accept-Encoding': 'gzip, deflate, br, zstd'
        });
        await page.evaluateOnNewDocument((langs) => {
            Object.defineProperty(navigator, 'webdriver', { get: () => false });
            Object.defineProperty(navigator, 'plugins', { get: () => [1,2,3,4,5] });
            Object.defineProperty(navigator, 'languages', { get: () => langs });
            Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
        }, NAV_LANGUAGES);

        // 注入所有 Cookie
        for (const c of cookies) {
            try {
                let expires = (c.expires && c.expires > 0) ? c.expires : undefined;
                // 对关键 Cookie 延长有效期（可根据需求调整）
                if ((c.name === 'PASS_ID' || c.name === 'windows_app_shop_token_23') && expires) {
                    expires += 0; // 暂时不调整：1天 = 86400秒
                }
                await page.setCookie({
                    name: c.name,
                    value: c.value,
                    domain: c.domain,
                    path: c.path,
                    secure: c.secure,
                    httpOnly: c.httpOnly,
                    sameSite: c.sameSite || 'Strict',
                    expires: expires
                });
            } catch (e) {
                console.log(`跳过无法设置的 Cookie: ${c.name} (${e.message})`);
            }
        }
        console.log(`✅ ${userDataDir} 的Cookie注入已完成,等待页面加载...`);

        // 验证注入结果
        await page.goto('https://mc.pinduoduo.com/ddmc-mms/order/management', { waitUntil: 'networkidle2' });
        const title = await page.title();
        console.log('页面标题:', title);

        await new Promise(resolve => setTimeout(resolve, 9000));//等待90秒，等待页面加载完成

        // 打印注入后的所有 Cookie 及其有效期
        console.log(`\n🍪 ${username} 注入后的 Cookie 列表：`);
        const allCookies = await page.cookies();
        if (allCookies.length === 0) {
            console.log('   (无 Cookie)');
        } else {
            allCookies.forEach(c => {
                const expiresStr = c.expires === -1 || c.expires === undefined
                    ? 'Session (浏览器关闭即失效)'
                    : new Date(c.expires * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
                console.log(`   • ${c.name.padEnd(30)} | 有效期: ${expiresStr}`);
            });
        }

        // 保持几秒观察后关闭
        console.log('5 秒后自动关闭浏览器...');
        await new Promise(resolve => setTimeout(resolve, 5000));
        await browser.close();
        console.log('👋 浏览器已关闭');
    }

    console.log('\n🎉 所有账号注入完成');
})();