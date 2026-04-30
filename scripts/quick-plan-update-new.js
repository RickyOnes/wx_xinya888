/* 【deepseek优化终极版本】————[并发]版本：
   1、不保存cookie为文件，能更智能判断登录状态及决定是否需要并完成自动登录！
   2、自动登录失败时注入有效的本地cookie兜底。
   3、优化setupRequestInterception方法，改为监听request事件，性能最优！
*/

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');

puppeteer.use(StealthPlugin());

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
    }
};

function formatDuration(ms) { return `${(ms / 1000).toFixed(2)}s`; }
function getAccountPrefix(username) { return `[${username || 'unknown'}]`; }
function createPrefixedLogger(prefix) { return { log: (...args) => console.log(prefix, ...args), warn: (...args) => console.warn(prefix, ...args), error: (...args) => console.error(prefix, ...args) }; }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function toPositiveInt(value, fallback) { const num = Number(value); return Number.isFinite(num) && num > 0 ? Math.floor(num) : fallback; }
function randomInt(min, max) { if (max <= min) return min; return Math.floor(Math.random() * (max - min + 1)) + min; }
function createDeferred() { let resolve, reject; const promise = new Promise((res, rej) => { resolve = res; reject = rej; }); return { promise, resolve, reject }; }

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
const FIXED_LANGUAGE = { header: 'zh,en-US;q=0.9,en;q=0.8,zh-CN;q=0.7', navigator: ['zh', 'en-US', 'en', 'zh-CN'] };

function buildAccountFingerprint(accountIndex = 0) {
    const idx = ((Number(accountIndex) || 0) % UA_POOL.length + UA_POOL.length) % UA_POOL.length;
    return { userAgent: UA_POOL[idx], language: FIXED_LANGUAGE, viewport: VIEWPORT_POOL[idx], typeDelay: 55 };
}

class AsyncSemaphore {
    constructor(maxConcurrency = 1) {
        this.maxConcurrency = Math.max(1, maxConcurrency);
        this.current = 0;
        this.queue = [];
    }
    async acquire() {
        if (this.current < this.maxConcurrency) { this.current++; return () => { this.current = Math.max(0, this.current - 1); const next = this.queue.shift(); if (next) next(); }; }
        await new Promise(resolve => this.queue.push(resolve));
        this.current++;
        return () => { this.current = Math.max(0, this.current - 1); const next = this.queue.shift(); if (next) next(); };
    }
}

class RiskController {
    constructor(cooldownMs = 45000) {
        this.cooldownMs = Math.max(5000, cooldownMs);
        this.cooldownUntil = 0;
    }
    async waitIfCoolingDown(logger) {
        const remain = this.cooldownUntil - Date.now();
        if (remain > 0) { logger.warn(`🛡️ 风控冷却中，等待 ${formatDuration(remain)}`); await sleep(remain); }
    }
    trigger(reason, logger) {
        const jitter = randomInt(3000, 12000);
        const nextUntil = Date.now() + this.cooldownMs + jitter;
        if (nextUntil > this.cooldownUntil) this.cooldownUntil = nextUntil;
        logger.warn(`🛡️ 触发风控冷却 (${reason || '未知'})`);
    }
}

