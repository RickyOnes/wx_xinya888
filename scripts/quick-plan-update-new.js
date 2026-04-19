const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { createClient } = require('@supabase/supabase-js');
const { execSync } = require('child_process'); // 用于检测系统 Chrome

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
          '--disable-features=IsolateOrigins,site-per-process,BlockInsecurePrivateNetworkRequests',
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

class PDDPlanAntiContentFetcher {
    constructor(loginCredentials, userDataDir, supabaseClient) {
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
        this.username = this.loginCredentials?.username || 'unknown';
        this.logger = createPrefixedLogger(getAccountPrefix(this.username));
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
            userDataDir: this.userDataDir
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

        await this.page.setUserAgent(
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36'
        );

        await this.page.setExtraHTTPHeaders({
            'Accept-Language': 'zh-CN,zh;q=0.9',
            'Accept-Encoding': 'gzip, deflate, br, zstd'
        });

        await this.page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => false });
            Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
            Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh'] });
        });

        this.log(`📊 浏览器版本: ${await this.browser.version()}`);
    }

    async setupRequestListener() {
        this.page.on('request', (request) => {
            const url = request.url();
            if (!url.includes(CONFIG.targetApiEndpointPlan)) return;

            this.log(`URL: ${url}`);

            const headers = request.headers();
            if (headers['anti-content']) {
                this.capturedData.antiContentPlan = headers['anti-content'];
                this.log(`✅ 捕获到 anti-content，长度: ${this.capturedData.antiContentPlan.length}`);
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
                            await new Promise(r => setTimeout(r, 500));
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
                        await usernameEl.type(this.loginCredentials.username, { delay: 50 });
                        this.log('✅ 已输入用户名');
                    }
                } catch {}

                try {
                    const existingPass = await this.page.evaluate(el => el.value, passwordEl).catch(() => '');
                    if (!existingPass && this.loginCredentials && this.loginCredentials.password) {
                        await passwordEl.type(this.loginCredentials.password, { delay: 50 });
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
            await new Promise(resolve => setTimeout(resolve, 1000));

            const startTime = Date.now();
            const maxWaitTime = 300000;
            const pollInterval = 2000;

            while (Date.now() - startTime < maxWaitTime) {
                let currentUrl = '';
                let verificationCodeInput = null;

                try {
                    currentUrl = this.page.url();
                } catch {
                    this.warn('获取URL失败，页面可能正在导航，等待后重试...');
                    await new Promise(resolve => setTimeout(resolve, 1000));
                    continue;
                }

                if (currentUrl.includes('mc.pinduoduo.com/ddmc-mms/appointment-delivery')) {
                    this.log('✅ 登录成功，已进入预估销量页面');
                    this.capturedData.needlogin = true;
                    return true;
                }

                try {
                    verificationCodeInput = await this.page.$('input[placeholder="请输入短信验证码"]');
                } catch {
                    verificationCodeInput = null;
                }

                if (verificationCodeInput) {
                    this.warn('检测到验证码输入框，可能需要短信验证码');
                    this.warn('需要验证码，跳过验证码处理（快速模式）');
                    return false;
                }

                await new Promise(resolve => setTimeout(resolve, pollInterval));
            }

            this.error('❌ 登录超时（5分钟），退出');
            return false;
        } catch (error) {
            this.error('❌ 登录过程出现错误:', error.message);
            return false;
        }
    }

    async waitForPlanAPIRequest() {
        if (this.capturedData.antiContentPlan) {
            this.log(`✅ 已捕获到anti-content，直接返回（长度: ${this.capturedData.antiContentPlan.length}）`);
            return true;
        }

        try {
            await this.page.waitForResponse(
                response => response.url().includes(CONFIG.targetApiEndpointPlan),
                { timeout: 30000 }
            );
            this.log(`✅ 已捕获到预估销量查询API请求，获取到anti-content（长度: ${this.capturedData.antiContentPlan.length}）`);
            return true;
        } catch {
            this.error('❌ 在30秒内未捕获到预估销量查询API请求');
            return false;
        }
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
            this.log('🪝 已改为 request 监听，不再启用 setRequestInterception');
            this.log(`📝 登录信息: 用户 ${this.loginCredentials.username}`);

            const loginStart = Date.now();
            const loginSuccess = await this.autoLogin();
            this.log(`⏱️ 会话/登录阶段耗时: ${formatDuration(Date.now() - loginStart)}`);

            if (!loginSuccess) {
                this.error('❌ 登录失败，程序退出');
                return;
            }

            const apiStart = Date.now();
            const apiCaptured = await this.waitForPlanAPIRequest();
            this.log(`⏱️ 等待目标API阶段耗时: ${formatDuration(Date.now() - apiStart)}`);
            if (!apiCaptured) {
                throw new Error('未捕获到预估销量查询API请求，无法获取anti-content参数');
            }

            if (this.capturedData.needlogin) {
                const cookieStart = Date.now();
                await this.captureCookies();
                this.log(`⏱️ Cookie 捕获耗时: ${formatDuration(Date.now() - cookieStart)}`);
            }
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

async function updatePlanAntiContent(username, password) {
    const logger = createPrefixedLogger(getAccountPrefix(username));

    try {
        logger.log('🔍 开始浏览器流程...');
        const browserFlowStart = Date.now();
        const fetcher = new PDDPlanAntiContentFetcher({ username, password }, `./puppeteer_user_data/${username}`, null);
        await fetcher.run();

        if (!fetcher.capturedData.antiContentPlan) {
            logger.warn('⚠️ 未获取到anti-content，跳过上传');
            return { username, success: false, skipped: true, reason: '未获取到anti-content' };
        }

        const uploadData = {
            username,
            anti_content: fetcher.capturedData.antiContentPlan,
            updated_at: new Date().toISOString()
        };

        if (fetcher.capturedData.needlogin) {
            uploadData.cookie_string = fetcher.capturedData.cookieString;
            logger.log('🧾 已准备批量上传数据（含 cookie_string）');
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

    const antiOnlyRows = [];
    const withCookieRows = [];

    for (const result of uploadableResults) {
        if (Object.prototype.hasOwnProperty.call(result.uploadData, 'cookie_string')) {
            withCookieRows.push(result.uploadData);
        } else {
            antiOnlyRows.push(result.uploadData);
        }
    }

    const [antiOnlyResult, withCookieResult] = await Promise.all([
        batchUpsertRows(supabase, antiOnlyRows, '仅 anti_content'),
        batchUpsertRows(supabase, withCookieRows, 'anti_content + cookie_string')
    ]);

    return {
        successCount: antiOnlyResult.successCount + withCookieResult.successCount,
        failedResults: antiOnlyResult.failedResults.concat(withCookieResult.failedResults)
    };
}

async function runAccountsWithConcurrency(accounts, concurrency) {
    const results = new Array(accounts.length);
    let currentIndex = 0;

    async function worker(workerId) {
        while (true) {
            const index = currentIndex++;
            if (index >= accounts.length) return;

            const account = accounts[index];
            const logger = createPrefixedLogger(getAccountPrefix(account.username));
            logger.log(`🧵 Worker-${workerId} 开始处理`);
            results[index] = await updatePlanAntiContent(account.username, account.password);
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

            runnableAccounts.push({ username, password });
        }

        if (runnableAccounts.length === 0) {
            console.log('❌ 没有可执行的账号');
            return;
        }

        const configuredConcurrency = Number(process.env.QUICK_PLAN_CONCURRENCY || 2);
        const concurrency = Number.isFinite(configuredConcurrency) && configuredConcurrency > 0
            ? Math.floor(configuredConcurrency)
            : 2;

        console.log(`⚙️ 并发账号数: ${Math.min(concurrency, runnableAccounts.length)}/${runnableAccounts.length}`);
        const results = await runAccountsWithConcurrency(runnableAccounts, concurrency);

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
