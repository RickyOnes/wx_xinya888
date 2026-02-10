// utils/duoduomai.js
// 拼多多多多买菜平台API测试模块
// 注意：以下域名需要在微信小程序后台配置为合法域名
// - https://mms.pinduoduo.com
// - https://mc.pinduoduo.com
// - https://apm.pinduoduo.com

const DUODUOMAI_CONFIG = {
  // 登录相关
  loginUrl: 'https://mms.pinduoduo.com/janus/api/auth',
  userInfoUrl: 'https://mms.pinduoduo.com/janus/api/new/userinfo',
  refreshTokenUrl: 'https://mms.pinduoduo.com/janus/api/refreshToken',
  
  // 子系统令牌
  getAuthTokenUrl: 'https://mms.pinduoduo.com/janus/api/subSystem/getAuthToken',
  maicaiLoginUrl: 'https://mc.pinduoduo.com/janus/api/subSystem/maicaiLogin',
  
  // 订单查询
  orderQueryUrl: 'https://mc.pinduoduo.com/cartman-mms/orderManagement/pageQueryDetail',
  
  // 其他接口
  mallInfoUrl: 'https://mc.pinduoduo.com/syndra-mms/supplier/commonMallInfo',
  
  // 存储键名
  cookieKey: 'duoduomai_cookies',
  tokenKey: 'duoduomai_token',
  userInfoKey: 'duoduomai_user_info'
};

/**
 * 测试域名连通性
 * @returns {Promise<Object>} 测试结果
 */
function testConnectivity() {
  return new Promise((resolve, reject) => {
    wx.request({
      url: 'https://mc.pinduoduo.com',
      method: 'GET',
      timeout: 10000,
      success: (res) => {
        // 302重定向是正常的，说明域名可访问但需要登录
        if (res.statusCode === 200 || res.statusCode === 302) {
          resolve({
            success: true,
            message: `域名连通性测试通过 (状态码: ${res.statusCode})`,
            statusCode: res.statusCode,
            data: res.statusCode === 302 ? '域名可访问，但需要登录（302重定向）' : '域名可访问',
            suggestion: res.statusCode === 302 ? '正常现象：未登录状态下会重定向到登录页面' : ''
          });
        } else {
          resolve({
            success: false,
            message: `域名连通性测试返回异常状态码: ${res.statusCode}`,
            statusCode: res.statusCode,
            data: res.data,
            error: `HTTP ${res.statusCode}`,
            suggestion: '请检查域名配置或网络连接'
          });
        }
      },
      fail: (err) => {
        resolve({
          success: false,
          message: '域名连通性测试失败',
          error: err.errMsg || '未知错误',
          suggestion: '请检查网络连接，或确认域名已添加到小程序合法域名列表'
        });
      }
    });
  });
}

/**
 * 使用用户提供的cookie测试订单查询
 * 注意：cookie可能已过期，仅用于测试
 * @param {Object} params 查询参数
 * @returns {Promise<Object>} 查询结果
 */
