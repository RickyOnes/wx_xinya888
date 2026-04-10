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

// GitHub 2FA 验证码轮询配置
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const MAX_VERIFICATION_WAIT_TIME = 120000; // 120秒超时
const VERIFICATION_POLL_INTERVAL = 3000;   // 3秒轮询间隔
const VERIFICATION_CODE_FRESHNESS_THRESHOLD = 5 * 60 * 1000; // 5分钟新鲜度阈值

// 浏览器无头模式配置（默认 true，生产环境建议 true）
const HEADLESS = process.env.HEADLESS !== 'false';
// ==================================================

// 延迟函数
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// 轮询 Supabase 获取 GitHub 2FA 验证码
async function pollGitHubVerificationCode(githubUsername) {
    if (!SUPABASE_SERVICE_ROLE_KEY) {
        throw new Error('SUPABASE_SERVICE_ROLE_KEY 环境变量未设置');
    }
    
    const dbUsername = `github_${githubUsername}`;
    console.log(`\n🔐 检测到 GitHub 2FA，开始轮询验证码...`);
    console.log(`   数据库标识: ${dbUsername}`);
    console.log(`   等待时间: ${MAX_VERIFICATION_WAIT_TIME / 1000}秒，轮询间隔: ${VERIFICATION_POLL_INTERVAL / 1000}秒\n`);
    
    const startTime = Date.now();
    let attemptCount = 0;
    
    while (Date.now() - startTime < MAX_VERIFICATION_WAIT_TIME) {
        attemptCount++;
        try {
            const url = `https://${SUPABASE_PROJECT_REF}.supabase.co/rest/v1/pdd_verification_codes?username=eq.${encodeURIComponent(dbUsername)}&select=code,updated_at`;
            const response = await fetch(url, {
                headers: {
                    'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
                    'apikey': SUPABASE_SERVICE_ROLE_KEY,
                    'Content-Type': 'application/json'
                }
            });
            
            if (response.ok) {
                const data = await response.json();
                if (data && data.length > 0 && data[0].code) {
                    const code = data[0].code;
                    const updatedAt = data[0].updated_at ? new Date(data[0].updated_at) : new Date(0);
                    const now = new Date();
                    const ageMs = now - updatedAt;
                    const ageSeconds = Math.floor(ageMs / 1000);
                    
                    // 检查验证码是否"新鲜"（5分钟内更新）
                    if (ageMs <= VERIFICATION_CODE_FRESHNESS_THRESHOLD) {
                        console.log(`✅ 获取到新鲜验证码: ${code} (${ageSeconds}秒前更新)`);
                        return code;
                    } else {
                        // 验证码存在但已过期
                        const ageMinutes = Math.floor(ageSeconds / 60);
                        console.log(`⏳ 验证码已过期: ${ageMinutes}分钟前更新，等待新验证码...`);
                        // 继续轮询，不返回过期验证码
                    }
                } else {
                    // 没有验证码或code字段为空
                    console.log('⏳ 数据库中暂无有效验证码，等待更新...');
                }
            }
            
            // 每10次尝试打印一次提示
            if (attemptCount % 10 === 0) {
                const elapsed = Math.floor((Date.now() - startTime) / 1000);
                console.log(`⏳ 已等待 ${elapsed}秒，请在 Supabase 中更新 github_${githubUsername} 的验证码...`);
            }
            
            await delay(VERIFICATION_POLL_INTERVAL);
            
        } catch (error) {
            console.log(`   轮询出错: ${error.message}`);
            await delay(VERIFICATION_POLL_INTERVAL);
        }
    }
    
    throw new Error(`❌ ${MAX_VERIFICATION_WAIT_TIME / 1000}秒内未获取到验证码`);
}

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

async function findFirstMatchedElement(page, selectors) {
    for (const selector of selectors) {
        try {
            const element = await page.$(selector);
            if (element) {
                return { element, selector };
            }
        } catch (error) {
            // 忽略单个 selector 检测失败
        }
    }
    return null;
}

