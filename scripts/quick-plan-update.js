/* 【deepseek优化终极版本】————非并发版本、日常使用脚本：
   1、不保存cookie为文件，能更智能判断登录状态及决定是否需要并完成自动登录！
   2、自动登录失败时注入本地cookie兜底，关键过期||临期 cookie 自动延长12小时
   3、优化setupRequestInterception方法，改为监听request事件，性能最优！
*/

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');

// 使用反检测插件
puppeteer.use(StealthPlugin());

// 配置常量
const CONFIG = {
    // 直接访问订单查询页面的URL
    planDirectUrl: 'https://mc.pinduoduo.com/ddmc-mms/order/management',
    // 登录后跳转到订单查询页面的URL
    planLoginUrl: 'https://mms.pinduoduo.com/login/?redirectUrl=https%3A%2F%2Fmc.pinduoduo.com%2Fddmc-mms%2Forder%2Fmanagement',
    targetApiEndpointPlan: 'cartman-mms/orderManagement/pageQueryDetail',

    // 浏览器配置（排查扩展/代理影响）
    browserOptions: {
        headless: 'new',
        defaultViewport: {
            width: 1366,
            height: 768
        },
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
            '--disk-cache-size=104857600', // 缓存大小100MB
            '--aggressive-cache-discard', // 缓存清理策略,激进地丢弃缓存，减少内存占用
            '--disable-features=IsolateOrigins,site-per-process,BlockInsecurePrivateNetworkRequests',
            '--disable-blink-features=AutomationControlled',// 进一步隐藏自动化特征
            '--disable-extensions',
            '--disable-component-extensions-with-background-pages',
            '--disable-sync',
            '--proxy-server=direct://',
            '--proxy-bypass-list=*'
        ],
        ignoreDefaultArgs: ['--enable-automation']
    },
    // 等待超时配置（毫秒）
    timeouts: {
        pageLoad: 30000,
        elementWait: 10000,
        navigation: 30000,
        apiRequest: 60000,
        dataProcessing: 10000
    }
};

const UA_POOL = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36 Edg/147.0.0.0'
];

const VIEWPORT_POOL = [
    { width: 1280, height: 720 },
    { width: 1320, height: 760 },
    { width: 1360, height: 800 }
];

const FIXED_ACCEPT_LANGUAGE = 'zh,en-US;q=0.9,en;q=0.8,zh-CN;q=0.7';
const FIXED_NAVIGATOR_LANGUAGES = ['zh', 'en-US', 'en', 'zh-CN'];

function getAccountProfile(accountIndex = 0) {
    const idx = ((Number(accountIndex) || 0) % UA_POOL.length + UA_POOL.length) % UA_POOL.length;
    return {
        userAgent: UA_POOL[idx],
        viewport: VIEWPORT_POOL[idx]
    };
}

class PDDPlanAntiContentFetcher {
    constructor(loginCredentials, userDataDir, supabaseClient, accountIndex = 0) {
        this.browser = null;
        this.page = null;
        this.capturedData = {
            antiContentPlan: null,
            cookieString: '',
            needlogin: false
        };
        this.loginCredentials = loginCredentials || { username: 'wangxh03', password: '' };
        this.userDataDir = userDataDir || './puppeteer_user_data/default';
        this.supabaseClient = supabaseClient || null;
        this.accountProfile = getAccountProfile(accountIndex);
    }

