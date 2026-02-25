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
    headless: false, //'new', 为新方法，字符串格式。要录制视频，改为有头模式
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
      '--disk-cache-size=52428800', // 缓存大小50MB
      '--aggressive-cache-discard', // 缓存清理策略,激进地丢弃缓存，减少内存占用
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
      const { scrollY, maxScroll } = await this.page.evaluate(() => ({
        scrollY: window.scrollY,
        maxScroll: document.body.scrollHeight - window.innerHeight
      }));

      // 边界智能处理
      let direction;
      if (scrollY < 100) {
        // 接近顶部，强制向下
        direction = 1;
      } else if (scrollY > maxScroll - 100) {
        // 接近底部，强制向上
        direction = -1;
      } else {
        // 随机方向，70%向下，30%向上（模拟人类阅读习惯）
        direction = Math.random() > 0.7 ? -1 : 1;
      }

      // 随机距离 200-700px
      const distance = (Math.random() * 500 + 200) * direction;

      // 执行平滑滚动
      await this.page.evaluate(d => window.scrollBy({ top: d, behavior: 'smooth' }), distance);

      // 随机停顿，模拟阅读时间
      await new Promise(r => setTimeout(r, Math.random() * 1000 + 500));

      console.log(`   👆 模拟用户滚动 (方向: ${direction > 0 ? '下' : '上'}, 距离: ${Math.abs(distance).toFixed(0)}px)`);

    } catch (e) {
      // 忽略滚动错误（如页面突然关闭）
    }
  }

  // 新增：模拟人类-like点击（带鼠标移动轨迹和随机偏移）
  async humanLikeClick(selectorOrElement) {
    try {
      // 1. 获取元素 - 支持选择器字符串或 ElementHandle 对象
      let element;
      if (typeof selectorOrElement === 'string') {
        element = await this.page.$(selectorOrElement);
      } else {
        element = selectorOrElement; // 已经是 ElementHandle 对象
      }

      if (!element) {
        console.log(`   ⚠️ 元素不存在: ${typeof selectorOrElement === 'string' ? selectorOrElement : '提供的元素对象'}`);
        return;
      }

      // 轻量级检查并关闭可能存在的弹窗/条幅
      await this.checkOverlaysLightweight();

      // 2. 获取元素位置和大小
      const box = await element.boundingBox();
      if (!box) {
        // 如果元素不可见，回退到普通点击
        console.log(`   ⚠️ 元素不可见，使用普通点击`);
        // 如果是字符串选择器，使用 page.click；否则使用元素点击
        if (typeof selectorOrElement === 'string') {
          await this.page.click(selectorOrElement);
        } else {
          await element.click();
        }
        return;
      }

      // 3. 随机点击元素内的偏移点（30%-70%区域）
      const x = box.x + box.width * (0.3 + Math.random() * 0.4);
      const y = box.y + box.height * (0.3 + Math.random() * 0.4);

      // 4. 分步移动鼠标（模拟人类轨迹）
      await this.page.mouse.move(x, y, { steps: 10 });

      // 5. 随机停顿（人类反应时间）
      await new Promise(resolve => setTimeout(resolve, Math.random() * 200 + 300));

      // 6. 按下、弹起（完整鼠标事件）
      await this.page.mouse.down();
      await new Promise(resolve => setTimeout(resolve, Math.random() * 50 + 30));
      await this.page.mouse.up();

      // 7. 等待 UI 更新
      await new Promise(resolve => setTimeout(resolve, 100));

    } catch (e) {
      // 8. 回退机制：如果上述过程失败，使用标准 page.click
      console.log(`   ⚠️ 人类模拟点击失败 (${e.message})，使用普通点击回退`);
      try {
        if (typeof selectorOrElement === 'string') {
          await this.page.click(selectorOrElement);
        } else {
          await selectorOrElement.click();
        }
      } catch (fallbackError) {
        console.log(`   ❌ 普通点击也失败: ${fallbackError.message}`);
      }
    }
  }

  // 新增：模拟人类-like输入（逐个字符输入，带随机延迟）
  async humanLikeType(selectorOrElement, text) {
    try {
      // 获取元素 - 支持选择器字符串或 ElementHandle 对象
      let element;
      if (typeof selectorOrElement === 'string') {
        element = await this.page.$(selectorOrElement);
      } else {
        element = selectorOrElement; // 已经是 ElementHandle 对象
      }

      if (!element) {
        console.log(`⚠️ 元素不存在: ${typeof selectorOrElement === 'string' ? selectorOrElement : '提供的元素对象'}`);
        return;
      }

      // 滚动到视口
      await element.scrollIntoViewIfNeeded();

      // 模拟点击聚焦（可选，但更安全）
      await element.click({ delay: Math.random() * 100 + 50 });
      await new Promise(r => setTimeout(r, Math.random() * 100 + 50));

      // 逐个字符输入
      for (const char of text) {
        await element.type(char, { delay: Math.random() * 100 + 50 });

        // 偶尔停顿，像人类思考
        if (Math.random() > 0.9) {
          await new Promise(r => setTimeout(r, Math.random() * 300 + 100));
        }
      }
    } catch (e) {
      console.log(`⚠️ 人类模拟输入失败，回退到普通输入: ${e.message}`);
      // 回退方案：使用 page.type 直接输入
      if (typeof selectorOrElement === 'string') {
        await this.page.type(selectorOrElement, text, { delay: 50 });
      } else {
        // 对于 ElementHandle，使用 type 方法
        await selectorOrElement.type(text, { delay: 50 });
      }
    }
  }

  // 新增：关闭页面弹窗和顶部条幅，使左侧菜单可点击
  async dismissPageOverlays() {
    console.log('🧹 检查并关闭页面弹窗和顶部条幅...');

    try {
      // 步骤1：关闭弹窗（优先）
      const popupSelector = 'i[data-testid="beast-core-modal-icon-close"]';
      const popupExists = await this.page.$(popupSelector).catch(() => null);
      if (popupExists) {
        await this.page.click(popupSelector);
        console.log('   ✅ 已关闭弹窗');
        // 等待弹窗消失动画和页面稳定
        await new Promise(r => setTimeout(r, 500));
      } else {
        console.log('   ℹ️ 未检测到弹窗');
      }

      // 步骤2：滚动到页面顶部（确保条幅可见）
      console.log('   🔼 正在滚动到顶部...');
      await this.page.evaluate(() => {
        window.scrollTo({ top: 0, behavior: 'smooth' }); // 平滑滚动，更自然
      });
      // 等待滚动完成（检测滚动位置是否稳定在0）
      await this.page.waitForFunction(
        () => window.scrollY === 0,
        { timeout: 5000, polling: 100 }
      );
      console.log('   ✅ 已滚动到顶部');

      // 步骤3：关闭顶部条幅
      const bannerSelector = '.mc-header-platform-close';
      const bannerExists = await this.page.$(bannerSelector).catch(() => null);
      if (bannerExists) {
        await this.page.click(bannerSelector);
        console.log('   ✅ 已关闭顶部条幅');
        await new Promise(r => setTimeout(r, 200));
      } else {
        console.log('   ℹ️ 未检测到顶部条幅');
      }

      return true;
    } catch (e) {
      console.log('   ⚠️ 关闭遮罩层时出错:', e.message);
      return false;
    }
  }

  // 新增：轻量级检查并关闭弹窗和条幅（不滚动到顶部）
  async checkOverlaysLightweight() {
    try {
      let closedAny = false;
      // 弹窗检查（直接点击）
      const popupSelector = 'i[data-testid="beast-core-modal-icon-close"]';
      const popupExists = await this.page.$(popupSelector).catch(() => null);
      if (popupExists) {
        await this.page.click(popupSelector);
        closedAny = true;
        console.log('   ✅ 轻量检查：已关闭弹窗');
        await new Promise(r => setTimeout(r, 50));
      }
      // 条幅检查（三级降级）
      const bannerSelector = '.mc-header-platform-close';
      const bannerExists = await this.page.$(bannerSelector).catch(() => null);
      if (bannerExists) {
        try {
          await this.page.click(bannerSelector);
          closedAny = true;
          console.log('   ✅ 轻量检查：已关闭条幅');
        } catch (clickError) {
          console.log('   🔄 轻量检查：首次点击失败，尝试滚动后点击...');
          try {
            await bannerExists.scrollIntoViewIfNeeded();
            await new Promise(r => setTimeout(r, 100)); // 等待滚动完成
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

  // 新增：极简版等待页面切换（URL轮询）
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
        // 等待稳定
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
    console.log(`💻 当前操作系统: ${process.platform} (${process.platform === 'win32' ? 'Windows' : process.platform === 'linux' ? 'Linux' : 'Mac'})`);


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

    // 显示标签页数量
    try {
      const pages = await this.browser.pages();
      console.log(`📑 当前标签页数量: ${pages.length}`);
    } catch (e) {
      console.log(`⚠️ 无法获取标签页数量: ${e.message}`);
    }

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
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
      Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh'] });
    });

    console.log('✅ 浏览器启动成功');
    console.log(`📊 浏览器版本: ${await this.browser.version()}`);
  }

  // 设置请求拦截    
  async setupRequestInterception() {
    await this.page.setRequestInterception(true);

    this.page.on('request', async (request) => {
      const url = request.url();

      if (url.includes(CONFIG.targetApiEndpoint)) {
        // 轻量级检查并关闭可能存在的弹窗/条幅
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
        // 轻量级检查并关闭可能存在的弹窗/条幅
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
        // 轻量级检查并关闭可能存在的弹窗/条幅
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

      // 切换到"账号登录"标签（并在切换前/后模拟滚动）
      try {
        const tabContainer = await this.page.$('.Common_operationTabs__3TW7c');
        if (tabContainer) {
          const items = await this.page.$$('.Common_operationTabs__3TW7c .Common_item__3diIn');
          if (items && items.length >= 2) {
            const secondClass = await this.page.evaluate(el => el.className, items[1]);
            if (!secondClass || !secondClass.includes('Common_checked__1oLdj')) {
              // 修改：使用 humanLikeClick 替代直接 click
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
            // 修改：使用 humanLikeType 替代直接 type
            await this.humanLikeType(usernameEl, this.loginCredentials.username);
            console.log('   ✅ 已输入用户名');
          }
        } catch (e) { }

        // 填充密码
        try {
          const existingPass = await this.page.evaluate(el => el.value, passwordEl).catch(() => '');
          if (!existingPass && this.loginCredentials && this.loginCredentials.password) {
            // 修改：使用 humanLikeType 替代直接 type
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

            // 修改：使用 humanLikeClick 替代直接 click
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
      await new Promise(resolve => setTimeout(resolve, 1000));

      const startTime = Date.now();
      const maxWaitTime = 180000; // 3分钟
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

      console.log('❌ 登录超时（3分钟），退出');
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
                        // 检查更新时间是否比之前记录的更近
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

  // 获取Cookies
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

  // 销售订单查询页面
  async waitForAPIRequest() {
    console.log('\n⏳ 等待页面自动发送订单查询请求...');
    console.log(`   初始URL: ${this.page.url()}`);
    await this.dismissPageOverlays(); // 先关闭弹窗和顶部条幅，确保菜单可点击

    const startTime = Date.now();
    const maxWaitTime = 900000; // 9分钟
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
            let urlAfterFail = '';
            try {
              urlAfterFail = this.page.url();
            } catch (e) {
              // 忽略错误
            }
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
      // 步骤1：先关闭弹窗和顶部条幅，确保菜单可点击
      await this.dismissPageOverlays();

      // 步骤2：等待并查找"预约送货"链接
      const linkSelector = 'a[data-report-click-text="预约送货"]';
      await this.page.waitForSelector(linkSelector, {
        timeout: 10000,
        visible: true
      });

      const targetLink = await this.page.$(linkSelector); // 获取链接元素
      if (!targetLink) {
        throw new Error('未找到预约送货链接');
      }

      // 步骤3：使用 humanLikeClick 模拟人类点击
      await this.humanLikeClick(targetLink);
      console.log('   ✅ 已点击"预约送货"链接，等待页面加载...');

      // 步骤4：等待 URL 切换（极简轮询）
      await this.waitForPageTransition('appointment-delivery', {
        timeout: 15000,
        stableWaitMs: 1000  // SPA 多等会儿稳定
      });

      // 步骤5：等待核心元素出现，确保页面完全加载
      try {
        await this.page.waitForSelector('[data-testid="beast-core-table"]', {
          timeout: 10000,
          visible: true
        });
        console.log('   ✅ 页面核心元素已加载');
      } catch (e) {
        console.log('   ⚠️ 核心元素未出现，但 URL 已变，继续执行');
      }

      console.log('✅ 已进入预估销量查询页面');

      console.log('⏳ 等待预估销量查询API请求...');
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
      // 步骤1：先关闭弹窗和顶部条幅，确保菜单可点击
      await this.dismissPageOverlays();

      // 步骤2：等待并查找"商品排期"链接
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

      // 步骤3：使用 humanLikeClick 模拟人类点击
      await this.humanLikeClick(targetLink);
      console.log('   ✅ 已点击"商品排期"链接（模拟人类点击）');

      // 步骤4：等待 URL 切换（极简轮询）
      await this.waitForPageTransition('goods-schedule', {
        timeout: 15000,
        stableWaitMs: 500
      });

      // 步骤5：等待核心元素出现，确保页面完全加载
      try {
        await this.page.waitForSelector('[data-testid="beast-core-table"]', {
          timeout: 10000,
          visible: true
        });
        console.log('   ✅ 页面核心元素已加载');
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
      await this.setupRequestInterception();// 设置请求拦截

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

              loginSuccess = await this.autoLogin(); // 执行登录
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
          await new Promise(resolve => setTimeout(resolve, 1000)); // 等待一小段时间确保进程完全退出
          console.log('👋 浏览器已关闭');
        } catch (closeError) {
          console.log('⚠️ 关闭浏览器时出现错误:', closeError.message);
        }
      }

      // 清理残留进程和文件
      try {
        console.log('🧹 开始清理残留文件...');
        const fs = require('fs');
        const path = require('path');

        // 2. 清理锁文件（可能在根目录或Default目录）
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

        // 3. 清理临时Socket文件（在Default目录下）
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
                } catch (e) {
                  // 忽略删除失败
                }
              }
            }
          } catch (e) {
            // 忽略读取目录失败
          }
        }

        // 4. 清理崩溃转储文件（在Default/Crashpad目录下）
        const crashDir = path.join(defaultDir, 'Crashpad');
        if (fs.existsSync(crashDir)) {
          try {
            require('child_process').execSync(`rm -rf "${crashDir}"`, { stdio: 'ignore' });
            console.log('   ✅ 已清理崩溃转储目录');
          } catch (e) {
            // 忽略删除失败
          }
        }

        // 5. 清理.dmp文件（可能在根目录或Default目录）
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
                  } catch (e) {
                    // 忽略删除失败
                  }
                }
              }
            } catch (e) {
              // 忽略读取目录失败
            }
          }
        }

        /*  
          // 6. 可选：清理HTTP缓存目录以立即释放空间（Default/Cache）
          const cacheDir = path.join(defaultDir, 'Cache');
          if (fs.existsSync(cacheDir)) {
              try {
                  require('child_process').execSync(`rm -rf "${cacheDir}"`, { stdio: 'ignore' });
                  console.log('   ✅ 已清理HTTP缓存目录，立即释放空间');
              } catch (e) {
                  // 忽略删除失败
              }
          }
          
          // 7. 可选：清理其他缓存目录
          const otherCacheDirs = ['Code Cache', 'GPUCache', 'ShaderCache', 'Service Worker'];
          for (const dirName of otherCacheDirs) {
              const dirPath = path.join(defaultDir, dirName);
              if (fs.existsSync(dirPath)) {
                  try {
                      require('child_process').execSync(`rm -rf "${dirPath}"`, { stdio: 'ignore' });
                      console.log(`   ✅ 已清理${dirName}目录`);
                  } catch (e) {
                      // 忽略删除失败
                  }
              }
          }
        */
      } catch (cleanupError) {
        console.log('⚠️ 清理过程中出现错误:', cleanupError.message);
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

    // 检查是否有有效的 anti_content 数据
    const hasAntiContent = crawler.capturedData.antiContent && crawler.capturedData.antiContent.trim() !== '';
    const hasAntiContentPlan = crawler.capturedData.antiContentPlan && crawler.capturedData.antiContentPlan.trim() !== '';
    const hasAntiContentDate = crawler.capturedData.antiContentDate && crawler.capturedData.antiContentDate.trim() !== '';

    // 只有三个字段全部有值时才上传
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