class PDDPlanAntiContentFetcher {
    constructor(loginCredentials, userDataDir, supabaseClient, runtimeContext = {}) {
        this.browser = null;
        this.page = null;
        this.capturedData = {
            antiContentPlan: null, cookieString: '', needlogin: false,
            riskTriggered: false, riskReason: ''
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

        this._sessionCheckResolve = null;
        this._sessionCheckPromise = null;
    }

    log(...args) { this.logger.log(...args); }
    warn(...args) { this.logger.warn(...args); }
    error(...args) { this.logger.error(...args); }

    _createSessionCheckPromise() {
        this._sessionCheckPromise = new Promise(resolve => { this._sessionCheckResolve = resolve; });
    }

    async init() {
        this.log(`🚀 启动浏览器... 📁 用户数据目录: ${this.userDataDir}`);
        const fsp = fs.promises;
        try { await fsp.mkdir(this.userDataDir, { recursive: true }); } catch (e) { this.warn(`无法创建目录: ${e.message}`); }

        const baseOptions = { ...CONFIG.browserOptions, userDataDir: this.userDataDir, defaultViewport: this.fingerprint.viewport };
        let launchOptions = { ...baseOptions };
        let useSystemChrome = false;
        try { require('child_process').execSync('which google-chrome', { stdio: 'ignore' }); launchOptions.executablePath = '/usr/bin/google-chrome'; useSystemChrome = true; } catch { this.log('ℹ️ 系统 Chrome 未找到，使用内置 Chromium'); }

        try {
            this.browser = await puppeteer.launch(launchOptions);
            if (useSystemChrome) this.log('✅ 系统 Chrome 启动成功');
        } catch (error) {
            if (useSystemChrome) {
                this.warn(`系统 Chrome 启动失败: ${error.message}`); this.log('🔄 回退到内置 Chromium...');
                delete launchOptions.executablePath;
                try { this.browser = await puppeteer.launch(launchOptions); this.log('✅ 内置 Chromium 启动成功'); } catch (e) { this.error('❌ 所有浏览器启动尝试均失败:', e.message); throw e; }
            } else { this.error('❌ 浏览器启动失败:', error.message); throw error; }
        }

        this.page = await this.browser.newPage();
        await this.page.setUserAgent(this.fingerprint.userAgent);
        await this.page.setExtraHTTPHeaders({ 'Accept-Language': this.fingerprint.language.header, 'Accept-Encoding': 'gzip, deflate, br, zstd' });
        await this.page.evaluateOnNewDocument((langs) => {
            Object.defineProperty(navigator, 'webdriver', { get: () => false });
            Object.defineProperty(navigator, 'plugins', { get: () => [1,2,3,4,5] });
            Object.defineProperty(navigator, 'languages', { get: () => langs });
            Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
        }, this.fingerprint.language.navigator);
        this.log(`🧬 指纹: viewport=${this.fingerprint.viewport.width}x${this.fingerprint.viewport.height}, UA片段=${this.fingerprint.userAgent.match(/Chrome\/\d+/)?.[0] || 'Chrome'}`);
        this.log(`📊 浏览器版本: ${await this.browser.version()}`);
    }

    setupRequestListener() {
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
                this.log(`✅ 捕获到 anti-content，长度: ${antiContent.length}`);
                this.antiContentDeferred.resolve(antiContent);
            }
        });
    }

    async autoLogin() {
        this.log('🔍 尝试使用现有会话...');
        this._createSessionCheckPromise();
        try {
            await this.page.goto(CONFIG.planDirectUrl, { waitUntil: 'domcontentloaded', timeout: 10000 });
        } catch (e) {
            this.warn('导航到订单页失败，进入登录流程');
            return this._doLogin();
        }

        let apiSeen = false;
        try {
            await Promise.race([ this._sessionCheckPromise, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000)) ]);
            apiSeen = true;
        } catch (_) {}

        if (apiSeen) { this.log('✅ 订单API已发生，会话有效'); return true; }

        const url = this.page.url();
        if (!url.includes('/order/management')) {
            this.warn('页面已跳转到登录页');
            return this._doLogin();
        }

        try {
            await this.page.waitForSelector('[data-testid="beast-core-table"]', { timeout: 3000, visible: true });
            this.log('✅ 表格加载完成，会话有效');
            return true;
        } catch (_) {
            const finalUrl = this.page.url();
            if (finalUrl.includes('/order/management')) { this.warn('表格未加载但URL未变，视为有效'); return true; }
            return this._doLogin();
        }
    }

    async _doLogin() {
        this.log('🌐 开始登录流程...');
        try {
            this.log(`📝 导航到登录URL: ${CONFIG.planLoginUrl}`);
            await this.page.goto(CONFIG.planLoginUrl, { waitUntil: 'domcontentloaded', timeout: 10000 });
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
            } catch (_) {}

            const usernameEl = await this.page.$('#usernameId');
            const passwordEl = await this.page.$('#passwordId');
            if (usernameEl && passwordEl) {
                await usernameEl.type(this.loginCredentials.username, { delay: this.fingerprint.typeDelay });
                await passwordEl.type(this.loginCredentials.password, { delay: this.fingerprint.typeDelay + randomInt(5, 25) });

                let loginButton = await this.page.$('button[data-testid="beast-core-button"]');
                if (!loginButton) {
                    const xpathBtn = await this.page.$x("//button[contains(., '登录')]");
                    if (xpathBtn && xpathBtn.length > 0) loginButton = xpathBtn[0];
                }
                if (loginButton) {
                    await loginButton.click();
                    this.log('✅ 点击登录按钮');
                } else {
                    await this.page.keyboard.press('Enter');
                    this.log('ℹ️ 按回车登录');
                }
            }

            this.log('⏳ 等待登录结果...');
            await sleep(1000);
            const start = Date.now();
            while (Date.now() - start < 90000) {
                await sleep(2000);
                let currentUrl = '';
                try { currentUrl = this.page.url(); } catch (_) { continue; }
                if (currentUrl.includes('/order/management')) { this.log('✅ 登录成功'); this.capturedData.needlogin = true; return true; }
                const vcode = await this.page.$('input[placeholder="请输入短信验证码"]').catch(() => null);
                if (vcode) {
                    this.warn('📱 需要短信验证码，将使用本地Cookie注入');
                    return false;
                }
            }
            this.warn('❌ 登录超时');
            return false;
        } catch (error) {
            this.warn('❌ 登录过程出错:', error.message);
            return false;
        }
    }

    async _fallbackLogin() {
        this.log('💉 尝试从本地Cookie文件恢复...');
        this.capturedData.antiContentPlan = null;
        this.antiContentDeferred = createDeferred();

        const cookieFile = `${this.userDataDir}/../cookie_${this.username}.json`;
        if (!fs.existsSync(cookieFile)) { this.warn('无本地cookie文件'); return false; }

        let cookies;
        try { cookies = JSON.parse(fs.readFileSync(cookieFile, 'utf8')); } catch (e) { this.warn('读取cookie文件失败'); return false; }

        const nowSec = Math.floor(Date.now() / 1000);
        for (const c of cookies) {
            try {
                let expires = (c.expires && c.expires > 0) ? c.expires : undefined;
                if ((c.name === 'PASS_ID' || c.name === 'windows_app_shop_token_23') && expires) {
                    if (expires < nowSec) {
                        this.log(`   ⚠️ ${c.name} 已过期，延长至当前UTC+12小时`);
                        expires = nowSec + 43200;
                    } else if (expires - nowSec < 3600) {
                        this.log(`   ⚠️ ${c.name} 即将过期，延长至当前UTC+12小时`);
                        expires = nowSec + 43200;
                    }
                }
                await this.page.setCookie({
                    name: c.name, value: c.value, domain: c.domain, path: c.path,
                    secure: c.secure, httpOnly: c.httpOnly, sameSite: c.sameSite || 'Strict', expires
                });
            } catch (_) {}
        }

        this.log('✅ Cookie注入完成，尝试访问订单页...');
        this._createSessionCheckPromise();
        try {
            await this.page.goto(CONFIG.planDirectUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
            let apiSeen = false;
            try {
                await Promise.race([ this._sessionCheckPromise, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 4000)) ]);
                apiSeen = true;
            } catch (_) {}
            if (apiSeen || this.page.url().includes('/order/management')) {
                this.log('✅ 注入后成功进入订单页');
                await sleep(3000);
                return true;
            }
        } catch (_) {}
        this.warn('❌ 注入后仍无法进入订单页');
        return false;
    }

    async waitForPlanAPIRequest() {
        if (this.capturedData.antiContentPlan) { this.log('✅ 已持有anti-content'); return true; }
        const timeoutMs = toPositiveInt(process.env.QUICK_PLAN_API_WAIT_MS, 30000);
        try {
            const antiContent = await Promise.race([
                this.antiContentDeferred.promise,
                new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs))
            ]);
            if (antiContent) { this.log(`✅ 捕获到anti-content，长度: ${antiContent.length}`); return true; }
        } catch (_) {}
        this.error(`anti-content 等待超时 (${timeoutMs}ms)`);
        return false;
    }

    async captureCookies() {
        this.log('🍪 捕获Cookies...');
        const cookies = await this.page.cookies();
        this.capturedData.allCookies = cookies;
        let cookieStr = '';
        cookies.forEach((c, i) => { if (i > 0) cookieStr += '; '; cookieStr += `${c.name}=${c.value}`; });
        this.capturedData.cookieString = cookieStr;
        this.log('✅ 已构造 Cookie 字符串');
        return cookies;
    }

    async run() {
        const totalStart = Date.now();
        try {
            this.log('🎬 开始执行并发优化版脚本');
            await this.init();
            this.setupRequestListener();

            if (this.riskController) await this.riskController.waitIfCoolingDown(this.logger);
            let releaseSlot = null;
            if (this.loginGate) { this.log('🚦 等待登录并发令牌...'); releaseSlot = await this.loginGate.acquire(); this.log('✅ 获得令牌'); }

            let loginSuccess = false;
            try { loginSuccess = await this.autoLogin(); } finally { if (releaseSlot) { releaseSlot(); this.log('🔓 释放令牌'); } }

            if (!loginSuccess) {
                if (this.capturedData.riskTriggered && this.riskController) this.riskController.trigger(this.capturedData.riskReason, this.logger);
                loginSuccess = await this._fallbackLogin();
                if (!loginSuccess) { this.error('❌ 所有登录方式均失败'); return; }
            }

            await this.waitForPlanAPIRequest();
            await this.captureCookies();
        } catch (error) { this.error('脚本执行出错:', error.message); } finally {
            if (this.browser) { try { await this.browser.close(); this.log('👋 浏览器已关闭'); } catch (e) { this.warn(`关闭浏览器出错: ${e.message}`); } }
            this.log(`🏁 程序执行完毕，总耗时: ${formatDuration(Date.now() - totalStart)}`);
        }
    }
}

