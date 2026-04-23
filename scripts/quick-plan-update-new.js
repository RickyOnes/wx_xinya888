// 脚本功能：快速更新预估销量查询密钥（并发版本）,适用于clawcloud应用中自动更新预估销量查询密钥

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { createClient } = require('@supabase/supabase-js');

// 使用反检测插件
puppeteer.use(StealthPlugin());

// 配置常量
const CONFIG = {
    // 直接访问预估销量页面的URL
    planDirectUrl: 'https://mc.pinduoduo.com/ddmc-mms/order/management',
    // 登录后跳转到预估销量页面的URL
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
    timeouts: {
        pageLoad: 30000,
        elementWait: 10000,
        navigation: 30000,
        apiRequest: 60000,
        dataProcessing: 10000
    }
};

function formatDuration(ms) {
    return `${(ms / 1000).toFixed(2)}s`;
}

function getAccountPrefix(username) {
    return `[${username || 'unknown'}]`;
}

function createPrefixedLogger(prefix) {
    return {
        log: (...args) => console.log(prefix, ...args),
        warn: (...args) => console.warn(prefix, ...args),
        error: (...args) => console.error(prefix, ...args)
    };
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function toPositiveInt(value, fallback) {
    const num = Number(value);
    return Number.isFinite(num) && num > 0 ? Math.floor(num) : fallback;
}

function randomInt(min, max) {
    if (max <= min) return min;
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function createDeferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

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

const FIXED_LANGUAGE = {
    header: 'zh,en-US;q=0.9,en;q=0.8,zh-CN;q=0.7',
    navigator: ['zh', 'en-US', 'en', 'zh-CN']
};

function buildAccountFingerprint(accountIndex = 0) {
    const idx = ((Number(accountIndex) || 0) % UA_POOL.length + UA_POOL.length) % UA_POOL.length;
    return {
        userAgent: UA_POOL[idx],
        language: FIXED_LANGUAGE,
        viewport: VIEWPORT_POOL[idx],
        typeDelay: 55
    };
}

class AsyncSemaphore {
    constructor(maxConcurrency = 1) {
        this.maxConcurrency = Math.max(1, maxConcurrency);
        this.current = 0;
        this.queue = [];
    }

    async acquire() {
        if (this.current < this.maxConcurrency) {
            this.current += 1;
            return this.createReleaser();
        }

        await new Promise(resolve => this.queue.push(resolve));
        this.current += 1;
        return this.createReleaser();
    }

    createReleaser() {
        let released = false;
        return () => {
            if (released) return;
            released = true;
            this.current = Math.max(0, this.current - 1);
            const next = this.queue.shift();
            if (next) next();
        };
    }
}

class RiskController {
    constructor(cooldownMs = 45000) {
        this.cooldownMs = Math.max(5000, cooldownMs);
        this.cooldownUntil = 0;
    }

    async waitIfCoolingDown(logger) {
        const remainMs = this.cooldownUntil - Date.now();
        if (remainMs > 0) {
            logger.warn(`🛡️ 风控冷却中，等待 ${formatDuration(remainMs)} 后再进入登录阶段`);
            await sleep(remainMs);
        }
    }

    trigger(reason, logger) {
        const jitterMs = randomInt(3000, 12000);
        const nextUntil = Date.now() + this.cooldownMs + jitterMs;
        if (nextUntil > this.cooldownUntil) {
            this.cooldownUntil = nextUntil;
        }
        logger.warn(`🛡️ 检测到风控信号（${reason || '未知原因'}），已进入冷却窗口`);
    }
}

class PDDPlanAntiContentFetcher {
    constructor(loginCredentials, userDataDir, supabaseClient, runtimeContext = {}) {
        this.browser = null;
        this.page = null;
        this.capturedData = {
            antiContentPlan: null,
            cookieString: '',
            needlogin: false,
            riskTriggered: false,
            riskReason: ''
        };
        this.loginCredentials = loginCredentials || { username: 'wangxh03', password: '' };
        this.userDataDir = userDataDir || './puppeteer_user_data/default';
        this.supabaseClient = supabaseClient || null;
        this.username = this.loginCredentials?.username || 'unknown';
        this.logger = createPrefixedLogger(getAccountPrefix(this.username));
        this.loginGate = runtimeContext.loginGate || null;
        this.riskController = runtimeContext.riskController || null;
        this.accountIndex = Number(runtimeContext.accountIndex || 0);
        this.fingerprint = buildAccountFingerprint(this.accountIndex);
        this.antiContentDeferred = createDeferred();
    }

    log(...args) {
        this.logger.log(...args);
    }

    warn(...args) {
        this.logger.warn(...args);
    }

    error(...args) {
        this.logger.error(...args);
    }

    async init() {
        this.log(`🚀 启动浏览器... 📁 用户数据目录: ${this.userDataDir}`);

        const fs = require('fs').promises;
        try {
            await fs.mkdir(this.userDataDir, { recursive: true });
        } catch (e) {
            this.warn(`无法创建目录: ${e.message}`);
        }

        const baseOptions = {
            ...CONFIG.browserOptions,
            userDataDir: this.userDataDir,
            defaultViewport: this.fingerprint.viewport
        };

        let launchOptions = { ...baseOptions };
        let useSystemChrome = false;
        try {
            const { execSync } = require('child_process');
            execSync('which google-chrome', { stdio: 'ignore' });
            launchOptions.executablePath = '/usr/bin/google-chrome';
            useSystemChrome = true;
        } catch {
            this.log('ℹ️ 系统 Chrome 未找到，将使用 Puppeteer 内置 Chromium');
        }

        try {
            this.browser = await puppeteer.launch(launchOptions);
            if (useSystemChrome) this.log('✅ 系统 Chrome 启动成功');
        } catch (error) {
            if (useSystemChrome) {
                this.warn(`系统 Chrome 启动失败: ${error.message}`);
                this.log('🔄 尝试回退到 Puppeteer 内置 Chromium...');
                delete launchOptions.executablePath;
                try {
                    this.browser = await puppeteer.launch(launchOptions);
                    this.log('✅ 内置 Chromium 启动成功');
                } catch (fallbackError) {
                    this.error('❌ 所有浏览器启动尝试均失败:', fallbackError.message);
                    throw fallbackError;
                }
            } else {
                this.error('❌ 浏览器启动失败:', error.message);
                throw error;
            }
        }

        this.page = await this.browser.newPage();

        await this.page.setUserAgent(this.fingerprint.userAgent);

        await this.page.setExtraHTTPHeaders({
            'Accept-Language': this.fingerprint.language.header,
            'Accept-Encoding': 'gzip, deflate, br, zstd'
        });

        const navigatorLanguages = this.fingerprint.language.navigator;
        await this.page.evaluateOnNewDocument((langs) => {
            Object.defineProperty(navigator, 'webdriver', { get: () => false });
            Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
            Object.defineProperty(navigator, 'languages', { get: () => langs });
            Object.defineProperty(navigator, 'platform', {
                get: () => 'Win32'
            });
        }, navigatorLanguages);
        this.log(`🧬 指纹: viewport=${this.fingerprint.viewport.width}x${this.fingerprint.viewport.height}, UA片段=${this.fingerprint.userAgent.match(/Chrome\/\d+/)?.[0] || 'Chrome'}`);
        this.log(`📊 浏览器版本: ${await this.browser.version()}`);
    }

    // 监听 request 事件，捕获请求头中的 anti-content
    async setupRequestListener() {
        this.page.on('request', (request) => {
            const url = request.url();
            if (!url.includes(CONFIG.targetApiEndpointPlan)) return;

            const headers = request.headers();
            const antiContent = headers['anti-content'];
            if (!antiContent) return;

            if (!this.capturedData.antiContentPlan) {
                this.log(`URL: ${url}`);
                this.log(`✅ 捕获到 anti-content，长度: ${antiContent.length}`);
                this.capturedData.antiContentPlan = antiContent;
                this.antiContentDeferred.resolve(antiContent);
            }
        });
    }

    async autoLogin() {
        this.log('🔍 尝试使用现有会话...');
        try {
            await this.page.goto(CONFIG.planDirectUrl, {
                waitUntil: 'domcontentloaded',
                timeout: 10000
            });

            this.log('✅ 会话有效，已进入目标页面');
            return true;
        } catch (error) {
            this.warn('现有会话无效或超时，开始登录流程');
        }

        this.log('🌐 开始登录流程，从登录URL直接登录...');

        try {
            this.log(`📝 导航到登录URL: ${CONFIG.planLoginUrl}`);
            await this.page.goto(CONFIG.planLoginUrl, {
                waitUntil: 'domcontentloaded',
                timeout: 10000
            });
            this.log('✅ 登录页面加载成功');

            try {
                const tabContainer = await this.page.$('.Common_operationTabs__3TW7c');
                if (tabContainer) {
                    const items = await this.page.$$('.Common_operationTabs__3TW7c .Common_item__3diIn');
                    if (items && items.length >= 2) {
                        const secondClass = await this.page.evaluate(el => el.className, items[1]);
                        if (!secondClass || !secondClass.includes('Common_checked__1oLdj')) {
                            await items[1].click().catch(() => {});
                            this.log('✅ 已切换到账号登录标签');
                            await sleep(500);
                        }
                    }
                }
            } catch {}

            const usernameEl = await this.page.$('#usernameId');
            const passwordEl = await this.page.$('#passwordId');

            if (usernameEl && passwordEl) {
                try {
                    const existingUser = await this.page.evaluate(el => el.value, usernameEl).catch(() => '');
                    if (!existingUser && this.loginCredentials && this.loginCredentials.username) {
                        await usernameEl.type(this.loginCredentials.username, { delay: this.fingerprint.typeDelay });
                        this.log('✅ 已输入用户名');
                    }
                } catch {}

                try {
                    const existingPass = await this.page.evaluate(el => el.value, passwordEl).catch(() => '');
                    if (!existingPass && this.loginCredentials && this.loginCredentials.password) {
                        await passwordEl.type(this.loginCredentials.password, { delay: this.fingerprint.typeDelay + randomInt(5, 25) });
                        this.log('✅ 已输入密码');
                    }
                } catch {}

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
                        this.log('✅ 尝试点击登录按钮进行自动登录');
                        await navigationPromise;
                    } else {
                        await this.page.keyboard.press('Enter').catch(() => {});
                        this.log('ℹ️ 未找到明确的登录按钮，已尝试按 Enter');
                    }
                } catch {}
            }

            this.log('⏳ 等待登录处理...');
            await sleep(1000 + randomInt(100, 600));

            const startTime = Date.now();
            const maxWaitTime = 90000;// 1.5分钟
            const pollInterval = 2000;

            while (Date.now() - startTime < maxWaitTime) {
                let currentUrl = '';
                let verificationCodeInput = null;

                try {
                    currentUrl = this.page.url();
                } catch {
                    this.warn('获取URL失败，页面可能正在导航，等待后重试...');
                    await sleep(1000);
                    continue;
                }

                if (
                    currentUrl.includes('/ddmc-mms/order/management') 
                ) {
                    this.log(`✅ 登录成功，已进入业务页面: ${currentUrl}`);
                    this.capturedData.needlogin = true;
                    return true;
                }

                try {
                    verificationCodeInput = await this.page.$('input[placeholder="请输入短信验证码"]');
                } catch {
                    verificationCodeInput = null;
                }

                if (verificationCodeInput) {
                    this.warn('检测到需要验证码，跳过验证码处理（快速模式）');
                    this.capturedData.riskTriggered = true;
                    this.capturedData.riskReason = '触发短信验证码';
                    return false;
                }

                await sleep(pollInterval);
            }

            this.error('❌ 登录超时（5分钟），退出');
            this.capturedData.riskTriggered = true;
            this.capturedData.riskReason = '登录超时';
            return false;
        } catch (error) {
            this.error('❌ 登录过程出现错误:', error.message);
            this.capturedData.riskTriggered = true;
            this.capturedData.riskReason = `登录异常: ${error.message}`;
            return false;
        }
    }

    async waitForPlanAPIRequest() {
        if (this.capturedData.antiContentPlan) {
            this.log(`✅ 已捕获到anti-content，直接返回（长度: ${this.capturedData.antiContentPlan.length}）`);
            return true;
        }

        const timeoutMs = toPositiveInt(process.env.QUICK_PLAN_API_WAIT_MS, 30000);
        let timeoutId = null;
        const timeoutPromise = new Promise(resolve => {
            timeoutId = setTimeout(() => resolve(null), timeoutMs);
            if (typeof timeoutId.unref === 'function') timeoutId.unref();
        });

        let antiContent = null;
        try {
            antiContent = await Promise.race([
                this.antiContentDeferred.promise,
                timeoutPromise
            ]);
        } finally {
            if (timeoutId) clearTimeout(timeoutId);
        }

        if (antiContent) {
            this.log(`✅ 已捕获到预估销量查询API请求，获取到anti-content（长度: ${String(antiContent).length}）`);
            return true;
        }

        this.error(`❌ 在${Math.floor(timeoutMs / 1000)}秒内未捕获到 anti-content`);
        return false;
    }

    async captureCookies() {
        this.log('🍪 捕获Cookies...');

        const cookies = await this.page.cookies();
        this.capturedData.allCookies = cookies;

        let cookieStr = '';
        cookies.forEach((cookie, index) => {
            if (index > 0) cookieStr += '; ';
            cookieStr += `${cookie.name}=${cookie.value}`;
        });
        this.capturedData.cookieString = cookieStr;
        this.log('✅ 已构造 Cookie 字符串');
        return cookies;
    }

    async run() {
        const totalStart = Date.now();
        try {
            this.log('🎬 开始执行快速预估销量参数捕获脚本（禁用扩展/代理+无请求拦截+分段计时版）');

            const initStart = Date.now();
            await this.init();
            this.log(`⏱️ 初始化浏览器耗时: ${formatDuration(Date.now() - initStart)}`);

            await this.setupRequestListener();
            this.log(`📝 登录信息: 用户 ${this.loginCredentials.username}`);

            const loginStart = Date.now();
            if (this.riskController) {
                await this.riskController.waitIfCoolingDown(this.logger);
            }

            let releaseLoginSlot = null;
            if (this.loginGate) {
                this.log('🚦 等待登录阶段并发令牌...');
                releaseLoginSlot = await this.loginGate.acquire();
                this.log('✅ 已获取登录阶段并发令牌');
            }

            let loginSuccess = false;
            try {
                loginSuccess = await this.autoLogin();
            } finally {
                if (releaseLoginSlot) {
                    releaseLoginSlot();
                    this.log('🔓 已释放登录阶段并发令牌');
                }
            }

            this.log(`⏱️ 会话/登录阶段耗时: ${formatDuration(Date.now() - loginStart)}`);

            if (!loginSuccess) {
                if (this.capturedData.riskTriggered && this.riskController) {
                    this.riskController.trigger(this.capturedData.riskReason, this.logger);
                }
                this.error('❌ 登录失败，程序退出');
                return;
            }

            const apiStart = Date.now();
            const apiCaptured = await this.waitForPlanAPIRequest();
            this.log(`⏱️ 等待目标API阶段耗时: ${formatDuration(Date.now() - apiStart)}`);
            if (!apiCaptured) {
                this.warn('⚠️ 未捕获到anti-content，将继续抓取并上传 cookie_string');
            }

            const cookieStart = Date.now();
            await this.captureCookies();
            this.log(`⏱️ Cookie 捕获耗时: ${formatDuration(Date.now() - cookieStart)}`);
        } catch (error) {
            this.error('❌ 脚本执行出错:', error.message);
        } finally {
            if (this.browser) {
                try {
                    await this.browser.close();
                    this.log('👋 浏览器已关闭');
                } catch (closeError) {
                    this.warn(`关闭浏览器时出现错误: ${closeError.message}`);
                }
            }
            this.log(`🏁 程序执行完毕。⏱️ 浏览器流程总耗时: ${formatDuration(Date.now() - totalStart)}`);
        }
    }
}