function testOrderQueryWithCookie(params = {}, debug = false) {
  // 设置默认查询参数（使用用户提供的本地存储数据中的信息）
  const defaultParams = {
    page: 1,
    pageSize: 10,
    areaId: 19881233,  // 湘北区域ID
    warehouseIds: [12009, 12079, 18902, 19099],  // 长沙开福1仓、长沙开福2仓、衡阳2仓、衡阳3仓
    startSessionTime: Date.now() - 24 * 60 * 60 * 1000,  // 24小时前
    endSessionTime: Date.now(),  // 当前时间
    mallId: 782246185  // 易悦贸易商家ID
  };
  
  const queryParams = { ...defaultParams, ...params };
  
  // 从用户提供的最新cookie数据中提取的cookie
  const testCookies = [
    'api_uid=CklsrWi/8Oo6dgCZtYeCAg==',
    '_nano_fp=XpmynqTolpdan5TJX9_0OCzi9CzuFdo8okM6Azch',
    'rckk=VQkv2sQnm4qFyl7AFQjCQAeSoi7N78Rf',
    '_bee=VQkv2sQnm4qFyl7AFQjCQAeSoi7N78Rf',
    'ru1k=66a16606-5b6d-4bc6-a27e-d8da7573a1bb',
    '_f77=66a16606-5b6d-4bc6-a27e-d8da7573a1bb',
    'ru2k=849c546e-662d-4591-bc16-9a104a960d36',
    '_a42=849c546e-662d-4591-bc16-9a104a960d36',
    'terminalFinger=B08QKEPYBHXNvRBFsRRA3cJfkJzD4dDq',
    'jrpl=Fph5EqAN6mjTKKLs9uq7Tn6rWcq9Z1YC',
    'njrpl=Fph5EqAN6mjTKKLs9uq7Tn6rWcq9Z1YC',
    'dilx=kNaLiNuP0~5D5b2y9CEVM',
    'mms_b84d1838=3428,3616,3700,3706,3523,3660,3614,3599,3605,3621,3622,3677,3588,3254,3532,3642,3474,3475,3477,3479,3497,3687,3482,1202,1203,1204,1205,3417',
    'x-visit-time=1769480425317',
    'JSESSIONID=BC83FAC2C4B0DE7F5EB6661E05A5EF0A',
    'windows_app_shop_token_23=eyJ0IjoiTWhWd0YxQUpyRjFnZ05kT3pabllKZlpKZXdBSnpScUMvc05qUU1iWHNkRFl5aUxDMm1sby9MNDVtc0tzR00wTSIsInYiOjEsInMiOjIzLCJtIjo3ODIyNDYxODUsInUiOjE2MTU0Mzk2OX0',
    'PASS_ID=1-GvBIYJSH5I2N6BfW00JRX0sNL6/fAVzGSCtgB8qX8q4kW2EQ7hp8TwOZosRJ7TgQFnes54X/VKME0m7GaqbT1g_733464025_161543970'
  ];
  
  // 构建cookie字符串
  const cookieStr = testCookies.join('; ');
  
  // 从用户提供的最新fetch请求中提取的anti-content
  const antiContent = '0apWfxUkMwVesaKWfqjSrSpFygwwszyk293C4onPUhU1t_V8g1CQYWJ7tNVXqR-n2RPifGYuzvYNcXYNzpc5jfpXKc_Fyc45JfOae1vUwjvUAq9t0ukvTATt4d-njFED2_TMvRdF-Kgd17e-35WM1hDvNPVWtAbSyX0Yab80Y-0dac0XYXp4acpganG4Jn0EdnYuaX0Pyc0X8nYPLl92KWPRwnL-qk7k-e7X-pFRRkEkWmFflImLZFKDPT0ruaoGjma4jgann9YOse9415k74cdMf-KtUV7sl_FZIuMW7W7LfODMROkMq-KW6hgRQHKtlwFkIuIhtuMkRAHtUZSslES1hKmM1UKBe4VTS257Mfwf-wGVykgT73-EMsPCF32_MtlTd1_pFZNkE1quksHw6L1ud5Zp8ZVd1vCS1c62igIsyVbkRudsbvSL-ob33h-10c6-d_MlUhM8iIh3noBlgC8DbXM99QA538ph7Cjz';

  // 调试输出
  if (debug) {
    console.log('[Duoduomai调试] 默认订单查询测试 - 请求URL:', DUODUOMAI_CONFIG.orderQueryUrl);
    console.log('[Duoduomai调试] 默认订单查询测试 - 请求头:', {
      'Content-Type': 'application/json',
      'Cookie': cookieStr ? '******' + cookieStr.substring(cookieStr.length - 50) : '空',
      'anti-content': antiContent ? '******' + antiContent.substring(antiContent.length - 20) : '空',
      'Referer': 'https://mc.pinduoduo.com/ddmc-mms/order/management',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36'
    });
    console.log('[Duoduomai调试] 默认订单查询测试 - 请求参数:', queryParams);
  }

  return new Promise((resolve, reject) => {
    wx.request({
      url: DUODUOMAI_CONFIG.orderQueryUrl,
      method: 'POST',
      data: queryParams,
      header: {
        'Content-Type': 'application/json',
        'Cookie': cookieStr,
        'anti-content': antiContent,
        'Referer': 'https://mc.pinduoduo.com/ddmc-mms/order/management',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36'
      },
      timeout: 15000,
      success: (res) => {
        // 调试输出
        if (debug) {
          console.log('[Duoduomai调试] 订单查询测试 - 响应状态码:', res.statusCode);
          console.log('[Duoduomai调试] 订单查询测试 - 响应数据:', res.data);
        }
        if (res.statusCode === 200) {
          // 检查返回数据是否包含错误信息
          if (res.data && res.data.errorCode) {
            resolve({
              success: false,
              message: `订单查询返回错误: ${res.data.errorMsg || '未知错误'}`,
              statusCode: res.statusCode,
              data: res.data,
              errorCode: res.data.errorCode,
              errorMsg: res.data.errorMsg,
              suggestion: '可能是cookie过期或权限不足'
            });
          } else {
            resolve({
              success: true,
              message: '订单查询测试通过',
              statusCode: res.statusCode,
              data: res.data,
              records: res.data?.result?.list || [],
              total: res.data?.result?.total || 0,
              suggestion: '成功获取订单数据'
            });
          }
        } else if (res.statusCode === 302) {
          resolve({
            success: false,
            message: '订单查询返回302重定向，需要重新登录',
            statusCode: res.statusCode,
            data: res.data,
            error: 'HTTP 302',
            suggestion: 'cookie可能已过期，请重新登录获取新的cookie'
          });
        } else {
          resolve({
            success: false,
            message: '订单查询返回非200状态码',
            statusCode: res.statusCode,
            data: res.data,
            error: `HTTP ${res.statusCode}`,
            suggestion: '请检查网络连接和cookie有效性'
          });
        }
      },
      fail: (err) => {
        resolve({
          success: false,
          message: '订单查询请求失败',
          error: err.errMsg || '未知错误',
          suggestion: '可能是cookie过期或网络问题'
        });
      }
    });
  });
}

/**
 * 测试登录功能（使用用户提供的最新登录数据）
 * 注意：可能需要图形验证码，此函数仅用于测试
 * @returns {Promise<Object>} 登录结果
 */
