const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { createClient } = require('@supabase/supabase-js');

// 使用反检测插件
puppeteer.use(StealthPlugin());

// 配置常量 - 只保留预估销量查询相关配置
const CONFIG = {
    // 预估销量查询API端点
    targetApiEndpointPlan: 'cartman-mms/appointment/queryAppointmentGoodsList',
    
    // 预估销量查询页面URL
    planPageUrl: 'https://mc.pinduoduo.com/ddmc-mms/appointment-delivery',
    
    // 直接登录URL（登录后重定向到预估销量页面）
    directLoginUrl: 'https://mms.pinduoduo.com/login/?redirectUrl=https%3A%2F%2Fmc.pinduoduo.com%2Fddmc-mms%2Fappointment-delivery',
    
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
    
    // 等待超时配置（毫秒）- 尽可能缩短以减少用户等待时间
    timeouts: {
        pageLoad: 8000,           // 8秒页面加载超时
        apiRequest: 10000,        // 10秒API请求等待超时（5分钟有效期，需要快速获取）
        loginWait: 20000,         // 20秒登录等待超时
    }
};

class PDDAntiContentPlanCrawler {
    constructor(loginCredentials, userDataDir, supabaseClient) {
        this.browser = null;
        this.page = null;
        this.capturedData = {
            antiContentPlan: null,
        };
        this.loginCredentials = loginCredentials || { username: 'wangxh03', password: '' };
        this.userDataDir = userDataDir || `./puppeteer_user_data/${this.loginCredentials.username}`;
        this.supabaseClient = supabaseClient || null;
    }

    async init() {
        console.log('🚀 启动浏览器（复用用户数据目录）...');
        console.log(`   📁 用户数据目录: ${this.userDataDir}`);
        
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
    }