async function updatePlanAntiContent(username, password, runtimeContext = {}) {
    const logger = createPrefixedLogger(getAccountPrefix(username));

    try {
        logger.log('🔍 开始浏览器流程...');
        const fetcher = new PDDPlanAntiContentFetcher(
            { username, password },
            `./puppeteer_user_data/${username}`,
            null,
            runtimeContext
        );
        await fetcher.run();

        const uploadData = {
            username,
            updated_at: new Date().toISOString()
        };

        if (fetcher.capturedData.antiContentPlan) {
            uploadData.anti_content = fetcher.capturedData.antiContentPlan;
        }
        if (fetcher.capturedData.cookieString) {
            uploadData.cookie_string = fetcher.capturedData.cookieString;
        }

        if (!uploadData.anti_content && !uploadData.cookie_string) {
            logger.warn('⚠️ 未获取到anti-content和cookie_string，跳过上传');
            return {
                username,
                success: false,
                skipped: true,
                reason: '未获取到anti-content和cookie_string',
                riskTriggered: Boolean(fetcher.capturedData.riskTriggered),
                riskReason: fetcher.capturedData.riskReason || ''
            };
        }

        if (uploadData.anti_content && uploadData.cookie_string) {
            logger.log('🧾 已准备批量上传数据（anti_content + cookie_string）');
        } else if (uploadData.cookie_string) {
            logger.log('🧾 已准备批量上传数据（仅 cookie_string）');
        } else {
            logger.log('🧾 已准备批量上传数据（仅 anti_content）');
        }

        return {
            username,
            success: true,
            skipped: false,
            uploadData
        };
    } catch (error) {
        logger.error('❌ 更新账号失败:', error.message);
        if (error?.stack) logger.error(error.stack);
        return { username, success: false, skipped: false, reason: error.message };
    }
}

