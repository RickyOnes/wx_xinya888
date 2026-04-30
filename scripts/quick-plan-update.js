/* 【deepseek优化终极版本】————非并发版本、日常使用脚本：
   1、智能判断登录状态，自动登录失败时注入本地cookie兜底，并立即尝试密码登录刷新凭证。
   2、注入后直接执行一次密码登录：成功则刷新凭证；失败则回退检测旧Cookie是否仍有效。
   3、若以上均失败，不再进行第三次尝试，直接退出。
   4、仅当成功刷新凭证（密码登录成功）时才保存新的cookie.json文件。
   5、若 windows_app_shop_token_23 有效期不足4小时，且本次未刷新过凭证，则主动重新登录续期，并更新cookie.json。
   6、支持环境变量 PDD_FIRST_RUN：设为 true 时跳过现有会话检测，直接进行 Cookie 注入恢复。
*/

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');

puppeteer.use(StealthPlugin());

// ==================== 配置常量 ====================
const CONFIG = {
    planDirectUrl: 'https://mc.pinduoduo.com/ddmc-mms/order/management',
    planLoginUrl: 'https://mms.pinduoduo.com/login/?redirectUrl=https%3A%2F%2Fmc.pinduoduo.com%2Fddmc-mms%2Forder%2Fmanagement',
    targetApiEndpointPlan: 'cartman-mms/orderManagement/pageQueryDetail',
    browserOptions: {
        headless: 'new',
        defaultViewport: { width: 1366, height: 768 },
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
            '--disk-cache-size=104857600',
            '--aggressive-cache-discard',
            '--disable-features=IsolateOrigins,site-per-process,BlockInsecurePrivateNetworkRequests',
            '--disable-blink-features=AutomationControlled',
            '--disable-extensions',
            '--disable-component-extensions-with-background-pages',
            '--disable-sync',
            '--proxy-server=direct://',
            '--proxy-bypass-list=*'
        ],
        ignoreDefaultArgs: ['--enable-automation']
    },
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
    return { userAgent: UA_POOL[idx], viewport: VIEWPORT_POOL[idx] };
}

// ==================== 核心类 ====================
class PDDPlanAntiContentFetcher {
    constructor(loginCredentials, userDataDir, supabaseClient, accountIndex = 0) {
        this.browser = null;
        this.page = null;
        this.capturedData = {
            antiContentPlan: null,
            cookieString: ''
        };
        this.loginCredentials = loginCredentials || { username: 'wangxh03', password: '' };
        this.userDataDir = userDataDir || './puppeteer_user_data/default';
        this.supabaseClient = supabaseClient || null;
        this.accountProfile = getAccountProfile(accountIndex);
        this._credentialRefreshed = false;   // 本次运行是否通过密码登录刷新了凭证
    }