function testLogin(debug = false) {
  // 从用户提供的最新fetch请求中提取的登录数据
  const loginData = {
    username: 'wangxh04',
    password: 'f2QtBGNu7Upu1Akf52vUgDx93t38TsmyL8jDWwsN7iIF/mB8Gqb//mzB8DlzCae5VAFiCi+B5q2D8lIk+of2R01HqL8+ggwaU5zN+vijXfjVLFlvJ72wUC6Rw4FF9FFRqKz6XF1OIw4RP7J5IGrTYVR66lW7JRFaxUjhgw26bgw=',
    passwordEncrypt: true,
    verificationCode: '',
    mobileVerifyCode: '',
    sign: '',
    touchevent: {
      mobileInputEditStartTime: 1770029155515,
      mobileInputEditFinishTime: 1770029155532,
      mobileInputKeyboardEvent: '0|0|0|',
      passwordInputEditStartTime: 1770029155536,
      passwordInputEditFinishTime: 1770029155552,
      passwordInputKeyboardEvent: '0|0|0|',
      captureInputEditStartTime: '',
      captureInputEditFinishTime: '',
      captureInputKeyboardEvent: '',
      loginButtonTouchPoint: '640,480',
      loginButtonClickTime: 1770029163772
    },
    fingerprint: {
      innerHeight: 781,
      innerWidth: 856,
      devicePixelRatio: 1.125,
      availHeight: 824,
      availWidth: 1536,
      height: 864,
      width: 1536,
      colorDepth: 24,
      locationHref: 'https://mms.pinduoduo.com/login/?redirectUrl=https%3A%2F%2Fmc.pinduoduo.com%2Fddmc-mms%2Forder%2Fmanagement',
      clientWidth: 856,
      clientHeight: 781,
      offsetWidth: 856,
      offsetHeight: 781,
      scrollWidth: 992,
      scrollHeight: 781,
      navigator: {
        appCodeName: 'Mozilla',
        appName: 'Netscape',
        hardwareConcurrency: 4,
        language: 'zh-CN',
        cookieEnabled: true,
        platform: 'Win32',
        doNotTrack: null,
        ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
        vendor: 'Google Inc.',
        product: 'Gecko',
        productSub: '20030107',
        mimeTypes: 'f5a1111231f589322da33fb59b56946b4043e092',
        plugins: '387b918f593d4d8d6bfa647c07e108afbd7a6223'
      },
      referer: '',
      timezoneOffset: -480
    },
    riskSign: 'Th8WBkUei0oDomhR9UimzhhH1t2MYytjVc3SYIafaHjiBDmBb1k4wulk8GecOFu9pQmufd9uBYprF2ygS1U3/HBNgeddmwvo1vV9a7+MiRWDqF2NXdKbKTRBNjTUYZgD2H2N5m2vjd8n4bNnqCE4W3SOgrb1q4GOfqnf4ju4UdU=',
    timestamp: 1770029163777,
    crawlerInfo: '0apWfxUkMwVesaKWfqjSrSpFygwwszyk293C4onPUhU1t_V8g1CQYWJ7tNVXqR-n2RPifGYuzvYNcXYNzpc5jfpXKc_Fyc45JfOae1vUwjvUAq9t0ukvTATt4d-njFED2_TMvRdF-Kgd17e-35WM1hDvNPVWtAbSyX0Yab80Y-0dac0XYXp4acpganG4Jn0EdnYuaX0Pyc0X8nYPLl92KWPRwnL-qk7k-e7X-pFRRkEkWmFflImLZFKDPT0ruaoGjma4jgann9YOse9415k74cdMf-KtUV7sl_FZIuMW7W7LfODMROkMq-KW6hgRQHKtlwFkIuIhtuMkRAHtUZSslES1hKmM1UKBe4VTS257Mfwf-wGVykgT73-EMsPCF32_MtlTd1_pFZNkE1quksHw6L1ud5Zp8ZVd1vCS1c62igIsyVbkRudsbvSL-ob33h-10c6-d_MlUhM8iIh3noBlgC8DbXM99QA538ph7Cjz'
  };
  
  // 从用户提供的最新fetch请求中提取的anti-content
  const antiContent = '0apWfxUkMwVesaKWfqjSrSpFygwwszyk293C4onPUhU1t_V8g1CQYWJ7tNVXqR-n2RPifGYuzvYNcXYNzpc5jfpXKc_Fyc45JfOae1vUwjvUAq9t0ukvTATt4d-njFED2_TMvRdF-Kgd17e-35WM1hDvNPVWtAbSyX0Yab80Y-0dac0XYXp4acpganG4Jn0EdnYuaX0Pyc0X8nYPLl92KWPRwnL-qk7k-e7X-pFRRkEkWmFflImLZFKDPT0ruaoGjma4jgann9YOse9415k74cdMf-KtUV7sl_FZIuMW7W7LfODMROkMq-KW6hgRQHKtlwFkIuIhtuMkRAHtUZSslES1hKmM1UKBe4VTS257Mfwf-wGVykgT73-EMsPCF32_MtlTd1_pFZNkE1quksHw6L1ud5Zp8ZVd1vCS1c62igIsyVbkRudsbvSL-ob33h-10c6-d_MlUhM8iIh3noBlgC8DbXM99QA538ph7Cjz';
  
  // 调试输出
  if (debug) {
    console.log('[Duoduomai调试] 默认登录测试 - 请求URL:', DUODUOMAI_CONFIG.loginUrl);
    console.log('[Duoduomai调试] 默认登录测试 - 请求头:', {
      'Content-Type': 'application/json',
      'anti-content': antiContent ? '******' + antiContent.substring(antiContent.length - 20) : '空',
      'Referer': 'https://mms.pinduoduo.com/login/?redirectUrl=https%3A%2F%2Fmc.pinduoduo.com%2Fddmc-mms%2Forder%2Fmanagement'
    });
    console.log('[Duoduomai调试] 默认登录测试 - 请求数据（简化）:', {
      username: loginData.username,
      password: loginData.password ? '******' + loginData.password.substring(loginData.password.length - 10) : '空',
      timestamp: loginData.timestamp,
      crawlerInfo: loginData.crawlerInfo ? '******' + loginData.crawlerInfo.substring(loginData.crawlerInfo.length - 10) : '空',
      riskSign: loginData.riskSign ? '******' + loginData.riskSign.substring(loginData.riskSign.length - 10) : '空'
    });
  }
  
  return new Promise((resolve, reject) => {
    wx.request({
      url: DUODUOMAI_CONFIG.loginUrl,
      method: 'POST',
      data: loginData,
      header: {
        'Content-Type': 'application/json',
        'anti-content': antiContent,
        'Referer': 'https://mms.pinduoduo.com/login/?redirectUrl=https%3A%2F%2Fmc.pinduoduo.com%2Fddmc-mms%2Forder%2Fmanagement'
      },
      timeout: 15000,
      success: (res) => {
        if (debug) {
          console.log('[Duoduomai调试] 默认登录测试 - 响应状态码:', res.statusCode);
          console.log('[Duoduomai调试] 默认登录测试 - 响应数据:', res.data);
        }
        
        if (res.statusCode === 200) {
          // 检查返回数据是否包含错误码
          if (res.data && res.data.errorCode === 54001) {
            resolve({
              success: false,
              message: '登录请求成功，但需要图形验证码',
              statusCode: res.statusCode,
              data: res.data,
              errorCode: res.data.errorCode,
              errorMsg: res.data.errorMsg,
              suggestion: '拼多多检测到异常登录行为，需要图形验证码验证。请尝试在浏览器中正常登录后再获取新的cookie。'
            });
          } else if (res.data && res.data.success === false) {
            resolve({
              success: false,
              message: '登录请求成功，但登录失败',
              statusCode: res.statusCode,
              data: res.data,
              errorCode: res.data.errorCode,
              errorMsg: res.data.errorMsg,
              suggestion: '可能是密码错误、账号异常或其他验证问题'
            });
          } else {
            resolve({
              success: true,
              message: '登录测试请求发送成功',
              statusCode: res.statusCode,
              data: res.data,
              suggestion: '登录请求已发送，但需要检查返回数据确认是否真正登录成功'
            });
          }
        } else {
          resolve({
            success: false,
            message: '登录返回非200状态码',
            statusCode: res.statusCode,
            data: res.data,
            error: `HTTP ${res.statusCode}`
          });
        }
      },
      fail: (err) => {
        if (debug) {
          console.log('[Duoduomai调试] 默认登录测试 - 请求失败:', err);
        }
        resolve({
          success: false,
          message: '登录请求失败',
          error: err.errMsg || '未知错误',
          suggestion: '可能是网络问题或域名未配置'
        });
      }
    });
  });
}