async function batchUpsertRows(supabase, rows, description) {
    if (!rows.length) {
        return { successCount: 0, failedResults: [] };
    }

    const start = Date.now();
    const { error } = await supabase
        .from('pdd_accounts')
        .upsert(rows, { onConflict: 'username' });

    console.log(`⏱️ Supabase 批量上传耗时（${description}，${rows.length}条）: ${formatDuration(Date.now() - start)}`);

    if (error) {
        return {
            successCount: 0,
            failedResults: rows.map(row => ({
                username: row.username,
                success: false,
                skipped: false,
                reason: `批量上传失败: ${error.message}`
            }))
        };
    }

    for (const row of rows) {
        const logger = createPrefixedLogger(getAccountPrefix(row.username));
        logger.log(`✅ 已批量上传到 Supabase（${description}）`);
    }

    return {
        successCount: rows.length,
        failedResults: []
    };
}

async function batchUploadAccountData(supabase, results) {
    const uploadableResults = results.filter(result => result?.success && result?.uploadData);
    if (uploadableResults.length === 0) {
        return { successCount: 0, failedResults: [] };
    }

    const antiWithCookieRows = [];
    const cookieOnlyRows = [];
    const antiOnlyRows = [];

    for (const result of uploadableResults) {
        const row = result.uploadData;
        if (Object.prototype.hasOwnProperty.call(row, 'anti_content') && Object.prototype.hasOwnProperty.call(row, 'cookie_string')) {
            antiWithCookieRows.push(row);
        } else if (Object.prototype.hasOwnProperty.call(row, 'cookie_string')) {
            cookieOnlyRows.push(row);
        } else {
            antiOnlyRows.push(row);
        }
    }

    const [antiWithCookieResult, cookieOnlyResult, antiOnlyResult] = await Promise.all([
        batchUpsertRows(supabase, antiWithCookieRows, 'anti_content + cookie_string'),
        batchUpsertRows(supabase, cookieOnlyRows, '仅 cookie_string'),
        batchUpsertRows(supabase, antiOnlyRows, '仅 anti_content')
    ]);

    return {
        successCount: antiWithCookieResult.successCount + cookieOnlyResult.successCount + antiOnlyResult.successCount,
        failedResults: antiWithCookieResult.failedResults.concat(cookieOnlyResult.failedResults, antiOnlyResult.failedResults)
    };
}