    async init() {
        console.log('🚀 启动浏览器...');
        console.log(`   📁 用户数据目录: ${this.userDataDir}`);

        // 直接使用顶部的 fs 模块
        try {
            await fs.promises.mkdir(this.userDataDir, { recursive: true });
        } catch (e) {
            console.log(`   ⚠️ 无法创建目录: ${e.message}`);
        }

        const baseOptions = {
            ...CONFIG.browserOptions,
            userDataDir: this.userDataDir,
            defaultViewport: this.accountProfile.viewport
        };

        let launchOptions = { ...baseOptions };
        let useSystemChrome = false;
        try {
            const { execSync } = require('child_process');
            execSync('which google-chrome', { stdio: 'ignore' });
            launchOptions.executablePath = '/usr/bin/google-chrome';
            useSystemChrome = true;
            console.log('   ✅ 将尝试使用系统 Chrome');
        } catch {
            console.log('   ℹ️ 系统 Chrome 未找到，将使用 Puppeteer 内置 Chromium');
        }

        try {
            this.browser = await puppeteer.launch(launchOptions);
            if (useSystemChrome) console.log('   ✅ 系统 Chrome 启动成功');
        } catch (error) {
            if (useSystemChrome) {
                console.log(`   ⚠️ 系统 Chrome 启动失败: ${error.message}`);
                console.log('   🔄 尝试回退到 Puppeteer 内置 Chromium...');
                delete launchOptions.executablePath;
                try {
                    this.browser = await puppeteer.launch(launchOptions);
                    console.log('   ✅ 内置 Chromium 启动成功');
                } catch (fallbackError) {
                    console.error('❌ 所有浏览器启动尝试均失败:', fallbackError.message);
                    throw fallbackError;
                }
            } else {
                console.error('❌ 浏览器启动失败:', error.message);
                throw error;
            }
        }

        this.page = await this.browser.newPage();

        await this.page.setUserAgent(this.accountProfile.userAgent);
        await this.page.setExtraHTTPHeaders({
            'Accept-Language': FIXED_ACCEPT_LANGUAGE,
            'Accept-Encoding': 'gzip, deflate, br, zstd'
        });

        await this.page.evaluateOnNewDocument((langs) => {
            Object.defineProperty(navigator, 'webdriver', { get: () => false });
            Object.defineProperty(navigator, 'plugins', { get: () => [1,2,3,4,5] });
            Object.defineProperty(navigator, 'languages', { get: () => langs });
            Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
        }, FIXED_NAVIGATOR_LANGUAGES);

        console.log(`🧬 指纹: viewport=${this.accountProfile.viewport.width}x${this.accountProfile.viewport.height}, UA片段=${this.accountProfile.userAgent.match(/Chrome\/\d+/)?.[0] || 'Chrome'}`);
        console.log(`📊 浏览器版本: ${await this.browser.version()}`);
    }

    async setupRequestInterception() {
        // 用于 autoLogin 快速判断会话有效性的 Promise
        this._sessionCheckPromise = new Promise((resolve) => {
            this._sessionCheckResolve = resolve;
        });

        // 创建 anti-content 捕获 Promise
        this._createAntiContentPromise();

        this.page.on('request', (request) => {
            const url = request.url();
            if (!url.includes(CONFIG.targetApiEndpointPlan)) return;

            // 一旦命中目标 API，立即通知会话检查
            if (this._sessionCheckResolve) {
                this._sessionCheckResolve();
                this._sessionCheckResolve = null;
            }

            // 捕获 anti-content
            const headers = request.headers();
            const antiContent = headers['anti-content'];
            if (antiContent && !this.capturedData.antiContentPlan) {
                this.capturedData.antiContentPlan = antiContent;
                console.log(`   ✅ 捕获到 anti-content，长度: ${antiContent.length}`);
                if (this._antiContentResolve) {
                    clearTimeout(this._antiContentTimeout);
                    this._antiContentResolve();
                    this._antiContentResolve = null;
                }
            }
        });
    }

    // 重新创建 anti-content Promise（用于注入后重置）
    _createAntiContentPromise() {
        if (this._antiContentTimeout) clearTimeout(this._antiContentTimeout);
        this.antiContentPromise = new Promise((resolve, reject) => {
            this._antiContentResolve = resolve;
            this._antiContentTimeout = setTimeout(() => {
                reject(new Error('anti-content 等待超时'));
            }, 60000);
        });
    }