/**
 * 使用自定义配置测试登录功能
 * @param {Object} config 配置对象，包含username, password, antiContent等
 * @returns {Promise<Object>} 登录结果
 */
function testLoginWithConfig(config = {}) {
  // 默认配置
  const defaultConfig = {
    username: 'wangxh04',
    password: '',
    antiContent: '',
    timestamp: Date.now(),
    loginData: null, // 完整的登录数据对象，如果提供则直接使用
    debug: false     // 是否输出调试信息
  };
  
  const loginConfig = { ...defaultConfig, ...config };
  
  // 如果提供了完整的loginData，则直接使用，否则构建
  let loginData;
  if (loginConfig.loginData && typeof loginConfig.loginData === 'object') {
    loginData = loginConfig.loginData;
    // 确保必要的字段存在
    if (!loginData.username) loginData.username = loginConfig.username;
    if (!loginData.password) loginData.password = loginConfig.password || 'f2QtBGNu7Upu1Akf52vUgDx93t38TsmyL8jDWwsN7iIF/mB8Gqb//mzB8DlzCae5VAFiCi+B5q2D8lIk+of2R01HqL8+ggwaU5zN+vijXfjVLFlvJ72wUC6Rw4FF9FFRqKz6XF1OIw4RP7J5IGrTYVR66lW7JRFaxUjhgw26bgw=';
    if (!loginData.timestamp) loginData.timestamp = loginConfig.timestamp;
    if (!loginData.crawlerInfo) loginData.crawlerInfo = loginConfig.antiContent || '0apWfxUkMwVesaKWfqjSrSpFygwwszyk293C4onPUhU1t_V8g1CQYWJ7tNVXqR-n2RPifGYuzvYNcXYNzpc5jfpXKc_Fyc45JfOae1vUwjvUAq9t0ukvTATt4d-njFED2_TMvRdF-Kgd17e-35WM1hDvNPVWtAbSyX0Yab80Y-0dac0XYXp4acpganG4Jn0EdnYuaX0Pyc0X8nYPLl92KWPRwnL-qk7k-e7X-pFRRkEkWmFflImLZFKDPT0ruaoGjma4jgann9YOse9415k74cdMf-KtUV7sl_FZIuMW7W7LfODMROkMq-KW6hgRQHKtlwFkIuIhtuMkRAHtUZSslES1hKmM1UKBe4VTS257Mfwf-wGVykgT73-EMsPCF32_MtlTd1_pFZNkE1quksHw6L1ud5Zp8ZVd1vCS1c62igIsyVbkRudsbvSL-ob33h-10c6-d_MlUhM8iIh3noBlgC8DbXM99QA538ph7Cjz';
    
    if (loginConfig.debug) {
      console.log('[Duoduomai调试] 使用提供的完整loginData:', JSON.stringify(loginData, null, 2));
    }
  } else {
    // 构建登录数据
    loginData = {
      username: loginConfig.username,
      password: loginConfig.password || 'f2QtBGNu7Upu1Akf52vUgDx93t38TsmyL8jDWwsN7iIF/mB8Gqb//mzB8DlzCae5VAFiCi+B5q2D8lIk+of2R01HqL8+ggwaU5zN+vijXfjVLFlvJ72wUC6Rw4FF9FFRqKz6XF1OIw4RP7J5IGrTYVR66lW7JRFaxUjhgw26bgw=',
      passwordEncrypt: true,
      verificationCode: '',
      mobileVerifyCode: '',
      sign: '',
      touchevent: {
        mobileInputEditStartTime: Date.now() - 1000,
        mobileInputEditFinishTime: Date.now() - 900,
        mobileInputKeyboardEvent: '0|0|0|',
        passwordInputEditStartTime: Date.now() - 800,
        passwordInputEditFinishTime: Date.now() - 700,
        passwordInputKeyboardEvent: '0|0|0|',
        captureInputEditStartTime: '',
        captureInputEditFinishTime: '',
        captureInputKeyboardEvent: '',
        loginButtonTouchPoint: '640,480',
        loginButtonClickTime: Date.now()
      },
      fingerprint: {
        innerHeight: 781,
        innerWidth: 856,
        devicePixelRatio: 1.125,
        availHeight: 824,
        availWidth: 1536,
        height: 864,
        width: 1536,
        colorDepth: 24,
        locationHref: 'https://mms.pinduoduo.com/login/?redirectUrl=https%3A%2F%2Fmc.pinduoduo.com%2Fddmc-mms%2Forder%2Fmanagement',
        clientWidth: 856,
        clientHeight: 781,
        offsetWidth: 856,
        offsetHeight: 781,
        scrollWidth: 992,
        scrollHeight: 781,
        navigator: {
          appCodeName: 'Mozilla',
          appName: 'Netscape',
          hardwareConcurrency: 4,
          language: 'zh-CN',
          cookieEnabled: true,
          platform: 'Win32',
          doNotTrack: null,
          ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
          vendor: 'Google Inc.',
          product: 'Gecko',
          productSub: '20030107',
          mimeTypes: 'f5a1111231f589322da33fb59b56946b4043e092',
          plugins: '387b918f593d4d8d6bfa647c07e108afbd7a6223'
        },
        referer: '',
        timezoneOffset: -480
      },
      riskSign: 'Th8WBkUei0oDomhR9UimzhhH1t2MYytjVc3SYIafaHjiBDmBb1k4wulk8GecOFu9pQmufd9uBYprF2ygS1U3/HBNgeddmwvo1vV9a7+MiRWDqF2NXdKbKTRBNjTUYZgD2H2N5m2vjd8n4bNnqCE4W3SOgrb1q4GOfqnf4ju4UdU=',
      timestamp: loginConfig.timestamp,
      crawlerInfo: loginConfig.antiContent || '0apWfxUkMwVesaKWfqjSrSpFygwwszyk293C4onPUhU1t_V8g1CQYWJ7tNVXqR-n2RPifGYuzvYNcXYNzpc5jfpXKc_Fyc45JfOae1vUwjvUAq9t0ukvTATt4d-njFED2_TMvRdF-Kgd17e-35WM1hDvNPVWtAbSyX0Yab80Y-0dac0XYXp4acpganG4Jn0EdnYuaX0Pyc0X8nYPLl92KWPRwnL-qk7k-e7X-pFRRkEkWmFflImLZFKDPT0ruaoGjma4jgann9YOse9415k74cdMf-KtUV7sl_FZIuMW7W7LfODMROkMq-KW6hgRQHKtlwFkIuIhtuMkRAHtUZSslES1hKmM1UKBe4VTS257Mfwf-wGVykgT73-EMsPCF32_MtlTd1_pFZNkE1quksHw6L1ud5Zp8ZVd1vCS1c62igIsyVbkRudsbvSL-ob33h-10c6-d_MlUhM8iIh3noBlgC8DbXM99QA538ph7Cjz'
    };
    
    if (loginConfig.debug) {
      console.log('[Duoduomai调试] 使用构建的loginData:', JSON.stringify(loginData, null, 2));
    }
  }
  
  // 构建请求头
  const headers = {
    'Content-Type': 'application/json',
    'anti-content': loginConfig.antiContent || '0apWfxUkMwVesaKWfqjSrSpFygwwszyk293C4onPUhU1t_V8g1CQYWJ7tNVXqR-n2RPifGYuzvYNcXYNzpc5jfpXKc_Fyc45JfOae1vUwjvUAq9t0ukvTATt4d-njFED2_TMvRdF-Kgd17e-35WM1hDvNPVWtAbSyX0Yab80Y-0dac0XYXp4acpganG4Jn0EdnYuaX0Pyc0X8nYPLl92KWPRwnL-qk7k-e7X-pFRRkEkWmFflImLZFKDPT0ruaoGjma4jgann9YOse9415k74cdMf-KtUV7sl_FZIuMW7W7LfODMROkMq-KW6hgRQHKtlwFkIuIhtuMkRAHtUZSslES1hKmM1UKBe4VTS257Mfwf-wGVykgT73-EMsPCF32_MtlTd1_pFZNkE1quksHw6L1ud5Zp8ZVd1vCS1c62igIsyVbkRudsbvSL-ob33h-10c6-d_MlUhM8iIh3noBlgC8DbXM99QA538ph7Cjz',
    'Referer': 'https://mms.pinduoduo.com/login/?redirectUrl=https%3A%2F%2Fmc.pinduoduo.com%2Fddmc-mms%2Forder%2Fmanagement'
  };
  
  if (loginConfig.debug) {
    console.log('[Duoduomai调试] 请求URL:', DUODUOMAI_CONFIG.loginUrl);
    console.log('[Duoduomai调试] 请求头:', headers);
    console.log('[Duoduomai调试] 请求数据（简化）:', {
      username: loginData.username,
      password: loginData.password ? '******' + loginData.password.substring(loginData.password.length - 10) : '空',
      timestamp: loginData.timestamp,
      crawlerInfo: loginData.crawlerInfo ? '******' + loginData.crawlerInfo.substring(loginData.crawlerInfo.length - 10) : '空'
    });
  }
  
  return new Promise((resolve, reject) => {
    wx.request({
      url: DUODUOMAI_CONFIG.loginUrl,
      method: 'POST',
      data: loginData,
      header: headers,
      timeout: 15000,
      success: (res) => {
        if (loginConfig.debug) {
          console.log('[Duoduomai调试] 响应状态码:', res.statusCode);
          console.log('[Duoduomai调试] 响应数据:', res.data);
        }
        
        if (res.statusCode === 200) {
          // 检查返回数据是否包含错误码
          if (res.data && res.data.errorCode === 54001) {
            resolve({
              success: false,
              message: '登录请求成功，但需要图形验证码',
              statusCode: res.statusCode,
              data: res.data,
              errorCode: res.data.errorCode,
              errorMsg: res.data.errorMsg,
              suggestion: '拼多多检测到异常登录行为，需要图形验证码验证。这通常是因为请求参数不完整或使用了旧的指纹数据。建议：1. 在浏览器中正常登录后复制完整的请求数据；2. 确保使用最新的cookie、anti-content、timestamp、riskSign等字段；3. 检查指纹数据是否与当前浏览器环境匹配。'
            });
          } else if (res.data && res.data.success === false) {
            resolve({
              success: false,
              message: '登录请求成功，但登录失败',
              statusCode: res.statusCode,
              data: res.data,
              errorCode: res.data.errorCode,
              errorMsg: res.data.errorMsg,
              suggestion: '可能是密码错误、账号异常或其他验证问题'
            });
          } else {
            resolve({
              success: true,
              message: '登录测试请求发送成功',
              statusCode: res.statusCode,
              data: res.data,
              suggestion: '登录请求已发送，但需要检查返回数据确认是否真正登录成功'
            });
          }
        } else {
          resolve({
            success: false,
            message: '登录返回非200状态码',
            statusCode: res.statusCode,
            data: res.data,
            error: `HTTP ${res.statusCode}`
          });
        }
      },
      fail: (err) => {
        if (loginConfig.debug) {
          console.log('[Duoduomai调试] 请求失败:', err);
        }
        resolve({
          success: false,
          message: '登录请求失败',
          error: err.errMsg || '未知错误',
          suggestion: '可能是网络问题或域名未配置'
        });
      }
    });
  });
}