async function runAccountsWithConcurrency(accounts, concurrency, runtimeContext = {}) {
    const results = new Array(accounts.length);
    let currentIndex = 0;

    const staggerMs = Math.max(0, runtimeContext.staggerMs || 0);
    const staggerJitterMs = Math.max(0, runtimeContext.staggerJitterMs || 0);

    async function worker(workerId) {
        while (true) {
            const index = currentIndex++;
            if (index >= accounts.length) return;

            const account = accounts[index];
            const logger = createPrefixedLogger(getAccountPrefix(account.username));

            if (index < concurrency && staggerMs > 0) {
                const delayMs = (index * staggerMs) + randomInt(0, staggerJitterMs);
                if (delayMs > 0) {
                    logger.log(`⏳ 错峰启动，等待 ${formatDuration(delayMs)} 后开始（Worker-${workerId}）`);
                    await sleep(delayMs);
                }
            }

            logger.log(`🧵 Worker-${workerId} 开始处理`);
            results[index] = await updatePlanAntiContent(
                account.username,
                account.password,
                { ...runtimeContext, accountIndex: account.accountIndex }
            );
            logger.log(`🧵 Worker-${workerId} 处理完成`);
        }
    }

    const workerCount = Math.max(1, Math.min(concurrency, accounts.length));
    await Promise.all(Array.from({ length: workerCount }, (_, index) => worker(index + 1)));
    return results;
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

    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!supabaseUrl || !supabaseKey) {
        console.log('❌ Supabase配置缺失，无法批量上传');
        return;
    }

    const supabase = createClient(supabaseUrl, supabaseKey);

    try {
        const accounts = JSON.parse(accountsJson).accounts;
        const runnableAccounts = [];

        for (const account of accounts) {
            const username = account.username;
            const password = process.env[`PASSWORD_${username.toUpperCase()}`];
            if (!password) {
                createPrefixedLogger(getAccountPrefix(username)).warn('❌ 密码未设置，跳过');
                continue;
            }

            runnableAccounts.push({ username, password, accountIndex: runnableAccounts.length });
        }

        if (runnableAccounts.length === 0) {
            console.log('❌ 没有可执行的账号');
            return;
        }

        const concurrency = toPositiveInt(process.env.QUICK_PLAN_CONCURRENCY, 3);
        const loginConcurrency = toPositiveInt(process.env.QUICK_LOGIN_CONCURRENCY, 1);
        const staggerMs = Math.max(0, Number(process.env.QUICK_PLAN_STAGGER_MS || 2000));
        const staggerJitterMs = Math.max(0, Number(process.env.QUICK_PLAN_STAGGER_JITTER_MS || 1000));
        const riskCooldownMs = toPositiveInt(process.env.QUICK_PLAN_RISK_COOLDOWN_MS, 45000);

        const runtimeContext = {
            loginGate: new AsyncSemaphore(Math.min(loginConcurrency, Math.max(1, runnableAccounts.length))),
            riskController: new RiskController(riskCooldownMs),
            staggerMs,
            staggerJitterMs
        };

        console.log(`⚙️ 账号并发数: ${Math.min(concurrency, runnableAccounts.length)}/${runnableAccounts.length}`);
        console.log(`⚙️ 登录阶段并发数: ${Math.min(loginConcurrency, runnableAccounts.length)}`);
        console.log(`⚙️ 错峰启动: 基础 ${staggerMs}ms, 抖动 ${staggerJitterMs}ms`);
        console.log(`⚙️ 风控冷却窗口: ${riskCooldownMs}ms`);

        const results = await runAccountsWithConcurrency(runnableAccounts, concurrency, runtimeContext);

        const skippedCount = results.filter(result => result?.skipped).length;
        const browserFailedResults = results.filter(result => result && !result.success && !result.skipped);
        const uploadSummary = await batchUploadAccountData(supabase, results);
        const failedResults = browserFailedResults.concat(uploadSummary.failedResults);
        const successCount = uploadSummary.successCount;

        if (failedResults.length > 0) {
            console.log('⚠️ 失败账号汇总:');
            for (const result of failedResults) {
                console.log(` - ${result.username}: ${result.reason || '未知原因'}`);
            }
        }

        console.log(`🎉 所有账号的预估销量参数更新完成（成功上传: ${successCount}，跳过: ${skippedCount}，失败: ${failedResults.length}）`);
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
