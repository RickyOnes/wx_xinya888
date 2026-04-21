const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { createClient } = require('@supabase/supabase-js');
const { GhostCursor } = require('ghost-cursor');

// 使用反检测插件
puppeteer.use(StealthPlugin());

// 配置常量
const CONFIG = {
  loginUrl: 'https://mms.pinduoduo.com/login/?redirectUrl=https%3A%2F%2Fmc.pinduoduo.com%2Fddmc-mms%2Forder%2Fmanagement',
  targetApiEndpoint: 'cartman-mms/orderManagement/pageQueryDetail',
  targetApiEndpointPlan: 'cartman-mms/appointment/queryAppointmentGoodsList',
  targetApiEndpointDate: 'orianna-mms/goods/schedule/pageQuery',

  browserOptions: {
    headless: process.env.HEADLESS === 'true' ? true : false,
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
      '--disk-cache-size=52428800',
      '--aggressive-cache-discard',
      '--disable-features=IsolateOrigins,site-per-process,BlockInsecurePrivateNetworkRequests',
      '--disable-blink-features=AutomationControlled',
      '--disable-sync',
      '--no-default-browser-check',
      '--disable-notifications',
      '--disable-save-password-bubble',
      '--disable-features=PasswordLeakDetection,PasswordManager,SavePassword',
      '--password-store=basic',
      '--deny-permission-prompts',
      '--disable-blink-features=RelatedApps'
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

const UA_POOL = [
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36'
];

const VIEWPORT_POOL = [
  { width: 1280, height: 720 },
  { width: 1320, height: 760 },
  { width: 1360, height: 800 }
];

const FIXED_ACCEPT_LANGUAGE = 'zh,en-US;q=0.9,en;q=0.8,zh-CN;q=0.7';
const FIXED_NAVIGATOR_LANGUAGES = ['zh', 'en-US', 'en', 'zh-CN'];

function getAccountProfile(accountIndex = 0) {
  const idx = ((Number(accountIndex) || 0) % UA_POOL.length + UA_POOL.length) % UA_POOL.length;
  return {
    userAgent: UA_POOL[idx],
    viewport: VIEWPORT_POOL[idx]
  };
}

class PDDOrderCrawler {
  constructor(loginCredentials, userDataDir, verificationCode, supabaseClient, accountIndex = 0) {
    this.browser = null;
    this.page = null;
    this.cursor = null;
    this.capturedData = {
      antiContent: null,
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
    this.accountProfile = getAccountProfile(accountIndex);
    this.lastCacheCleanTime = null;
  }

  // 模拟用户随机滚动
  async randomScroll() {
    try {
      const direction = Math.random() > 0.7 ? -1 : 1;
      const distance = (Math.random() * 200 + 100) * direction;
      await this.page.mouse.wheel({ deltaY: distance });
      await new Promise(r => setTimeout(r, Math.random() * 1000 + 500));
      console.log(`   👆 模拟鼠标滚轮滚动 (方向: ${direction > 0 ? '下' : '上'}, 距离: ${Math.abs(distance).toFixed(0)}px)`);
    } catch (e) {}
  }

  // 模拟页面阅读停留
  async waitForReading() {
    const delay = 2000 + Math.random() * 3000;
    console.log(`   👁️ 模拟阅读，停留 ${(delay/1000).toFixed(1)} 秒`);
    await new Promise(r => setTimeout(r, delay));
  }

  // 使用 ghost-cursor 模拟人类点击
  async humanLikeClick(selectorOrElement) {
    const getElement = async (input) => {
      if (typeof input === 'string') {
        return await this.page.$(input);
      }
      return input;
    };

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await this.checkOverlaysLightweight();
        let element = await getElement(selectorOrElement);
        if (!element) throw new Error('元素不存在');
        const box = await element.boundingBox();
        if (!box) throw new Error('元素不可见');
        const targetX = box.x + box.width * (0.1 + Math.random() * 0.8);
        const targetY = box.y + box.height * (0.1 + Math.random() * 0.8);
        await this.cursor.moveTo({ x: targetX, y: targetY });
        await this.checkOverlaysLightweight();
        const newElement = await getElement(selectorOrElement);
        if (!newElement) throw new Error('元素在弹窗关闭后消失');
        const newBox = await newElement.boundingBox();
        if (!newBox) throw new Error('元素在弹窗关闭后不可见');
        const newTargetX = newBox.x + newBox.width * (0.1 + Math.random() * 0.8);
        const newTargetY = newBox.y + newBox.height * (0.1 + Math.random() * 0.8);
        await this.cursor.moveTo({ x: newTargetX, y: newTargetY });
        await this.cursor.click();
        await new Promise(r => setTimeout(r, 100));
        return;
      } catch (err) {
        console.log(`   ⚠️ 人类点击尝试 ${attempt} 失败: ${err.message}`);
        if (attempt === 3) {
          console.log('   ⚠️ 回退到原生 click()');
          try {
            if (typeof selectorOrElement === 'string') {
              await this.page.click(selectorOrElement);
            } else {
              await selectorOrElement.click();
            }
          } catch (finalErr) {
            console.log('   ❌ 原生点击也失败:', finalErr.message);
          }
        } else {
          await this.checkOverlaysLightweight();
          await new Promise(r => setTimeout(r, 300 + Math.random() * 200));
        }
      }
    }
  }

  // 模拟人类输入
  async humanLikeType(selectorOrElement, text) {
    try {
      let element;
      if (typeof selectorOrElement === 'string') {
        element = await this.page.$(selectorOrElement);
      } else {
        element = selectorOrElement;
      }
      if (!element) {
        console.log(`⚠️ 元素不存在: ${typeof selectorOrElement === 'string' ? selectorOrElement : '提供的元素对象'}`);
        return;
      }
      await element.scrollIntoViewIfNeeded();
      await element.click({ delay: Math.random() * 100 + 50 });
      await new Promise(r => setTimeout(r, Math.random() * 100 + 50));
      for (const char of text) {
        await element.type(char, { delay: Math.random() * 100 + 50 });
        if (Math.random() > 0.9) {
          await new Promise(r => setTimeout(r, Math.random() * 300 + 100));
        }
      }
    } catch (e) {
      console.log(`⚠️ 人类模拟输入失败，回退到普通输入: ${e.message}`);
      if (typeof selectorOrElement === 'string') {
        await this.page.type(selectorOrElement, text, { delay: 50 });
      } else {
        await selectorOrElement.type(text, { delay: 50 });
      }
    }
  }

  // 轻量弹窗检查
  async checkOverlaysLightweight() {
    try {
      let closedAny = false;
      const popupSelector = 'i[data-testid="beast-core-modal-icon-close"]';
      const popupHandle = await this.page.$(popupSelector).catch(() => null);
      if (popupHandle) {
        try {
          await this.cursor.click(popupSelector);
          closedAny = true;
          console.log('   ✅ 轻量检查：已关闭弹窗');
          await new Promise(r => setTimeout(r, 300));
        } catch (err) {
          console.log('   ⚠️ 弹窗点击失败，尝试原生 page.click 降级');
          await this.page.click(popupSelector);
          closedAny = true;
        }
      }

      const bannerSelector = 'div.mc-header-platform-mask';
      const bannerExists = await this.page.$(bannerSelector).catch(() => null);
      if (bannerExists) {
        try {
          const box = await bannerExists.boundingBox();
          if (box) {
            const randomX = box.x + box.width * (0.3 + Math.random() * 0.4);
            const randomY = box.y + box.height * (0.3 + Math.random() * 0.4);
            await new Promise(r => setTimeout(r, 100 + Math.random() * 200));
            await this.cursor.moveTo({ x: randomX, y: randomY });
            await this.cursor.click();
            closedAny = true;
            console.log('   ✅ 轻量检查：已关闭遮罩层');
          }
        } catch (clickError) {
          console.log('   🔄 轻量检查：首次点击失败，尝试滚动后点击...');
          try {
            await bannerExists.scrollIntoViewIfNeeded();
            await new Promise(r => setTimeout(r, 100));
            await this.page.click(bannerSelector);
            closedAny = true;
            console.log('   ✅ 轻量检查：滚动后点击成功关闭条幅');
          } catch (scrollError) {
            console.log('   🔧 轻量检查：JS方法关闭条幅');
            await this.page.evaluate((sel) => {
              const element = document.querySelector(sel);
              if (element) {
                element.click();
                setTimeout(() => {
                  if (document.querySelector(sel)) {
                    element.style.display = 'none';
                  }
                }, 100);
              }
            }, bannerSelector);
            closedAny = true;
          }
        }
        await new Promise(r => setTimeout(r, 50));
      }
      return closedAny;
    } catch (e) {
      console.error('轻量检查异常:', e);
      return false;
    }
  }

  // 等待页面跳转
  async waitForPageTransition(targetUrlPattern, options = {}) {
    const {
      timeout = 30000,
      checkInterval = 200,
      stableWaitMs = 500
    } = options;

    const startTime = Date.now();
    console.log(`   ⏳ 等待页面切换至: *${targetUrlPattern}*`);

    while (Date.now() - startTime < timeout) {
      const currentUrl = this.page.url();
      if (currentUrl.includes(targetUrlPattern)) {
        console.log(`   ✅ URL已匹配: ${currentUrl}`);
        if (stableWaitMs > 0) {
          await new Promise(r => setTimeout(r, stableWaitMs));
        }
        return { url: currentUrl };
      }
      await new Promise(r => setTimeout(r, checkInterval));
    }

    throw new Error(`页面切换超时(${timeout / 1000}秒)，目标: ${targetUrlPattern}, 当前: ${this.page.url()}`);
  }

  // 初始化浏览器
  async init() {
    console.log('🚀 启动浏览器...');
    console.log(`   📁 用户数据目录: ${this.userDataDir}`);

    const fs = require('fs').promises;
    try {
      await fs.mkdir(this.userDataDir, { recursive: true });
    } catch (e) {
      console.log(`   ⚠️ 无法创建目录: ${e.message}`);
    }

    const baseOptions = {
      ...CONFIG.browserOptions,
      userDataDir: this.userDataDir,
      defaultViewport: this.accountProfile.viewport
    };

    let launchOptions = { ...baseOptions };
    let useSystemChrome = false;
    try {
      const { execSync } = require('child_process');
      execSync('which google-chrome', { stdio: 'ignore' });
      launchOptions.executablePath = '/usr/bin/google-chrome';
      useSystemChrome = true;
    } catch {
      console.log('   ℹ️ 系统 Chrome 未找到，将使用 Puppeteer 内置 Chromium');
    }

    try {
      this.browser = await puppeteer.launch(launchOptions);
      if (useSystemChrome) console.log('   ✅ 系统 Chrome 启动成功');
    } catch (error) {
      if (useSystemChrome) {
        console.log(`   ⚠️ 系统 Chrome 启动失败: ${error.message}`);
        console.log('   🔄 尝试回退到 Puppeteer 内置 Chromium...');
        delete launchOptions.executablePath;
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

    try {
      const pages = await this.browser.pages();
      console.log(`📑 当前标签页数量: ${pages.length}`);
    } catch (e) {
      console.log(`⚠️ 无法获取标签页数量: ${e.message}`);
    }

    await this.page.setUserAgent(this.accountProfile.userAgent);

    await this.page.setExtraHTTPHeaders({
      'Accept-Language': FIXED_ACCEPT_LANGUAGE,
      'Accept-Encoding': 'gzip, deflate, br, zstd'
    });

    await this.page.evaluateOnNewDocument((langs) => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
      Object.defineProperty(navigator, 'languages', { get: () => langs });
      Object.defineProperty(navigator, 'platform', {
        get: () => 'Linux x86_64'
      });
    }, FIXED_NAVIGATOR_LANGUAGES);

    this.cursor = new GhostCursor(this.page);

    console.log(`🧬 指纹: viewport=${this.accountProfile.viewport.width}x${this.accountProfile.viewport.height}, UA片段=${this.accountProfile.userAgent.match(/Chrome\/\d+/)?.[0] || 'Chrome'}`);
    console.log(`📊 浏览器版本: ${await this.browser.version()}`);
  }

  // 监听请求，捕获请求头中的 anti-content
  async setupRequestInterception() {
    this.page.on('request', (request) => {
      const url = request.url();
      const headers = request.headers();
      const antiContent = headers['anti-content'];
      if (!antiContent) return;

      if (url.includes(CONFIG.targetApiEndpoint)) {
        this.capturedData.antiContent = antiContent;
        this.capturedData.apiRequestCaptured = true;
        this.capturedData.orderRequestHeaders = headers;
        if (request.method() === 'POST') {
          const postData = request.postData();
          if (postData) this.capturedData.orderRequestBody = postData;
        }
        console.log('\n🎯 捕获到订单查询请求:');
        console.log('   URL:', url);
        console.log('   方法:', request.method());
        console.log('   ✅ 捕获到 anti-content:', antiContent);
      } else if (url.includes(CONFIG.targetApiEndpointPlan)) {
        this.capturedData.antiContentPlan = antiContent;
        console.log('\n🎯 捕获到预估销量查询请求:');
        console.log('   URL:', url);
        console.log('   方法:', request.method());
        console.log('   ✅ 捕获到 anti-content (预估销量):', antiContent);
      } else if (url.includes(CONFIG.targetApiEndpointDate)) {
        this.capturedData.antiContentDate = antiContent;
        console.log('\n🎯 捕获到生产日期查询请求:');
        console.log('   URL:', url);
        console.log('   方法:', request.method());
        console.log('   ✅ 捕获到 anti-content (生产日期):', antiContent);
      }
    });
  }

  // 自动登录
  async autoLogin() {
    console.log('\n🌐 开始登录流程，直接登录...');

    try {
      console.log(`📝 导航到登录URL: ${CONFIG.loginUrl}`);
      await this.page.goto(CONFIG.loginUrl, {
        waitUntil: 'domcontentloaded',
        timeout: CONFIG.timeouts.pageLoad
      });
      console.log('✅ 登录页面加载成功');

      // 切换到"账号登录"标签
      try {
        const tabContainer = await this.page.$('.Common_operationTabs__3TW7c');
        if (tabContainer) {
          const items = await this.page.$$('.Common_operationTabs__3TW7c .Common_item__3diIn');
          if (items && items.length >= 2) {
            const secondClass = await this.page.evaluate(el => el.className, items[1]);
            if (!secondClass || !secondClass.includes('Common_checked__1oLdj')) {
              await this.humanLikeClick(items[1]);
              console.log('   ✅ 已切换到账号登录标签');
              await new Promise(r => setTimeout(r, 500));
            }
          }
        }
      } catch (e) {}

      // 填写用户名和密码
      const usernameEl = await this.page.$('#usernameId');
      const passwordEl = await this.page.$('#passwordId');

      if (usernameEl && passwordEl) {
        try {
          const existingUser = await this.page.evaluate(el => el.value, usernameEl).catch(() => '');
          if (!existingUser && this.loginCredentials && this.loginCredentials.username) {
            await this.humanLikeType(usernameEl, this.loginCredentials.username);
            console.log('   ✅ 已输入用户名');
          }
        } catch (e) {}

        try {
          const existingPass = await this.page.evaluate(el => el.value, passwordEl).catch(() => '');
          if (!existingPass && this.loginCredentials && this.loginCredentials.password) {
            await this.humanLikeType(passwordEl, this.loginCredentials.password);
            console.log('   ✅ 已输入密码');
          }
        } catch (e) {}

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

            await this.humanLikeClick(loginButton);
            console.log('   ✅ 尝试点击登录按钮进行自动登录');

            await navigationPromise;
          } else {
            await this.page.keyboard.press('Enter').catch(() => {});
            console.log('   ℹ️ 未找到明确的登录按钮，已尝试按 Enter');
          }
        } catch (e) {}
      }

      console.log('⏳ 等待登录处理...');

      const startTime = Date.now();
      const maxWaitTime = 180000; // 3分钟

      while (Date.now() - startTime < maxWaitTime) {
        let verificationCodeInput = null;

        try {
          verificationCodeInput = await this.page.$('input[placeholder="请输入短信验证码"]');
        } catch (elementError) {
          verificationCodeInput = null;
        }

        if (verificationCodeInput) {
          console.log('📱 检测到验证码输入框，需要人工干预，终止脚本');
          throw new Error('VERIFICATION_CODE_NEEDED');
        } else {
          console.log('✅ 登录成功');
          return true;
        }
      }

      console.log('❌ 登录超时（3分钟），退出');
      return false;

    } catch (error) {
      console.log('❌ 登录过程出现错误:', error.message);
      if (error.message === 'VERIFICATION_CODE_NEEDED') {
        throw error;
      }
      return false;
    }
  }

  // 捕获Cookies
  async captureCookies() {
    console.log('\n🍪 捕获Cookies...');
    const cookies = await this.page.cookies();
    let cookieStr = '';
    cookies.forEach((cookie, index) => {
      if (index > 0) cookieStr += '; ';
      cookieStr += `${cookie.name}=${cookie.value}`;
    });
    this.capturedData.cookieString = cookieStr;
    console.log('   ✅  已构造 Cookie字符串');
    return cookies;
  }

  // 等待订单查询API请求
  async waitForAPIRequest() {
    await this.waitForPageTransition('order/management', {
      timeout: 15000,
      stableWaitMs: 1000
    });

    try {
      await this.page.waitForSelector('[data-testid="beast-core-table"]', {
        timeout: 10000,
        visible: true
      });
      console.log('   ✅ 页面核心元素已加载');
    } catch (e) {
      console.log('   ⚠️ 核心元素未出现，但 URL 已变，继续执行');
    }

    console.log(`✅ 登录成功，已进入订单管理页面：,${this.page.url()}`);
    await this.randomScroll();
    await this.waitForReading();
    await this.checkOverlaysLightweight();

    const startTime = Date.now();
    const maxWaitTime = 300000; // 5分钟
    let retryCount = 0;
    const maxRetries = 3;
    let needReLogin = false;

    while (!this.capturedData.antiContent && (Date.now() - startTime) < maxWaitTime) {
      const currentUrl = this.page.url();

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
            await new Promise(resolve => setTimeout(resolve, 3000));
            continue;
          } catch (error) {
            console.log(`❌ 重新导航失败: ${error.message}`);
            let urlAfterFail = '';
            try {
              urlAfterFail = this.page.url();
            } catch (e) {}
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

      await this.randomScroll();
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
      return true;
    } else {
      console.log(`❌ 在 ${maxWaitTime / 1000 / 60} 分钟内未捕获到API请求或未获取到anti-content参数`);
      return false;
    }
  }

  // 捕获预估销量anti-content（已注释，保留未用）
  async capturePlanAntiContent() {
    // ... 保持不变，但实际未调用
  }

  // 捕获生产日期anti-content（已注释，保留未用）
  async captureDateAntiContent() {
    // ... 保持不变，但实际未调用
  }

  async run() {
    try {
      console.log('🎬 开始执行拼多多订单数据捕获脚本');
      const headlessMode = process.env.HEADLESS === 'true' ? '无头模式（定时触发）' : '有头模式（调试/手动运行）';
      console.log(`🔧 运行模式: ${headlessMode}`);
      console.log(`🔧 HEADLESS 环境变量: ${process.env.HEADLESS || '未设置（默认有头）'}`);
      await this.init();
      await this.setupRequestInterception();

      console.log(`\n📝 登录信息: 用户 ${this.loginCredentials.username}`);

      let loginSuccess = await this.autoLogin();

      if (!loginSuccess) {
        console.log('❌ 登录失败，程序退出');
        return;
      }

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

            console.log('🌐 重新执行登录流程...');
            try {
              await this.page.goto(CONFIG.loginUrl, {
                waitUntil: 'domcontentloaded',
                timeout: CONFIG.timeouts.pageLoad
              });

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
            throw error;
          }
        }
      }

      if (!apiCaptured) {
        throw new Error('未捕获到订单查询API请求，无法获取anti-content参数');
      }

      await this.captureCookies();

    } catch (error) {
      console.error('❌ 脚本执行出错:', error.message);
      throw error;

    } finally {
      if (this.browser) {
        try {
          await this.browser.close();
          await new Promise(resolve => setTimeout(resolve, 1000));
          console.log('👋 浏览器已关闭');
        } catch (closeError) {
          console.log('⚠️ 关闭浏览器时出现错误:', closeError.message);
        }
      }

      // 缓存清理策略（保留不变）
      try {
        const fs = require('fs');
        const path = require('path');

        const timeFile = path.join(this.userDataDir, 'last_cache_clean.txt');
        const now = new Date();
        const dayOfWeek = now.getDay();
        const todayStr = now.toISOString().slice(0, 10);

        let lastCleanDate = null;
        if (fs.existsSync(timeFile)) {
          lastCleanDate = fs.readFileSync(timeFile, 'utf8').trim();
        }

        const shouldClean = (dayOfWeek === 5 && lastCleanDate !== todayStr);

        if (shouldClean) {
          console.log('🧹 开始清理浏览器缓存（周五例行清理）');

          const dirsToClean = [
            'Default/Cache',
            'Default/Code Cache',
            'Default/GPUCache',
            'Default/Media Cache',
            'Default/Offline Cache',
            'GrShaderCache',
            'ShaderCache',
            'DawnCache',
            'blob_storage',
            'File System'
          ];

          for (const relativePath of dirsToClean) {
            const fullPath = path.join(this.userDataDir, relativePath);
            if (fs.existsSync(fullPath)) {
              try {
                fs.rmSync(fullPath, { recursive: true, force: true });
                console.log(`   ✅ 已清理: ${relativePath}`);
              } catch (e) {
                console.log(`   ⚠️ 清理失败 ${relativePath}: ${e.message}`);
              }
            }
          }

          fs.writeFileSync(timeFile, todayStr);
          console.log('✅ 周五缓存清理完成');
        } else {
          if (dayOfWeek !== 5) {
            console.log('   ℹ️ 不是周五，跳过缓存清理');
          } else {
            console.log('   ℹ️ 周五已清理过，跳过本次清理');
          }
        }

        const lockFiles = ['SingletonLock', 'SingletonCookie'];
        const possibleLockDirs = [this.userDataDir, path.join(this.userDataDir, 'Default')];
        for (const lockFile of lockFiles) {
          for (const lockDir of possibleLockDirs) {
            const lockFilePath = path.join(lockDir, lockFile);
            if (fs.existsSync(lockFilePath)) {
              try {
                fs.unlinkSync(lockFilePath);
                console.log(`   ✅ 已删除锁文件: ${lockFile} (位于: ${lockDir})`);
              } catch (e) {
                console.log(`   ⚠️ 无法删除锁文件 ${lockFile}: ${e.message}`);
              }
            }
          }
        }

        const defaultDir = path.join(this.userDataDir, 'Default');
        if (fs.existsSync(defaultDir)) {
          try {
            const files = fs.readdirSync(defaultDir);
            for (const file of files) {
              if (file.includes('DevToolsActivePort') || file.endsWith('.sock') || file.endsWith('.socket')) {
                const filePath = path.join(defaultDir, file);
                try {
                  fs.unlinkSync(filePath);
                  console.log(`   ✅ 已删除临时文件: ${file}`);
                } catch (e) {}
              }
            }
          } catch (e) {}
        }

        const crashDir = path.join(defaultDir, 'Crashpad');
        if (fs.existsSync(crashDir)) {
          try {
            require('child_process').execSync(`rm -rf "${crashDir}"`, { stdio: 'ignore' });
            console.log('   ✅ 已清理崩溃转储目录');
          } catch (e) {}
        }

        const possibleDmpDirs = [this.userDataDir, defaultDir];
        for (const dmpDir of possibleDmpDirs) {
          if (fs.existsSync(dmpDir)) {
            try {
              const files = fs.readdirSync(dmpDir);
              for (const file of files) {
                if (file.endsWith('.dmp')) {
                  const filePath = path.join(dmpDir, file);
                  try {
                    fs.unlinkSync(filePath);
                    console.log(`   ✅ 已删除崩溃文件: ${file} (位于: ${dmpDir})`);
                  } catch (e) {}
                }
              }
            } catch (e) {}
          }
        }

      } catch (cleanupError) {
        console.log('⚠️ 清理过程中出现错误:', cleanupError.message);
      }

      console.log('🏁 程序执行完毕');
    }
  }
}

