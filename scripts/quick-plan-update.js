const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { createClient } = require('@supabase/supabase-js');

// 使用反检测插件
puppeteer.use(StealthPlugin());

// 配置常量
const CONFIG = {
    // 直接访问预估销量页面的URL
    planDirectUrl: 'https://mc.pinduoduo.com/ddmc-mms/appointment-delivery',
    // 登录后跳转到预估销量页面的URL
    planLoginUrl: 'https://mms.pinduoduo.com/login/?redirectUrl=https%3A%2F%2Fmc.pinduoduo.com%2Fddmc-mms%2Fappointment-delivery',
    // 目标API端点
    targetApiEndpointPlan: 'cartman-mms/appointment/queryAppointmentGoodsList',

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

class PDDPlanAntiContentFetcher {
    constructor(loginCredentials, userDataDir, supabaseClient) {
        this.browser = null;
        this.page = null;
        this.capturedData = {
            antiContentPlan: null,
            apiRequestCaptured: false
        };
        this.loginCredentials = loginCredentials || { username: 'wangxh03', password: '' };
        this.userDataDir = userDataDir || './puppeteer_user_data/default';
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

            // 捕获预估销量查询API的请求
            if (url.includes(CONFIG.targetApiEndpointPlan)) {
                console.log('\n🎯 捕获到预估销量查询请求:');
                console.log('   URL:', url);
                console.log('   方法:', request.method());

                // 获取请求头
                const headers = request.headers();
                if (headers['anti-content']) {
                    this.capturedData.antiContentPlan = headers['anti-content'];
                    this.capturedData.apiRequestCaptured = true;
                    console.log('   ✅ 捕获到 anti-content (预估销量):', this.capturedData.antiContentPlan);
                }

                // 继续请求
                request.continue();
                return;
            }

            // 其他请求继续
            request.continue();
        });
    }

    async tryDirectAccess() {
        console.log('\n🔍 尝试直接访问预估销量页面...');
        console.log(`📝 导航到: ${CONFIG.planDirectUrl}`);
        
        try {
            await this.page.goto(CONFIG.planDirectUrl, {
                waitUntil: 'domcontentloaded',
                timeout: CONFIG.timeouts.pageLoad
            });
            console.log('✅ 页面加载成功');

            // 等待API请求
            console.log('⏳ 等待预估销量查询API请求（直接访问）...');
            const startTime = Date.now();
            const maxWaitTime = 60000; // 1分钟
            while (!this.capturedData.antiContentPlan && (Date.now() - startTime) < maxWaitTime) {
                await new Promise(resolve => setTimeout(resolve, 1000));
                const elapsedSeconds = Math.floor((Date.now() - startTime) / 1000);
                if (elapsedSeconds > 0 && elapsedSeconds % 10 === 0) {
                    console.log(`   已等待 ${elapsedSeconds} 秒...`);
                }
            }

            if (this.capturedData.antiContentPlan) {
                console.log(`✅ 直接访问成功，获取到anti-content（长度: ${this.capturedData.antiContentPlan.length}）`);
                return true;
            } else {
                console.log('❌ 直接访问未捕获到API请求，可能需要登录');
                return false;
            }
        } catch (error) {
            console.log('⚠️ 直接访问页面失败:', error.message);
            return false;
        }
    }

    async autoLogin() {
        console.log('\n🌐 开始登录流程，跳转到预估销量页面...');
        
        try {
            // 1. 访问登录页面（跳转到预估销量页面）
            console.log(`📝 导航到登录URL: ${CONFIG.planLoginUrl}`);
            await this.page.goto(CONFIG.planLoginUrl, {
                waitUntil: 'domcontentloaded',
                timeout: CONFIG.timeouts.pageLoad
            });
            console.log('✅ 登录页面加载成功');

            // 2. 切换到"账号登录"标签
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

            // 3. 填写用户名和密码
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
                        // 点击前设置导航等待
                        const navigationPromise = this.page.waitForNavigation({
                            waitUntil: 'domcontentloaded',
                            timeout: 5000
                        }).catch(() => {
                            // 导航可能不会立即发生（比如需要验证码）
                            return null;
                        });
                        
                        await loginButton.click().catch(() => {});
                        console.log('   ✅ 尝试点击登录按钮进行自动登录');
                        
                        // 等待可能的导航（最多5秒）
                        await navigationPromise;
                    } else {
                        await this.page.keyboard.press('Enter').catch(() => {});
                        console.log('   ℹ️ 未找到明确的登录按钮，已尝试按 Enter');
                    }
                } catch (e) {
                    // 忽略点击失败
                }
            }

            // 4. 等待登录结果，检查是否跳转到预估销量页面
            console.log('⏳ 等待登录处理...');
            // 给页面一点时间稳定，避免导航期间访问页面属性
            await new Promise(resolve => setTimeout(resolve, 1000));
            
            const startTime = Date.now();
            const maxWaitTime = 300000; // 5分钟超时
            const pollInterval = 2000; // 检查间隔2秒
            
            while (Date.now() - startTime < maxWaitTime) {
                let currentUrl = '';
                let verificationCodeInput = null;
                
                try {
                    // 安全地获取当前URL
                    currentUrl = await this.page.url();
                } catch (urlError) {
                    // 如果页面正在导航，url()可能失败，等待后重试
                    console.log('   ⚠️ 获取URL失败，页面可能正在导航，等待后重试...');
                    await new Promise(resolve => setTimeout(resolve, 1000));
                    continue;
                }
                
                // 检查是否已跳转到预估销量页面
                if (currentUrl.includes('mc.pinduoduo.com/ddmc-mms/appointment-delivery')) {
                    console.log('✅ 登录成功，已进入预估销量页面');
                    return true;
                }
                
                // 检查是否需要验证码
                try {
                    verificationCodeInput = await this.page.$('input[placeholder="请输入短信验证码"]');
                } catch (elementError) {
                    // 元素查找可能失败，继续下一次循环
                    verificationCodeInput = null;
                }
                
                if (verificationCodeInput) {
                    console.log('📱 检测到验证码输入框，可能需要短信验证码');
                    // 由于我们只快速获取anti-content，如果遇到验证码，直接返回false
                    console.log('   ⚠️ 需要验证码，跳过验证码处理（快速模式）');
                    return false;
                }
                
                // 等待2秒后再次检查
                await new Promise(resolve => setTimeout(resolve, pollInterval));
            }
            
            console.log('❌ 登录超时（5分钟），退出');
            return false;
            
        } catch (error) {
            console.log('❌ 登录过程出现错误:', error.message);
            return false;
        }
    }

    async waitForPlanAPIRequest() {
        console.log('\n⏳ 等待预估销量查询API请求...');
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
    }

    async run() {
        try {
            console.log('🎬 开始执行快速预估销量参数捕获脚本');

            // 1. 初始化浏览器
            await this.init();

            // 2. 设置请求拦截
            await this.setupRequestInterception();

            console.log(`\n📝 登录信息: 用户 ${this.loginCredentials.username}`);

            // 3. 先尝试直接访问预估销量页面
            const directSuccess = await this.tryDirectAccess();

            // 4. 如果直接访问失败，尝试登录
            let loginSuccess = false;
            if (!directSuccess) {
                console.log('\n🔑 直接访问失败，尝试登录...');
                loginSuccess = await this.autoLogin();
                
                if (!loginSuccess) {
                    console.log('❌ 登录失败，程序退出');
                    return;
                }
            }

            // 5. 等待API请求，捕获anti-content参数
            // 如果直接访问已经成功，这里可能已经捕获到了，但再等等确保
            if (!this.capturedData.antiContentPlan) {
                const apiCaptured = await this.waitForPlanAPIRequest();
                if (!apiCaptured) {
                    throw new Error('未捕获到预估销量查询API请求，无法获取anti-content参数');
                }
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
async function updatePlanAntiContent(username, password) {
    console.log(`\n🔄 开始更新账号的预估销量参数: ${username}`);

    // 获取Supabase客户端
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !supabaseKey) {
        console.log('❌ Supabase配置缺失，跳过数据上传');
        return;
    }

    const supabase = createClient(supabaseUrl, supabaseKey);

    try {
        // 开始浏览器流程
        console.log(`🔍 开始浏览器流程...`);
        const fetcher = new PDDPlanAntiContentFetcher({ username, password }, `./puppeteer_user_data/${username}`, supabase);
        await fetcher.run();

        // 如果成功获取到anti-content，更新到Supabase
        if (fetcher.capturedData.antiContentPlan) {
            // 只更新anti_content_Plan字段
            const { error } = await supabase
                .from('pdd_accounts')
                .update({
                    anti_content_Plan: fetcher.capturedData.antiContentPlan,
                    updated_at: new Date().toISOString()
                })
                .eq('username', username);

            if (error) {
                console.log(`❌ 更新失败: ${error.message}`);
            } else {
                console.log(`✅ 账号 ${username} 的预估销量参数已更新到Supabase`);
                console.log('\n' + '='.repeat(50));
            }
        } else {
            console.log(`⚠️ 未获取到anti-content，跳过更新`);
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

            await updatePlanAntiContent(username, password);
        }

        console.log('\n🎉 所有账号的预估销量参数更新完成');

    } catch (error) {
        console.log('❌ 解析账号信息失败:', error.message);
    }
}

// 执行主函数
main().catch(console.error);