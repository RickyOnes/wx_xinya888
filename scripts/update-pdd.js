const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { createClient } = require('@supabase/supabase-js');
const { execSync } = require('child_process'); // 用于检测系统 Chrome

// 使用反检测插件
puppeteer.use(StealthPlugin());

// 配置常量
const CONFIG = {
    loginUrl: 'https://mms.pinduoduo.com/login/?redirectUrl=https%3A%2F%2Fmc.pinduoduo.com%2Fddmc-mms%2Forder%2Fmanagement',
    targetApiEndpoint: 'cartman-mms/orderManagement/pageQueryDetail',
    targetApiEndpointPlan: 'cartman-mms/appointment/queryAppointmentGoodsList',
    targetApiEndpointDate: 'orianna-mms/goods/schedule/pageQuery',

    // 浏览器配置（优化后）
    browserOptions: {
        headless: 'new',  // 新方法，字符串格式
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
            '--disable-features=IsolateOrigins,site-per-process,BlockInsecurePrivateNetworkRequests'
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

class PDDOrderCrawler {
    constructor(loginCredentials, userDataDir, verificationCode, supabaseClient) {
        this.browser = null;
        this.page = null;
        this.capturedData = {
            antiContent: null,
            antiContentPlan: null,
            antiContentDate: null,
            allCookies: [],
            orderRequestHeaders: null,
            orderRequestBody: null,
            localStorageData: null,
            sessionStorageData: null,
            apiRequestCaptured: false,
            verificationCodeRequest: null,
            verificationCodeRequestHeaders: null,
            requiresVerificationCode: false,
            verificationCode: verificationCode || null
        };
        this.loginCredentials = loginCredentials || { username: 'wangxh03', password: '' };
        this.userDataDir = userDataDir || './puppeteer_user_data/default';
        this.verificationCode = verificationCode || null;
        this.supabaseClient = supabaseClient || null;
    }

    // 新增：模拟用户随机滚动
    async randomScroll() {
        try {
            await this.page.evaluate(() => {
                const scrollY = Math.random() * 300;
                window.scrollBy(0, scrollY);
            });
            await new Promise(resolve => setTimeout(resolve, Math.random() * 1000 + 500));
            console.log('   👆 模拟用户随机滚动');
        } catch (e) {
            // 忽略滚动错误
        }
    }

    async init() {
        console.log('🚀 启动浏览器...');
        console.log(`   📁 用户数据目录: ${this.userDataDir}`);
    
        // 确保用户数据目录存在并可写
        const fs = require('fs').promises;
        try {
            await fs.mkdir(this.userDataDir, { recursive: true });
        } catch (e) {
            console.log(`   ⚠️ 无法创建目录: ${e.message}`);
        }
    
        // 基础启动选项
        const baseOptions = {
            ...CONFIG.browserOptions,
            userDataDir: this.userDataDir
        };
    
        // 尝试使用系统 Chrome
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
    
        // 启动浏览器，失败时回退到内置 Chromium
        try {
            this.browser = await puppeteer.launch(launchOptions);
            if (useSystemChrome) console.log('   ✅ 系统 Chrome 启动成功');
        } catch (error) {
            if (useSystemChrome) {
                console.log(`   ⚠️ 系统 Chrome 启动失败: ${error.message}`);
                console.log('   🔄 尝试回退到 Puppeteer 内置 Chromium...');
                delete launchOptions.executablePath; // 移除系统 Chrome 路径
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
    
        // 设置用户代理
        await this.page.setUserAgent(
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36'
        );
    
        await this.page.setExtraHTTPHeaders({
            'Accept-Language': 'zh-CN,zh;q=0.9',
            'Accept-Encoding': 'gzip, deflate, br, zstd',
        });
    
        await this.page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => false });
            Object.defineProperty(navigator, 'plugins', { get: () => [1,2,3,4,5] });
            Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh'] });
        });
    
        console.log('✅ 浏览器启动成功');
        console.log(`📊 浏览器版本: ${await this.browser.version()}`);
    }

    async setupRequestInterception() {
        await this.page.setRequestInterception(true);

        this.page.on('request', async (request) => {
            const url = request.url();

            if (url.includes(CONFIG.targetApiEndpoint)) {
                console.log('\n🎯 捕获到订单查询请求:');
                console.log('   URL:', url);
                console.log('   方法:', request.method());

                const headers = request.headers();
                if (headers['anti-content']) {
                    this.capturedData.antiContent = headers['anti-content'];
                    this.capturedData.apiRequestCaptured = true;
                    console.log('   ✅ 捕获到 anti-content:', this.capturedData.antiContent);
                }

                if (request.method() === 'POST') {
                    const postData = request.postData();
                    if (postData) {
                        this.capturedData.orderRequestBody = postData;
                    }
                }

                this.capturedData.orderRequestHeaders = headers;
            }
            else if (url.includes(CONFIG.targetApiEndpointPlan)) {
                console.log('\n🎯 捕获到预估销量查询请求:');
                console.log('   URL:', url);
                console.log('   方法:', request.method());

                const headers = request.headers();
                if (headers['anti-content']) {
                    this.capturedData.antiContentPlan = headers['anti-content'];
                    console.log('   ✅ 捕获到 anti-content (预估销量):', this.capturedData.antiContentPlan);
                }
            }
            else if (url.includes(CONFIG.targetApiEndpointDate)) {
                console.log('\n🎯 捕获到生产日期查询请求:');
                console.log('   URL:', url);
                console.log('   方法:', request.method());

                const headers = request.headers();
                if (headers['anti-content']) {
                    this.capturedData.antiContentDate = headers['anti-content'];
                    console.log('   ✅ 捕获到 anti-content (生产日期):', this.capturedData.antiContentDate);
                }
            }
            request.continue();
        });
    }

    async autoLogin() {
        // 先尝试使用现有会话
        console.log('\n🔍 尝试使用现有会话...');
        try {
            await this.page.goto('https://mc.pinduoduo.com/ddmc-mms/order/management', {
                waitUntil: 'networkidle0', // 改为 networkidle0，确保页面完全加载
                timeout: 30000
            });
            
            // 等待页面稳定并检查是否有重定向
            let urlStable = true;
            const initialUrl = this.page.url();
            console.log(`   初始URL: ${initialUrl}`);
            
            // 等待5秒，每1秒检查一次URL是否变化
            for (let i = 0; i < 5; i++) {
                await new Promise(resolve => setTimeout(resolve, 1000));
                const currentUrl = await this.page.url().catch(() => '');
                console.log(`   等待 ${i+1}/5秒，当前URL: ${currentUrl}`);
                
                if (!currentUrl.includes('mc.pinduoduo.com/ddmc-mms/order/management')) {
                    console.log(`   ⚠️  URL已变化到: ${currentUrl}，会话可能已失效`);
                    urlStable = false;
                    break;
                }
            }
            
            const finalUrl = await this.page.url().catch(() => '');
            console.log(`   最终URL: ${finalUrl}`);
            
            // 加强会话检测：不仅检查URL，还检查页面元素
            if (urlStable && finalUrl.includes('mc.pinduoduo.com/ddmc-mms/order/management')) {
                // 检查是否实际在订单管理页面（没有登录表单）
                const hasLoginForm = await this.page.$('#usernameId, input[placeholder="请输入手机号"]').catch(() => null);
                const hasPasswordInput = await this.page.$('#passwordId').catch(() => null);
                const hasLoginButton = await this.page.$('button[data-testid="beast-core-button"]').catch(() => null);
                
                if (hasLoginForm || hasPasswordInput || hasLoginButton) {
                    console.log('⚠️ 检测到登录相关元素，会话可能已失效');
                    // 继续执行登录流程
                } else {
                    console.log('✅ 会话有效，直接进入订单管理页面');
                    return true;
                }
            } else {
                console.log('ℹ️ 会话无效或URL不稳定，开始登录流程');
            }
        } catch (error) {
            console.log(`ℹ️ 会话检测失败: ${error.message}，开始登录流程`);
        }      
        console.log('\n🌐 开始登录流程，从loginUrl直接登录...');

        try {
            console.log(`📝 导航到登录URL: ${CONFIG.loginUrl}`);
            await this.page.goto(CONFIG.loginUrl, {
                waitUntil: 'domcontentloaded',
                timeout: CONFIG.timeouts.pageLoad
            });
            console.log('✅ 登录页面加载成功');

            // 切换到“账号登录”标签（并在切换前/后模拟滚动）
            try {
                const tabContainer = await this.page.$('.Common_operationTabs__3TW7c');
                if (tabContainer) {
                    const items = await this.page.$$('.Common_operationTabs__3TW7c .Common_item__3diIn');
                    if (items && items.length >= 2) {
                        // 在点击切换标签前模拟滚动
                        await this.randomScroll();

                        const secondClass = await this.page.evaluate(el => el.className, items[1]);
                        if (!secondClass || !secondClass.includes('Common_checked__1oLdj')) {
                            await items[1].click().catch(() => {});
                            console.log('   ✅ 已切换到账号登录标签');
                            await new Promise(r => setTimeout(r, 500));
                            // 切换后再滚动一下
                            await this.randomScroll();
                        }
                    }
                }
            } catch (e) {
                // 忽略切换标签时的错误
            }

            // 填写用户名和密码
            const usernameEl = await this.page.$('#usernameId');
            const passwordEl = await this.page.$('#passwordId');

            if (usernameEl && passwordEl) {
                // 填充用户名
                try {
                    const existingUser = await this.page.evaluate(el => el.value, usernameEl).catch(() => '');
                    if (!existingUser && this.loginCredentials && this.loginCredentials.username) {
                        await usernameEl.type(this.loginCredentials.username, { delay: 50 });
                        console.log('   ✅ 已输入用户名');
                    }
                } catch (e) {}

                // 填充密码
                try {
                    const existingPass = await this.page.evaluate(el => el.value, passwordEl).catch(() => '');
                    if (!existingPass && this.loginCredentials && this.loginCredentials.password) {
                        await passwordEl.type(this.loginCredentials.password, { delay: 50 });
                        console.log('   ✅ 已输入密码');
                    }
                } catch (e) {}

                // 在点击登录按钮前模拟随机滚动
                await this.randomScroll();

                // 尝试点击登录按钮或按回车
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
                        console.log('   ✅ 尝试点击登录按钮进行自动登录');

                        await navigationPromise;
                    } else {
                        await this.page.keyboard.press('Enter').catch(() => {});
                        console.log('   ℹ️ 未找到明确的登录按钮，已尝试按 Enter');
                    }
                } catch (e) {
                    // 忽略点击失败
                }
            }

            // 等待登录结果，检查是否跳转或需要验证码
            console.log('⏳ 等待登录处理...');
            await new Promise(resolve => setTimeout(resolve, 1000));

            const startTime = Date.now();
            const maxWaitTime = 300000; // 5分钟
            const pollInterval = 2000;

            while (Date.now() - startTime < maxWaitTime) {
                let currentUrl = '';
                let verificationCodeInput = null;

                try {
                    currentUrl = await this.page.url();
                } catch (urlError) {
                    console.log('   ⚠️ 获取URL失败，页面可能正在导航，等待后重试...');
                    await new Promise(resolve => setTimeout(resolve, 1000));
                    continue;
                }

                if (currentUrl.includes('mc.pinduoduo.com/ddmc-mms/order/management')) {
                    console.log('✅ 登录成功，已进入订单管理页面');
                    return true;
                }

                try {
                    verificationCodeInput = await this.page.$('input[placeholder="请输入短信验证码"]');
                } catch (elementError) {
                    verificationCodeInput = null;
                }

                if (verificationCodeInput) {
                    console.log('📱 检测到验证码输入框，可能需要短信验证码');
                    return await this.handleVerificationCode(verificationCodeInput);
                }

                await new Promise(resolve => setTimeout(resolve, pollInterval));
            }

            console.log('❌ 登录超时（5分钟），退出');
            return false;

        } catch (error) {
            console.log('❌ 登录过程出现错误:', error.message);
            return false;
        }
    }

    // 保留原有验证码处理方法（不变）
    async handleVerificationCode(verificationCodeInput) {
        console.log('📱 检测到验证码输入框，可能需要短信验证码');

        const confirmButton = await this.page.$('button[data-tracking-click-viewid="account_login_confirmation"]');

        let verificationCode = null;

        if (this.supabaseClient) {
            console.log('🔍 从Supabase获取验证码...');
            try {
                const { data, error } = await this.supabaseClient
                    .from('pdd_verification_codes')
                    .select('code, updated_at')
                    .eq('username', this.loginCredentials.username)
                    .single();

                if (!error && data && data.code) {
                    const updatedAt = new Date(data.updated_at);
                    const now = new Date();
                    const tenMinutesAgo = new Date(now.getTime() - 10 * 60 * 1000);

                    if (updatedAt > tenMinutesAgo) {
                        verificationCode = data.code;
                        console.log(`   🔑 从Supabase获取验证码: ${verificationCode} (更新时间: ${updatedAt.toLocaleString()})`);
                    } else {
                        console.log(`   ⚠️  Supabase中的验证码已过期 (更新时间: ${updatedAt.toLocaleString()})`);
                    }
                } else if (error && error.code !== 'PGRST116') {
                    console.log(`   ⚠️  查询Supabase失败: ${error.message}`);
                }
            } catch (e) {
                console.log(`   ⚠️  从Supabase获取验证码异常: ${e.message}`);
            }
        } else {
            console.log('❌ Supabase客户端未初始化，无法获取验证码');
            return false;
        }

        if (!verificationCode) {
            console.log('⏳ 未找到有效验证码，等待用户更新...');
            console.log('   📝 请更新Supabase表 pdd_verification_codes (字段: username, code)');
            console.log('   ⏰ 等待120秒（拼多多验证码有效期10分钟）...');

            const waitStartTime = Date.now();
            const maxWaitTime = 120000;
            const pollInterval = 5000;

            while (Date.now() - waitStartTime < maxWaitTime && !verificationCode) {
                await new Promise(resolve => setTimeout(resolve, pollInterval));

                console.log(`   🔍 第${Math.floor((Date.now() - waitStartTime) / pollInterval)}次检查更新...`);

                if (this.supabaseClient) {
                    try {
                        const { data, error } = await this.supabaseClient
                            .from('pdd_verification_codes')
                            .select('code, updated_at')
                            .eq('username', this.loginCredentials.username)
                            .single();

                        if (!error && data && data.code) {
                            const updatedAt = new Date(data.updated_at);
                            const now = new Date();
                            const tenMinutesAgo = new Date(now.getTime() - 10 * 60 * 1000);

                            if (updatedAt > tenMinutesAgo) {
                                verificationCode = data.code;
                                console.log(`   🔑 从Supabase获取到更新后的验证码: ${verificationCode} (更新时间: ${updatedAt.toLocaleString()})`);
                                break;
                            }
                        }
                    } catch (e) {
                        // 忽略Supabase查询错误
                    }
                }
            }

            if (!verificationCode) {
                console.log('❌ 等待超时，未获取到验证码');
                console.log('   ℹ️  请更新验证码后重新运行脚本');
                return false;
            }
        }

        console.log(`   🔑 使用验证码: ${verificationCode}`);

        try {
            await verificationCodeInput.click({ clickCount: 3 });
            await verificationCodeInput.press('Backspace');
            await verificationCodeInput.type(verificationCode, { delay: 50 });
            console.log('   ✅ 已输入验证码');

            if (confirmButton) {
                const navigationPromise = this.page.waitForNavigation({
                    waitUntil: 'domcontentloaded',
                    timeout: 5000
                }).catch(() => null);

                await confirmButton.click();
                console.log('   ✅ 已点击确认按钮');

                await navigationPromise;

                const verificationCodeWaitStart = Date.now();
                const maxVerificationCodeWait = 60000;

                let verificationCodeAccepted = false;
                let verificationCodeDisappearTime = null;

                while (Date.now() - verificationCodeWaitStart < maxVerificationCodeWait) {
                    let currentUrl = '';
                    try {
                        currentUrl = await this.page.url();
                    } catch (urlError) {
                        await new Promise(resolve => setTimeout(resolve, 1000));
                        continue;
                    }

                    if (currentUrl.includes('mc.pinduoduo.com/ddmc-mms/order/management')) {
                        console.log('✅ 验证码正确，成功跳转到订单管理页面');
                        return true;
                    }

                    const errorElement = await this.page.$('.error-message, .ant-message-error, [class*="error"], [class*="Error"]').catch(() => null);
                    if (errorElement) {
                        const errorText = await this.page.evaluate(el => el.textContent, errorElement).catch(() => '');
                        if (errorText.includes('验证码') || errorText.includes('错误') || errorText.includes('不正确')) {
                            console.log(`❌ 验证码错误: ${errorText}`);
                            return false;
                        }
                    }

                    if (!verificationCodeAccepted) {
                        const stillExists = await this.page.$('input[placeholder="请输入短信验证码"]').catch(() => null);
                        if (!stillExists) {
                            console.log('✅ 验证码输入框已消失，可能已自动处理');
                            verificationCodeAccepted = true;
                            verificationCodeDisappearTime = Date.now();
                        }
                    } else {
                        if (verificationCodeDisappearTime && Date.now() - verificationCodeDisappearTime > 30000) {
                            console.log('❌ 验证码已接受，但页面长时间未跳转，可能登录失败');
                            return false;
                        }
                    }

                    await new Promise(resolve => setTimeout(resolve, 1000));
                }

                const stillOnVerificationPage = await this.page.$('input[placeholder="请输入短信验证码"]').catch(() => null);
                if (stillOnVerificationPage) {
                    console.log('❌ 验证码可能错误或已过期，页面未跳转');
                    return false;
                }
            }
        } catch (e) {
            console.log('   ⚠️  自动填写验证码失败:', e.message);
        }

        this.capturedData.requiresVerificationCode = true;
        return false;
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
        console.log('   ✅  已构造 Cookie字符串');
        return cookies;
    }

    async waitForAPIRequest() {
        console.log('\n⏳ 等待页面自动发送订单查询请求...');
        console.log(`   初始URL: ${this.page.url()}`);

        const startTime = Date.now();
        const maxWaitTime = 900000; // 15分钟
        let retryCount = 0;
        const maxRetries = 3;
        let needReLogin = false;

        while (!this.capturedData.antiContent && (Date.now() - startTime) < maxWaitTime) {
            const currentUrl = this.page.url();
            
            // 检查是否需要重新登录（页面在登录页面）
            if (currentUrl.includes('mms.pinduoduo.com/login')) {
                console.log(`⚠️  页面已跳转到登录页面，会话可能已失效`);
                if (retryCount < maxRetries) {
                    console.log(`🔄 检测到登录页面，尝试重新登录 (重试 ${retryCount + 1}/${maxRetries})...`);
                    needReLogin = true;
                    break;
                } else {
                    console.log('❌ 超过最大重试次数，停止等待API请求');
                    break;
                }
            }
            
            if (!currentUrl.includes('mc.pinduoduo.com/ddmc-mms/order/management')) {
                console.log(`⚠️  页面已离开订单管理页面，当前URL: ${currentUrl}`);
                if (retryCount < maxRetries) {
                    console.log(`🔄 尝试重新导航到订单管理页面 (重试 ${retryCount + 1}/${maxRetries})...`);
                    try {
                        await this.page.goto('https://mc.pinduoduo.com/ddmc-mms/order/management', {
                            waitUntil: 'networkidle0',
                            timeout: 15000
                        });
                        retryCount++;
                        console.log(`✅ 重新导航成功，继续等待API请求...`);
                        
                        // 重新导航后等待页面稳定
                        await new Promise(resolve => setTimeout(resolve, 3000));
                        continue;
                    } catch (error) {
                        console.log(`❌ 重新导航失败: ${error.message}`);
                        
                        // 检查失败后是否在登录页面
                        const urlAfterFail = await this.page.url().catch(() => '');
                        if (urlAfterFail.includes('mms.pinduoduo.com/login')) {
                            console.log(`⚠️  重新导航失败后页面在登录页面，需要重新登录`);
                            needReLogin = true;
                        }
                        break;
                    }
                } else {
                    console.log('❌ 超过最大重试次数，停止等待API请求');
                    break;
                }
            }

            await new Promise(resolve => setTimeout(resolve, 1000));

            const elapsedSeconds = Math.floor((Date.now() - startTime) / 1000);
            if (elapsedSeconds > 0 && elapsedSeconds % 30 === 0) {
                console.log(`   已等待 ${elapsedSeconds} 秒...`);
            }
        }

        if (needReLogin) {
            console.log(`🔄 检测到需要重新登录，抛出错误让外层处理`);
            throw new Error('SESSION_EXPIRED');
        }

        if (this.capturedData.antiContent) {
            console.log(`✅ 已捕获到订单查询API请求，获取到anti-content（长度: ${this.capturedData.antiContent.length}）`);
            return true;
        } else {
            console.log(`❌ 在 ${maxWaitTime/1000/60} 分钟内未捕获到API请求或未获取到anti-content参数`);
            return false;
        }
    }

    async capturePlanAntiContent() {
        console.log('\n📊 跳转到预估销量查询页面...');
        try {
            await this.page.goto('https://mc.pinduoduo.com/ddmc-mms/appointment-delivery', {
                waitUntil: 'networkidle0',
                timeout: 30000
            });
            console.log('✅ 已进入预估销量查询页面');

            console.log('⏳ 等待预估销量查询API请求...');
            const startTime = Date.now();
            const maxWaitTime = 300000;
            while (!this.capturedData.antiContentPlan && (Date.now() - startTime) < maxWaitTime) {
                await new Promise(resolve => setTimeout(resolve, 1000));
                const elapsedSeconds = Math.floor((Date.now() - startTime) / 1000);
                if (elapsedSeconds > 0 && elapsedSeconds % 30 === 0) {
                    console.log(`   已等待 ${elapsedSeconds} 秒...`);
                }
            }

            if (this.capturedData.antiContentPlan) {
                console.log(`✅ 已捕获到预估销量查询API请求，获取到anti-content（长度: ${this.capturedData.antiContentPlan.length}）`);
                return true;
            } else {
                console.log(`❌ 在 ${maxWaitTime/1000/60} 分钟内未捕获到预估销量查询API请求`);
                return false;
            }
        } catch (error) {
            console.log('⚠️ 跳转到预估销量查询页面失败:', error.message);
            return false;
        }
    }

    async captureDateAntiContent() {
        console.log('\n📅 跳转到生产日期查询页面...');
        try {
            await this.page.goto('https://mc.pinduoduo.com/ddmc-supplier-product/goods-schedule', {
                waitUntil: 'networkidle0',
                timeout: 30000
            });
            console.log('✅ 已进入生产日期查询页面');

            console.log('⏳ 等待生产日期查询API请求...');
            const startTime = Date.now();
            const maxWaitTime = 300000;
            while (!this.capturedData.antiContentDate && (Date.now() - startTime) < maxWaitTime) {
                await new Promise(resolve => setTimeout(resolve, 1000));
                const elapsedSeconds = Math.floor((Date.now() - startTime) / 1000);
                if (elapsedSeconds > 0 && elapsedSeconds % 30 === 0) {
                    console.log(`   已等待 ${elapsedSeconds} 秒...`);
                }
            }

            if (this.capturedData.antiContentDate) {
                console.log(`✅ 已捕获到生产日期查询API请求，获取到anti-content（长度: ${this.capturedData.antiContentDate.length}）`);
                return true;
            } else {
                console.log(`❌ 在 ${maxWaitTime/1000/60} 分钟内未捕获到生产日期查询API请求`);
                return false;
            }
        } catch (error) {
            console.log('⚠️ 跳转到生产日期查询页面失败:', error.message);
            return false;
        }
    }

    async run() {
        try {
            console.log('🎬 开始执行拼多多订单数据捕获脚本');

            await this.init();
            await this.setupRequestInterception();

            console.log(`\n📝 登录信息: 用户 ${this.loginCredentials.username}`);

            let loginSuccess = await this.autoLogin();

            if (!loginSuccess) {
                console.log('❌ 登录失败，程序退出');
                return;
            }

            // 尝试捕获API请求，允许会话过期重试
            let apiCaptured = false;
            let sessionRetryCount = 0;
            const maxSessionRetries = 2;
            
            while (!apiCaptured && sessionRetryCount < maxSessionRetries) {
                try {
                    apiCaptured = await this.waitForAPIRequest();
                    
                    if (!apiCaptured) {
                        throw new Error('未捕获到订单查询API请求，无法获取anti-content参数');
                    }
                } catch (error) {
                    if (error.message === 'SESSION_EXPIRED' && sessionRetryCount < maxSessionRetries) {
                        sessionRetryCount++;
                        console.log(`\n🔄 会话过期，尝试重新登录 (重试 ${sessionRetryCount}/${maxSessionRetries})...`);
                        
                        // 重新导航到登录页面执行登录
                        console.log('🌐 重新执行登录流程...');
                        try {
                            await this.page.goto(CONFIG.loginUrl, {
                                waitUntil: 'domcontentloaded',
                                timeout: CONFIG.timeouts.pageLoad
                            });
                            
                            // 执行登录流程（这里可以调用一个专门的登录方法，但为了简单，我们重用autoLogin的登录部分）
                            // 实际上，autoLogin会先尝试现有会话，但我们现在需要强制登录
                            // 暂时重新调用autoLogin，它会检测到会话无效
                            loginSuccess = await this.autoLogin();
                            if (!loginSuccess) {
                                console.log('❌ 重新登录失败，退出');
                                return;
                            }
                            console.log('✅ 重新登录成功，继续等待API请求...');
                            continue;
                        } catch (loginError) {
                            console.log(`❌ 重新登录失败: ${loginError.message}`);
                            break;
                        }
                    } else {
                        // 其他错误，直接抛出
                        throw error;
                    }
                }
            }
            
            if (!apiCaptured) {
                throw new Error('未捕获到订单查询API请求，无法获取anti-content参数');
            }

            console.log('\n📊 开始捕获预估销量查询参数...');
            const planCaptured = await this.capturePlanAntiContent();
            if (!planCaptured) {
                console.log('⚠️ 预估销量查询参数捕获失败，继续执行...');
            }

            console.log('\n📅 开始捕获生产日期查询参数...');
            const dateCaptured = await this.captureDateAntiContent();
            if (!dateCaptured) {
                console.log('⚠️ 生产日期查询参数捕获失败，继续执行...');
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

// 主函数（以下部分完全不变）
async function updateAccount(username, password, verificationCode) {
    console.log(`\n🔄 开始更新账号: ${username}`);
    if (verificationCode) {
        console.log(`   🔑 使用验证码: ${verificationCode}`);
    }

    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !supabaseKey) {
        console.log('❌ Supabase配置缺失，跳过数据上传');
        return;
    }

    const supabase = createClient(supabaseUrl, supabaseKey);

    try {
        console.log(`🔍 开始浏览器登录流程...`);
        const crawler = new PDDOrderCrawler({ username, password }, `./puppeteer_user_data/${username}`, verificationCode, supabase);
        await crawler.run();

        const accountData = {
            username,
            anti_content: crawler.capturedData.antiContent,
            anti_content_Plan: crawler.capturedData.antiContentPlan,
            anti_content_Date: crawler.capturedData.antiContentDate,
            cookie_string: crawler.capturedData.cookieString,
            expires_at: new Date(Date.now() + 20 * 60 * 60 * 1000).toISOString(),
            updated_at: new Date().toISOString(),
            last_success: true
        };

        const { error } = await supabase
            .from('pdd_accounts')
            .upsert(accountData, { onConflict: 'username' });

        if (error) {
            console.log(`❌ 上传失败: ${error.message}`);
        } else {
            console.log(`✅ 账号 ${username} 数据已更新到Supabase`);
            console.log('\n' + '='.repeat(50));
        }

    } catch (error) {
        console.log(`❌ 更新账号 ${username} 失败:`, error.message);
        console.error(error.stack);
    }
}

async function main() {
    const accountsJson = process.env.PDD_ACCOUNTS_JSON;
    if (!accountsJson) {
        console.log('❌ PDD_ACCOUNTS_JSON环境变量未设置');
        return;
    }

    try {
        const accounts = JSON.parse(accountsJson).accounts;

        for (const account of accounts) {
            const username = account.username;
            const password = process.env[`PASSWORD_${username.toUpperCase()}`];
            if (!password) {
                console.log(`❌ 账号 ${username} 的密码未设置，跳过`);
                continue;
            }

            await updateAccount(username, password, null);
        }

        console.log('\n🎉 所有账号更新完成');

    } catch (error) {
        console.log('❌ 解析账号信息失败:', error.message);
    }
}

main().catch(console.error);
