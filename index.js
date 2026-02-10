const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs').promises;

// 设置控制台编码，解决中文乱码问题
if (process.platform === 'win32') {
    const { execSync } = require('child_process');
    try {
        // 尝试设置控制台编码为UTF-8
        execSync('chcp 65001 > nul', { stdio: 'ignore' });
    } catch (error) {
        // 如果设置失败，继续执行
    }
}

// 使用反检测插件
puppeteer.use(StealthPlugin());

// 配置常量
const CONFIG = {
    loginUrl: 'https://mms.pinduoduo.com/login/?redirectUrl=https%3A%2F%2Fmc.pinduoduo.com%2Fddmc-mms%2Forder%2Fmanagement',
    targetApiEndpoint: 'cartman-mms/orderManagement/pageQueryDetail',
    
    // 本地Chrome浏览器路径
    chromePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    
    // 浏览器配置
    browserOptions: {
        headless: false, // 显示浏览器以便观察
        executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        defaultViewport: {
            width: 1366,  // 调整为更常见的分辨率
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
            '--window-size=1366,768',  // 调整窗口大小
            '--start-maximized',
            '--remote-debugging-port=9222',
            '--disable-site-isolation-trials',
            '--disable-blink-features=AutomationControlled',
            '--allow-running-insecure-content',
            '--disable-features=BlockInsecurePrivateNetworkRequests'
        ],
        // userDataDir 会在运行时根据选择的账号动态设置
        // 添加用户数据目录，保持session和cookies（动态设置）
        ignoreDefaultArgs: ['--enable-automation']
    },
    
    // 等待超时配置（毫秒）
    timeouts: {
        pageLoad: 30000,
        elementWait: 10000,
        navigation: 30000,
        apiRequest: 60000, // 等待API请求的最大时间
        dataProcessing: 10000 // 等待数据处理的最大时间
    }
};

