const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { createClient } = require('@supabase/supabase-js');
const { execSync } = require('child_process'); // 用于检测系统 Chrome

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

class PDDPlanAntiContentFetcher {
    constructor(loginCredentials, userDataDir, supabaseClient) {
        this.browser = null;
        this.page = null;
        this.capturedData = {
            antiContentPlan: null,
            cookieString: '', // 存储Cookie
            needlogin: false
        };
        this.loginCredentials = loginCredentials || { username: 'wangxh03', password: '' };
        this.userDataDir = userDataDir || './puppeteer_user_data/default';
        this.supabaseClient = supabaseClient || null;
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

    async autoLogin() {
        // 先尝试使用现有会话
        console.log('\n🔍 尝试使用现有会话...');
        try {
            await this.page.goto(CONFIG.planDirectUrl, {
                waitUntil: 'domcontentloaded', 
                timeout: 10000
            });
            
            // 等待页面稳定并检查是否有重定向
            let urlStable = true;
            const initialUrl = this.page.url();
            console.log(`   初始URL: ${initialUrl}`);
            
            // 等待5秒，每1秒检查一次URL是否变化，同时检查是否已捕获到anti-content
            for (let i = 0; i < 5; i++) {
                // 检查是否已经捕获到anti-content，如果是则提前结束等待
                if (this.capturedData.antiContentPlan) {
                    console.log(`   ✅ 已捕获到anti-content，提前结束等待`);
                    return true;
                }
                
                await new Promise(resolve => setTimeout(resolve, 1000));
                let currentUrl = '';
                try {
                    currentUrl = this.page.url();
                } catch (e) {
                    // 忽略错误
                }
                console.log(`   等待 ${i+1}/5秒，当前URL: ${currentUrl}`);
                
                if (!currentUrl.includes('mc.pinduoduo.com/ddmc-mms/appointment-delivery')) {
                    console.log(`   ⚠️  URL已变化到: ${currentUrl}，会话可能已失效`);
                    urlStable = false;
                    break;
                }
            }
            
            let finalUrl = '';
            try {
                finalUrl = this.page.url();
            } catch (e) {
                // 忽略错误
            }
            console.log(`   最终URL: ${finalUrl}`);
            
            // 加强会话检测：不仅检查URL，还检查页面元素
            if (urlStable && finalUrl.includes('mc.pinduoduo.com/ddmc-mms/appointment-delivery')) {
                // 如果在导航过程中已经捕获到anti-content，说明会话有效，直接返回
                if (this.capturedData.antiContentPlan) {
                    console.log('✅ 会话有效，已捕获到anti-content，直接进入预估销量页面');
                    return true;
                }
                
                // 检查是否实际在预估销量页面（没有登录表单）
                const hasLoginForm = await this.page.$('#usernameId, input[placeholder="请输入手机号"]').catch(() => null);
                const hasPasswordInput = await this.page.$('#passwordId').catch(() => null);
                const hasLoginButton = await this.page.$('button[data-testid="beast-core-button"]').catch(() => null);
                
                if (hasLoginForm || hasPasswordInput || hasLoginButton) {
                    // 即使检测到登录表单，如果已经捕获到 anti-content，仍然认为会话有效
                    if (this.capturedData.antiContentPlan) {
                        console.log('   ✅ 已捕获到anti-content，会话有效，忽略登录表单');
                        return true;
                    }
                    console.log('⚠️ 检测到登录相关元素，会话可能已失效');
                    // 继续执行登录流程
                } else {
                    console.log('✅ 会话有效，直接进入预估销量页面');
                    return true;
                }
            } else {
                // 即使URL不稳定，如果已经捕获到 anti-content，仍然认为会话有效
                if (this.capturedData.antiContentPlan) {
                    console.log('   ✅ 已捕获到anti-content，会话有效，提前退出');
                    return true;
                }
                console.log('ℹ️ 会话无效或URL不稳定，开始登录流程');
            }
        } catch (error) {
            console.log(`ℹ️ 会话检测失败: ${error.message}`);
            // 即使导航失败，如果已经捕获到 anti-content，仍然认为会话有效
            if (this.capturedData.antiContentPlan) {
                console.log(`   ✅ 已捕获到anti-content，会话有效，提前退出`);
                return true;
            }
            console.log(`开始登录流程`);
        }
        
        console.log('\n🌐 开始登录流程，从登录URL直接登录...');
        
        try {
            console.log(`📝 导航到登录URL: ${CONFIG.planLoginUrl}`);
            await this.page.goto(CONFIG.planLoginUrl, {
                waitUntil: 'domcontentloaded',
                timeout: 10000
            });
            console.log('✅ 登录页面加载成功');

            // 切换到"账号登录"标签（并在切换前/后模拟滚动）
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

            // 等待登录结果，检查是否跳转到预估销量页面
            console.log('⏳ 等待登录处理...');
            await new Promise(resolve => setTimeout(resolve, 1000));

            const startTime = Date.now();
            const maxWaitTime = 300000; // 5分钟
            const pollInterval = 2000;

            while (Date.now() - startTime < maxWaitTime) {
                let currentUrl = '';
                let verificationCodeInput = null;

                try {
                    currentUrl = this.page.url();
                } catch (urlError) {
                    console.log('   ⚠️ 获取URL失败，页面可能正在导航，等待后重试...');
                    await new Promise(resolve => setTimeout(resolve, 1000));
                    continue;
                }

                if (currentUrl.includes('mc.pinduoduo.com/ddmc-mms/appointment-delivery')) {
                    console.log('✅ 登录成功，已进入预估销量页面');
                    this.capturedData.needlogin = true; // 标记为需要登录，表示我们已经完成了登录流程
                    return true;
                }

                try {
                    verificationCodeInput = await this.page.$('input[placeholder="请输入短信验证码"]');
                } catch (elementError) {
                    verificationCodeInput = null;
                }

                if (verificationCodeInput) {
                    console.log('📱 检测到验证码输入框，可能需要短信验证码');
                    // 由于我们只快速获取anti-content，如果遇到验证码，直接返回false
                    console.log('   ⚠️ 需要验证码，跳过验证码处理（快速模式）');
                    return false;
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

    async waitForPlanAPIRequest() {
        // 检查是否已经捕获到anti-content，如果是则立即返回
        if (this.capturedData.antiContentPlan) {
            console.log(`✅ 已捕获到anti-content，直接返回（长度: ${this.capturedData.antiContentPlan.length}）`);
            return true;
        }
        
        const startTime = Date.now();
        const maxWaitTime = 90000; // 90秒钟
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

    // 获取Cookies（未修改）
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

    async run() {
        try {
            console.log('🎬 开始执行快速预估销量参数捕获脚本');

            // 1. 初始化浏览器
            await this.init();

            // 2. 设置请求拦截
            await this.setupRequestInterception();

            console.log(`\n📝 登录信息: 用户 ${this.loginCredentials.username}`);

            // 3. 自动登录（先尝试现有会话，如果失败则执行登录流程）
            const loginSuccess = await this.autoLogin();
                
            if (!loginSuccess) {
                console.log('❌ 登录失败，程序退出');
                return;
            }

            // 4. 等待API请求，捕获anti-content参数
            const apiCaptured = await this.waitForPlanAPIRequest();
            if (!apiCaptured) {
                throw new Error('未捕获到预估销量查询API请求，无法获取anti-content参数');
            }

            // 只在重新登录时才抓取 Cookie
            if (this.capturedData.needlogin) {
                await this.captureCookies();
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

        // 如果成功获取到anti-content,且未重新登录，更新到Supabase
        if (fetcher.capturedData.antiContentPlan && !fetcher.capturedData.needlogin) {
            // 只更新anti_content字段
            const { error } = await supabase
                .from('pdd_accounts')
                .update({
                  anti_content: fetcher.capturedData.antiContentPlan,
                  updated_at: new Date().toISOString()
                })
                .eq('username', username);

            if (error) {
                console.log(`❌ 更新失败: ${error.message}`);
            } else {
                console.log(`✅ 账号 ${username} 的anti_content已更新到Supabase`);
                console.log('\n' + '='.repeat(50));
            }
        } else if (fetcher.capturedData.antiContentPlan && fetcher.capturedData.needlogin){
            // 如果已重新登录，则更新anti_content字段和cookie_string字段
            const { error } = await supabase
                .from('pdd_accounts')
                .update({
                  anti_content: fetcher.capturedData.antiContentPlan,
                  cookie_string: fetcher.capturedData.cookieString,
                  updated_at: new Date().toISOString()
                })
                .eq('username', username);

            if (error) {
                console.log(`❌ 更新失败: ${error.message}`);
            } else {
                console.log(`✅ 账号 ${username} 的anti_content、cookie_string已更新到Supabase`);
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
    // 添加开始时间记录
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
        // 添加结束时间统计
        const endTime = Date.now();
        const duration = Math.floor((endTime - startTime) / 1000);
        console.log(`脚本结束时间: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`);
        console.log(`总运行时长: ${duration} 秒`);
        console.log(`==========================================`);        

    } catch (error) {
        console.log('❌ 解析账号信息失败:', error.message);
    }
}

// 执行主函数
main().catch(console.error);