    async autoLogin() {
        console.log('\n🔍 尝试使用现有会话...');
        let navigated = false;
        try {
            await this.page.goto(CONFIG.planDirectUrl, {
                waitUntil: 'domcontentloaded',
                timeout: 10000
            });
            navigated = true;
        } catch (e) {
            console.log('   ⚠️ 导航到订单页失败，进入登录流程');
            return this._doLogin();
        }

        // 等待第一个订单 API 请求（最多 2 秒）
        let apiSeen = false;
        try {
            await Promise.race([
                this._sessionCheckPromise,
                new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000))
            ]);
            apiSeen = true;
        } catch (e) {
            // 超时，未出现 API
        }

        if (apiSeen) {
            console.log('   ✅ 订单API请求已发生，会话有效');
            return true;
        }

        const currentUrl = this.page.url();
        if (!currentUrl.includes('/order/management')) {
            console.log('   ⚠️ 页面已跳转到登录页');
            return this._doLogin();
        }

        // 表格兜底检查
        try {
            await this.page.waitForSelector('[data-testid="beast-core-table"]', {
                timeout: 3000,
                visible: true
            });
            console.log('   ✅ 表格加载完成，会话有效');
            return true;
        } catch (e) {
            const finalUrl = this.page.url();
            if (finalUrl.includes('/order/management')) {
                console.log('   ⚠️ 表格未加载但URL未变，视为有效');
                return true;
            }
            console.log('   ⚠️ 页面已跳转，开始登录');
            return this._doLogin();
        }
    }

    async _doLogin() {
        console.log('\n🌐 开始登录流程，从登录URL直接登录...');
        try {
            console.log(`   📝 导航到登录URL: ${CONFIG.planLoginUrl}`);
            await this.page.goto(CONFIG.planLoginUrl, {
                waitUntil: 'domcontentloaded',
                timeout: 10000
            });
            console.log('   ✅ 登录页面加载成功');

            // 切换到"账号登录"标签
            try {
                const tabContainer = await this.page.$('.Common_operationTabs__3TW7c');
                if (tabContainer) {
                    const items = await this.page.$$('.Common_operationTabs__3TW7c .Common_item__3diIn');
                    if (items && items.length >= 2) {
                        const secondClass = await this.page.evaluate(el => el.className, items[1]);
                        if (!secondClass || !secondClass.includes('Common_checked__1oLdj')) {
                            await items[1].click().catch(() => {});
                            console.log('   ✅ 已切换到账号登录标签');
                            await new Promise(r => setTimeout(r, 500));
                        }
                    }
                }
            } catch (e) {}

            const usernameEl = await this.page.$('#usernameId');
            const passwordEl = await this.page.$('#passwordId');
            if (usernameEl && passwordEl) {
                try {
                    const existingUser = await this.page.evaluate(el => el.value, usernameEl).catch(() => '');
                    if (!existingUser && this.loginCredentials && this.loginCredentials.username) {
                        await usernameEl.type(this.loginCredentials.username, { delay: 50 });
                        console.log('   ✅ 已输入用户名');
                    }
                } catch (e) {}
                try {
                    const existingPass = await this.page.evaluate(el => el.value, passwordEl).catch(() => '');
                    if (!existingPass && this.loginCredentials && this.loginCredentials.password) {
                        await passwordEl.type(this.loginCredentials.password, { delay: 50 });
                        console.log('   ✅ 已输入密码');
                    }
                } catch (e) {}

                try {
                    let loginButton = await this.page.$('button[data-testid="beast-core-button"]');
                    if (!loginButton) {
                        const xpathBtn = await this.page.$x("//button[contains(., '登录')]");
                        if (xpathBtn && xpathBtn.length > 0) loginButton = xpathBtn[0];
                    }
                    if (loginButton) {
                        const navigationPromise = this.page.waitForNavigation({
                            waitUntil: 'domcontentloaded',
                            timeout: 5000
                        }).catch(() => null);
                        await loginButton.click().catch(() => {});
                        console.log('   ✅ 尝试点击登录按钮');
                        await navigationPromise;
                    } else {
                        await this.page.keyboard.press('Enter').catch(() => {});
                        console.log('   ℹ️ 未找到明确的登录按钮，已尝试按 Enter');
                    }
                } catch (e) {}
            }

            console.log('   ⏳ 等待登录处理...');
            await new Promise(resolve => setTimeout(resolve, 1000));
            const startTime = Date.now();
            const maxWaitTime = 90000;
            const pollInterval = 2000;
            while (Date.now() - startTime < maxWaitTime) {
                let currentUrl = '';
                try {
                    currentUrl = this.page.url();
                } catch (e) {
                    await new Promise(r => setTimeout(r, 1000));
                    continue;
                }
                if (currentUrl.includes('/order/management')) {
                    console.log('   ✅ 登录成功，已进入订单查询页面');
                    this.capturedData.needlogin = true;
                    return true;
                }
                try {
                    const vcodeInput = await this.page.$('input[placeholder="请输入短信验证码"]');
                    if (vcodeInput) {
                        console.log('   📱 需要短信验证码，将尝试使用本地Cookie注入');
                        return false; // 返回 false 触发兜底注入
                    }
                } catch (e) {}
                await new Promise(r => setTimeout(r, pollInterval));
            }
            console.log('   ❌ 登录超时');
            return false;
        } catch (error) {
            console.log('   ❌ 登录过程出错:', error.message);
            return false;
        }
    }

    // 兜底注入Cookie并尝试恢复会话
    async _fallbackLogin() {
        // 1. 重置 anti-content 数据，避免注入后仍使用旧值
        this.capturedData.antiContentPlan = null;
        this._createAntiContentPromise();

        // Cookie 文件路径使用用户数据目录（可配置）
        const cookieFile = `${this.userDataDir}/../cookie_${this.loginCredentials.username}.json`;
        if (!fs.existsSync(cookieFile)) {
            console.log('   ℹ️ 无本地 cookie 文件，无法进行注入登录');
            return false;
        }
        console.log('   📂 检测到本地Cookie文件，尝试注入恢复会话...');
        let cookies;
        try {
            cookies = JSON.parse(fs.readFileSync(cookieFile, 'utf8'));
        } catch (e) {
            console.log('   ❌ 读取 cookie 文件失败:', e.message);
            return false;
        }

        // 注入 Cookie，对关键 Cookie 自动延长过期时间
        const nowSec = Math.floor(Date.now() / 1000);
        // 先检查 windows_app_shop_token_23 是否需要延长
        const tokenCookie = cookies.find(c => c.name === 'windows_app_shop_token_23');
        const needExtend = tokenCookie && tokenCookie.expires > 0 && 
            (tokenCookie.expires < nowSec || tokenCookie.expires - nowSec < 3600);

        for (const c of cookies) {
            try {
                let expires = (c.expires && c.expires > 0) ? c.expires : undefined;
                // 只有 token 需要延长时，才同步更新 PASS_ID 和 token 本身
                if (needExtend && (c.name === 'PASS_ID' || c.name === 'windows_app_shop_token_23') && expires) {
                    if (tokenCookie.expires < nowSec) {
                        console.log('   ⚠️ windows_app_shop_token_23 已过期，同步延长 PASS_ID 和 token 至当前UTC+12小时');
                    } else {
                        console.log('   ⚠️ windows_app_shop_token_23 即将过期，同步延长 PASS_ID 和 token 至当前UTC+12小时');
                    }
                    expires = nowSec + 43200;
                }
                await this.page.setCookie({
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
                console.log(`   跳过无法设置的 Cookie: ${c.name}`);
            }
        }

        console.log('   ✅ Cookie 注入完成，尝试访问订单页...');
        try {
            await this.page.goto(CONFIG.planDirectUrl, {
                waitUntil: 'domcontentloaded',
                timeout: 15000
            });

            // 快速验证：等待目标 API 请求（最多 6 秒）确认会话真实有效
            let apiSeen = false;
            try {
                await Promise.race([
                    this._sessionCheckPromise,
                    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 6000))
                ]);
                apiSeen = true;
            } catch (e) {}

            const url = this.page.url();
            if (apiSeen || url.includes('/order/management')) {
                console.log('   ✅ 注入后成功进入订单页');
                // 等待页面完全稳定
                await new Promise(r => setTimeout(r, 3000));
                return true;
            } else {
                console.log('   ❌ 注入后仍被重定向到登录页');
                return false;
            }
        } catch (e) {
            console.log('   ❌ 注入后导航失败:', e.message);
            return false;
        }
    }

    async captureCookies() {
        console.log('\n🍪 捕获Cookies...');
        const cookies = await this.page.cookies();
        this.capturedData.allCookies = cookies;

        let cookieStr = '';
        cookies.forEach((cookie, index) => {
            if (index > 0) cookieStr += '; ';
            cookieStr += `${cookie.name}=${cookie.value}`;
        });
        this.capturedData.cookieString = cookieStr;
        console.log(`   ✅ 已构造 Cookie字符串，共 ${cookies.length} 个 Cookie`);
        return cookies;
    }

    async run() {
        try {
            console.log('🎬 开始执行快速订单查询参数捕获脚本');
            await this.init();
            await this.setupRequestInterception();

            console.log(`\n📝 登录信息: 用户 ${this.loginCredentials.username}`);
            let loginSuccess = await this.autoLogin();

            // 自动登录失败（如遇到验证码），尝试注入本地Cookie
            if (!loginSuccess) {
                console.log('⚠️ 自动登录失败，尝试从本地Cookie文件恢复...');
                loginSuccess = await this._fallbackLogin();
                
                // 注入也失败：再次尝试自动登录（利用现有指纹，大概率无需验证码）
                if (!loginSuccess) {
                    console.log('⚠️ 注入恢复失败，再次尝试自动登录（指纹一致可能无需验证码）...');
                    loginSuccess = await this.autoLogin();  // 第二次自动登录
                    if (!loginSuccess) {
                        console.log('❌ 所有登录方式均失败，程序退出');
                        return;
                    }
                }
            }

            // 如果还未捕获 anti-content，等待它
            if (!this.capturedData.antiContentPlan) {
                console.log('⏳ 等待 anti-content 出现...');
                try {
                    await this.antiContentPromise;
                    console.log('✅ anti-content 已捕获');
                } catch (e) {
                    console.log('⚠️ anti-content 超时，继续抓取 Cookie');
                }
            }

            await this.captureCookies();
        } catch (error) {
            console.error('❌ 脚本执行出错:', error.message);
        } finally {
            if (this.browser) {
                try {
                    await this.browser.close();
                    console.log('👋 浏览器已关闭');
                } catch (closeError) {
                    console.log('⚠️ 关闭浏览器时出现错误:', closeError.message);
                }
            }
            console.log('🏁 程序执行完毕');
        }
    }
}