/**
 * 使用自定义配置测试订单查询
 * @param {Object} config 配置对象，包含cookie, antiContent等
 * @param {Object} params 查询参数
 * @returns {Promise<Object>} 查询结果
 */
function testOrderQueryWithConfig(config = {}, params = {}) {
  // 设置默认查询参数
  const defaultParams = {
    page: 1,
    pageSize: 10,
    areaId: 19881233,  // 湘北区域ID
    warehouseIds: [12009, 12079, 18902, 19099],  // 长沙开福1仓、长沙开福2仓、衡阳2仓、衡阳3仓
    startSessionTime: Date.now() - 24 * 60 * 60 * 1000,  // 24小时前
    endSessionTime: Date.now(),  // 当前时间
    mallId: 782246185  // 易悦贸易商家ID
  };
  
  const queryParams = { ...defaultParams, ...params };
  
  // 默认配置
  const defaultConfig = {
    cookie: '',
    antiContent: '',
    debug: false
  };
  
  const queryConfig = { ...defaultConfig, ...config };
  
  // 如果用户提供了cookie，使用用户cookie，否则使用默认cookie
  let cookieStr = queryConfig.cookie;
  
  if (!cookieStr) {
    // 默认cookie（可能已过期）
    const defaultCookies = [
      'api_uid=CklsrWi/8Oo6dgCZtYeCAg==',
      '_nano_fp=XpmynqTolpdan5TJX9_0OCzi9CzuFdo8okM6Azch',
      'rckk=VQkv2sQnm4qFyl7AFQjCQAeSoi7N78Rf',
      '_bee=VQkv2sQnm4qFyl7AFQjCQAeSoi7N78Rf',
      'ru1k=66a16606-5b6d-4bc6-a27e-d8da7573a1bb',
      '_f77=66a16606-5b6d-4bc6-a27e-d8da7573a1bb',
      'ru2k=849c546e-662d-4591-bc16-9a104a960d36',
      '_a42=849c546e-662d-4591-bc16-9a104a960d36',
      'terminalFinger=B08QKEPYBHXNvRBFsRRA3cJfkJzD4dDq',
      'jrpl=Fph5EqAN6mjTKKLs9uq7Tn6rWcq9Z1YC',
      'njrpl=Fph5EqAN6mjTKKLs9uq7Tn6rWcq9Z1YC',
      'dilx=kNaLiNuP0~5D5b2y9CEVM',
      'mms_b84d1838=3428,3616,3700,3706,3523,3660,3614,3599,3605,3621,3622,3677,3588,3254,3532,3642,3474,3475,3477,3479,3497,3687,3482,1202,1203,1204,1205,3417',
      'x-visit-time=1769480425317',
      'JSESSIONID=BC83FAC2C4B0DE7F5EB6661E05A5EF0A',
      'windows_app_shop_token_23=eyJ0IjoiTWhWd0YxQUpyRjFnZ05kT3pabllKZlpKZXdBSnpScUMvc05qUU1iWHNkRFl5aUxDMm1sby9MNDVtc0tzR00wTSIsInYiOjEsInMiOjIzLCJtIjo3ODIyNDYxODUsInUiOjE2MTU0Mzk2OX0',
      'PASS_ID=1-GvBIYJSH5I2N6BfW00JRX0sNL6/fAVzGSCtgB8qX8q4kW2EQ7hp8TwOZosRJ7TgQFnes54X/VKME0m7GaqbT1g_733464025_161543970'
    ];
    cookieStr = defaultCookies.join('; ');
  }
  
  // 使用用户提供的anti-content或默认值
  const antiContent = queryConfig.antiContent || '0apWfxUkMwVesaKWfqjSrSpFygwwszyk293C4onPUhU1t_V8g1CQYWJ7tNVXqR-n2RPifGYuzvYNcXYNzpc5jfpXKc_Fyc45JfOae1vUwjvUAq9t0ukvTATt4d-njFED2_TMvRdF-Kgd17e-35WM1hDvNPVWtAbSyX0Yab80Y-0dac0XYXp4acpganG4Jn0EdnYuaX0Pyc0X8nYPLl92KWPRwnL-qk7k-e7X-pFRRkEkWmFflImLZFKDPT0ruaoGjma4jgann9YOse9415k74cdMf-KtUV7sl_FZIuMW7W7LfODMROkMq-KW6hgRQHKtlwFkIuIhtuMkRAHtUZSslES1hKmM1UKBe4VTS257Mfwf-wGVykgT73-EMsPCF32_MtlTd1_pFZNkE1quksHw6L1ud5Zp8ZVd1vCS1c62igIsyVbkRudsbvSL-ob33h-10c6-d_MlUhM8iIh3noBlgC8DbXM99QA538ph7Cjz';

  // 调试输出
  if (queryConfig.debug) {
    console.log('[Duoduomai调试] 订单查询测试 - 请求URL:', DUODUOMAI_CONFIG.orderQueryUrl);
    console.log('[Duoduomai调试] 订单查询测试 - 请求头:', {
      'Content-Type': 'application/json',
      'Cookie': cookieStr ? '******' + cookieStr.substring(cookieStr.length - 50) : '空',
      'anti-content': antiContent ? '******' + antiContent.substring(antiContent.length - 20) : '空',
      'Referer': 'https://mc.pinduoduo.com/ddmc-mms/order/management',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36'
    });
    console.log('[Duoduomai调试] 订单查询测试 - 请求参数:', queryParams);
  }

  return new Promise((resolve, reject) => {
    wx.request({
      url: DUODUOMAI_CONFIG.orderQueryUrl,
      method: 'POST',
      data: queryParams,
      header: {
        'Content-Type': 'application/json',
        'Cookie': cookieStr,
        'anti-content': antiContent,
        'Referer': 'https://mc.pinduoduo.com/ddmc-mms/order/management',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36'
      },
      timeout: 15000,
      success: (res) => {
        // 调试输出
        if (debug) {
          console.log('[Duoduomai调试] 订单查询测试 - 响应状态码:', res.statusCode);
          console.log('[Duoduomai调试] 订单查询测试 - 响应数据:', res.data);
        }
        if (res.statusCode === 200) {
          // 检查返回数据是否包含错误信息
          if (res.data && res.data.errorCode) {
            resolve({
              success: false,
              message: `订单查询返回错误: ${res.data.errorMsg || '未知错误'}`,
              statusCode: res.statusCode,
              data: res.data,
              errorCode: res.data.errorCode,
              errorMsg: res.data.errorMsg,
              suggestion: '可能是cookie过期或权限不足'
            });
          } else {
            resolve({
              success: true,
              message: '订单查询测试通过',
              statusCode: res.statusCode,
              data: res.data,
              records: res.data?.result?.list || [],
              total: res.data?.result?.total || 0,
              suggestion: '成功获取订单数据'
            });
          }
        } else if (res.statusCode === 302) {
          resolve({
            success: false,
            message: '订单查询返回302重定向，需要重新登录',
            statusCode: res.statusCode,
            data: res.data,
            error: 'HTTP 302',
            suggestion: 'cookie可能已过期，请重新登录获取新的cookie'
          });
        } else {
          resolve({
            success: false,
            message: '订单查询返回非200状态码',
            statusCode: res.statusCode,
            data: res.data,
            error: `HTTP ${res.statusCode}`,
            suggestion: '请检查网络连接和cookie有效性'
          });
        }
      },
      fail: (err) => {
        resolve({
          success: false,
          message: '订单查询请求失败',
          error: err.errMsg || '未知错误',
          suggestion: '可能是cookie过期或网络问题'
        });
      }
    });
  });
}