// --- 主流程及并发控制（完全保留原版 batch 工具函数）---
async function updatePlanAntiContent(username, password, runtimeContext = {}) {
    const logger = createPrefixedLogger(getAccountPrefix(username));
    try {
        const fetcher = new PDDPlanAntiContentFetcher({ username, password }, `./puppeteer_user_data/${username}`, null, runtimeContext);
        await fetcher.run();
        const uploadData = { username, updated_at: new Date().toISOString() };
        if (fetcher.capturedData.antiContentPlan) uploadData.anti_content = fetcher.capturedData.antiContentPlan;
        if (fetcher.capturedData.cookieString) uploadData.cookie_string = fetcher.capturedData.cookieString;
        if (!uploadData.anti_content && !uploadData.cookie_string) { logger.warn('无数据可上传'); return { username, success: false, skipped: true, reason: '无数据' }; }
        return { username, success: true, skipped: false, uploadData };
    } catch (error) { logger.error('更新失败:', error.message); return { username, success: false, skipped: false, reason: error.message }; }
}

async function batchUpsertRows(supabase, rows, description) {
    if (!rows.length) return { successCount: 0, failedResults: [] };
    const { error } = await supabase.from('pdd_accounts').upsert(rows, { onConflict: 'username' });
    if (error) return { successCount: 0, failedResults: rows.map(r => ({ username: r.username, success: false, reason: error.message })) };
    return { successCount: rows.length, failedResults: [] };
}

