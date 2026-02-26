const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { createClient } = require('@supabase/supabase-js');
const { execSync } = require('child_process');
const { createCursor } = require('ghost-cursor'); // 新增：导入 ghost-cursor

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
    headless: false,
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
      // 新增：更多反检测参数
      '--disable-blink-features=AutomationControlled',
      '--disable-sync',
      '--no-default-browser-check',
      '--disable-notifications'
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
    this.cursor = null; // 将在初始化页面后创建
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
    // 用于记录上次清理缓存的时间
    this.lastCacheCleanTime = null;
  }

  // 新增：模拟用户随机滚动（使用鼠标滚轮）
  async randomScroll() {
    try {
      const direction = Math.random() > 0.7 ? -1 : 1; // 70%向下，30%向上
      const distance = (Math.random() * 200 + 100) * direction; // 200~300px

      await this.page.mouse.wheel({ deltaY: distance });
      await new Promise(r => setTimeout(r, Math.random() * 1000 + 500));

      console.log(`   👆 模拟鼠标滚轮滚动 (方向: ${direction > 0 ? '下' : '上'}, 距离: ${Math.abs(distance).toFixed(0)}px)`);
    } catch (e) {
      // 忽略滚动错误
    }
  }

  // 新增：模拟页面阅读停留（随机2~5秒）
  async waitForReading() {
    const delay = 2000 + Math.random() * 3000;
    console.log(`   👁️ 模拟阅读，停留 ${(delay/1000).toFixed(1)} 秒`);
    await new Promise(r => setTimeout(r, delay));
  }

  // 修改：使用 ghost-cursor 模拟人类点击（带重试和弹窗检查）
  async humanLikeClick(selectorOrElement) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        // 1. 获取元素
        let element;
        if (typeof selectorOrElement === 'string') {
          element = await this.page.$(selectorOrElement);
        } else {
          element = selectorOrElement;
        }
        if (!element) throw new Error('元素不存在');

        // 2. 第一次弹窗检查
        await this.checkOverlaysLightweight();

        // 3. 使用 ghost-cursor 移动并点击
        const box = await element.boundingBox();
        if (!box) throw new Error('元素不可见');

        // 生成点击点（在元素内部随机偏移）
        const x = box.x + box.width * (0.3 + Math.random() * 0.4);
        const y = box.y + box.height * (0.3 + Math.random() * 0.4);

        // 移动鼠标（使用 ghost-cursor 的移动方法）
        await this.cursor.moveTo({ x, y });

        // 4. 第二次弹窗检查（移动后、点击前）
        await this.checkOverlaysLightweight();
        await new Promise(r => setTimeout(r, 100 + Math.random() * 100));

        // 5. 执行点击（使用 ghost-cursor 的点击方法）
        await this.cursor.click();

        // 点击后短暂等待
        await new Promise(r => setTimeout(r, 100));
        return; // 成功则退出

      } catch (err) {
        console.log(`   ⚠️ 人类点击尝试 ${attempt} 失败: ${err.message}`);
        if (attempt === 3) {
          // 最后一次失败，回退到原生点击
          console.log('   ⚠️ 回退到原生 click()');
          if (typeof selectorOrElement === 'string') {
            await this.page.click(selectorOrElement).catch(() => {});
          } else {
            await selectorOrElement.click().catch(() => {});
          }
        } else {
          // 尝试关闭可能出现的弹窗
          await this.checkOverlaysLightweight();
          await new Promise(r => setTimeout(r, 500));
        }
      }
    }
  }

  // 保留原有 humanLikeType（未修改）
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

  // 保留原有 checkOverlaysLightweight（未修改）
  async checkOverlaysLightweight() {
    try {
      let closedAny = false;
      const popupSelector = 'i[data-testid="beast-core-modal-icon-close"]';
      const popupExists = await this.page.$(popupSelector).catch(() => null);
      if (popupExists) {
        await this.page.click(popupSelector);
        closedAny = true;
        console.log('   ✅ 轻量检查：已关闭弹窗');
        await new Promise(r => setTimeout(r, 50));
      }
      const bannerSelector = '.mc-header-platform-close';
      const bannerExists = await this.page.$(bannerSelector).catch(() => null);
      if (bannerExists) {
        await this.page.evaluate(() => { // 滚动到顶部
          window.scrollTo({ top: 0, behavior: 'smooth' });
        });
        await this.page.waitForFunction( // 等待滚动到顶部
          () => window.scrollY === 0,
          { timeout: 5000, polling: 100 }
        );        
        try {
          await this.page.click(bannerSelector);
          closedAny = true;
          console.log('   ✅ 轻量检查：已关闭条幅');
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
      return false;
    }
  }

  // 保留原有 waitForPageTransition（未修改）
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

  // 初始化浏览器（修改：创建 cursor）
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
      userDataDir: this.userDataDir
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

    // 设置用户代理（可随机化，但此处保留原样）
    await this.page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36'
    );

    await this.page.setExtraHTTPHeaders({
      'Accept-Language': 'zh-CN,zh;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br, zstd',
    });

    await this.page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
      Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh'] });
    });

    // 初始化 ghost-cursor
    this.cursor = createCursor(this.page);

    console.log('✅ 浏览器启动成功');
    console.log(`📊 浏览器版本: ${await this.browser.version()}`);
  }

  // 设置请求拦截（未修改）
  async setupRequestInterception() {
    await this.page.setRequestInterception(true);

    this.page.on('request', async (request) => {
      const url = request.url();

      if (url.includes(CONFIG.targetApiEndpoint)) {
        await this.checkOverlaysLightweight();
        
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
        await this.checkOverlaysLightweight();
        
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
        await this.checkOverlaysLightweight();
        
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

  // 自动登录（未修改，但内部 humanLikeClick 已更新，所以无需改动）
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
            await this.humanLikeType(usernameEl, this.loginCredentials.username);
            console.log('   ✅ 已输入用户名');
          }
        } catch (e) { }

        // 填充密码
        try {
          const existingPass = await this.page.evaluate(el => el.value, passwordEl).catch(() => '');
          if (!existingPass && this.loginCredentials && this.loginCredentials.password) {
            await this.humanLikeType(passwordEl, this.loginCredentials.password);
            console.log('   ✅ 已输入密码');
          }
        } catch (e) { }

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

            await this.humanLikeClick(loginButton);
            console.log('   ✅ 尝试点击登录按钮进行自动登录');

            await navigationPromise;
          } else {
            await this.page.keyboard.press('Enter').catch(() => { });
            console.log('   ℹ️ 未找到明确的登录按钮，已尝试按 Enter');
          }
        } catch (e) {
          // 忽略点击失败
        }
      }

      // 等待登录结果，检查是否跳转或需要验证码
      console.log('⏳ 等待登录处理...');

      const startTime = Date.now();
      const maxWaitTime = 180000; // 3分钟
      const pollInterval = 2000;

      while (Date.now() - startTime < maxWaitTime) {
        let verificationCodeInput = null;

        try {
        } catch (urlError) {
          console.log('   ⚠️ 获取URL失败，页面可能正在导航，等待后重试...');
          await new Promise(resolve => setTimeout(resolve, 1000));
          continue;
        }

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
          return true;
        } catch (e) {
          console.log('   ⚠️ 核心元素未出现，但 URL 已变，继续执行');
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

      console.log('❌ 登录超时（3分钟），退出');
      return false;

    } catch (error) {
      console.log('❌ 登录过程出现错误:', error.message);
      return false;
    }
  }

  // 保留原有验证码处理方法（未修改）
  async handleVerificationCode(verificationCodeInput) {
    console.log('📱 检测到验证码输入框，可能需要短信验证码');

    const confirmButton = await this.page.$('button[data-tracking-click-viewid="account_login_confirmation"]');

    let verificationCode = null;
    let lastVerificationUpdateTime = null;

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
            lastVerificationUpdateTime = updatedAt;
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
                lastVerificationUpdateTime = updatedAt;
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

        let verificationCodeWaitStart = Date.now();
        const maxVerificationCodeWait = 60000;

        let verificationCodeAccepted = false;
        let verificationCodeDisappearTime = null;

        while (Date.now() - verificationCodeWaitStart < maxVerificationCodeWait) {
          let currentUrl = '';
          try {
            currentUrl = this.page.url();
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
              // 增加一次重新输入验证码的机会
              console.log('🔄 检测到验证码错误，尝试重新获取验证码...');
              const retryStartTime = Date.now();
              const maxRetryWaitTime = 120000; // 120秒
              const retryPollInterval = 5000; // 每5秒检查一次
              let newVerificationCode = null;
              let newUpdatedAt = null;

              while (Date.now() - retryStartTime < maxRetryWaitTime && !newVerificationCode) {
                await new Promise(resolve => setTimeout(resolve, retryPollInterval));
                console.log(`   🔍 第${Math.floor((Date.now() - retryStartTime) / retryPollInterval)}次检查更新...`);

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
                        if (!lastVerificationUpdateTime || updatedAt > lastVerificationUpdateTime) {
                          newVerificationCode = data.code;
                          newUpdatedAt = updatedAt;
                          console.log(`   🔑 发现更新的验证码: ${newVerificationCode} (更新时间: ${updatedAt.toLocaleString()})`);
                          break;
                        } else {
                          console.log(`   ℹ️  验证码未更新，最近更新时间: ${updatedAt.toLocaleString()}`);
                        }
                      }
                    }
                  } catch (e) {
                    // 忽略查询错误
                  }
                }
              }

              if (newVerificationCode) {
                // 使用新验证码重新输入
                try {
                  await verificationCodeInput.click({ clickCount: 3 });
                  await verificationCodeInput.press('Backspace');
                  await verificationCodeInput.type(newVerificationCode, { delay: 50 });
                  console.log('   ✅ 已重新输入验证码');

                  if (confirmButton) {
                    const navigationPromise = this.page.waitForNavigation({
                      waitUntil: 'domcontentloaded',
                      timeout: 5000
                    }).catch(() => null);

                    await confirmButton.click();
                    console.log('   ✅ 已重新点击确认按钮');

                    await navigationPromise;

                    // 重置等待计时器
                    verificationCodeWaitStart = Date.now();
                    lastVerificationUpdateTime = newUpdatedAt;
                    console.log('🔄 验证码已更新，继续等待跳转...');
                    continue; // 继续主循环
                  }
                } catch (e) {
                  console.log('   ⚠️  重新输入验证码失败:', e.message);
                  return false;
                }
              } else {
                console.log('❌ 等待超时，未获取到更新的验证码');
                return false;
              }
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

  // 销售订单查询页面（未修改）
  async waitForAPIRequest() {
    console.log(`✅ 登录成功，已进入订单管理页面：,${this.page.url()}`);
    await this.waitForReading(); // 模拟阅读，等待2-5秒
    await this.randomScroll(); // 模拟滚动页面
    await this.checkOverlaysLightweight(); // 检查遮罩层

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

  // 修改：通过点击菜单导航到预估销量页面（使用极简等待+元素检测）
  async capturePlanAntiContent() {
    console.log('\n📊 导航到预估销量查询页面...');
    try {
      await this.checkOverlaysLightweight();

      const linkSelector = 'a[data-report-click-text="预约送货"]';
      await this.page.waitForSelector(linkSelector, {
        timeout: 10000,
        visible: true
      });

      const targetLink = await this.page.$(linkSelector);
      if (!targetLink) {
        throw new Error('未找到预约送货链接');
      }

      await this.humanLikeClick(targetLink);
      console.log('   ✅ 已点击"预约送货"链接，等待页面加载...');

      await this.waitForPageTransition('appointment-delivery', {
        timeout: 15000,
        stableWaitMs: 1000
      });

      try {
        await this.page.waitForSelector('[data-testid="beast-core-table"]', {
          timeout: 10000,
          visible: true
        });
        console.log('   ✅ 页面核心元素已加载，已进入预估销量查询页面');
        await this.waitForReading();
        await this.randomScroll();
      } catch (e) {
        console.log('   ⚠️ 核心元素未出现，但 URL 已变，继续执行');
      }

      const startTime = Date.now();
      const maxWaitTime = 300000;
      while (!this.capturedData.antiContentPlan && (Date.now() - startTime) < maxWaitTime) {
        await this.randomScroll();
        await new Promise(resolve => setTimeout(resolve, 1000));
        const elapsedSeconds = Math.floor((Date.now() - startTime) / 1000);
        if (elapsedSeconds > 0 && elapsedSeconds % 30 === 0) {
          console.log(`   已等待 ${elapsedSeconds} 秒...`);
        }
      }

      if (this.capturedData.antiContentPlan) {
        return true;
      } else {
        console.log(`❌ 在 ${maxWaitTime / 1000 / 60} 分钟内未捕获到预估销量查询API请求`);
        return false;
      }
    } catch (error) {
      console.log(`   ⚠️ ${error.message}，回退到直接导航`);
      await this.page.goto('https://mc.pinduoduo.com/ddmc-mms/appointment-delivery', {
        waitUntil: 'networkidle0',
        timeout: 30000
      });
      return false;
    }
  }

  // 修改：通过点击菜单导航到生产日期页面（使用极简等待+元素检测）
  async captureDateAntiContent() {
    console.log('\n📅 导航到生产日期查询页面...');
    try {
      await this.checkOverlaysLightweight();

      console.log('   🔍 等待"商品排期"链接出现...');
      const linkSelector = 'a[data-report-click-text="商品排期"]';
      await this.page.waitForSelector(linkSelector, {
        timeout: 10000,
        visible: true
      });

      const targetLink = await this.page.$(linkSelector);
      if (!targetLink) {
        throw new Error('未找到商品排期链接');
      }

      await this.humanLikeClick(targetLink);
      console.log('   ✅ 已模拟人类点击"商品排期"链接');

      await this.waitForPageTransition('goods-schedule', {
        timeout: 15000,
        stableWaitMs: 500
      });

      try {
        await this.page.waitForSelector('[data-testid="beast-core-table"]', {
          timeout: 10000,
          visible: true
        });
        console.log('   ✅ 页面核心元素已加载');
        await this.waitForReading();
        await this.randomScroll();
      } catch (e) {
        console.log('   ⚠️ 核心元素未出现，但 URL 已变，继续执行');
      }

      console.log('✅ 已进入生产日期查询页面');

      console.log('⏳ 等待生产日期查询API请求...');
      const startTime = Date.now();
      const maxWaitTime = 300000;
      while (!this.capturedData.antiContentDate && (Date.now() - startTime) < maxWaitTime) {
        await this.randomScroll();
        await new Promise(resolve => setTimeout(resolve, 1000));
        const elapsedSeconds = Math.floor((Date.now() - startTime) / 1000);
        if (elapsedSeconds > 0 && elapsedSeconds % 30 === 0) {
          console.log(`   已等待 ${elapsedSeconds} 秒...`);
        }
      }

      if (this.capturedData.antiContentDate) {
        return true;
      } else {
        console.log(`❌ 在 ${maxWaitTime / 1000 / 60} 分钟内未捕获到生产日期查询API请求`);
        return false;
      }
    } catch (error) {
      console.log(`   ⚠️ ${error.message}，回退到直接导航`);
      await this.page.goto('https://mc.pinduoduo.com/ddmc-supplier-product/goods-schedule', {
        waitUntil: 'networkidle0',
        timeout: 30000
      });
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

      console.log('\n📊 开始捕获预估销量查询参数...');
      const planCaptured = await this.capturePlanAntiContent();
      if (!planCaptured && !this.capturedData.antiContentPlan) {
        console.log('⚠️ 预估销量查询参数捕获失败，继续执行...');
      }

      console.log('\n📅 开始捕获生产日期查询参数...');
      const dateCaptured = await this.captureDateAntiContent();
      if (!dateCaptured && !this.capturedData.antiContentDate) {
        console.log('⚠️ 生产日期查询参数捕获失败，继续执行...');
      }

      await this.captureCookies();

    } catch (error) {
      console.error('❌ 脚本执行出错:', error.message);

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

      // 新增：缓存清理策略（删除 Cache 目录，每周四清理一次）
      try {
        const fs = require('fs');
        const path = require('path');
      
        const cacheDir = path.join(this.userDataDir, 'Default', 'Cache');
        const timeFile = path.join(this.userDataDir, 'last_cache_clean.txt');
      
        const now = new Date();
        const dayOfWeek = now.getDay(); // 0 = Sunday, 1 = Monday, ... 6 = Saturday
        const todayStr = now.toISOString().slice(0, 10); // 格式: YYYY-MM-DD
      
        // 读取上次清理日期
        let lastCleanDate = null;
        if (fs.existsSync(timeFile)) {
          lastCleanDate = fs.readFileSync(timeFile, 'utf8').trim();
        }
      
        // 判断条件：今天是周一 且 上次清理日期不是今天
        const shouldClean = (dayOfWeek === 1 && lastCleanDate !== todayStr);
      
        if (shouldClean) {
          if (fs.existsSync(cacheDir)) {
            fs.rmSync(cacheDir, { recursive: true, force: true });
            console.log('   ✅ 已清理 Cache 目录（周一首次清理）');
            fs.writeFileSync(timeFile, todayStr); // 记录本次清理日期
          } else {
            console.log('   ℹ️ Cache 目录不存在，无需清理');
          }
        } else {
          if (dayOfWeek !== 1) {
            console.log('   ℹ️ 不是周一，跳过 Cache 清理');
          } else {
            console.log('   ℹ️ 周一已清理过，跳过本次清理');
          }
        }

        // 原有的其他清理代码（锁文件、崩溃转储等）
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

// 以下为外部函数（未修改）
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

    const hasAntiContent = crawler.capturedData.antiContent && crawler.capturedData.antiContent.trim() !== '';
    const hasAntiContentPlan = crawler.capturedData.antiContentPlan && crawler.capturedData.antiContentPlan.trim() !== '';
    const hasAntiContentDate = crawler.capturedData.antiContentDate && crawler.capturedData.antiContentDate.trim() !== '';

    if (!hasAntiContent || !hasAntiContentPlan || !hasAntiContentDate) {
      console.log(`⚠️  账号 ${username} 未捕获到完整的 anti_content 数据，跳过上传`);
      console.log(`   状态: anti_content=${hasAntiContent ? '有值' : '空'}, anti_content_Plan=${hasAntiContentPlan ? '有值' : '空'}, anti_content_Date=${hasAntiContentDate ? '有值' : '空'}`);
      console.log('\n' + '='.repeat(50));
      return;
    }

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
  const accountsJson = process.env.PDD_ACCOUNTS;
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