class PDDOrderCrawler {
    constructor(loginCredentials, userDataDir) {
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
            resultListExtracted: false, // 新增标志：resultList是否已提取
            dataSaved: false // 新增标志：数据是否已保存
        };
        this.loginCredentials = loginCredentials || { username: 'wangxh03', password: '' };
        this.userDataDir = userDataDir || './puppeteer_user_data/default';
    }

    async init() {
        console.log('🚀 启动本地Chrome浏览器...');
        
        // 检查Chrome是否存在
        try {
            const fsSync = require('fs');
            const chromePath = CONFIG.chromePath;
            
            if (fsSync.existsSync(chromePath)) {
                console.log(`✅ 找到Chrome浏览器: ${chromePath}`);
            } else {
                console.log(`❌ Chrome浏览器未找到: ${chromePath}`);
                delete CONFIG.browserOptions.executablePath;
            }
        } catch (error) {
            console.log('❌ 检查Chrome浏览器时出错:', error.message);
            delete CONFIG.browserOptions.executablePath;
        }
        
        try {
            // 创建用户数据目录（按账号隔离）
            const fsSync = require('fs');
            if (!fsSync.existsSync(this.userDataDir)) {
                fsSync.mkdirSync(this.userDataDir, { recursive: true });
            }

            const launchOptions = {
                ...CONFIG.browserOptions,
                userDataDir: this.userDataDir
            };

            this.browser = await puppeteer.launch(launchOptions);
            this.page = await this.browser.newPage();
            
            // 设置用户代理
            await this.page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36');
            
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
            
        } catch (error) {
            console.error('❌ 启动浏览器失败:', error.message);
            
            // 尝试使用默认配置（不带executablePath）
            console.log('🔄 尝试使用默认配置启动...');
            delete CONFIG.browserOptions.executablePath;

            const fallbackLaunch = {
                ...CONFIG.browserOptions,
                headless: false,
                userDataDir: this.userDataDir
            };

            this.browser = await puppeteer.launch(fallbackLaunch);
            this.page = await this.browser.newPage();
            
            console.log('✅ 浏览器启动成功（使用默认配置）');
        }
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
                        try {
                            const jsonBody = JSON.parse(postData);
                            console.log('   📦 请求体:', JSON.stringify(jsonBody, null, 2));
                        } catch (e) {
                            console.log('   📦 请求体（非JSON）:', postData.substring(0, 200) + '...');
                        }
                    }
                }
                
                this.capturedData.orderRequestHeaders = headers;
            }
            
            // 继续请求
            request.continue();
        });

        // 监听响应
        this.page.on('response', async (response) => {
            const url = response.url();
            
            // 捕获登录API响应
            if (url.includes('/janus/api/auth')) {
                console.log('\n🔐 登录响应状态:', response.status());
                const headers = response.headers();
                console.log('   响应头包含 ETag:', !!headers['etag']);
                
                // 保存登录响应头
                this.capturedData.loginResponseHeaders = headers;
            }
            
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
                        console.log('   响应数据（前500字符）:', JSON.stringify(jsonResponse).substring(0, 500) + '...');
                        
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
                            this.capturedData.resultListExtracted = true; // 即使没有resultList，也标记为已处理
                        }
                    } catch (e) {
                        console.log('   响应数据（前500字符）:', responseData.substring(0, 500) + '...');
                        this.capturedData.resultListExtracted = true; // 即使解析失败，也标记为已处理
                    }
                } catch (e) {
                    console.log('   无法获取响应数据:', e.message);
                    this.capturedData.resultListExtracted = true; // 即使获取失败，也标记为已处理
                }
            }
        });
    }

    async waitForPageLoad() {
        try {
            // 等待页面加载完成
            await this.page.waitForNavigation({ 
                waitUntil: 'networkidle0', 
                timeout: CONFIG.timeouts.pageLoad 
            });
        } catch (error) {
            // 如果超时，尝试等待domcontentloaded
            try {
                await this.page.waitForNavigation({ 
                    waitUntil: 'domcontentloaded', 
                    timeout: 5000 
                });
            } catch (e) {
                console.log('⚠️  页面加载超时，继续执行...');
            }
        }
    }

    async waitForElement(selector, timeout = CONFIG.timeouts.elementWait) {
        try {
            return await this.page.waitForSelector(selector, { timeout });
        } catch (error) {
            return null;
        }
    }

    async waitForURL(expectedUrlPart, timeout = CONFIG.timeouts.navigation) {
        const startTime = Date.now();
        
        while (Date.now() - startTime < timeout) {
            const currentUrl = this.page.url();
            if (currentUrl.includes(expectedUrlPart)) {
                return true;
            }
            
            // 等待500ms再检查
            await new Promise(resolve => setTimeout(resolve, 500));
        }
        
        return false;
    }

    async waitForDataProcessing() {
        console.log('\n⏳ 等待数据处理完成...');
        
        const startTime = Date.now();
        const maxWaitTime = CONFIG.timeouts.dataProcessing;
        
        // 等待resultList数据提取完成
        while (!this.capturedData.resultListExtracted && (Date.now() - startTime) < maxWaitTime) {
            // 等待100ms后再次检查
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        
        if (this.capturedData.resultListExtracted) {
            console.log('✅ 数据处理完成');
            return true;
        } else {
            console.log(`⚠️  在 ${maxWaitTime/1000} 秒内未完成数据处理`);
            return false;
        }
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
            // 忽略切换标签时的错误，继续后续逻辑
        }

        const startTime = Date.now();
        const pollInterval = 2000; // 每次检查间隔
        const statusLogInterval = 5000; // 状态日志间隔
        let lastStatusLog = 0;

        // 持续轮询，直到页面跳转到订单管理页面（用户可在浏览器手动登录）
        while (true) {
            const currentUrl = this.page.url();
            if (currentUrl.includes('mc.pinduoduo.com/ddmc-mms/order/management')) {
                console.log('✅ 已处于订单管理页面，可能已自动登录');
                return true;
            }

            const now = Date.now();
            if (now - lastStatusLog > statusLogInterval) {
                const elapsed = Math.floor((now - startTime) / 1000);
                console.log(`⏳ 等待登录或页面跳转中... 已等待 ${elapsed} 秒。请在浏览器中完成登录或检查网络。`);
                lastStatusLog = now;
            }

            // 如果出现登录表单，尝试自动填写（如果提供了凭据），否则继续等待用户手动登录
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
                        // 忽略点击失败，继续等待页面变化
                    }
                }
            } catch (e) {
                // 忽略查询表单时的错误
            }

            // 等待一段时间然后再次检查（不设置整体超时）
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
        
        // 显示所有cookie名称
        console.log('   📋 所有Cookie名称:', cookies.map(c => c.name).join(', '));
        
        // 构建cookie字符串用于curl命令
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
        console.log('   页面将自动运行，无需人工干预');
        
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

    async saveResults() {
        console.log('\n💾 开始保存结果...');
        
        // 先等待数据处理完成
        const dataProcessed = await this.waitForDataProcessing();
        
        if (!dataProcessed) {
            console.log('⚠️  数据处理未完成，继续保存其他数据...');
        }
        
        const results = {
            timestamp: new Date().toISOString(),
            loginCredentials: {
                username: this.loginCredentials.username,
                hasPassword: !!this.loginCredentials.password
            },
            capturedData: {
                antiContent: this.capturedData.antiContent,
                windowsAppShopToken23: this.capturedData.windowsAppShopToken23,
                passId: this.capturedData.passId,
                localStorageData: this.capturedData.localStorageData,
                sessionStorageData: this.capturedData.sessionStorageData,
                orderRequestHeaders: this.capturedData.orderRequestHeaders,
                orderRequestBody: this.capturedData.orderRequestBody ? 
                    (() => {
                        try {
                            return JSON.parse(this.capturedData.orderRequestBody);
                        } catch (e) {
                            return this.capturedData.orderRequestBody;
                        }
                    })() : null,
                orderResponse: this.capturedData.orderResponse ? 
                    (() => {
                        try {
                            return JSON.parse(this.capturedData.orderResponse);
                        } catch (e) {
                            return this.capturedData.orderResponse.substring(0, 1000) + '...';
                        }
                    })() : null,
                allCookies: this.capturedData.allCookies,
                apiRequestCaptured: this.capturedData.apiRequestCaptured,
                resultListExtracted: this.capturedData.resultListExtracted
            }
        };
        
        // 保存完整结果到文件
        const timestamp = Date.now();
        const accountId = this.loginCredentials && this.loginCredentials.username ? this.loginCredentials.username : 'unknown';
        const fileName = `pdd_results_${accountId}_${timestamp}.json`;
        await fs.writeFile(fileName, JSON.stringify(results, null, 2), 'utf8');
        console.log(`✅ 完整结果已保存到 ${fileName}`);
        
        // 保存resultList到单独的JSON文件
        if (this.capturedData.resultList) {
            const resultListFileName = `resultList_${accountId}_${timestamp}.json`;
            const resultListData = {
                timestamp: new Date().toISOString(),
                totalCount: this.capturedData.resultList.length,
                resultList: this.capturedData.resultList
            };
            await fs.writeFile(resultListFileName, JSON.stringify(resultListData, null, 2), 'utf8');
            console.log(`✅ resultList已保存到 ${resultListFileName}`);
            this.capturedData.dataSaved = true;
        } else if (this.capturedData.resultListExtracted) {
            console.log('⚠️  resultList数据为空，可能是响应中没有该字段');
            this.capturedData.dataSaved = true;
        } else {
            console.log('⚠️  resultList数据未提取，可能是响应处理尚未完成');
            this.capturedData.dataSaved = true; // 标记为已保存，避免无限等待
        }
        
        // 输出关键信息
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
        
        // 生成curl命令模板
        if (this.capturedData.antiContent && this.capturedData.cookieString) {
            console.log('\n' + '='.repeat(50));
            console.log('📝 生成的curl命令模板:');
            console.log('='.repeat(50));
            
            let requestBody;
            try {
                requestBody = this.capturedData.orderRequestBody ? JSON.parse(this.capturedData.orderRequestBody) : { page: 1, pageSize: 10, areaId: 19881233 };
            } catch (e) {
                requestBody = { page: 1, pageSize: 10, areaId: 19881233 };
            }
            
            // 转义双引号和特殊字符，生成Windows CMD可用的curl命令
            const escapedAntiContent = this.capturedData.antiContent.replace(/"/g, '""');
            const escapedCookieString = this.capturedData.cookieString.replace(/"/g, '""');
            const escapedRequestBody = JSON.stringify(requestBody)
                .replace(/\\/g, '\\\\')
                .replace(/"/g, '\\"')
                .replace(/\^/g, '^^');
            
            const curlCommand = `curl ^"https://mc.pinduoduo.com/cartman-mms/orderManagement/pageQueryDetail^" ^
  -H ^"accept: */*^" ^
  -H ^"accept-language: zh-CN,zh;q=0.9^" ^
  -H ^"anti-content: ${escapedAntiContent}^" ^
  -H ^"content-type: application/json^" ^
  -H ^"origin: https://mc.pinduoduo.com^" ^
  -H ^"referer: https://mc.pinduoduo.com/ddmc-mms/order/management^" ^
  -H ^"user-agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36^" ^
  -b ^"${escapedCookieString}^" ^
  --data-raw ^"${escapedRequestBody}^"`;
            
            console.log(curlCommand);
            
            // 保存curl命令到文件
            const curlFileName = `curl_command_${accountId}_${timestamp}.cmd`;
            await fs.writeFile(curlFileName, curlCommand, 'utf8');
            console.log(`\n📁 curl命令已保存到 ${curlFileName}`);
        }
        
        console.log('='.repeat(50));
        
        // 标记保存完成
        this.capturedData.dataSaved = true;
    }

    async run() {
        try {
            console.log('🎬 开始执行拼多多订单数据捕获脚本');
            console.log('==================================================');
            console.log('📋 策略说明:');
            console.log('  1. 使用重定向URL登录，自动跳转到订单页面');
            console.log('  2. 程序只负责监听和捕获API请求');
            console.log('  3. 登录后页面将自动运行，无需手动操作');
            console.log('==================================================');
            
            // 1. 初始化浏览器
            await this.init();
            
            // 2. 设置请求拦截（必须先设置拦截，再访问页面）
            await this.setupRequestInterception();
            
            console.log(`\n📝 登录信息: 用户 ${this.loginCredentials.username}`);
            
            // 3. 自动登录（带重定向）
            const loginSuccess = await this.autoLogin();
            if (!loginSuccess) {
                console.log('❌ 登录失败，程序退出');
                console.log('\n⚠️  请检查以下可能的问题:');
                console.log('  1. 账号密码是否正确');
                console.log('  2. 是否需要验证码');
                console.log('  3. 网络连接是否正常');
                
                // 等待5秒让用户查看错误
                await new Promise(resolve => setTimeout(resolve, 5000));
                await this.browser.close();
                return;
            }
            
            // 4. 捕获cookies
            await this.captureCookies();
            
            // 5. 等待页面自动发送API请求
        /*    const apiCaptured = await this.waitForAPIRequest();
            
            if (!apiCaptured) {
                console.log('\n⚠️  未自动捕获到API请求，可能的原因:');
                console.log('  1. 页面尚未加载完成');
                console.log('  2. 需要手动点击查询按钮');
                console.log('  3. 网络请求被拦截或延迟');
                console.log('  4. 页面已离开订单管理页面');
                console.log('\n💡 建议: 请在浏览器中手动操作订单页面，程序会继续监听');
            }*/
            
            // 6. 保存结果（这里会等待数据处理完成）
            await this.saveResults();
            
            console.log('\n✅ 脚本执行完成！');
            console.log('\n📋 执行结果:');
            console.log('  - API请求捕获:', this.capturedData.apiRequestCaptured ? '✅ 成功' : '❌ 失败');
            console.log('  - anti-content:', this.capturedData.antiContent ? '✅ 已捕获' : '❌ 未捕获');
            console.log('  - 关键Cookie:', this.capturedData.windowsAppShopToken23 ? '✅ 已捕获' : '❌ 未捕获');
            console.log('  - resultList数据:', this.capturedData.resultList ? `✅ 已提取 ${this.capturedData.resultList.length} 条` : '❌ 未提取');
            console.log('  - 数据处理完成:', this.capturedData.resultListExtracted ? '✅ 是' : '❌ 否');
            console.log('  - 数据保存完成:', this.capturedData.dataSaved ? '✅ 是' : '❌ 否');
            
        } catch (error) {
            console.error('❌ 脚本执行出错:', error.message);
            console.error(error.stack);
            
        } finally {
            if (this.browser) {
                try {
                    await this.browser.close();
                    console.log('👋 浏览器已关闭');
                } catch (closeError) {
                    console.log('⚠️ 关闭浏览器时出现错误:', closeError.message);
                }
            }
            
            console.log('🏁 程序执行完毕，正在退出...');
            process.exit(0);
        }
    }
}

// 运行脚本
(async () => {
    // 从配置文件读取可用账号（账号列表保持在 accounts.json，密码不再以明文存储）
    let accountsConfig = null;
    try {
        accountsConfig = require('./accounts.json');
        if (!accountsConfig || !Array.isArray(accountsConfig.accounts) || accountsConfig.accounts.length === 0) {
            throw new Error('accounts.json 格式不正确或为空');
        }
    } catch (e) {
        console.log('⚠️ 无法读取 accounts.json，使用内置默认账号列表。错误：', e.message);
        accountsConfig = { accounts: [ { username: 'wangxh03' }, { username: 'wangxh04' }, { username: '17752768679' } ] };
    }

    const AVAILABLE_ACCOUNTS = accountsConfig.accounts.map(a => a.username);
    const selectedAccount = process.env.ACCOUNT || process.argv[2] || AVAILABLE_ACCOUNTS[0];
    if (!AVAILABLE_ACCOUNTS.includes(selectedAccount)) {
        console.log(`❌ 未知账号: ${selectedAccount}. 可用账号: ${AVAILABLE_ACCOUNTS.join(', ')}`);
        process.exit(1);
    }

    // 密码优先顺序：
    // 1) 环境变量 PASSWORD_<username> 或 ACCOUNT_PASSWORD
    // 2) 配置文件 accounts.json 中的 password 字段
    const accountObj = accountsConfig.accounts.find(a => a.username === selectedAccount) || {};
    const envPassword = process.env[`PASSWORD_${selectedAccount}`] || process.env.ACCOUNT_PASSWORD;

    const resolvedPassword = (envPassword !== undefined) ? envPassword : (accountObj.password || '');
    const loginCredentials = { username: selectedAccount, password: resolvedPassword };
    const userDataDir = `./puppeteer_user_data/${selectedAccount}`;

    const crawler = new PDDOrderCrawler(loginCredentials, userDataDir);
    await crawler.run();
})();