    // -------------------- 初始化浏览器 --------------------
    async init() {
        console.log('🚀 启动浏览器...');
        console.log(`   📁 用户数据目录: ${this.userDataDir}`);

        try {
            await fs.promises.mkdir(this.userDataDir, { recursive: true });
        } catch (e) {
            console.log(`   ⚠️ 无法创建目录: ${e.message}`);
        }

        const baseOptions = { ...CONFIG.browserOptions, userDataDir: this.userDataDir, defaultViewport: this.accountProfile.viewport };
        let launchOptions = { ...baseOptions };
        let useSystemChrome = false;

        try {
            require('child_process').execSync('which google-chrome', { stdio: 'ignore' });
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

    // -------------------- 请求监听 --------------------
    async setupRequestInterception() {
        this._sessionCheckPromise = new Promise((resolve) => { this._sessionCheckResolve = resolve; });
        this._createAntiContentPromise();

        this.page.on('request', (request) => {
            const url = request.url();
            if (!url.includes(CONFIG.targetApiEndpointPlan)) return;

            if (this._sessionCheckResolve) {
                this._sessionCheckResolve();
                this._sessionCheckResolve = null;
            }

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

    _createAntiContentPromise() {
        if (this._antiContentTimeout) clearTimeout(this._antiContentTimeout);
        this.antiContentPromise = new Promise((resolve, reject) => {
            this._antiContentResolve = resolve;
            this._antiContentTimeout = setTimeout(() => reject(new Error('anti-content 等待超时')), 60000);
        });
    }

    // -------------------- 会话检测与自动登录 --------------------
    async autoLogin() {
        console.log('\n🔍 尝试使用现有会话...');
        try {
            await this.page.goto(CONFIG.planDirectUrl, { waitUntil: 'domcontentloaded', timeout: 10000 });
        } catch (e) {
            console.log('   ⚠️ 导航到订单页失败，进入登录流程');
            return this._doLogin();
        }

        let apiSeen = false;
        try {
            await Promise.race([
                this._sessionCheckPromise,
                new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000))
            ]);
            apiSeen = true;
        } catch (e) {}

        if (apiSeen) {
            console.log('   ✅ 订单API请求已发生，会话有效');
            return true;
        }

        const currentUrl = this.page.url();
        if (!currentUrl.includes('/order/management')) {
            console.log('   ⚠️ 页面已跳转到登录页');
            return this._doLogin();
        }

        try {
            await this.page.waitForSelector('[data-testid="beast-core-table"]', { timeout: 3000, visible: true });
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
            await this.page.goto(CONFIG.planLoginUrl, { waitUntil: 'domcontentloaded', timeout: 10000 });
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
                await usernameEl.type(this.loginCredentials.username, { delay: 50 });
                console.log('   ✅ 已输入用户名');
                await passwordEl.type(this.loginCredentials.password, { delay: 50 });
                console.log('   ✅ 已输入密码');

                let loginButton = await this.page.$('button[data-testid="beast-core-button"]');
                if (!loginButton) {
                    const xpathBtn = await this.page.$x("//button[contains(., '登录')]");
                    if (xpathBtn && xpathBtn.length > 0) loginButton = xpathBtn[0];
                }
                if (loginButton) {
                    const navigationPromise = this.page.waitForNavigation({
                        waitUntil: 'domcontentloaded', timeout: 5000
                    }).catch(() => null);
                    await loginButton.click().catch(() => {});
                    console.log('   ✅ 尝试点击登录按钮');
                    await navigationPromise;
                } else {
                    await this.page.keyboard.press('Enter').catch(() => {});
                    console.log('   ℹ️ 未找到明确的登录按钮，已尝试按 Enter');
                }
            }

            console.log('   ⏳ 等待登录处理...');
            await new Promise(r => setTimeout(r, 1000));
            const startTime = Date.now();
            while (Date.now() - startTime < 90000) {
                await new Promise(r => setTimeout(r, 2000));
                let currentUrl = '';
                try {
                    currentUrl = this.page.url();
                } catch (e) { continue; }
                if (currentUrl.includes('/order/management')) {
                    console.log('   ✅ 登录成功，已进入订单查询页面');
                    this._credentialRefreshed = true;   // 新增：标记凭证已刷新
                    return true;
                }
                const vcodeInput = await this.page.$('input[placeholder="请输入短信验证码"]').catch(() => null);
                if (vcodeInput) {
                    console.log('   📱 需要短信验证码，将尝试使用本地Cookie注入');
                    return false;
                }
            }
            console.log('   ❌ 登录超时');
            return false;
        } catch (error) {
            console.log('   ❌ 登录过程出错:', error.message);
            return false;
        }
    }

    // -------------------- 兜底注入本地Cookie，并立即尝试密码登录刷新凭证 --------------------
    async _fallbackLogin() {
        this.capturedData.antiContentPlan = null;
        this._createAntiContentPromise();
        this._credentialRefreshed = false;

        const cookieFile = `${this.userDataDir}/../cookie_${this.loginCredentials.username}.json`;
        if (!fs.existsSync(cookieFile)) {
            console.log('   ℹ️ 无本地 cookie 文件，无法进行注入登录');
            return false;
        }
        console.log('   📂 检测到本地Cookie文件，尝试注入并立即密码登录...');
        let cookies;
        try {
            cookies = JSON.parse(fs.readFileSync(cookieFile, 'utf8'));
        } catch (e) {
            console.log('   ❌ 读取 cookie 文件失败:', e.message);
            return false;
        }

        // 注入所有 Cookie
        for (const c of cookies) {
            try {
                await this.page.setCookie({
                    name: c.name, value: c.value, domain: c.domain, path: c.path,
                    secure: c.secure, httpOnly: c.httpOnly,
                    sameSite: c.sameSite || 'Strict',
                    expires: (c.expires && c.expires > 0) ? c.expires : undefined
                });
            } catch (e) {
                console.log(`   跳过无法设置的 Cookie: ${c.name}`);
            }
        }

        // 立即尝试密码登录
        const refreshed = await this._doLogin();
        if (refreshed) {
            console.log('   ⏳ 等待新会话的 anti-content...');
            this.capturedData.antiContentPlan = null;
            this._createAntiContentPromise();
            try {
                await this.antiContentPromise;
                console.log('   ✅ 已捕获刷新后的 anti-content');
            } catch (e) {
                console.log('   ⚠️ 刷新后未捕获到 anti-content，但仍将使用新 Cookie');
            }
            this._credentialRefreshed = true;
            return true;
        }

        // 密码登录失败，回退检测旧 Cookie 是否仍有效
        console.log('   ⚠️ 主动登录失败，检查旧Cookie是否仍有效...');
        try {
            await this.page.goto(CONFIG.planDirectUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
            const url = this.page.url();
            if (url.includes('/order/management')) {
                console.log('   ✅ 旧Cookie仍然有效，继续使用（凭证未刷新）');
                return true;
            }
        } catch (e) {
            console.log('   ❌ 访问订单页失败:', e.message);
        }
        console.log('   ❌ 旧Cookie也无效');
        return false;
    }

    // -------------------- Cookie 操作 --------------------
    async captureCookies() {
        console.log('\n🍪 捕获Cookies...');
        const cookies = await this.page.cookies();
        this.capturedData.allCookies = cookies;
        let cookieStr = '';
        cookies.forEach((c, i) => {
            if (i > 0) cookieStr += '; ';
            cookieStr += `${c.name}=${c.value}`;
        });
        this.capturedData.cookieString = cookieStr;
        console.log(`   ✅ 已构造 Cookie字符串，共 ${cookies.length} 个 Cookie`);
        return cookies;
    }

    async exportCookies() {
        console.log('\n💾 导出最新 Cookie 文件...');
        const cdpSession = await this.page.target().createCDPSession();
        const { cookies } = await cdpSession.send('Network.getCookies');
        const fileName = `./puppeteer_user_data/cookie_${this.loginCredentials.username}.json`;
        fs.writeFileSync(fileName, JSON.stringify(cookies, null, 2));
        console.log(`   ✅ 已保存 ${cookies.length} 个 Cookie → ${fileName}`);
    }

    // -------------------- 续期相关 --------------------
    async checkTokenExpiry(thresholdSeconds = 14400) {
        const cookies = await this.page.cookies();
        const token = cookies.find(c => c.name === 'windows_app_shop_token_23');
        if (!token || token.expires <= 0) return false;
        const remaining = token.expires - Math.floor(Date.now() / 1000);
        if (remaining > 0 && remaining < thresholdSeconds) {
            console.log(`   ⚠️ windows_app_shop_token_23 将在 ${Math.floor(remaining / 3600).toFixed(1)} 小时后过期，准备续期`);
            return true;
        }else {
            console.log(`   ✅ windows_app_shop_token_23 有效期还有 ${Math.floor(remaining / 3600).toFixed(1)} 小时，无需续期`);
        }
        return false;
    }

    async renewCookies() {
        console.log('🔄 主动续期：开始重新登录...');
        const loginSuccess = await this._doLogin();
        if (!loginSuccess) {
            console.log('   ❌ 续期登录失败（可能验证码），放弃续期');
            return false;
        }
        console.log('   ⏳ 等待新会话的 anti-content...');
        this.capturedData.antiContentPlan = null;
        this._createAntiContentPromise();
        try {
            await this.antiContentPromise;
            console.log('   ✅ 已捕获续期后的 anti-content');
        } catch (e) {
            console.log('   ⚠️ 续期后未捕获到 anti-content，但仍将保存新 Cookie');
        }
        await this.captureCookies();
        await this.exportCookies();
        console.log('   ✅ 主动续期完成，Cookie 文件已更新');
        return true;
    }

    // -------------------- 主流程 --------------------
    async run() {
        try {
            console.log('🎬 开始执行快速订单查询参数捕获脚本');
            await this.init();
            await this.setupRequestInterception();

            console.log(`\n📝 登录信息: 用户 ${this.loginCredentials.username}`);

            let loginSuccess = false;
            const isFirstRun = process.env.PDD_FIRST_RUN === 'true';

            if (isFirstRun) {
                console.log('🔰 检测为首次运行，跳过现有会话检测，直接进行注入恢复...');
                loginSuccess = await this._fallbackLogin();
            } else {
                // 尝试一：现有会话
                loginSuccess = await this.autoLogin();
                // 尝试二：注入本地Cookie恢复（仅当尝试一失败）
                if (!loginSuccess) {
                    console.log('⚠️ 自动登录失败，尝试从本地Cookie文件恢复...');
                    loginSuccess = await this._fallbackLogin();
                }
            }

            if (!loginSuccess) {
                console.log('❌ 所有恢复方式均失败，程序退出');
                return;
            }

            // 等待 anti-content（如果尚未捕获）
            if (!this.capturedData.antiContentPlan) {
                console.log('⏳ 等待 anti-content 出现...');
                try {
                    await this.antiContentPromise;
                    console.log('✅ anti-content 已捕获');
                } catch (e) {
                    console.log('⚠️ anti-content 超时');
                }
            }

            if (this.capturedData.antiContentPlan) {
                await this.captureCookies();

                if (this._credentialRefreshed) {
                    await this.exportCookies();
                } else {
                    console.log('ℹ️ 本次未产生新登录凭证，跳过 Cookie 文件保存');
                }

                // 主动续期检查，但刚刚刷新过凭证则跳过
                if (!this._credentialRefreshed) {
                    const shouldRenew = await this.checkTokenExpiry(14400);
                    if (shouldRenew) {
                        await this.renewCookies();
                    }
                } else {
                    console.log('ℹ️ 本次已刷新凭证，跳过主动续期检查');
                }
            } else {
                console.log('⚠️ 未捕获 anti-content，跳过 Cookie 抓取、文件导出');
            }
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

// ==================== 主函数与入口 ====================
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
        console.log('🔍 开始浏览器流程...');
        const fetcher = new PDDPlanAntiContentFetcher(
            { username, password },
            `./puppeteer_user_data/${username}`,
            supabase,
            accountIndex
        );
        await fetcher.run();

        if (fetcher.capturedData.antiContentPlan) {
            const updatePayload = {
                anti_content: fetcher.capturedData.antiContentPlan,
                cookie_string: fetcher.capturedData.cookieString || '',
                updated_at: new Date().toISOString()
            };
            const { error } = await supabase
                .from('pdd_accounts')
                .update(updatePayload)
                .eq('username', username);

            if (error) {
                console.log(`❌ 更新失败: ${error.message}`);
            } else {
                console.log(`✅ 账号 ${username} 的anti_content、cookie_string已更新到Supabase`);
                console.log('\n' + '='.repeat(50));
            }
        } else {
            console.log(`⚠️ 未捕获 anti-content，跳过上传`);
        }
    } catch (error) {
        console.log(`❌ 更新账号 ${username} 失败:`, error.message);
        console.error(error.stack);
    }
}

async function main() {
    console.log('==========================================');
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
        console.log('==========================================');
    } catch (error) {
        console.log('❌ 解析账号信息失败:', error.message);
    }
}

main().catch(console.error);