// 主函数
async function updatePlanAntiContent(username, password, accountIndex = 0) {
    console.log(`\n🔄 开始更新账号的预估销量参数: ${username}`);

    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !supabaseKey) {
        console.log('❌ Supabase配置缺失，跳过数据上传');
        return;
    }

    const supabase = createClient(supabaseUrl, supabaseKey);

    try {
        console.log(`🔍 开始浏览器流程...`);
        const fetcher = new PDDPlanAntiContentFetcher({ username, password }, `./puppeteer_user_data/${username}`, supabase, accountIndex);
        await fetcher.run();

        const updatePayload = {
            cookie_string: fetcher.capturedData.cookieString || '',
            updated_at: new Date().toISOString()
        };

        if (fetcher.capturedData.antiContentPlan) {
            updatePayload.anti_content = fetcher.capturedData.antiContentPlan;
        }

        const { error } = await supabase
            .from('pdd_accounts')
            .update(updatePayload)
            .eq('username', username);

        if (error) {
            console.log(`❌ 更新失败: ${error.message}`);
        } else if (fetcher.capturedData.antiContentPlan) {
            console.log(`✅ 账号 ${username} 的anti_content、cookie_string已更新到Supabase`);
            console.log('\n' + '='.repeat(50));
        } else {
            console.log(`✅ 账号 ${username} 的cookie_string已更新到Supabase（未捕获到anti-content）`);
            console.log('\n' + '='.repeat(50));
        }

    } catch (error) {
        console.log(`❌ 更新账号 ${username} 失败:`, error.message);
        console.error(error.stack);
    }
}

// 从环境变量获取账号信息
async function main() {
    console.log(`==========================================`);
    console.log(`脚本开始时间: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`);
    const startTime = Date.now();

    const accountsJson = process.env.PDD_ACCOUNTS_JSON;
    if (!accountsJson) {
        console.log('❌ PDD_ACCOUNTS_JSON环境变量未设置');
        return;
    }

    try {
        const accounts = JSON.parse(accountsJson).accounts;

        for (const [accountIndex, account] of accounts.entries()) {
            const username = account.username;
            const password = process.env[`PASSWORD_${username.toUpperCase()}`];
            if (!password) {
                console.log(`❌ 账号 ${username} 的密码未设置，跳过`);
                continue;
            }

            await updatePlanAntiContent(username, password, accountIndex);
        }

        console.log('\n🎉 所有账号的预估销量参数更新完成');
        const endTime = Date.now();
        const duration = Math.floor((endTime - startTime) / 1000);
        console.log(`脚本结束时间: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`);
        console.log(`总运行时长: ${duration} 秒`);
        console.log(`==========================================`);

    } catch (error) {
        console.log('❌ 解析账号信息失败:', error.message);
    }
}

main().catch(console.error);