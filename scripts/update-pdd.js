const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { createClient } = require('@supabase/supabase-js');

// 使用反检测插件
puppeteer.use(StealthPlugin());

// 配置常量
const CONFIG = {
    loginUrl: 'https://mms.pinduoduo.com/login/?redirectUrl=https%3A%2F%2Fmc.pinduoduo.com%2Fddmc-mms%2Forder%2Fmanagement',
    targetApiEndpoint: 'cartman-mms/orderManagement/pageQueryDetail',
    targetApiEndpointPlan: 'cartman-mms/appointment/queryAppointmentGoodsList',
    targetApiEndpointDate: 'orianna-mms/goods/schedule/pageQuery',

    // 浏览器配置
    browserOptions: {
        headless: true,
        defaultViewport: {
            width: 1366,
            height: 768
        },
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-web-security',
            '--disable-features=IsolateOrigins,site-per-process',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--disable-gpu',
            '--window-size=1366,768',
            '--start-maximized',
            '--remote-debugging-port=9222',
            '--disable-site-isolation-trials',
            '--disable-blink-features=AutomationControlled',
            '--allow-running-insecure-content',
            '--disable-features=BlockInsecurePrivateNetworkRequests',
            '--use-gl=swiftshader',  // 固定WebGL渲染器
            '--disable-software-rasterizer',
            '--disable-webgl',
            '--disable-canvas-aa',  // 禁用画布抗锯齿
            '--disable-2d-canvas-clip-aa',
            '--disable-gl-drawing-for-tests'
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
            // 验证码相关字段
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

    async init() {
        console.log('🚀 启动浏览器...');
        console.log(`   📁 用户数据目录: ${this.userDataDir}`);

        // 在GitHub Actions中使用puppeteer
        const launchOptions = {
            ...CONFIG.browserOptions,
            userDataDir: this.userDataDir
        };

        this.browser = await puppeteer.launch(launchOptions);
        this.page = await this.browser.newPage();

        // 设置用户代理
        await this.page.setUserAgent(
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
          {
            brands: [
              { brand: 'Chromium', version: '144' },
              { brand: 'Not=A?Brand', version: '99' },
            ],
            platform: 'Windows',
            platformVersion: '10.0',
            architecture: 'x86',
            model: '',
            mobile: false,
            bitness: '64',
          }
        );

        // 设置额外的请求头
        await this.page.setExtraHTTPHeaders({
            'Accept-Language': 'zh-CN,zh;q=0.9',
            'Accept-Encoding': 'gzip, deflate, br, zstd',
        });

        // 注入JavaScript来绕过自动化检测
        await this.page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', {
                get: () => false,
            });

            Object.defineProperty(navigator, 'plugins', {
                get: () => [1, 2, 3, 4, 5],
            });

            Object.defineProperty(navigator, 'languages', {
                get: () => ['zh-CN', 'zh'],
            });
        });

        console.log('✅ 浏览器启动成功');
        // 检查Puppeteer版本
        const version = await this.browser.version();
        console.log(`📊 浏览器版本: ${version}`);
    }

    async setupRequestInterception() {
        // 启用请求拦截
        await this.page.setRequestInterception(true);

        this.page.on('request', async (request) => {
            const url = request.url();

            // 捕获订单查询API的请求
            if (url.includes(CONFIG.targetApiEndpoint)) {
                console.log('\n🎯 捕获到订单查询请求:');
                console.log('   URL:', url);
                console.log('   方法:', request.method());

                // 获取请求头
                const headers = request.headers();
                if (headers['anti-content']) {
                    this.capturedData.antiContent = headers['anti-content'];
                    this.capturedData.apiRequestCaptured = true;
                    console.log('   ✅ 捕获到 anti-content:', this.capturedData.antiContent);
                }

                // 获取请求体（对于POST请求）
                if (request.method() === 'POST') {
                    const postData = request.postData();
                    if (postData) {
                        this.capturedData.orderRequestBody = postData;
                    }
                }

                this.capturedData.orderRequestHeaders = headers;
            }
            // 捕获预估销量查询API的请求
            else if (url.includes(CONFIG.targetApiEndpointPlan)) {
                console.log('\n🎯 捕获到预估销量查询请求:');
                console.log('   URL:', url);
                console.log('   方法:', request.method());

                // 获取请求头
                const headers = request.headers();
                if (headers['anti-content']) {
                    this.capturedData.antiContentPlan = headers['anti-content'];
                    console.log('   ✅ 捕获到 anti-content (预估销量):', this.capturedData.antiContentPlan);
                }
            }
            // 捕获生产日期查询API的请求
            else if (url.includes(CONFIG.targetApiEndpointDate)) {
                console.log('\n🎯 捕获到生产日期查询请求:');
                console.log('   URL:', url);
                console.log('   方法:', request.method());

                // 获取请求头
                const headers = request.headers();
                if (headers['anti-content']) {
                    this.capturedData.antiContentDate = headers['anti-content'];
                    console.log('   ✅ 捕获到 anti-content (生产日期):', this.capturedData.antiContentDate);
                }
            }
            // 继续请求
            request.continue();
        });
    }

    async autoLogin() {
        console.log('\n🔍 检查登录时间间隔...');
        
        const COUNTER_USERNAME = 'global_daily_login_counter';
        let forceLogin = false;
        let lastUpdated = null;
        
        // 计数器检查逻辑
        if (this.supabaseClient) {
            try {
                const { data, error } = await this.supabaseClient
                    .from('pdd_verification_codes')
                    .select('updated_at')
                    .eq('username', COUNTER_USERNAME)
                    .single();
                
                if (error && error.code === 'PGRST116') {
                    // 记录不存在，创建新记录
                    console.log('📝 计数器记录不存在，创建新记录并强制登录');
                    forceLogin = true;
                    lastUpdated = new Date();
                    
                    // 不创建记录，等待登录成功后创建
                        
                } else if (!error && data) {
                    // 记录存在，检查时间间隔
                    lastUpdated = new Date(data.updated_at);
                    const now = new Date();
                    const timeDiff = now.getTime() - lastUpdated.getTime();
                    const eightHours = 8 * 60 * 60 * 1000; // 8小时 = 28,800,000毫秒
                    
                    if (timeDiff > eightHours) {
                        forceLogin = true;
                        console.log(`🔄 需要强制登录：上次强制登录时间 ${lastUpdated.toISOString()} (UTC)，已过去 ${Math.floor(timeDiff/1000/60)} 分钟`);
                    } else {
                        console.log(`⏸️ 不需要强制登录：上次强制登录时间 ${lastUpdated.toISOString()} (UTC)，仅过去 ${Math.floor(timeDiff/1000/60)} 分钟`);
                    }
                } else if (error) {
                    console.log('⚠️ 查询计数器失败:', error.message);
                    forceLogin = true; // 出错时强制登录以确保业务连续性
                    
                    // 尝试创建记录，即使查询失败
                    try {
                        const now = new Date().toISOString();
                        await this.supabaseClient
                            .from('pdd_verification_codes')
                            .upsert({
                                username: COUNTER_USERNAME,
                                code: '强制登录',
                                updated_at: now
                            }, { onConflict: 'username' });
                        console.log(`📝 查询失败，已创建计数器记录: ${now} (UTC)`);
                    } catch (createError) {
                        console.log('⚠️ 创建计数器记录失败:', createError.message);
                    }
                }
            } catch (error) {
                console.log('⚠️ 计数器操作异常:', error.message);
                forceLogin = true;
                
                // 尝试创建记录，即使操作异常
                if (this.supabaseClient) {
                    try {
                        const now = new Date().toISOString();
                        await this.supabaseClient
                            .from('pdd_verification_codes')
                            .upsert({
                                username: COUNTER_USERNAME,
                                code: '强制登录',
                                updated_at: now
                            }, { onConflict: 'username' });
                        console.log(`📝 计数器操作异常，已创建记录: ${now} (UTC)`);
                    } catch (createError) {
                        console.log('⚠️ 创建计数器记录失败:', createError.message);
                    }
                }
            }
        } else {
            console.log('⚠️ Supabase客户端未初始化，无法检查计数器');
            forceLogin = true;
        }
        
        // 如果不需要强制登录，则执行原有会话检查
        if (!forceLogin) {
            console.log('\n🔍 检查现有会话...');

            // 首先尝试直接访问订单管理页面，使用现有cookies
            try {
                await this.page.goto('https://mc.pinduoduo.com/ddmc-mms/order/management', {
                    waitUntil: 'networkidle0',
                    timeout: 15000  // 15秒超时
                });

                // 检查是否成功进入订单管理页面
                const currentUrl = this.page.url();
                console.log(`   当前URL: ${currentUrl}`);
                if (currentUrl.includes('mc.pinduoduo.com/ddmc-mms/order/management')) {
                    console.log('✅ 会话有效，已直接进入订单管理页面');
                    // 等待页面完全稳定，确保任何自动跳转已完成
                    await new Promise(resolve => setTimeout(resolve, 3000));
                    // 再次检查URL，确保仍在订单管理页面
                    const stableUrl = this.page.url();
                    if (!stableUrl.includes('mc.pinduoduo.com/ddmc-mms/order/management')) {
                        console.log(`⚠️  页面跳转到: ${stableUrl}，需要重新登录`);
                        // 继续登录流程
                    } else {
                        console.log(`✅ 页面稳定在订单管理页面`);
                        return true;
                    }
                }
            } catch (error) {
                // 忽略导航错误，继续登录流程
                console.log(`⚠️  会话检查导航错误: ${error.message}`);
            }
        } else {
            console.log('🚀 跳过会话检查，直接执行强制登录流程...');
        }

        console.log('🌐 会话无效或已过期，开始登录流程...');
        console.log('   访问登录页面（带重定向）...');
        let pageLoadRetryCount = 0;
        const maxPageLoadRetries = 3;
        let pageLoaded = false;
        
        while (pageLoadRetryCount < maxPageLoadRetries && !pageLoaded) {
            try {
                // 设置合理的超时时间，避免无限等待
                await this.page.goto(CONFIG.loginUrl, {
                    waitUntil: 'domcontentloaded',
                    timeout: 30000  // 30秒超时
                });
                pageLoaded = true;
                console.log('✅ 登录页面加载成功');
            } catch (error) {
                pageLoadRetryCount++;
                console.log(`⚠️ 页面导航出现问题 (重试 ${pageLoadRetryCount}/${maxPageLoadRetries}):`, error.message);
                if (pageLoadRetryCount < maxPageLoadRetries) {
                    console.log('   ⏳ 等待5秒后重试...');
                    await new Promise(resolve => setTimeout(resolve, 5000));
                } else {
                    console.log('❌ 页面加载失败，达到最大重试次数');
                }
            }
        }
        
        if (!pageLoaded) {
            console.log('❌ 无法加载登录页面，登录失败');
            return false;
        }

        // 页面打开后尝试切换到“账号登录”标签（如果存在）
        try {
            const tabContainer = await this.page.$('.Common_operationTabs__3TW7c');
            if (tabContainer) {
                const items = await this.page.$$('.Common_operationTabs__3TW7c .Common_item__3diIn');
                if (items && items.length >= 2) {
                    // 第二个通常是"账号登录"
                    const secondClass = await this.page.evaluate(el => el.className, items[1]);
                    if (!secondClass || !secondClass.includes('Common_checked__1oLdj')) {
                        await items[1].click().catch(() => {});
                        console.log('   ✅ 已切换到账号登录标签');
                        // 等待表单渲染
                        await new Promise(r => setTimeout(r, 500));
                    }
                }
            }
        } catch (e) {
            // 忽略切换标签时的错误
        }

        const startTime = Date.now();
        const pollInterval = 2000;
        const statusLogInterval = 5000;
        let lastStatusLog = 0;
        
        // 新增：无进展检测和重试机制
        let lastUrl = this.page.url();
        let sameUrlCount = 0;
        const maxSameUrlCount = 30; // 连续30次检查URL无变化（约60秒）则重新加载
        let reloadCount = 0;
        const maxReloadCount = 3; // 最多重新加载3次

        // 持续轮询，直到页面跳转到订单管理页面
        while (true) {
            const currentUrl = this.page.url();
            if (currentUrl.includes('mc.pinduoduo.com/ddmc-mms/order/management')) {
                console.log('✅ 已处于订单管理页面：',currentUrl);
                
                // 如果是强制登录，更新Supabase记录
                if (forceLogin && this.supabaseClient) {
                    try {
                        const now = new Date().toISOString();
                        const { error } = await this.supabaseClient
                            .from('pdd_verification_codes')
                            .upsert({
                                username: COUNTER_USERNAME,
                                code: '强制登录',
                                updated_at: now
                            }, { onConflict: 'username' });
                        
                        if (error) {
                            console.log('⚠️ 更新计数器失败:', error.message);
                        } else {
                            console.log(`✅ 强制登录成功，计数器已更新: ${now} (UTC)`);
                        }
                    } catch (error) {
                        console.log('⚠️ 更新计数器异常:', error.message);
                    }
                }
                
                return true;
            }

            // 检查是否为错误页面（网络错误等）
            if (currentUrl.startsWith('chrome-error://') || 
                currentUrl.startsWith('about:blank') || 
                currentUrl.startsWith('data:') ||
                currentUrl.includes('error') ||
                currentUrl.includes('failed')) {
                console.log(`⚠️  检测到错误页面: ${currentUrl}，尝试重新加载...`);
                try {
                    await this.page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
                    console.log('✅ 错误页面重新加载成功');
                    // 重新加载后等待一段时间再继续
                    await new Promise(resolve => setTimeout(resolve, 3000));
                    continue;
                } catch (reloadError) {
                    console.log('⚠️ 错误页面重新加载失败:', reloadError.message);
                }
            }

            // 检查URL是否有变化
            if (currentUrl === lastUrl) {
                sameUrlCount++;
                // 如果URL长时间无变化，可能是页面卡住了
                if (sameUrlCount >= maxSameUrlCount) {
                    console.log(`⚠️  URL连续${sameUrlCount}次无变化，可能页面卡住，尝试重新加载...`);
                    try {
                        await this.page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
                        console.log('✅ 页面重新加载成功');
                        sameUrlCount = 0;
                        reloadCount++;
                        lastUrl = this.page.url(); // 更新上次URL
                        
                        // 检查是否达到最大重载次数
                        if (reloadCount >= maxReloadCount) {
                            console.log('❌ 达到最大重新加载次数，登录失败');
                            return false;
                        }
                        
                        // 重新加载后等待一段时间再继续
                        await new Promise(resolve => setTimeout(resolve, 3000));
                        continue;
                    } catch (reloadError) {
                        console.log('⚠️ 页面重新加载失败:', reloadError.message);
                        // 继续执行，可能网络有问题
                    }
                }
            } else {
                // URL有变化，重置计数器
                sameUrlCount = 0;
                lastUrl = currentUrl;
                console.log(`   🔄 URL变化: ${currentUrl}`);
            }

            const now = Date.now();
            if (now - lastStatusLog > statusLogInterval) {
                const elapsed = Math.floor((now - startTime) / 1000);
                console.log(`⏳ 等待登录或页面跳转中... 已等待 ${elapsed} 秒。`);
                lastStatusLog = now;
            }

            // 如果出现登录表单，尝试自动填写
            try {
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

                    // 尝试点击登录按钮或按回车
                    try {
                        let loginButton = await this.page.$('button[data-testid="beast-core-button"]');
                        if (!loginButton) {
                            const xpathBtn = await this.page.$x("//button[contains(., '登录')]");
                            if (xpathBtn && xpathBtn.length > 0) loginButton = xpathBtn[0];
                        }

                        if (loginButton) {
                            await loginButton.click().catch(() => {});
                            console.log('   ✅ 尝试点击登录按钮进行自动登录');
                        } else {
                            await this.page.keyboard.press('Enter').catch(() => {});
                            console.log('   ℹ️ 未找到明确的登录按钮，已尝试按 Enter');
                        }
                    } catch (e) {
                        // 忽略点击失败
                    }
                }

                // 检查是否出现验证码输入框（用户提供的元素结构）
                const verificationCodeInput = await this.page.$('input[placeholder="请输入短信验证码"]');
                if (verificationCodeInput) {
                    console.log('📱 检测到验证码输入框，可能需要短信验证码');

                    // 检查确认按钮是否存在
                    const confirmButton = await this.page.$('button[data-tracking-click-viewid="account_login_confirmation"]');

                    let verificationCode = null;

                    // 只从Supabase获取验证码
                    if (this.supabaseClient) {
                        console.log('🔍 从Supabase获取验证码...');
                        try {
                            const { data, error } = await this.supabaseClient
                                .from('pdd_verification_codes')
                                .select('code, updated_at')
                                .eq('username', this.loginCredentials.username)
                                .single();

                            if (!error && data && data.code) {
                                // 检查验证码是否新鲜（10分钟内）
                                const updatedAt = new Date(data.updated_at);
                                const now = new Date();
                                const tenMinutesAgo = new Date(now.getTime() - 10 * 60 * 1000);

                                if (updatedAt > tenMinutesAgo) {
                                    verificationCode = data.code;
                                    console.log(`   🔑 从Supabase获取验证码: ${verificationCode} (更新时间: ${updatedAt.toLocaleString()})`);
                                } else {
                                    console.log(`   ⚠️  Supabase中的验证码已过期 (更新时间: ${updatedAt.toLocaleString()})`);
                                }
                            } else if (error && error.code !== 'PGRST116') { // PGRST116是"未找到行"的错误
                                console.log(`   ⚠️  查询Supabase失败: ${error.message}`);
                            }
                        } catch (e) {
                            console.log(`   ⚠️  从Supabase获取验证码异常: ${e.message}`);
                        }
                    } else {
                        console.log('❌ Supabase客户端未初始化，无法获取验证码');
                        return false;
                    }

                    // 如果没有有效的验证码，等待用户更新（轮询Supabase）
                    if (!verificationCode) {
                        console.log('⏳ 未找到有效验证码，等待用户更新...');
                        console.log('   📝 请更新Supabase表 pdd_verification_codes (字段: username, code)');
                        console.log('   ⏰ 等待120秒（拼多多验证码有效期10分钟）...');

                        const waitStartTime = Date.now();
                        const maxWaitTime = 120000; // 120秒
                        const pollInterval = 5000; // 每5秒检查一次

                        while (Date.now() - waitStartTime < maxWaitTime && !verificationCode) {
                            // 等待一段时间
                            await new Promise(resolve => setTimeout(resolve, pollInterval));

                            console.log(`   🔍 第${Math.floor((Date.now() - waitStartTime) / pollInterval)}次检查更新...`);

                            // 检查Supabase
                            if (this.supabaseClient) {
                                try {
                                    const { data, error } = await this.supabaseClient
                                        .from('pdd_verification_codes')
                                        .select('code, updated_at')
                                        .eq('username', this.loginCredentials.username)
                                        .single();

                                    if (!error && data && data.code) {
                                        // 检查验证码是否新鲜
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

                    // 4. 使用获取到的验证码进行自动填写
                    console.log(`   🔑 使用验证码: ${verificationCode}`);

                    try {
                        // 清空输入框并填写验证码
                        await verificationCodeInput.click({ clickCount: 3 }); // 全选
                        await verificationCodeInput.press('Backspace'); // 删除
                        await verificationCodeInput.type(verificationCode, { delay: 50 });
                        console.log('   ✅ 已输入验证码');

                        // 点击确认按钮
                        if (confirmButton) {
                            await confirmButton.click();
                            console.log('   ✅ 已点击确认按钮');

                            // 等待一段时间（30秒）看看是否自动跳转
                            const verificationCodeWaitStart = Date.now();
                            const maxVerificationCodeWait = 30000; // 30秒

                            while (Date.now() - verificationCodeWaitStart < maxVerificationCodeWait) {
                                // 检查是否已跳转到订单管理页面
                                const currentUrl = this.page.url();
                                if (currentUrl.includes('mc.pinduoduo.com/ddmc-mms/order/management')) {
                                    console.log('✅ 验证码正确，成功跳转到订单管理页面');
                                    
                                    // 如果是强制登录，更新Supabase记录
                                    if (forceLogin && this.supabaseClient) {
                                        try {
                                            const now = new Date().toISOString();
                                            const { error } = await this.supabaseClient
                                                .from('pdd_verification_codes')
                                                .upsert({
                                                    username: COUNTER_USERNAME,
                                                    code: '强制登录',
                                                    updated_at: now
                                                }, { onConflict: 'username' });
                                            
                                            if (error) {
                                                console.log('⚠️ 更新计数器失败:', error.message);
                                            } else {
                                                console.log(`✅ 强制登录成功，计数器已更新: ${now} (UTC)`);
                                            }
                                        } catch (error) {
                                            console.log('⚠️ 更新计数器异常:', error.message);
                                        }
                                    }
                                    
                                    return true;
                                }

                                // 检查是否出现错误提示或验证码输入框是否消失
                                const stillExists = await this.page.$('input[placeholder="请输入短信验证码"]').catch(() => null);
                                if (!stillExists) {
                                    console.log('✅ 验证码输入框已消失，可能已自动处理');
                                    break;
                                }

                                // 检查是否有错误提示
                                const errorElement = await this.page.$('.error-message, .ant-message-error, [class*="error"], [class*="Error"]').catch(() => null);
                                if (errorElement) {
                                    const errorText = await this.page.evaluate(el => el.textContent, errorElement).catch(() => '');
                                    if (errorText.includes('验证码') || errorText.includes('错误') || errorText.includes('不正确')) {
                                        console.log(`❌ 验证码错误: ${errorText}`);
                                        return false;
                                    }
                                }

                                await new Promise(resolve => setTimeout(resolve, 1000));
                            }

                            // 如果30秒后仍然在验证码页面，返回false
                            const stillOnVerificationPage = await this.page.$('input[placeholder="请输入短信验证码"]').catch(() => null);
                            if (stillOnVerificationPage) {
                                console.log('❌ 验证码可能错误或已过期，页面未跳转');
                                return false;
                            }
                        }
                    } catch (e) {
                        console.log('   ⚠️  自动填写验证码失败:', e.message);
                    }

                    // 标记需要验证码
                    this.capturedData.requiresVerificationCode = true;
                }
            } catch (e) {
                // 忽略查询表单时的错误
            }
            // 等待一段时间然后再次检查（设置10分钟超时）
            if (Date.now() - startTime > 5 * 60 * 1000) {
                console.log('❌ 登录超时（5分钟），退出');
                return false;
            }

            await new Promise(resolve => setTimeout(resolve, pollInterval));
        }
    }

    async captureCookies() {
        console.log('\n🍪 捕获Cookies...');

        // 获取所有cookies
        const cookies = await this.page.cookies();
        this.capturedData.allCookies = cookies;

        // 构建cookie字符串
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

        // 等待API请求被捕获 - 增加到15分钟
        const startTime = Date.now();
        const maxWaitTime = 900000; // 15分钟
        let retryCount = 0;
        const maxRetries = 1;

        while (!this.capturedData.antiContent && (Date.now() - startTime) < maxWaitTime) {
            // 检查页面是否仍在订单管理页面
            const currentUrl = this.page.url();
            if (!currentUrl.includes('mc.pinduoduo.com/ddmc-mms/order/management')) {
                console.log(`⚠️  页面已离开订单管理页面，当前URL: ${currentUrl}`);
                if (retryCount < maxRetries) {
                    console.log(`🔄 尝试重新导航到订单管理页面 (重试 ${retryCount + 1}/${maxRetries})...`);
                    try {
                        await this.page.goto('https://mc.pinduoduo.com/ddmc-mms/order/management', {
                            waitUntil: 'networkidle0',
                            timeout: 10000
                        });
                        retryCount++;
                        console.log(`✅ 重新导航成功，继续等待API请求...`);
                        // 继续循环
                        continue;
                    } catch (error) {
                        console.log(`❌ 重新导航失败: ${error.message}`);
                        break;
                    }
                } else {
                    console.log('❌ 超过最大重试次数，停止等待API请求');
                    break;
                }
            }

            // 等待1秒后再次检查
            await new Promise(resolve => setTimeout(resolve, 1000));

            // 每30秒显示一次状态
            const elapsedSeconds = Math.floor((Date.now() - startTime) / 1000);
            if (elapsedSeconds > 0 && elapsedSeconds % 30 === 0) {
                console.log(`   已等待 ${elapsedSeconds} 秒...`);
            }
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

            // 等待API请求
            console.log('⏳ 等待预估销量查询API请求...');
            const startTime = Date.now();
            const maxWaitTime = 300000; // 5分钟
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

            // 等待API请求
            console.log('⏳ 等待生产日期查询API请求...');
            const startTime = Date.now();
            const maxWaitTime = 300000; // 5分钟
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

            // 1. 初始化浏览器
            await this.init();

            // 2. 设置请求拦截
            await this.setupRequestInterception();

            console.log(`\n📝 登录信息: 用户 ${this.loginCredentials.username}`);

            // 3. 自动登录
            const loginSuccess = await this.autoLogin();

            // 4. 检查登录是否成功
            if (!loginSuccess) {
                console.log('❌ 登录失败，程序退出');
                return;
            }

            // 5. 等待API请求，捕获anti-content参数
            const apiCaptured = await this.waitForAPIRequest();

            if (!apiCaptured) {
                throw new Error('未捕获到订单查询API请求，无法获取anti-content参数');
            }

            // 6. 捕获预估销量查询的anti-content
            console.log('\n📊 开始捕获预估销量查询参数...');
            const planCaptured = await this.capturePlanAntiContent();
            if (!planCaptured) {
                console.log('⚠️ 预估销量查询参数捕获失败，继续执行...');
            }

            // 7. 捕获生产日期查询的anti-content
            console.log('\n📅 开始捕获生产日期查询参数...');
            const dateCaptured = await this.captureDateAntiContent();
            if (!dateCaptured) {
                console.log('⚠️ 生产日期查询参数捕获失败，继续执行...');
            }

            // 8. 捕获Cookies
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
async function updateAccount(username, password, verificationCode) {
    console.log(`\n🔄 开始更新账号: ${username}`);
    if (verificationCode) {
        console.log(`   🔑 使用验证码: ${verificationCode}`);
    }

    // 获取Supabase客户端
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !supabaseKey) {
        console.log('❌ Supabase配置缺失，跳过数据上传');
        return;
    }

    const supabase = createClient(supabaseUrl, supabaseKey);

    try {
        // 开始浏览器登录流程
        console.log(`🔍 开始浏览器登录流程...`);
        const crawler = new PDDOrderCrawler({ username, password }, `./puppeteer_user_data/${username}`, verificationCode, supabase);
        await crawler.run();

        // 4. 准备要上传的数据
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

        // 5. 上传到Supabase
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

// 从环境变量获取账号信息
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
            const password = process.env[`PASSWORD_${username.toUpperCase()}`]; // 全大写
            if (!password) {
                console.log(`❌ 账号 ${username} 的密码未设置，跳过`);
                continue;
            }

            // 验证码只从Supabase获取，不传递验证码参数
            await updateAccount(username, password, null);
        }

        console.log('\n🎉 所有账号更新完成');

    } catch (error) {
        console.log('❌ 解析账号信息失败:', error.message);
    }
}

// 执行主函数
main().catch(console.error);