async function batchUploadAccountData(supabase, results) {
    const uploadable = results.filter(r => r?.success && r?.uploadData);
    if (!uploadable.length) return { successCount: 0, failedResults: [] };
    return await batchUpsertRows(supabase, uploadable.map(r => r.uploadData), 'account data');
}

async function runAccountsWithConcurrency(accounts, concurrency, runtimeContext) {
    const results = new Array(accounts.length);
    let idx = 0;
    const stagger = runtimeContext.staggerMs || 0;
    const staggerJitter = runtimeContext.staggerJitterMs || 0;
    async function worker(id) {
        while (true) {
            const i = idx++;
            if (i >= accounts.length) return;
            const account = accounts[i];
            const logger = createPrefixedLogger(getAccountPrefix(account.username));
            if (i < concurrency && stagger > 0) { const delay = (i * stagger) + randomInt(0, staggerJitter); logger.log(`⏳ 错峰启动等待 ${formatDuration(delay)}`); await sleep(delay); }
            logger.log(`🧵 Worker-${id} 开始处理`);
            results[i] = await updatePlanAntiContent(account.username, account.password, { ...runtimeContext, accountIndex: account.accountIndex });
            logger.log(`🧵 Worker-${id} 处理完成`);
        }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, accounts.length) }, (_, i) => worker(i + 1)));
    return results;
}