async function getClawCloudReadySelector(page) {
    const readySelectors = [
        'div.apps-container.css-1stzn3a',
        'div.system-applaunchpad.css-y0ay84',
        'button[id^="menu-button-"]'
    ];

    for (const selector of readySelectors) {
        try {
            if (await page.$(selector)) {
                return selector;
            }
        } catch (error) {
            // 忽略单个 selector 检测失败
        }
    }

    return null;
}

async function waitForClawCloudReady(page, timeout = 90000) {
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
        if (page.isClosed()) {
            return 'page-closed';
        }

        const readySelector = await getClawCloudReadySelector(page);
        if (readySelector) {
            return readySelector;
        }

        await delay(1000);
    }

    throw new Error(`等待 ClawCloud 主页面超时，当前 URL: ${page.url()}`);
}

async function handleGitHubAuth(authPage) {
    const loginFieldSelectors = [
        '#login_field',
        'input[name="login"]',
        'input[autocomplete="username"]'
    ];
    const passwordFieldSelectors = [
        '#password',
        'input[name="password"]',
        'input[type="password"]'
    ];
    const loginSubmitSelectors = [
        'input[type="submit"]',
        'button[type="submit"]'
    ];
    const otpSelectors = [
        '#app_totp',
        '#otp',
        'input[name="otp"]',
        'input[autocomplete="one-time-code"]',
        'input[type="text"][id*="code" i]',
        'input[type="text"][name*="code" i]',
        'input[aria-label*="code" i]'
    ];
    const authorizeButtonSelectors = [
        'button#js-oauth-authorize-btn',
        'button[name="authorize"]',
        'button[type="submit"]',
        'input[type="submit"]'
    ];

    console.log(`进入 GitHub 认证处理，当前 URL: ${authPage.url()}`);
    const startTime = Date.now();

    while (Date.now() - startTime < 120000) {
        if (authPage.isClosed()) {
            console.log('GitHub 认证窗口已关闭，继续等待 ClawCloud 主页面...');
            return;
        }

        const readySelector = await getClawCloudReadySelector(authPage);
        if (readySelector) {
            console.log(`检测到已回到 ClawCloud 页面: ${readySelector}`);
            return;
        }

        const currentUrl = authPage.url();
        console.log(`认证处理中，当前 URL: ${currentUrl}`);

        const loginField = await findFirstMatchedElement(authPage, loginFieldSelectors);
        const passwordField = await findFirstMatchedElement(authPage, passwordFieldSelectors);
        if (loginField && passwordField) {
            console.log(`检测到 GitHub 登录表单: ${loginField.selector}`);
            await authPage.click(loginField.selector, { clickCount: 3 });
            await authPage.type(loginField.selector, USERNAME_GITHUB);
            await authPage.click(passwordField.selector, { clickCount: 3 });
            await authPage.type(passwordField.selector, PASSWORD_GITHUB);

            const submitButton = await findFirstMatchedElement(authPage, loginSubmitSelectors);
            const loginNavigationPromise = authPage
                .waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 })
                .catch(() => null);

            if (submitButton) {
                await submitButton.element.click();
            } else {
                await authPage.keyboard.press('Enter');
            }

            await loginNavigationPromise;
            await delay(2000);
            continue;
        }

        const otpInput = await findFirstMatchedElement(authPage, otpSelectors);
        if (otpInput) {
            console.log(`🔑 检测到 2FA 输入框: ${otpInput.selector}`);
            const verificationCode = await pollGitHubVerificationCode(USERNAME_GITHUB);
            console.log(`⌨️  正在填充验证码: ${verificationCode}`);
            await otpInput.element.click({ clickCount: 3 });
            await otpInput.element.type(verificationCode);

            const submitButton = await findFirstMatchedElement(authPage, loginSubmitSelectors);
            const otpNavigationPromise = authPage
                .waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 })
                .catch(() => null);

            if (submitButton) {
                await submitButton.element.click();
            } else {
                await authPage.keyboard.press('Enter');
            }

            console.log('📤 验证码已提交，等待验证...');
            await otpNavigationPromise;
            await delay(2000);
            continue;
        }

        const authorizeButton = await findFirstMatchedElement(authPage, authorizeButtonSelectors);
        if (authorizeButton) {
            const buttonText = await authPage
                .evaluate(el => (el.textContent || el.value || '').trim(), authorizeButton.element)
                .catch(() => '');
            console.log(`检测到授权/继续按钮: ${buttonText || authorizeButton.selector}`);

            const authorizeNavigationPromise = authPage
                .waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 })
                .catch(() => null);
            await authorizeButton.element.click();
            await authorizeNavigationPromise;
            await delay(2000);
            continue;
        }

        await delay(2000);
    }

    throw new Error(`GitHub 认证流程超时，当前 URL: ${authPage.isClosed() ? 'page-closed' : authPage.url()}`);
}

