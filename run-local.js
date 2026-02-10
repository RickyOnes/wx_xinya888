// run-local.js - 本地运行用于首次登录验证（基于 index.js 配置）
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { createClient } = require('@supabase/supabase-js');

// 使用反检测插件
puppeteer.use(StealthPlugin());

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

// 配置常量（完全参考 index.js）
const CONFIG = {
    loginUrl: 'https://mms.pinduoduo.com/login/?redirectUrl=https%3A%2F%2Fmc.pinduoduo.com%2Fddmc-mms%2Forder%2Fmanagement',
    targetApiEndpoint: 'cartman-mms/orderManagement/pageQueryDetail',
    
    // 本地Chrome浏览器路径
    chromePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    
    // 浏览器配置（完全参考 index.js）
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

// 您的账号配置
const ACCOUNTS = [
  { username: 'wangxh03', password: 'Xinya123' },
  { username: 'wangxh04', password: 'Xinya123' },
  { username: '17752768679', password: 'Wy430768' }
];

async function initBrowser(username) {
    console.log(`🚀 为账号 ${username} 启动本地Chrome浏览器...`);
    
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
        const userDataDir = `./puppeteer_user_data/${username}`;
        const fsSync = require('fs');
        if (!fsSync.existsSync(userDataDir)) {
            fsSync.mkdirSync(userDataDir, { recursive: true });
        }

        const launchOptions = {
            ...CONFIG.browserOptions,
            userDataDir: userDataDir
        };

        const browser = await puppeteer.launch(launchOptions);
        const page = await browser.newPage();
        
        // 设置用户代理（完全参考 index.js）
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36');
        
        // 设置额外的请求头（完全参考 index.js）
        await page.setExtraHTTPHeaders({
            'Accept-Language': 'zh-CN,zh;q=0.9',
            'Accept-Encoding': 'gzip, deflate, br, zstd',
        });
        
        // 注入JavaScript来绕过自动化检测（完全参考 index.js）
        await page.evaluateOnNewDocument(() => {
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
        const version = await browser.version();
        console.log(`📊 浏览器版本: ${version}`);
        
        return { browser, page };
        
    } catch (error) {
        console.error('❌ 启动浏览器失败:', error.message);
        
        // 尝试使用默认配置（不带executablePath）
        console.log('🔄 尝试使用默认配置启动...');
        delete CONFIG.browserOptions.executablePath;

        const userDataDir = `./puppeteer_user_data/${username}`;
        const fsSync = require('fs');
        if (!fsSync.existsSync(userDataDir)) {
            fsSync.mkdirSync(userDataDir, { recursive: true });
        }

        const fallbackLaunch = {
            ...CONFIG.browserOptions,
            headless: false,
            userDataDir: userDataDir
        };

        const browser = await puppeteer.launch(fallbackLaunch);
        const page = await browser.newPage();
        
        console.log('✅ 浏览器启动成功（使用默认配置）');
        return { browser, page };
    }
}

async function localLogin() {
  console.log('🖥️  本地首次登录验证模式（使用 index.js 完整配置）');
  console.log('⚠️  注意：此模式会显示浏览器窗口，请手动完成验证');
  console.log('📋 配置特点：');
  console.log('   - 使用 puppeteer-extra + StealthPlugin 反检测');
  console.log('   - 完整的浏览器指纹伪装');
  console.log('   - 用户数据目录隔离（保持登录状态）');
  console.log('   - 与 index.js 完全一致的浏览器配置');
  
  for (const account of ACCOUNTS) {
    console.log(`\n🔐 处理账号: ${account.username}`);
    
    // 初始化浏览器（使用与 index.js 完全相同的配置）
    const { browser, page } = await initBrowser(account.username);
    
    try {
      // 访问登录页面
      console.log('🌐 访问登录页面...');
      await page.goto(CONFIG.loginUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 0  // 不设超时
      });
      
      console.log('\n👉 请手动完成以下操作:');
      console.log('   1. 如果出现"账号登录"标签，请切换到该标签');
      console.log('   2. 输入用户名和密码');
      console.log('   3. 完成图形验证码验证');
      console.log('   4. 如果出现手机验证，请手动输入验证码');
      console.log('   5. 等待页面自动跳转到订单管理页面');
      console.log('\n💡 提示：');
      console.log('   - 浏览器已配置反检测，应该能减少手机验证的出现');
      console.log('   - 如果仍然需要手机验证，请手动输入验证码');
      console.log('   - 登录成功后，Cookies 将自动保存到 Supabase');
      
      // 等待用户手动操作，直到跳转到订单管理页面
      let loginSuccess = false;
      const startTime = Date.now();
      const maxWaitTime = 10 * 60 * 1000; // 最多等待10分钟
      
      while (!loginSuccess && (Date.now() - startTime) < maxWaitTime) {
        const currentUrl = page.url();
        
        if (currentUrl.includes('mc.pinduoduo.com/ddmc-mms/order/management')) {
          loginSuccess = true;
          console.log(`✅ 账号 ${account.username} 登录成功！`);
          
          // 等待页面稳定
          await new Promise(resolve => setTimeout(resolve, 3000));
          
          // 捕获Cookies并保存到Supabase
          await captureAndSaveCookies(account.username, page);
          break;
        }
        
        // 每30秒显示一次状态
        if ((Date.now() - startTime) % 30000 < 1000) {
          const elapsed = Math.floor((Date.now() - startTime) / 1000);
          console.log(`⏳ 等待登录中... 已等待 ${elapsed} 秒`);
          console.log(`   当前URL: ${currentUrl.substring(0, 100)}...`);
        }
        
        // 等待2秒后再次检查
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
      
      if (!loginSuccess) {
        console.log(`⚠️  账号 ${account.username} 登录超时（10分钟）`);
        console.log('💡 建议：');
        console.log('   1. 检查网络连接');
        console.log('   2. 检查账号密码是否正确');
        console.log('   3. 检查是否被限制登录');
      }
      
    } catch (error) {
      console.error(`❌ 处理账号 ${account.username} 时出错:`, error.message);
    } finally {
      // 关闭浏览器
      try {
        await browser.close();
        console.log(`👋 账号 ${account.username} 的浏览器已关闭`);
      } catch (closeError) {
        console.log('⚠️ 关闭浏览器时出现错误:', closeError.message);
      }
      
      // 账号之间等待5秒
      if (account !== ACCOUNTS[ACCOUNTS.length - 1]) {
        console.log('⏳ 等待5秒后处理下一个账号...');
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }
  }
  
  console.log('\n🎉 所有账号处理完成！');
  console.log('\n📋 后续步骤：');
  console.log('   1. GitHub Actions 将使用保存的 Cookies 自动运行');
  console.log('   2. 无需再次手动登录（除非 Cookies 过期）');
  console.log('   3. Cookies 有效期为20小时');
}

async function captureAndSaveCookies(username, page) {
  console.log(`🍪 捕获账号 ${username} 的 Cookies...`);
  
  // 获取所有cookies
  const cookies = await page.cookies();
  console.log(`   📋 找到 ${cookies.length} 个 Cookie`);
  
  // 查找特定的cookie
  let foundShopToken = false;
  let foundPassId = false;
  
  for (const cookie of cookies) {
    if (cookie.name === 'windows_app_shop_token_23') {
      foundShopToken = true;
      console.log(`   ✅ 捕获到 windows_app_shop_token_23 (长度: ${cookie.value.length})`);
    }
    if (cookie.name === 'PASS_ID') {
      foundPassId = true;
      console.log(`   ✅ 捕获到 PASS_ID (长度: ${cookie.value.length})`);
    }
  }
  
  if (!foundShopToken) {
    console.log('   ⚠️  未找到 windows_app_shop_token_23');
  }
  
  if (!foundPassId) {
    console.log('   ⚠️  未找到 PASS_ID');
  }
  
  // 显示所有cookie名称
  console.log('   📋 所有Cookie名称:', cookies.map(c => c.name).join(', '));
  
  // 保存到Supabase
  await saveCookiesToSupabase(username, cookies);
}

async function saveCookiesToSupabase(username, cookies) {
  const supabaseUrl = 'https://iglmqwpagzjadwauvchh.supabase.co';
  const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlnbG1xd3BhZ3pqYWR3YXV2Y2hoIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc1MDg4OTg0MCwiZXhwIjoyMDY2NDY1ODQwfQ.X02QG8bhyFu7ZcOjIW23-Bp0mF5R-1KXX_lS07Rrqyc';
  
  const supabase = createClient(supabaseUrl, supabaseKey);
  
  const cookieString = cookies.map(c => `${c.name}=${c.value}`).join('; ');
  
  // 准备完整的数据（参考 update-pdd.js 中的结构）
  const accountData = {
    username,
    cookie_string: cookieString,
    expires_at: new Date(Date.now() + 20 * 60 * 60 * 1000).toISOString(),
    last_success: true,
    updated_at: new Date().toISOString()
  };
  
  const { error } = await supabase
    .from('pdd_accounts')
    .upsert(accountData, { onConflict: 'username' });
  
  if (error) {
    console.log(`❌ 保存到 Supabase 失败: ${error.message}`);
  } else {
    console.log(`✅ 账号 ${username} 的 Cookies 已保存到 Supabase`);
    console.log(`   ⏳ 过期时间: ${accountData.expires_at}`);
  }
}

// 运行
localLogin().catch(console.error);