async function main() {
    console.log(`==========================================`);
    console.log(`脚本开始时间: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`);
    const start = Date.now();
    const accountsJson = process.env.PDD_ACCOUNTS_JSON;
    if (!accountsJson) { console.log('❌ PDD_ACCOUNTS_JSON环境变量未设置'); return; }
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!supabaseUrl || !supabaseKey) { console.log('❌ Supabase配置缺失'); return; }
    const supabase = createClient(supabaseUrl, supabaseKey);

    let accounts;
    try { accounts = JSON.parse(accountsJson).accounts; } catch (e) { console.log('❌ 解析账号失败:', e.message); return; }

    const runnable = [];
    for (const account of accounts) {
        const username = account.username;
        const password = process.env[`PASSWORD_${username.toUpperCase()}`];
        if (!password) { createPrefixedLogger(getAccountPrefix(username)).warn('密码未设置，跳过'); continue; }
        runnable.push({ username, password, accountIndex: runnable.length });
    }
    if (!runnable.length) { console.log('没有可执行的账号'); return; }

    // 并发控制参数, 默认3个并发登录, 1个登录并发, 错峰1秒±0.5秒, 风控冷却20秒
    const concurrency = toPositiveInt(process.env.QUICK_PLAN_CONCURRENCY, 3); // 总并发数
    const loginConcurrency = toPositiveInt(process.env.QUICK_LOGIN_CONCURRENCY, 2); // 登录并发数
    const staggerMs = Math.max(0, Number(process.env.QUICK_PLAN_STAGGER_MS || 1000)); // 错峰时间
    const staggerJitterMs = Math.max(0, Number(process.env.QUICK_PLAN_STAGGER_JITTER_MS || 500)); // 错峰抖动，避免过于规律的请求间隔
    const riskCooldownMs = toPositiveInt(process.env.QUICK_PLAN_RISK_COOLDOWN_MS, 20000);// 风控触发后冷却时间
    const runtimeContext = {
        loginGate: new AsyncSemaphore(Math.min(loginConcurrency, runnable.length)),
        riskController: new RiskController(riskCooldownMs),
        staggerMs, staggerJitterMs
    };

    console.log(`⚙️ 并发数: ${concurrency}/${runnable.length}, 登录并发: ${loginConcurrency}, 错峰: ${staggerMs/1000}秒±${staggerJitterMs/1000}秒, 风控冷却: ${riskCooldownMs/1000}秒`);
    const results = await runAccountsWithConcurrency(runnable, concurrency, runtimeContext);
    const uploadSummary = await batchUploadAccountData(supabase, results);
    const failed = results.filter(r => r && !r.success && !r.skipped).concat(uploadSummary.failedResults);
    if (failed.length) { console.log('⚠️ 失败汇总:'); failed.forEach(r => console.log(` - ${r.username}: ${r.reason || '未知'}`)); }
    console.log(`🎉 完成 (成功上传: ${uploadSummary.successCount}/${results.length})`);
    console.log(`脚本结束时间: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`);
    console.log(`总运行时长: ${Math.floor((Date.now() - start) / 1000)} 秒`);
    console.log(`==========================================`);
}

main().catch(console.error);