/**
 * 获取测试状态信息
 * @returns {Object} 状态信息
 */
function getTestStatus() {
  return {
    module: 'duoduomai',
    description: '拼多多多多买菜平台测试模块',
    version: '1.0.0',
    config: DUODUOMAI_CONFIG,
    lastTestTime: wx.getStorageSync('duoduomai_last_test_time') || '未测试',
    testResults: wx.getStorageSync('duoduomai_test_results') || []
  };
}

/**
 * 保存测试结果
 * @param {Object} result 测试结果
 */
function saveTestResult(result) {
  const now = new Date().toISOString();
  const results = wx.getStorageSync('duoduomai_test_results') || [];
  
  results.unshift({
    timestamp: now,
    testType: result.testType || 'unknown',
    success: result.success,
    message: result.message,
    details: result
  });
  
  // 只保留最近10次测试结果
  if (results.length > 10) {
    results.pop();
  }
  
  wx.setStorageSync('duoduomai_test_results', results);
  wx.setStorageSync('duoduomai_last_test_time', now);
}

/**
 * 从Supabase获取拼多多参数
 * @param {string} username 账号用户名
 * @returns {Promise<Object|null>} 参数对象
 */
async function getPddParamsFromSupabase(username) {
  try {
    // 导入配置函数
    const { getConfig } = require('./request.js');
    const config = getConfig();
    
    const token = wx.getStorageSync('access_token');
    
    const response = await new Promise((resolve, reject) => {
      wx.request({
        url: `${config.supabaseUrl}/rest/v1/pdd_accounts?username=eq.${username}&select=*`,
        method: 'GET',
        header: {
          'apikey': config.supabaseKey,
          'Authorization': token ? `Bearer ${token}` : '',
          'Prefer': 'return=representation'
        },
        success: resolve,
        fail: reject
      });
    });
    
    if (response.statusCode === 200 && response.data && response.data.length > 0) {
      const accountData = response.data[0];
      
      // 检查参数是否过期
      const expiresAt = accountData.expires_at ? new Date(accountData.expires_at) : null;
      const now = new Date();
      
      if (expiresAt && expiresAt < now) {
        console.warn(`⚠️ 账号 ${username} 的参数已过期`);
        return null;
      }
      
      console.log(`✅ 从Supabase获取到账号 ${username} 的参数`);
      return accountData;
    } else {
      console.log(`❌ 账号 ${username} 在Supabase中未找到数据`);
      return null;
    }
  } catch (error) {
    console.error(`❌ 从Supabase获取参数失败:`, error);
    return null;
  }
}