// 更新单个账号
async function updateAccount(username, password, verificationCode, accountIndex = 0) {
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
    const crawler = new PDDOrderCrawler({ username, password }, `./puppeteer_user_data/${username}`, verificationCode, supabase, accountIndex);
    await crawler.run();

    const hasAntiContent = crawler.capturedData.antiContent && crawler.capturedData.antiContent.trim() !== '';

    if (!hasAntiContent) {
      console.log(`⚠️  账号 ${username} 未捕获到完整的 anti_content 数据，跳过上传`);
      console.log('\n' + '='.repeat(50));
      return;
    }

    const accountData = {
      username,
      anti_content: crawler.capturedData.antiContent,
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
    if (error.message === 'VERIFICATION_CODE_NEEDED') {
      throw error;
    }
    console.log(`❌ 更新账号 ${username} 失败:`, error.message);
    console.error(error.stack);
  }
}

// 主函数（带重试）
async function main() {
  const fs = require('fs');
  const accountsJson = process.env.PDD_ACCOUNTS;
  if (!accountsJson) {
    console.log('❌ PDD_ACCOUNTS_JSON环境变量未设置');
    return;
  }

  const MAX_RETRIES = 2; // 最大重试运行脚本次数
  const RETRY_DELAY = 10000; // 10秒

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      console.log(`\n========== 开始第 ${attempt} 次尝试 ==========`);
      const accounts = JSON.parse(accountsJson).accounts;

      for (const [accountIndex, account] of accounts.entries()) {
        const username = account.username;
        const password = process.env[`PASSWORD_${username.toUpperCase()}`];
        if (!password) {
          console.log(`❌ 账号 ${username} 的密码未设置，跳过`);
          continue;
        }

        await updateAccount(username, password, null, accountIndex);
      }

      console.log('\n🎉 所有账号更新完成');
      return; // 成功，退出函数

    } catch (error) {
      if (error.message === 'VERIFICATION_CODE_NEEDED' && attempt < MAX_RETRIES) {
        console.log(`⚠️ 检测到需要验证码，${RETRY_DELAY / 1000}秒后进行第 ${attempt + 1} 次重试...`);
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
        // 继续下一次循环
      } else if (error.message === 'VERIFICATION_CODE_NEEDED' && attempt === MAX_RETRIES) {
        console.log('🚫 已重试多次，仍然需要验证码，终止脚本');
        // 如果存在 GitHub Actions 输出，保留（但在 ClawCloud 中可能不需要）
        if (process.env.GITHUB_OUTPUT) {
          fs.appendFileSync(process.env.GITHUB_OUTPUT, 'verification_needed=true\n');
        }
        process.exit(1);
      } else {
        // 其他错误
        console.log('❌ 执行出错:', error.message);
        process.exit(1);
      }
    }
  }
}

main().catch(console.error);