async function loginWithGitHub(page) {
    console.log('开始 GitHub 登录流程...');
    await page.waitForSelector('button.chakra-button.css-1ggp06u', { timeout: 30000 });

    const popupPromise = new Promise(resolve => {
        page.once('popup', (popup) => resolve({ type: 'popup', page: popup }));
    });
    const navigationPromise = page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 90000 })
        .then(() => ({ type: 'navigation', page }))
        .catch(() => null);

    await page.click('button.chakra-button.css-1ggp06u');

    const result = await Promise.race([popupPromise, navigationPromise]);
    if (!result) {
        throw new Error('GitHub 登录超时，未出现弹窗或导航');
    }
    console.log(`GitHub 登录触发方式: ${result.type}`);

    await handleGitHubAuth(result.page);

    const readySelector = await waitForClawCloudReady(page, 90000);
    console.log(`GitHub 登录完成，已回到 ClawCloud 主页: ${readySelector}`);
}

async function main() {
    if (!USERNAME_GITHUB || !PASSWORD_GITHUB) {
        throw new Error('请设置环境变量 USERNAME_GITHUB 和 PASSWORD_GITHUB');
    }
    if (!ACCESS_TOKEN_SUPABASE) {
        throw new Error('请设置环境变量 ACCESS_TOKEN_SUPABASE');
    }
    
    // 检查 GitHub 2FA 所需的环境变量
    if (!SUPABASE_SERVICE_ROLE_KEY) {
        console.warn('⚠️  警告: SUPABASE_SERVICE_ROLE_KEY 环境变量未设置，如果出现 GitHub 2FA 验证将失败');
    } else {
        console.log('✅ GitHub 2FA 验证码轮询功能已启用');
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
            '--disable-crashpad',
            '--disable-crash-reporter',
            '--disable-breakpad',
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
     //   await new Promise(resolve => setTimeout(resolve, 1000000));
        const detected = await Promise.race([
            page.waitForSelector(menuSelector, { visible: true, timeout: 10000 }).then(() => 'menu'),
            page.waitForSelector(loginSelector, { visible: true, timeout: 10000 }).then(() => 'login')
        ]).catch(() => null);

        if (detected === 'menu') {
            console.log('✅ 检测到已登录状态，准备退出并重新登录...');
            await logout(page);
            await new Promise(resolve => setTimeout(resolve, 2000)); // 等2秒确保页面完全加载
            await loginWithGitHub(page);
        } else if (detected === 'login') {
            console.log('⏳ 检测到登录页，直接执行登录流程...');
            await loginWithGitHub(page);
        } else {
            throw new Error('无法检测到页面状态，可能页面结构已变化');
        }

        await page.waitForSelector('div.system-applaunchpad.css-y0ay84', { timeout: 10000 });
        await page.click('div.system-applaunchpad.css-y0ay84'); // 点击主界面应用图标

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
