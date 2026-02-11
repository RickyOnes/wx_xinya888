const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { createClient } = require('@supabase/supabase-js');

// 使用反检测插件
puppeteer.use(StealthPlugin());

// 配置常量
const CONFIG = {
    loginUrl: 'https://mms.pinduoduo.com/login/?redirectUrl=https%3A%2F%2Fmc.pinduoduo.com%2Fddmc-mms%2Forder%2Fmanagement',
    targetApiEndpoint: 'cartman-mms/orderManagement/pageQueryDetail',
    
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
            windowsAppShopToken23: null,
            passId: null,
            allCookies: [],
            orderRequestHeaders: null,
            orderRequestBody: null,
            orderResponse: null,
            localStorageData: null,
            sessionStorageData: null,
            apiRequestCaptured: false,
            resultList: null,
            resultListExtracted: false,
            dataSaved: false,
            // 验证码相关字段
            verificationCodeRequest: null,
            verificationCodeRequestHeaders: null,
            verificationCodeResponse: null,
            verificationCodeJson: null,
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
                    console.log('   ✅ 捕获到 anti-content:', this.capturedData.antiContent.substring(0, 50) + '...');
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
            
            // 捕获登录验证码请求
            if (url.includes('janus/api/user/getLoginVerificationCode')) {
                console.log('\n📱 捕获到登录验证码请求:');
                console.log('   URL:', url);
                console.log('   方法:', request.method());
                console.log('   请求头:', JSON.stringify(request.headers(), null, 2));
                
                // 获取请求体
                if (request.method() === 'POST') {
                    const postData = request.postData();
                    if (postData) {
                        console.log('   请求体:', postData);
                        this.capturedData.verificationCodeRequest = postData;
                    }
                }
                
                // 保存请求信息
                this.capturedData.verificationCodeRequestHeaders = request.headers();
            }
            
            // 继续请求
            request.continue();
        });
        
        // 监听响应
        this.page.on('response', async (response) => {
            const url = response.url();
            
            // 捕获订单查询API响应
            if (url.includes(CONFIG.targetApiEndpoint)) {
                console.log('\n📊 订单查询响应状态:', response.status());
                try {
                    const responseData = await response.text();
                    console.log('   响应数据长度:', responseData.length);
                    // 保存响应数据
                    this.capturedData.orderResponse = responseData;
                    
                    // 尝试解析为JSON并提取resultList
                    try {
                        const jsonResponse = JSON.parse(responseData);
                        
                        // 提取resultList字段
                        if (jsonResponse.result && jsonResponse.result.resultList && Array.isArray(jsonResponse.result.resultList)) {
                            this.capturedData.resultList = jsonResponse.result.resultList;
                            this.capturedData.resultListExtracted = true;
                            console.log(`   ✅ 提取到resultList，包含 ${jsonResponse.result.resultList.length} 条数据`);
                        } else if (jsonResponse.resultList && Array.isArray(jsonResponse.resultList)) {
                            this.capturedData.resultList = jsonResponse.resultList;
                            this.capturedData.resultListExtracted = true;
                            console.log(`   ✅ 提取到resultList，包含 ${jsonResponse.resultList.length} 条数据`);
                        } else {
                            console.log('   ⚠️  响应中未找到resultList字段或不是数组');
                            this.capturedData.resultListExtracted = true;
                        }
                    } catch (e) {
                        this.capturedData.resultListExtracted = true;
                    }
                } catch (e) {
                    console.log('   无法获取响应数据:', e.message);
                    this.capturedData.resultListExtracted = true;
                }
            }
            
            // 捕获登录验证码响应
            if (url.includes('janus/api/user/getLoginVerificationCode')) {
                console.log('\n📱 登录验证码响应状态:', response.status());
                try {
                    const responseData = await response.text();
                    console.log('   响应数据长度:', responseData.length);
                    console.log('   响应内容:', responseData);
                    
                    // 保存响应数据
                    this.capturedData.verificationCodeResponse = responseData;
                    
                    // 尝试解析为JSON
                    try {
                        const jsonResponse = JSON.parse(responseData);
                        console.log('   ✅ 验证码响应JSON解析成功:');
                        console.log('      success:', jsonResponse.success);
                        console.log('      errorCode:', jsonResponse.errorCode);
                        console.log('      errorMsg:', jsonResponse.errorMsg);
                        console.log('      result:', jsonResponse.result);
                        
                        // 保存解析后的数据
                        this.capturedData.verificationCodeJson = jsonResponse;
                        
                        // 如果响应表明需要验证码，记录该信息
                        if (jsonResponse.success === true && jsonResponse.result === null) {
                            console.log('   ⚠️  响应表明需要验证码（result为null），可能需要手动输入');
                            this.capturedData.requiresVerificationCode = true;
                        }
                    } catch (e) {
                        console.log('   ⚠️  响应不是有效的JSON格式');
                    }
                } catch (e) {
                    console.log('   无法获取验证码响应数据:', e.message);
                }
            }
        });
    }

    async autoLogin() {
        console.log('\n🌐 访问登录页面（带重定向）...');
        try {
            // 不设超时，初次加载可能很慢
            await this.page.goto(CONFIG.loginUrl, {
                waitUntil: 'domcontentloaded',
                timeout: 0
            });
        } catch (error) {
            console.log('⚠️ 页面导航出现问题，但继续等待...:', error.message);
        }

        // 页面打开后尝试切换到“账号登录”标签（如果存在）
        try {
            const tabContainer = await this.page.$('.Common_operationTabs__3TW7c');
            if (tabContainer) {
                const items = await this.page.$$('.Common_operationTabs__3TW7c .Common_item__3diIn');
                if (items && items.length >= 2) {
                    // 第二个通常是“账号登录”
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

        // 持续轮询，直到页面跳转到订单管理页面
        while (true) {
            const currentUrl = this.page.url();
            if (currentUrl.includes('mc.pinduoduo.com/ddmc-mms/order/management')) {
                console.log('✅ 已处于订单管理页面，可能已自动登录');
                return true;
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

            // 等待一段时间然后再次检查（设置30分钟超时）
            if (Date.now() - startTime > 15 * 60 * 1000) {
                console.log('❌ 登录超时（15分钟），退出');
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
        
        // 查找特定的cookie
        let foundShopToken = false;
        let foundPassId = false;
        
        for (const cookie of cookies) {
            if (cookie.name === 'windows_app_shop_token_23') {
                this.capturedData.windowsAppShopToken23 = cookie.value;
                foundShopToken = true;
                console.log(`   ✅ 捕获到 windows_app_shop_token_23 (长度: ${cookie.value.length})`);
            }
            if (cookie.name === 'PASS_ID') {
                this.capturedData.passId = cookie.value;
                foundPassId = true;
                console.log(`   ✅ 捕获到 PASS_ID (长度: ${cookie.value.length})`);
            }
        }
        
        if (!foundShopToken) {
            console.log('   ⚠️  未找到 windows_app_shop_token_23');
            // 尝试从localStorage获取
            const shopTokenFromStorage = await this.page.evaluate(() => {
                try {
                    return localStorage.getItem('windows_app_shop_token_23') || 
                           sessionStorage.getItem('windows_app_shop_token_23');
                } catch (e) {
                    return null;
                }
            });
            
            if (shopTokenFromStorage) {
                this.capturedData.windowsAppShopToken23 = shopTokenFromStorage;
                console.log('   ✅ 从localStorage捕获到 windows_app_shop_token_23');
            }
        }
        
        if (!foundPassId) {
            console.log('   ⚠️  未找到 PASS_ID');
        }
        
        // 构建cookie字符串
        let cookieStr = '';
        cookies.forEach((cookie, index) => {
            if (index > 0) cookieStr += '; ';
            cookieStr += `${cookie.name}=${cookie.value}`;
        });
        this.capturedData.cookieString = cookieStr;
        
        return cookies;
    }

    async waitForAPIRequest() {
        console.log('\n⏳ 等待页面自动发送订单查询请求...');
        
        // 等待API请求被捕获
        const startTime = Date.now();
        const maxWaitTime = CONFIG.timeouts.apiRequest;
        
        while (!this.capturedData.apiRequestCaptured && (Date.now() - startTime) < maxWaitTime) {
            // 检查页面是否仍在订单管理页面
            const currentUrl = this.page.url();
            if (!currentUrl.includes('mc.pinduoduo.com/ddmc-mms/order/management')) {
                console.log('⚠️  页面已离开订单管理页面，停止等待API请求');
                break;
            }
            
            // 等待1秒后再次检查
            await new Promise(resolve => setTimeout(resolve, 1000));
            
            // 每10秒显示一次状态
            const elapsedSeconds = Math.floor((Date.now() - startTime) / 1000);
            if (elapsedSeconds > 0 && elapsedSeconds % 10 === 0) {
                console.log(`   已等待 ${elapsedSeconds} 秒...`);
            }
        }
        
        if (this.capturedData.apiRequestCaptured) {
            console.log('✅ 已捕获到订单查询API请求');
            return true;
        } else {
            console.log(`❌ 在 ${maxWaitTime/1000} 秒内未捕获到API请求`);
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
            
            // 4. 无论登录成功与否，都捕获cookies和输出信息
            await this.captureCookies();
            
            // 输出关键信息（包括验证码响应）
            console.log('\n📋 关键信息汇总:');
            console.log('='.repeat(50));
            
            if (this.capturedData.antiContent) {
                console.log('ANTI-CONTENT (前100字符):');
                console.log(this.capturedData.antiContent.substring(0, 100) + '...');
            } else {
                console.log('ANTI-CONTENT: 未捕获到');
            }
            
            console.log('\n' + '='.repeat(50));
            
            if (this.capturedData.windowsAppShopToken23) {
                console.log('WINDOWS_APP_SHOP_TOKEN_23 (前100字符):');
                console.log(this.capturedData.windowsAppShopToken23.substring(0, 100) + '...');
            } else {
                console.log('WINDOWS_APP_SHOP_TOKEN_23: 未捕获到');
            }
            
            console.log('\n' + '='.repeat(50));
            
            if (this.capturedData.passId) {
                console.log('PASS_ID (前100字符):');
                console.log(this.capturedData.passId.substring(0, 100) + '...');
            } else {
                console.log('PASS_ID: 未捕获到');
            }
            
            console.log('\n' + '='.repeat(50));
            
            // 验证码响应信息
            if (this.capturedData.verificationCodeResponse) {
                console.log('📱 验证码响应:');
                console.log('   响应数据长度:', this.capturedData.verificationCodeResponse.length);
                console.log('   响应内容:', this.capturedData.verificationCodeResponse);
                
                if (this.capturedData.verificationCodeJson) {
                    const json = this.capturedData.verificationCodeJson;
                    console.log('   JSON解析结果:');
                    console.log('     success:', json.success);
                    console.log('     errorCode:', json.errorCode);
                    console.log('     errorMsg:', json.errorMsg);
                    console.log('     result:', json.result);
                }
                
                if (this.capturedData.requiresVerificationCode) {
                    console.log('   ⚠️  需要验证码: 响应表明需要短信验证码');
                }
            } else {
                console.log('📱 验证码响应: 未捕获到');
            }
            
            console.log('='.repeat(50));
            
            // 5. 等待API请求（注释掉）
            // const apiCaptured = await this.waitForAPIRequest();
            
            // 检查登录是否成功
            if (!loginSuccess) {
                console.log('❌ 登录失败，程序退出');
                return;
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
            windows_app_shop_token_23: crawler.capturedData.windowsAppShopToken23,
            pass_id: crawler.capturedData.passId,
            cookie_string: crawler.capturedData.cookieString,
            expires_at: new Date(Date.now() + 20 * 60 * 60 * 1000).toISOString(),
            last_success: true
        };
        
        // 5. 上传到Supabase
        const { data, error } = await supabase
            .from('pdd_accounts')
            .upsert(accountData, { onConflict: 'username' });
            
        if (error) {
            console.log(`❌ 上传失败: ${error.message}`);
        } else {
            console.log(`✅ 账号 ${username} 数据已更新到Supabase`);
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