    async setupRequestInterception() {
        // 启用请求拦截
        await this.page.setRequestInterception(true);
        
        this.page.on('request', async (request) => {
            const url = request.url();
            
            // 只捕获预估销量查询API的请求
            if (url.includes(CONFIG.targetApiEndpointPlan)) {
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
            // 继续请求
            request.continue();
        });
    }

    async checkAndLogin() {
        console.log('\n🔍 尝试直接访问预估销量页面...');
        
        try {
            // 尝试直接访问预估销量页面
            await this.page.goto(CONFIG.planPageUrl, {
                waitUntil: 'domcontentloaded',
                timeout: CONFIG.timeouts.pageLoad
            });
            
            const currentUrl = this.page.url();
            console.log(`   当前URL: ${currentUrl}`);
            
            // 检查是否成功进入预估销量页面
            if (currentUrl.includes('mc.pinduoduo.com/ddmc-mms/appointment-delivery')) {
                console.log('✅ 会话有效，已直接进入预估销量页面');
                // 等待3秒，确保没有发生重定向
                await new Promise(resolve => setTimeout(resolve, 3000));
                const finalUrl = this.page.url();
                if (finalUrl.includes('mc.pinduoduo.com/ddmc-mms/appointment-delivery')) {
                    console.log('✅ 会话稳定，仍在预估销量页面');
                    return true;
                } else {
                    console.log(`⚠️  页面已重定向到: ${finalUrl}`);
                    // 页面已跳转到登录页面，直接处理登录
                    if (finalUrl.includes('mms.pinduoduo.com/login/')) {
                        console.log('📝 检测到登录页面，尝试自动登录...');
                        return await this.fillLoginFormAndSubmit();
                    }
                }
            }
            
            // 如果不在预估销量页面，检查当前是否已经在登录页面
            if (currentUrl.includes('mms.pinduoduo.com/login/')) {
                console.log('📝 当前已在登录页面，尝试自动登录...');
                return await this.fillLoginFormAndSubmit();
            }
            
            // 如果既不是预估销量页面也不是登录页面，尝试使用直接登录URL
            console.log('⚠️  当前不在预估销量页面，尝试使用直接登录URL...');
            await this.page.goto(CONFIG.directLoginUrl, {
                waitUntil: 'domcontentloaded',
                timeout: CONFIG.timeouts.pageLoad
            });
            
            // 使用统一的登录处理方法
            return await this.fillLoginFormAndSubmit();
            
        } catch (error) {
            console.log(`⚠️  页面访问或登录失败: ${error.message}`);
            
            // 在异常时截图以便调试
            try {
                if (this.page && !this.page.isClosed()) {
                    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
                    const username = this.loginCredentials.username || 'unknown';
                    const screenshotPath = `./debug-check-login-error-${username}-${timestamp}.png`;
                    await this.page.screenshot({ path: screenshotPath, fullPage: false });
                    console.log(`   📸 已保存错误截图: ${screenshotPath}`);
                }
            } catch (screenshotError) {
                console.log('   ⚠️  截图失败:', screenshotError.message);
            }
            
            return false;
        }
    }

    // 在登录页面填写表单并提交
    async fillLoginFormAndSubmit() {
        console.log('📝 检测到登录页面，尝试自动填写登录表单...');
        
        try {
            // 等待页面完全加载
            await this.page.waitForSelector('body', { timeout: 5000 }).catch(() => {
                console.log('   ⚠️  页面加载较慢，继续执行...');
            });
            
            // 检查是否已经跳转到目标页面
            const currentUrl = this.page.url();
            if (currentUrl.includes('mc.pinduoduo.com/ddmc-mms/appointment-delivery')) {
                console.log('✅ 登录成功，已进入预估销量页面');
                return true;
            }
            
            // 等待登录表单出现
            console.log('   ⏳ 等待登录表单加载...');
            const usernameInput = await this.page.waitForSelector('#usernameId', { timeout: 5000 }).catch(() => null);
            const passwordInput = await this.page.waitForSelector('#passwordId', { timeout: 5000 }).catch(() => null);
            
            if (!usernameInput || !passwordInput) {
                console.log('❌ 未找到登录表单元素，登录失败');
                return false;
            }
            
            console.log('   ✅ 登录表单已加载');
            
            // 填写用户名 - 尝试多种方式
            console.log('   ⏳ 填写用户名...');
            let usernameFilled = false;
            const username = this.loginCredentials.username;
            
            // 方式1: 直接使用type方法（最自然的方式）
            try {
                await usernameInput.type(username, { delay: 30 });
                console.log('   ✅ 已输入用户名 (方式1)');
                usernameFilled = true;
            } catch (e) {
                console.log('   ⚠️  方式1失败:', e.message);
            }
            
            // 方式2: 使用JavaScript设置value属性
            if (!usernameFilled) {
                try {
                    await this.page.evaluate((input, value) => {
                        input.value = value;
                        input.dispatchEvent(new Event('input', { bubbles: true }));
                        input.dispatchEvent(new Event('change', { bubbles: true }));
                    }, usernameInput, username);
                    console.log('   ✅ 已输入用户名 (方式2: JS设置)');
                    usernameFilled = true;
                } catch (e) {
                    console.log('   ⚠️  方式2失败:', e.message);
                }
            }
            
            // 方式3: 使用focus后type
            if (!usernameFilled) {
                try {
                    await usernameInput.focus();
                    await this.page.keyboard.type(username, { delay: 30 });
                    console.log('   ✅ 已输入用户名 (方式3: 键盘输入)');
                    usernameFilled = true;
                } catch (e) {
                    console.log('   ⚠️  方式3失败:', e.message);
                }
            }
            
            if (!usernameFilled) {
                console.log('❌ 无法填写用户名，登录失败');
                return false;
            }
            
            // 填写密码 - 尝试多种方式
            console.log('   ⏳ 填写密码...');
            let passwordFilled = false;
            const password = this.loginCredentials.password;
            
            // 方式1: 直接使用type方法
            try {
                await passwordInput.type(password, { delay: 30 });
                console.log('   ✅ 已输入密码 (方式1)');
                passwordFilled = true;
            } catch (e) {
                console.log('   ⚠️  方式1失败:', e.message);
            }
            
            // 方式2: 使用JavaScript设置value属性
            if (!passwordFilled) {
                try {
                    await this.page.evaluate((input, value) => {
                        input.value = value;
                        input.dispatchEvent(new Event('input', { bubbles: true }));
                        input.dispatchEvent(new Event('change', { bubbles: true }));
                    }, passwordInput, password);
                    console.log('   ✅ 已输入密码 (方式2: JS设置)');
                    passwordFilled = true;
                } catch (e) {
                    console.log('   ⚠️  方式2失败:', e.message);
                }
            }
            
            // 方式3: 使用focus后type
            if (!passwordFilled) {
                try {
                    await passwordInput.focus();
                    await this.page.keyboard.type(password, { delay: 30 });
                    console.log('   ✅ 已输入密码 (方式3: 键盘输入)');
                    passwordFilled = true;
                } catch (e) {
                    console.log('   ⚠️  方式3失败:', e.message);
                }
            }
            
            if (!passwordFilled) {
                console.log('❌ 无法填写密码，登录失败');
                return false;
            }
            
            // 尝试多种方式找到并点击登录按钮
            let loginButton = null;
            
            // 方式1: 通过data-testid属性
            loginButton = await this.page.$('button[data-testid="beast-core-button"]');
            
            // 方式2: 通过文本内容
            if (!loginButton) {
                const loginButtons = await this.page.$x("//button[contains(., '登录')]");
                if (loginButtons.length > 0) {
                    loginButton = loginButtons[0];
                }
            }
            
            // 方式3: 通过type属性
            if (!loginButton) {
                loginButton = await this.page.$('button[type="submit"]');
            }
            
            // 方式4: 通过class名称
            if (!loginButton) {
                loginButton = await this.page.$('.login-btn, .submit-btn, .ant-btn-primary');
            }
            
            if (loginButton) {
                console.log('   ✅ 找到登录按钮，尝试点击...');
                
                // 尝试多种点击方式
                try {
                    // 方式1: 直接点击
                    await loginButton.click();
                    console.log('   ✅ 已点击登录按钮');
                } catch (clickError) {
                    console.log('   ⚠️  直接点击失败，尝试JavaScript点击:', clickError.message);
                    try {
                        // 方式2: 通过JavaScript点击
                        await this.page.evaluate(btn => btn.click(), loginButton);
                        console.log('   ✅ 通过JavaScript点击登录按钮');
                    } catch (jsError) {
                        console.log('   ⚠️  JavaScript点击失败:', jsError.message);
                        try {
                            // 方式3: 提交表单
                            await this.page.evaluate(() => {
                                const form = document.querySelector('form');
                                if (form) form.submit();
                            });
                            console.log('   ✅ 尝试提交表单');
                        } catch (formError) {
                            console.log('   ⚠️  提交表单失败:', formError.message);
                        }
                    }
                }
            } else {
                console.log('   ⚠️  未找到登录按钮，尝试通过回车键提交');
                // 尝试按回车键提交表单
                await passwordInput.press('Enter');
            }
            
            // 等待登录完成，检查是否跳转到目标页面
            console.log('   ⏳ 等待登录完成...');
            const loginStartTime = Date.now();
            const loginTimeout = CONFIG.timeouts.loginWait; // 20秒
            
            while (Date.now() - loginStartTime < loginTimeout) {
                await new Promise(resolve => setTimeout(resolve, 1000));
                const newUrl = this.page.url();
                
                if (newUrl.includes('mc.pinduoduo.com/ddmc-mms/appointment-delivery')) {
                    console.log('✅ 登录成功，已进入预估销量页面');
                    return true;
                }
                
                // 检查是否需要验证码
                const verificationCodeInput = await this.page.$('input[placeholder="请输入短信验证码"]');
                if (verificationCodeInput) {
                    console.log('❌ 检测到需要验证码，快速脚本无法处理，退出');
                    return false;
                }
                
                // 检查是否有错误消息（提前退出）
                const errorSelectors = [
                    '.error-message', 
                    '.ant-form-item-explain-error',
                    '[data-testid="error-message"]',
                    'div[role="alert"]',
                    'div.error',
                    'div.fail',
                    'span.error',
                    '.ant-message-error' // Ant Design错误消息
                ];
                
                let hasError = false;
                for (const selector of errorSelectors) {
                    const errorElement = await this.page.$(selector);
                    if (errorElement) {
                        const errorText = await this.page.evaluate(el => el.textContent?.trim(), errorElement);
                        if (errorText && errorText.length > 0) {
                            console.log(`❌ 发现登录错误: ${errorText}`);
                            hasError = true;
                            break;
                        }
                    }
                }
                
                if (hasError) {
                    console.log('❌ 登录失败，发现错误消息');
                    return false;
                }
                
                // 检查是否仍在登录页面
                if (!newUrl.includes('mms.pinduoduo.com/login/')) {
                    console.log(`   🔄 页面已跳转: ${newUrl}`);
                    // 如果不是登录页面，继续等待
                }
                
                // 显示剩余等待时间
                const elapsed = Math.floor((Date.now() - loginStartTime) / 1000);
                const remaining = Math.floor((loginTimeout - (Date.now() - loginStartTime)) / 1000);
                if (remaining % 5 === 0) { // 每5秒打印一次
                    console.log(`   ⏰ 已等待 ${elapsed} 秒，剩余 ${remaining} 秒`);
                }
            }
            
            console.log('❌ 登录超时，未成功跳转到目标页面');
            
            // 检查是否有错误消息
            console.log('   🔍 检查登录错误信息...');
            try {
                // 检查常见的错误消息选择器
                const errorSelectors = [
                    '.error-message', 
                    '.ant-form-item-explain-error',
                    '[data-testid="error-message"]',
                    'div[role="alert"]',
                    'div.error',
                    'div.fail',
                    'span.error'
                ];
                
                let foundError = false;
                for (const selector of errorSelectors) {
                    const errorElement = await this.page.$(selector);
                    if (errorElement) {
                        const errorText = await this.page.evaluate(el => el.textContent.trim(), errorElement);
                        if (errorText && errorText.length > 0) {
                            console.log(`   ⚠️  发现错误消息 (${selector}): ${errorText}`);
                            foundError = true;
                        }
                    }
                }
                
                // 检查页面标题或h1标签中是否包含"登录失败"等关键词
                const pageTitle = await this.page.title();
                if (pageTitle.includes('失败') || pageTitle.includes('错误') || pageTitle.includes('登录失败')) {
                    console.log(`   ⚠️  页面标题提示失败: ${pageTitle}`);
                    foundError = true;
                }
                
                if (!foundError) {
                    console.log('   ℹ️  未发现明显的错误消息，可能是网络问题或需要额外验证');
                }
            } catch (errorCheckError) {
                console.log('   ⚠️  检查错误信息时出错:', errorCheckError.message);
            }
            
            // 在失败时截图以便调试
            try {
                const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
                const screenshotPath = `./debug-login-failed-${this.loginCredentials.username}-${timestamp}.png`;
                await this.page.screenshot({ path: screenshotPath, fullPage: false });
                console.log(`   📸 已保存失败截图: ${screenshotPath}`);
                console.log(`   💡 截图路径: ${screenshotPath}`);
                console.log(`   💡 在本地运行时，可以在当前工作目录找到此文件`);
                console.log(`   💡 在GitHub Actions中，可以通过Artifacts下载截图`);
            } catch (screenshotError) {
                console.log('   ⚠️  截图失败:', screenshotError.message);
            }
            
            return false;
            
        } catch (error) {
            console.log(`❌ 登录过程中出错: ${error.message}`);
            
            // 在异常时截图以便调试
            try {
                const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
                const screenshotPath = `./debug-login-error-${this.loginCredentials.username}-${timestamp}.png`;
                await this.page.screenshot({ path: screenshotPath, fullPage: false });
                console.log(`   📸 已保存错误截图: ${screenshotPath}`);
            } catch (screenshotError) {
                console.log('   ⚠️  截图失败:', screenshotError.message);
            }
            
            return false;
        }
    }

    async capturePlanAntiContent() {
        console.log('\n⏳ 等待预估销量查询API请求...');
        const startTime = Date.now();
        const maxWaitTime = CONFIG.timeouts.apiRequest;
        
        while (!this.capturedData.antiContentPlan && (Date.now() - startTime) < maxWaitTime) {
            await new Promise(resolve => setTimeout(resolve, 500)); // 更频繁的检查
            
            // 检查当前URL是否仍在预估销量页面
            const currentUrl = this.page.url();
            if (!currentUrl.includes('mc.pinduoduo.com/ddmc-mms/appointment-delivery')) {
                console.log('⚠️  页面已离开预估销量页面，当前URL:', currentUrl);
                
                // 如果跳转到登录页面，说明会话已过期，快速失败
                if (currentUrl.includes('mms.pinduoduo.com/login/')) {
                    console.log('❌ 会话已过期，在等待API请求期间跳转到登录页面');
                    return false;
                }
                
                // 其他情况，重新访问目标页面（快速重试）
                console.log('   🔄 重新访问预估销量页面...');
                try {
                    await this.page.goto(CONFIG.planPageUrl, {
                        waitUntil: 'domcontentloaded',
                        timeout: 3000 // 更短的超时
                    });
                } catch (refreshError) {
                    console.log('   ⚠️  重新访问失败:', refreshError.message);
                }
            }
        }
        
        if (this.capturedData.antiContentPlan) {
            console.log(`✅ 已捕获到预估销量查询API请求，获取到anti-content（长度: ${this.capturedData.antiContentPlan.length}）`);
            return true;
        } else {
            console.log(`❌ 在 ${maxWaitTime/1000} 秒内未捕获到预估销量查询API请求`);
            return false;
        }
    }

    async run() {
        try {
            console.log('🎬 开始执行预估销量anti-content快速捕获脚本');
            
            // 1. 初始化浏览器
            await this.init();
            
            // 2. 设置请求拦截
            await this.setupRequestInterception();
            
            console.log(`\n📝 目标账号: ${this.loginCredentials.username}`);
            
            // 3. 检查会话并登录
            const loginSuccess = await this.checkAndLogin();
            
            if (!loginSuccess) {
                throw new Error('登录失败，无法继续执行');
            }
            
            // 4. 捕获预估销量查询的anti-content
            const planCaptured = await this.capturePlanAntiContent();
            
            if (!planCaptured) {
                throw new Error('未捕获到预估销量查询API请求，无法获取anti-content参数');
            }
            
            console.log('✅ 预估销量anti-content捕获成功');
            
        } catch (error) {
            console.error('❌ 脚本执行出错:', error.message);
            throw error;
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

// 更新数据库函数 - 只更新anti_content_Plan字段
async function updatePlanAntiContent(username, antiContentPlan) {
    console.log(`\n🔄 更新账号 ${username} 的预估销量anti-content...`);
    
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    
    if (!supabaseUrl || !supabaseKey) {
        console.log('❌ Supabase配置缺失，跳过数据上传');
        return;
    }
    
    const supabase = createClient(supabaseUrl, supabaseKey);
    
    try {
        // 准备要上传的数据 - 只更新anti_content_Plan和updated_at
        const accountData = {
            username,
            anti_content_Plan: antiContentPlan,
            updated_at: new Date().toISOString(),
        };
        
        // 上传到Supabase
        const { error } = await supabase
            .from('pdd_accounts')
            .upsert(accountData, { onConflict: 'username' });
            
        if (error) {
            console.log(`❌ 上传失败: ${error.message}`);
            throw error;
        } else {
            console.log(`✅ 账号 ${username} 的预估销量anti-content已更新到Supabase`);
        }
        
    } catch (error) {
        console.log(`❌ 更新账号 ${username} 失败:`, error.message);
        throw error;
    }
}

// 主函数 - 处理所有账号
async function main() {
    const accountsJson = process.env.PDD_ACCOUNTS_JSON;
    if (!accountsJson) {
        console.log('❌ PDD_ACCOUNTS_JSON环境变量未设置');
        return;
    }
    
    try {
        const accounts = JSON.parse(accountsJson).accounts;
        
        if (!accounts || accounts.length === 0) {
            console.log('❌ 账号列表为空');
            return;
        }
        
        console.log(`📋 开始处理 ${accounts.length} 个账号`);
        
        // 依次处理每个账号
        for (const account of accounts) {
            const username = account.username;
            const password = process.env[`PASSWORD_${username.toUpperCase()}`];
            
            if (!password) {
                console.log(`\n⚠️  账号 ${username} 的密码未设置，跳过`);
                continue;
            }
            
            console.log(`\n📝 处理账号: ${username}`);
            
            // 获取Supabase客户端
            const supabaseUrl = process.env.SUPABASE_URL;
            const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
            
            if (!supabaseUrl || !supabaseKey) {
                console.log('❌ Supabase配置缺失，跳过此账号');
                continue;
            }
            
            const supabase = createClient(supabaseUrl, supabaseKey);
            
            // 创建爬虫实例
            const crawler = new PDDAntiContentPlanCrawler(
                { username, password }, 
                `./puppeteer_user_data/${username}`, 
                supabase
            );
            
            // 执行捕获
            await crawler.run();
            
            // 如果捕获成功，更新数据库
            if (crawler.capturedData.antiContentPlan) {
                await updatePlanAntiContent(username, crawler.capturedData.antiContentPlan);
            } else {
                console.log('❌ 未获取到anti-content，跳过数据库更新');
            }
            
            console.log(`✅ 账号 ${username} 处理完成`);
        }
        
        console.log('\n🎉 所有账号预估销量anti-content更新完成');
        
    } catch (error) {
        console.log('❌ 执行失败:', error.message);
        console.error(error.stack);
        process.exit(1);
    }
}

// 执行主函数
if (require.main === module) {
    main().catch(console.error);
}

module.exports = { PDDAntiContentPlanCrawler, updatePlanAntiContent };