/**
 * 使用Supabase参数测试订单查询
 * @param {string} username 账号用户名
 * @param {Object} params 查询参数
 * @returns {Promise<Object>} 查询结果
 */
async function testOrderQueryWithSupabase(username, params = {}) {
  try {
    // 从Supabase获取参数
    const accountData = await getPddParamsFromSupabase(username);
    
    if (!accountData) {
      return {
        success: false,
        message: '无法从Supabase获取有效参数',
        suggestion: '请检查Supabase中是否有该账号的参数数据'
      };
    }
    
    // 设置默认查询参数
    const defaultParams = {
      page: 1,
      pageSize: 10,
      areaId: 19881233,  // 湘北区域ID
      warehouseIds: [12009, 12079, 18902, 19099],  // 长沙开福1仓、长沙开福2仓、衡阳2仓、衡阳3仓
      startSessionTime: Date.now() - 24 * 60 * 60 * 1000,  // 24小时前
      endSessionTime: Date.now(),  // 当前时间
      mallId: 782246185  // 易悦贸易商家ID
    };
    
    const queryParams = { ...defaultParams, ...params };
    
    // 构建请求头
    const headers = {
      'Content-Type': 'application/json',
      'Cookie': accountData.cookie_string || '',
      'anti-content': accountData.anti_content || '',
      'Referer': 'https://mc.pinduoduo.com/ddmc-mms/order/management',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36'
    };
    
    return new Promise((resolve, reject) => {
      wx.request({
        url: DUODUOMAI_CONFIG.orderQueryUrl,
        method: 'POST',
        data: queryParams,
        header: headers,
        timeout: 15000,
        success: (res) => {
          if (res.statusCode === 200) {
            // 检查返回数据是否包含错误信息
            if (res.data && res.data.errorCode) {
              resolve({
                success: false,
                message: `订单查询返回错误: ${res.data.errorMsg || '未知错误'}`,
                statusCode: res.statusCode,
                data: res.data,
                errorCode: res.data.errorCode,
                errorMsg: res.data.errorMsg,
                suggestion: '可能是参数过期或权限不足'
              });
            } else {
              resolve({
                success: true,
                message: '订单查询测试通过',
                statusCode: res.statusCode,
                data: res.data,
                records: res.data?.result?.list || [],
                total: res.data?.result?.total || 0,
                suggestion: '成功获取订单数据'
              });
            }
          } else if (res.statusCode === 302) {
            resolve({
              success: false,
              message: '订单查询返回302重定向，需要重新登录',
              statusCode: res.statusCode,
              data: res.data,
              error: 'HTTP 302',
              suggestion: '参数可能已过期，请更新Supabase中的参数'
            });
          } else {
            resolve({
              success: false,
              message: '订单查询返回非200状态码',
              statusCode: res.statusCode,
              data: res.data,
              error: `HTTP ${res.statusCode}`,
              suggestion: '请检查网络连接和参数有效性'
            });
          }
        },
        fail: (err) => {
          resolve({
            success: false,
            message: '订单查询请求失败',
            error: err.errMsg || '未知错误',
            suggestion: '可能是参数过期或网络问题'
          });
        }
      });
    });
    
  } catch (error) {
    return {
      success: false,
      message: '订单查询测试失败',
      error: error.message || '未知错误',
      suggestion: '请检查网络连接和参数配置'
    };
  }
}

module.exports = {
  DUODUOMAI_CONFIG,
  testConnectivity,
  testOrderQueryWithCookie,
  testOrderQueryWithConfig,
  testLogin,
  testLoginWithConfig,
  getTestStatus,
  saveTestResult,
  getPddParamsFromSupabase,
  testOrderQueryWithSupabase
};