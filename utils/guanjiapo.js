// utils/guanjiapo.js
// 管家婆库存系统API模块

/**
 * 管家婆系统配置
 * 注意：以下URL需要在微信小程序后台配置为合法域名
 * 
 * 根据用户调试信息：
 * - 登录接口：https://www.hhyunerp.com/Account/UserLogin
 * - 用户请求检查接口：https://home-g1.hhyunerp.com/hhyunerp/online/userRequestCheck
 * - 库存查询接口：https://home-g1.hhyunerp.com/hhyunerp/report/pkuCunListPtype/getPagerData
 * - 登录成功后token存储在localStorage的"token"键中
 * - 后续API调用需要Authorization: Bearer {token}头
 */
const GUANJIAPO_CONFIG = {
  // 登录接口（已确认）
  loginUrl: 'https://www.hhyunerp.com/Account/UserLogin',
  // 用户请求检查接口（用于连通性测试）
  userRequestCheckUrl: 'https://home-g1.hhyunerp.com/hhyunerp/online/userRequestCheck',
  // 库存查询接口
  stockQueryUrl: 'https://home-g1.hhyunerp.com/hhyunerp/report/pkuCunListPtype/getPagerData',
  // 令牌存储键名（与管家婆系统保持一致）
  tokenKey: 'token',
  // 用户信息存储键名
  userInfoKey: 'guanjiapo_user_info',
  // 浏览器ID存储键名（部分接口需要）
  browserIdKey: 'browserID'
};

/**
 * SHA-1哈希函数
 * 经过验证的正确实现，确保与管家婆系统一致
 * 
 * @param {string} str 要哈希的字符串
 * @returns {string} 16进制表示的SHA-1哈希值
 */
function sha1(str) {
  // 将字符串转换为字节数组（ASCII/UTF-8）
  function strToBytes(str) {
    const bytes = [];
    for (let i = 0; i < str.length; i++) {
      const charCode = str.charCodeAt(i);
      if (charCode < 0x80) {
        bytes.push(charCode);
      } else if (charCode < 0x800) {
        bytes.push(0xc0 | (charCode >> 6));
        bytes.push(0x80 | (charCode & 0x3f));
      } else if (charCode < 0xd800 || charCode >= 0xe000) {
        bytes.push(0xe0 | (charCode >> 12));
        bytes.push(0x80 | ((charCode >> 6) & 0x3f));
        bytes.push(0x80 | (charCode & 0x3f));
      } else {
        i++;
        const code = 0x10000 + (((charCode & 0x3ff) << 10) | (str.charCodeAt(i) & 0x3ff));
        bytes.push(0xf0 | (code >> 18));
        bytes.push(0x80 | ((code >> 12) & 0x3f));
        bytes.push(0x80 | ((code >> 6) & 0x3f));
        bytes.push(0x80 | (code & 0x3f));
      }
    }
    return bytes;
  }

  // 将字节数组转换为32位字数组（大端序）
  function bytesToWords(bytes) {
    const words = [];
    for (let i = 0; i < bytes.length; i += 4) {
      words.push(
        ((bytes[i] & 0xff) << 24) |
        ((bytes[i + 1] & 0xff) << 16) |
        ((bytes[i + 2] & 0xff) << 8) |
        (bytes[i + 3] & 0xff)
      );
    }
    return words;
  }

  // 循环左移
  function rol(num, cnt) {
    return (num << cnt) | (num >>> (32 - cnt));
  }

  // 核心SHA-1计算
  function coreSha1(words, bitLength) {
    // 初始哈希值
    let h0 = 0x67452301;
    let h1 = 0xEFCDAB89;
    let h2 = 0x98BADCFE;
    let h3 = 0x10325476;
    let h4 = 0xC3D2E1F0;

    // 添加填充位：先加一个1，然后加足够的0，最后加64位的原始消息长度
    words[bitLength >> 5] |= 0x80 << (24 - (bitLength % 32));
    words[(((bitLength + 64) >> 9) << 4) + 15] = bitLength;

    // 处理每个512位块（16个字）
    for (let i = 0; i < words.length; i += 16) {
      const w = new Array(80);
      
      // 初始化前16个字
      for (let j = 0; j < 16; j++) {
        w[j] = words[i + j] || 0;
      }
      
      // 扩展剩余的64个字
      for (let j = 16; j < 80; j++) {
        w[j] = rol(w[j - 3] ^ w[j - 8] ^ w[j - 14] ^ w[j - 16], 1);
      }

      let a = h0;
      let b = h1;
      let c = h2;
      let d = h3;
      let e = h4;

      // 主循环
      for (let j = 0; j < 80; j++) {
        let f, k;

        if (j < 20) {
          f = (b & c) | ((~b) & d);
          k = 0x5A827999;
        } else if (j < 40) {
          f = b ^ c ^ d;
          k = 0x6ED9EBA1;
        } else if (j < 60) {
          f = (b & c) | (b & d) | (c & d);
          k = 0x8F1BBCDC;
        } else {
          f = b ^ c ^ d;
          k = 0xCA62C1D6;
        }

        const temp = (rol(a, 5) + f + e + k + w[j]) >>> 0;
        e = d;
        d = c;
        c = rol(b, 30);
        b = a;
        a = temp;
      }

      // 更新哈希值
      h0 = (h0 + a) >>> 0;
      h1 = (h1 + b) >>> 0;
      h2 = (h2 + c) >>> 0;
      h3 = (h3 + d) >>> 0;
      h4 = (h4 + e) >>> 0;
    }

    return [h0, h1, h2, h3, h4];
  }

  // 将32位整数转换为16进制字符串（固定8位）
  function toHex(num) {
    const hex = num.toString(16);
    return hex.length < 8 ? '0'.repeat(8 - hex.length) + hex : hex;
  }

  // 主函数
  const bytes = strToBytes(str);
  const words = bytesToWords(bytes);
  const bitLength = bytes.length * 8;
  
  // 确保words数组足够长
  const neededLength = (((bitLength + 64) >> 9) << 4) + 16;
  while (words.length < neededLength) {
    words.push(0);
  }
  
  const hash = coreSha1(words, bitLength);
  return hash.map(toHex).join('');
}

/**
 * 测试SHA-1函数是否正确
 * @returns {boolean} 测试是否通过
 */
function testSha1() {
  const testCases = [
    { input: '123456', expected: '7c4a8d09ca3762af61e59520943dc26494f8941b' },
    { input: 'admin', expected: 'd033e22ae348aeb5660fc2140aec35850c4da997' },
    { input: '', expected: 'da39a3ee5e6b4b0d3255bfef95601890afd80709' }
  ];
  
  for (const testCase of testCases) {
    const result = sha1(testCase.input);
    if (result !== testCase.expected) {
      console.error(`SHA-1测试失败: "${testCase.input}" => "${result}"，期望: "${testCase.expected}"`);
      return false;
    }
  }
  
  return true;
}

// 初始化时自动运行测试
try {
  testSha1();
} catch (e) {
  console.warn('SHA-1测试运行失败:', e);
}

/**
 * 获取管家婆令牌（带Bearer前缀）
 * @returns {string} 完整的Authorization头值，如"Bearer eyJ..."
 */
function getToken() {
  const token = wx.getStorageSync(GUANJIAPO_CONFIG.tokenKey) || '';
  return token;
}

/**
 * 获取纯令牌（不含Bearer前缀）
 * @returns {string} 纯令牌字符串
 */
function getTokenWithoutBearer() {
  const token = getToken();
  if (token.startsWith('Bearer ')) {
    return token.substring(7);
  }
  return token;
}

/**
 * 保存管家婆令牌
 * @param {string} token 令牌字符串，可以带或不带Bearer前缀
 */
function setToken(token) {
  // 确保存储时包含Bearer前缀（如果传入的token没有）
  let tokenToStore = token;
  if (token && !token.startsWith('Bearer ')) {
    tokenToStore = `Bearer ${token}`;
  }
  
  // 获取当前存储的令牌
  const currentToken = wx.getStorageSync(GUANJIAPO_CONFIG.tokenKey) || '';
  
  // 仅当令牌发生变化时才更新存储
  if (currentToken !== tokenToStore) {
    wx.setStorageSync(GUANJIAPO_CONFIG.tokenKey, tokenToStore);
  }
}

/**
 * 获取浏览器ID（部分接口需要）
 * @returns {string} 浏览器ID
 */
function getBrowserId() {
  return wx.getStorageSync(GUANJIAPO_CONFIG.browserIdKey) || '';
}

/**
 * 保存浏览器ID
 * @param {string} browserId 浏览器ID
 */
function setBrowserId(browserId) {
  wx.setStorageSync(GUANJIAPO_CONFIG.browserIdKey, browserId);
}

/**
 * 清除管家婆认证信息
 */
function clearAuth() {
  wx.removeStorageSync(GUANJIAPO_CONFIG.tokenKey);
  wx.removeStorageSync(GUANJIAPO_CONFIG.userInfoKey);
  wx.removeStorageSync(GUANJIAPO_CONFIG.browserIdKey);
}

/**
 * 检查是否有有效的令牌
 * @returns {boolean} 是否有有效令牌
 */
function hasValidToken() {
  const token = getToken();
  // TODO: 这里可以添加令牌过期检查逻辑（解析JWT检查exp字段）
  // 目前只检查是否存在令牌
  return !!token && token.length > 10; // 简单长度检查
}

/**
 * 管家婆登录函数
 * 根据用户提供的登录参数实现
 * 
 * 注意：根据用户观察，当管家婆系统触发安全验证时（如短时间内登录次数超限），
 * 登录请求可能需要额外的 captchaVerifyParam 字段，该字段包含验证码服务的验证参数：
 * - sceneId: 验证场景ID
 * - certifyId: 验证标识
 * - deviceToken: 设备令牌
 * - data: 验证数据
 * 
 * 当前实现仅处理基本的登录流程，如需支持验证码验证场景，需要获取并添加此字段。
 * 
 * @param {string} companyName 公司名称
 * @param {string} username 用户名
 * @param {string} password 密码（明文，将在前端进行SHA-1哈希）
 * @param {boolean} passTips 密码提示，默认为true
 * @param {string} captchaCode 验证码，默认为空字符串
 * @returns {Promise<Object>} 登录结果
 */
async function guanjiapoLogin(companyName, username, password, passTips, captchaCode) {
  // 设置默认值
  if (passTips === undefined) passTips = true;
  if (captchaCode === undefined) captchaCode = '';
  
  return new Promise((resolve, reject) => {
    // 对密码进行SHA-1哈希（与用户提供的示例一致）
    const passwordHash = sha1(password);
    
    // 构建URL编码的表单数据（与管家婆系统完全一致）
    // 注意：当系统触发安全验证时，可能还需要添加 captchaVerifyParam 字段
    // 例如：&captchaVerifyParam=${encodeURIComponent(captchaVerifyParam)}
    const formData = `CompanyName=${encodeURIComponent(companyName)}&UserName=${encodeURIComponent(username)}&Password=${encodeURIComponent(passwordHash)}&CaptchaCode=${encodeURIComponent(captchaCode)}&PassTips=${passTips.toString()}`;
    
    wx.request({
      url: GUANJIAPO_CONFIG.loginUrl,
      method: 'POST',
      header: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest'
      },
      data: formData,
      success: (res) => {
        console.log('管家婆登录响应:', res);
        
        // 根据用户调试信息分析响应
        // 管家婆系统使用ResultCode和ResultMsg字段表示登录结果
        // 成功时ResultCode可能为0或正值，失败时为负值（如-11018）
        // 令牌可能通过cookie或响应头设置，而不是在响应体中
        
        if (res.statusCode === 200) {
          const responseData = res.data || {};
          const headers = res.header || {};
          
          // 提取管家婆系统的ResultCode和ResultMsg
          const resultCode = responseData.ResultCode;
          const resultMsg = responseData.ResultMsg;
          
          // 判断登录是否成功
          // 根据常见模式，ResultCode为0或正值表示成功，负值表示失败
          // 同时检查是否有重定向URL（RedirecteUrl）
          const isSuccessful = (
            resultCode === 0 || 
            resultCode === '0' || 
            (typeof resultCode === 'number' && resultCode > 0) ||
            responseData.RedirecteUrl !== null
          );
          
          if (isSuccessful) {
            // 登录成功，尝试从各种可能的位置提取令牌和浏览器ID
            
            let token = '';
            let browserId = '';
            
            // 1. 检查响应头中的Authorization
            const authHeader = headers['Authorization'] || headers['authorization'];
            if (authHeader) {
              // 可能格式：Bearer {token} 或 {token}
              token = authHeader.startsWith('Bearer ') ? authHeader.substring(7) : authHeader;
            }
            
            // 2. 检查Set-Cookie头
            const setCookieHeader = headers['Set-Cookie'] || headers['set-cookie'];
            if (setCookieHeader) {
              const cookieStr = Array.isArray(setCookieHeader) ? setCookieHeader.join('; ') : setCookieHeader;
              
              // 尝试提取token
              const tokenMatch = cookieStr.match(/token=([^;]+)/i);
              if (tokenMatch && !token) {
                token = tokenMatch[1];
              }
              
              // 尝试提取browserID
              const browserIdMatch = cookieStr.match(/browserID=([^;]+)/i);
              if (browserIdMatch) {
                browserId = browserIdMatch[1];
              }
            }
            
            // 3. 检查响应体中的令牌字段（如果有）
            if (!token && responseData.token) {
              token = responseData.token;
            }
            // 4. 检查响应体中的Authorization字段（如果有）
            if (!token && responseData.Authorization) {
              const authValue = responseData.Authorization;
              token = authValue.startsWith('Bearer ') ? authValue.substring(7) : authValue;
            }
            
            // 4. 检查响应体中的浏览器ID字段（如果有）
            if (!browserId && responseData.browserID) {
              browserId = responseData.browserID;
            }
            
            // 存储提取到的信息
            if (token) {
              setToken(token);
            }
            
            if (browserId) {
              setBrowserId(browserId);
            }
            
            // 保存用户信息（如果有）
            if (responseData.userInfo || responseData.UserInfo || responseData.user) {
              const userInfo = responseData.userInfo || responseData.UserInfo || responseData.user;
              wx.setStorageSync(GUANJIAPO_CONFIG.userInfoKey, userInfo);
            }
            
            resolve({
              success: true,
              data: responseData,
              token: token,
              browserId: browserId,
              message: resultMsg || '登录成功'
            });
          } else {
            // 登录失败，使用管家婆的错误信息
            const errorMessage = resultMsg || `登录失败 (错误码: ${resultCode})`;
            reject(new Error(errorMessage));
          }
        } else if (res.statusCode === 401 || res.statusCode === 403) {
          // 认证失败
          const responseData = res.data || {};
          const resultMsg = responseData.ResultMsg || responseData.message || responseData.Message;
          const errorMessage = resultMsg || '用户名、密码或公司名错误';
          reject(new Error(errorMessage));
        } else if (res.statusCode === 400) {
          // 请求参数错误
          const responseData = res.data || {};
          const resultMsg = responseData.ResultMsg || responseData.message || responseData.Message;
          const errorMessage = resultMsg || '请求参数错误';
          reject(new Error(errorMessage));
        } else if (res.statusCode === 404) {
          // 接口不存在
          reject(new Error(`登录接口不存在 (${res.statusCode})，请确认URL是否正确`));
        } else {
          // 其他错误
          const responseData = res.data || {};
          const resultMsg = responseData.ResultMsg || responseData.message || responseData.Message;
          const errorMessage = resultMsg || `登录失败，状态码: ${res.statusCode}`;
          reject(new Error(errorMessage));
        }
      },
      fail: (err) => {
        console.error('管家婆登录请求失败:', err);
        reject(new Error(`网络请求失败: ${err.errMsg || '未知错误'}`));
      }
    });
  });
}

/**
 * 从响应头中提取新令牌（如果需要）
 * @param {Object} res 请求响应对象
 * @returns {string|null} 新令牌（纯令牌，不含Bearer前缀），如果没有则返回null
 */
function extractTokenFromHeaders(res) {
  const headers = res.header || {};
  
  // 1. 检查Authorization头
  const authHeader = headers['Authorization'] || headers['authorization'];
  if (authHeader) {
    // 可能格式：Bearer {token} 或 {token}
    if (authHeader.startsWith('Bearer ')) {
      return authHeader.substring(7); // 移除Bearer前缀
    }
    // 如果没有Bearer前缀，直接返回
    return authHeader;
  }
  
  // 2. 检查Set-Cookie头中的token
  const setCookieHeader = headers['Set-Cookie'] || headers['set-cookie'];
  if (setCookieHeader) {
    const cookieStr = Array.isArray(setCookieHeader) ? setCookieHeader.join('; ') : setCookieHeader;
    const tokenMatch = cookieStr.match(/token=([^;]+)/i);
    if (tokenMatch) {
      return tokenMatch[1];
    }
  }
  
  // 3. 检查其他可能包含令牌的头
  // 例如：X-Auth-Token, X-Access-Token等
  const possibleTokenHeaders = ['X-Auth-Token', 'X-Access-Token', 'X-Token', 'Auth-Token'];
  for (const headerName of possibleTokenHeaders) {
    const headerValue = headers[headerName] || headers[headerName.toLowerCase()];
    if (headerValue) {
      return headerValue;
    }
  }
  
  return null;
}

/**
 * 查询库存列表（基于管家婆实际数据结构）
 * 使用用户提供的完整请求体结构，支持获取全部记录
 * 
 * @param {Object} options 查询选项
 * @param {number} options.count 每页记录数，默认9999以获取全部记录
 * @param {number} options.first 起始索引，默认0
 * @returns {Promise<Object>} 库存数据，包含提取的5个关键字段
 */
async function queryStockList(options) {
  // 设置默认值
  options = options || {};
  
  const token = getToken();
  const browserId = getBrowserId();
  
  if (!token) {
    throw new Error('请先登录管家婆系统');
  }
  
  return new Promise((resolve, reject) => {
    // 构建请求头（根据用户调试信息）
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': token,
      'X-Requested-With': 'XMLHttpRequest',
      'Accept': 'application/json, text/javascript, */*; q=0.01'
    };
    
    // 添加browserID（如果存在）
    if (browserId) {
      headers['browserID'] = browserId;
    }
    
    // 基于用户提供的完整请求体结构
    const requestData = {
      "pageId": {
        "controllerName": "reportbasepage",
        "actionName": "index",
        "pageRandomGuid": "RzF8@1769602166",
        "pagerDataSource": "GridDataSource"
      },
      "gridDataSource": "GridDataSource",
      "first": options.first || 0,
      "count": options.count || 9999, // 设置足够大的值以获取全部记录
      "pagerQuery": {
        "queryAction": "QueryParams",
        "queryParams": {
          "cmode": "KC",
          "QueryConditions": "0",
          "QueryConditionsText": "快速查询",
          "QueryInformation": "",
          "custom": "",
          "": "",
          "ptypeid": "00000",
          "ktypeid": "00000",
          "kfullname": "全部仓库",
          "period": "",
          "pricemode": 1,
          "ucode": 0,
          "operator": "00001",
          "nPubPrice": 1,
          "_typeName": "",
          "_searchid": "",
          "_showfranchise": 0,
          "_showjoint": 0,
          "_showgroup": 0,
          "_typ_showspliteName": 0,
          "baseColumns": "ptypeid_pusercode,ptypeid_pfullname,ptypeid_basebarcode,ptypeid_unit2,ptypeid_unit1,",
          "filter": "1",
          "nostop": 0,
          "__BaseInfoColumns": ["ptype_ptypeid"],
          "treeOrList": 1,
          "memo": "1",
          "level": 0,
          "dqty": 1,
          "sztext": "",
          "bonlylevel": 0
        },
        "queryFilter": {
          "items": [],
          "append": false
        },
        "queryOrder": {
          "orders": []
        },
        "querySummary": {
          "dataSumList": [
            {
              "dataField": "qty",
              "summaryKind": "sum",
              "typeName": "qty"
            },
            {
              "dataField": "total",
              "summaryKind": "sum",
              "typeName": "total"
            },
            {
              "dataField": "p2",
              "summaryKind": "sum",
              "typeName": "total"
            },
            {
              "dataField": "p3",
              "summaryKind": "sum",
              "typeName": "total"
            }
          ]
        }
      },
      "expandParams": {
        "expressColumns": [
          {
            "dataField": "p1",
            "expression": "total/qty",
            "displayEmptyForZero": true
          },
          {
            "dataField": "p2",
            "expression": "price*qty",
            "displayEmptyForZero": true
          },
          {
            "dataField": "p3",
            "expression": "(price*qty)-total",
            "displayEmptyForZero": true
          }
        ],
        "columnInfo": [
          {
            "dataField": "ptypeid_pusercode",
            "editType": "TextEdit",
            "typeName": "ptype",
            "displayEmptyForZero": ""
          },
          {
            "dataField": "ptypeid_pfullname",
            "editType": "TextEdit",
            "typeName": "ptype",
            "displayEmptyForZero": ""
          },
          {
            "dataField": "ptypeid_basebarcode",
            "editType": "TextEdit",
            "typeName": "ptype",
            "displayEmptyForZero": ""
          },
          {
            "dataField": "ptypeid_unit2",
            "editType": "TextEdit",
            "typeName": "ptype",
            "displayEmptyForZero": ""
          },
          {
            "dataField": "unitqty",
            "editType": "TextEdit",
            "typeName": "",
            "displayEmptyForZero": ""
          },
          {
            "dataField": "qty",
            "editType": "NumberEdit",
            "typeName": "qty",
            "displayEmptyForZero": true
          },
          {
            "dataField": "p1",
            "editType": "expression",
            "typeName": "price",
            "displayEmptyForZero": true
          },
          {
            "dataField": "f1p1",
            "editType": "NumberEdit",
            "typeName": "price",
            "displayEmptyForZero": true
          },
          {
            "dataField": "f2p1",
            "editType": "NumberEdit",
            "typeName": "price",
            "displayEmptyForZero": true
          },
          {
            "dataField": "total",
            "editType": "NumberEdit",
            "typeName": "total",
            "displayEmptyForZero": true
          },
          {
            "dataField": "price",
            "editType": "NumberEdit",
            "typeName": "price",
            "displayEmptyForZero": true
          },
          {
            "dataField": "p2",
            "editType": "expression",
            "typeName": "total",
            "displayEmptyForZero": true
          },
          {
            "dataField": "p3",
            "editType": "expression",
            "typeName": "total",
            "displayEmptyForZero": true
          },
          {
            "dataField": "jobnumber",
            "editType": "TextEdit",
            "typeName": "",
            "displayEmptyForZero": ""
          },
          {
            "dataField": "outfactorydate",
            "editType": "DateEdit",
            "typeName": "",
            "displayEmptyForZero": ""
          },
          {
            "dataField": "usefulenddate",
            "editType": "DateEdit",
            "typeName": "",
            "displayEmptyForZero": ""
          },
          {
            "dataField": "goodsorderid",
            "editType": "NumberEdit",
            "typeName": "integer",
            "displayEmptyForZero": true
          },
          {
            "dataField": "Ucode",
            "editType": "NumberEdit",
            "typeName": "integer",
            "displayEmptyForZero": true
          }
        ],
        "beanName": "PkuCunListPtypePager",
        "otherPageResult": {
          "useCache": true
        }
      },
      "gridId": "reportbasepage$index$529$53341161"
    };
    
    wx.request({
      url: GUANJIAPO_CONFIG.stockQueryUrl,
      method: 'POST',
      header: headers,
      data: requestData,
      success: (res) => {
        // 检查是否需要更新令牌（从响应头）
        const newToken = extractTokenFromHeaders(res);
        if (newToken) {
          // 获取当前令牌（不含Bearer前缀）
          const currentToken = getTokenWithoutBearer();
          // 只有当新令牌与当前令牌不同时才更新
          if (newToken !== currentToken) {
            setToken(newToken);
          } else {
            // 令牌未变化，可选：调试日志
            // console.log('令牌未变化，跳过更新');
          }
        }
        
        // 检查响应状态码
        if (res.statusCode === 200) {
          const responseData = res.data || {};
          
          if (responseData.code === 0 && responseData.success) {
            const itemList = (responseData.data && responseData.data.itemList) || [];
            const totalCount = (responseData.data && responseData.data.itemCount) || 0;
            
            // 提取所需的4个字段
            const extractedData = itemList.map(item => ({
              productName: item.ptypeid_pfullname || '',  //商品名称
              userCode: item.ptypeid_pusercode || '',  //商品编码
              unitQuantity: item.unitqty || '',    //总件数
              ptypeId: item.ptypeid || ''   //商品品牌及名称识别
            }));
            
            resolve({
              success: true,
              data: extractedData, // 返回提取的数据
              total: totalCount,
              rawData: responseData, // 原始数据
              message: `查询成功，共 ${totalCount} 条记录，返回 ${extractedData.length} 条`
            });
          } else {
            // 检查是否为凭证失效错误
            if (responseData.code === -4001 || 
                (responseData.msg && responseData.msg.includes('用户凭证已失效'))) {
              clearAuth();
              reject(new Error('登录已过期，请重新登录'));
            } else {
              reject(new Error(responseData.msg || `查询失败，错误码: ${responseData.code}`));
            }
          }
        } else if (res.statusCode === 401 || res.statusCode === 403) {
          // 令牌无效或过期
          clearAuth();
          reject(new Error('登录已过期，请重新登录'));
        } else if (res.statusCode === 404) {
          // 接口不存在
          reject(new Error('库存查询接口不存在，请确认URL是否正确'));
        } else {
          // 其他错误
          const resData = res.data || {};
          const errorMsg = resData.msg || resData.message || 
                         resData.error || resData.Error || `请求失败: ${res.statusCode}`;
          reject(new Error(errorMsg));
        }
      },
      fail: (err) => {
        console.error('库存查询请求失败:', err);
        reject(new Error(`网络请求失败: ${err.errMsg || '未知错误'}`));
      }
    });
  });
}



/**
 * 查询品牌列表
 * 注意：使用相同的库存查询接口，但设置特定参数以获取品牌列表
 * @returns {Promise<Object>} 品牌数据，包含品牌ID和名称
 */
async function queryBrandList() {
  const token = getToken();
  const browserId = getBrowserId();
  
  if (!token) {
    throw new Error('请先登录管家婆系统');
  }
  
  return new Promise((resolve, reject) => {
    // 构建请求头（与库存查询相同）
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': token,
      'X-Requested-With': 'XMLHttpRequest',
      'Accept': 'application/json, text/javascript, */*; q=0.01'
    };
    
    // 添加browserID（如果存在）
    if (browserId) {
      headers['browserID'] = browserId;
    }
    
    // 基于用户提供的品牌查询请求体结构
    const requestData = {
      "pageId": {
        "controllerName": "reportbasepage",
        "actionName": "index",
        "pageRandomGuid": "Qnq7@1769686490",
        "pagerDataSource": "GridDataSource"
      },
      "gridDataSource": "GridDataSource",
      "first": 0,
      "count": 100, // 限制数量，因为品牌数量不会太多
      "pagerQuery": {
        "queryAction": "QueryParams",
        "queryParams": {
          "": "",
          "ptypeid": "00000",      // 关键参数：查询所有品牌
          "ktypeid": "00000",
          "kfullname": "全部仓库",
          "period": "",
          "pricemode": 1,
          "ucode": 0,
          "operator": "00001",
          "nPubPrice": 1,
          "_typeName": "ptypenoserver",
          "_searchid": "",
          "_showfranchise": 0,
          "_showjoint": 0,
          "_showgroup": 0,
          "_typ_showspliteName": 0,
          "baseColumns": "ptypeid_pusercode,ptypeid_pfullname,ptypeid_basebarcode,ptypeid_unit2,ptypeid_unit1,",
          "filter": 1,              // 关键参数：只查询数据非0的品牌
          "nostop": 0,
          "__BaseInfoColumns": ["ptype_ptypeid"]
        },
        "queryFilter": {
          "items": [],
          "append": false
        },
        "queryOrder": {
          "orders": []
        },
        "querySummary": {
          "dataSumList": [
            {
              "dataField": "qty",
              "summaryKind": "sum",
              "typeName": "qty"
            },
            {
              "dataField": "sideqty",
              "summaryKind": "sum",
              "typeName": "qty"
            },
            {
              "dataField": "total",
              "summaryKind": "sum",
              "typeName": "total"
            },
            {
              "dataField": "p2",
              "summaryKind": "sum",
              "typeName": "total"
            },
            {
              "dataField": "p3",
              "summaryKind": "sum",
              "typeName": "total"
            }
          ]
        }
      },
      "expandParams": {
        "expressColumns": [
          {
            "dataField": "p1",
            "expression": "total/qty",
            "displayEmptyForZero": true
          },
          {
            "dataField": "p2",
            "expression": "price*qty",
            "displayEmptyForZero": true
          },
          {
            "dataField": "p3",
            "expression": "(price*qty)-total",
            "displayEmptyForZero": true
          }
        ],
        "columnInfo": [
          {
            "dataField": "ptypeid_pusercode",
            "editType": "TextEdit",
            "typeName": "ptype",
            "displayEmptyForZero": ""
          },
          {
            "dataField": "ptypeid_pfullname",
            "editType": "TextEdit",
            "typeName": "ptype",
            "displayEmptyForZero": ""
          },
          {
            "dataField": "ptypeid_basebarcode",
            "editType": "TextEdit",
            "typeName": "ptype",
            "displayEmptyForZero": ""
          },
          {
            "dataField": "unitqty",
            "editType": "TextEdit",
            "typeName": "",
            "displayEmptyForZero": ""
          },
          {
            "dataField": "ptypeid_unit2",
            "editType": "TextEdit",
            "typeName": "ptype",
            "displayEmptyForZero": ""
          },
          {
            "dataField": "ptypeid_unit1",
            "editType": "text",
            "typeName": "ptype",
            "displayEmptyForZero": true
          },
          {
            "dataField": "qty",
            "editType": "NumberEdit",
            "typeName": "qty",
            "displayEmptyForZero": true
          },
          {
            "dataField": "sideqty",
            "editType": "NumberEdit",
            "typeName": "qty",
            "displayEmptyForZero": true
          },
          {
            "dataField": "p1",
            "editType": "expression",
            "typeName": "price",
            "displayEmptyForZero": true
          },
          {
            "dataField": "f1p1",
            "editType": "NumberEdit",
            "typeName": "price",
            "displayEmptyForZero": true
          },
          {
            "dataField": "f2p1",
            "editType": "NumberEdit",
            "typeName": "price",
            "displayEmptyForZero": true
          },
          {
            "dataField": "total",
            "editType": "NumberEdit",
            "typeName": "total",
            "displayEmptyForZero": true
          },
          {
            "dataField": "price",
            "editType": "NumberEdit",
            "typeName": "price",
            "displayEmptyForZero": true
          },
          {
            "dataField": "p2",
            "editType": "expression",
            "typeName": "total",
            "displayEmptyForZero": true
          },
          {
            "dataField": "p3",
            "editType": "expression",
            "typeName": "total",
            "displayEmptyForZero": true
          },
          {
            "dataField": "goodsorderid",
            "editType": "NumberEdit",
            "typeName": "integer",
            "displayEmptyForZero": true
          },
          {
            "dataField": "Ucode",
            "editType": "NumberEdit",
            "typeName": "integer",
            "displayEmptyForZero": true
          },
          {
            "dataField": "isStop",
            "editType": "NumberEdit",
            "typeName": "integer",
            "displayEmptyForZero": true
          }
        ],
        "beanName": "PkuCunListPtypePager",
        "otherPageResult": {
          "useCache": true
        }
      },
      "gridId": "reportbasepage$index$204$59280325"
    };
    
    wx.request({
      url: GUANJIAPO_CONFIG.stockQueryUrl,
      method: 'POST',
      header: headers,
      data: requestData,
      success: (res) => {
        
        // 检查是否需要更新令牌（从响应头）
        const newToken = extractTokenFromHeaders(res);
        if (newToken) {
          // 获取当前令牌（不含Bearer前缀）
          const currentToken = getTokenWithoutBearer();
          // 只有当新令牌与当前令牌不同时才更新
          if (newToken !== currentToken) {
            setToken(newToken);
          } else {
            // 令牌未变化，可选：调试日志
            // console.log('令牌未变化，跳过更新');
          }
        }
        
        // 检查响应状态码
        if (res.statusCode === 200) {
          const responseData = res.data || {};
          
          if (responseData.code === 0 && responseData.success) {
            const itemList = (responseData.data && responseData.data.itemList) || [];
            
            // 提取品牌ID和全名
            const brandData = itemList.map(item => ({
              brandId: item.ptypeid || '',
              brandName: item.ptypeid_pfullname || ''
            }));
            
            resolve({
              success: true,
              data: brandData,
              total: brandData.length,
              rawData: responseData,
              message: `品牌查询成功，共 ${brandData.length} 个品牌`
            });
          } else {
            // 检查是否为凭证失效错误
            if (responseData.code === -4001 || 
                (responseData.msg && responseData.msg.includes('用户凭证已失效'))) {
              clearAuth();
              reject(new Error('登录已过期，请重新登录'));
            } else {
              reject(new Error(responseData.msg || `品牌查询失败，错误码: ${responseData.code}`));
            }
          }
        } else if (res.statusCode === 401 || res.statusCode === 403) {
          // 令牌无效或过期
          clearAuth();
          reject(new Error('登录已过期，请重新登录'));
        } else if (res.statusCode === 404) {
          // 接口不存在
          reject(new Error('品牌查询接口不存在，请确认URL是否正确'));
        } else {
          // 其他错误
          const resData = res.data || {};
          const errorMsg = resData.msg || resData.message || 
                         resData.error || resData.Error || `请求失败: ${res.statusCode}`;
          reject(new Error(errorMsg));
        }
      },
      fail: (err) => {
        console.error('品牌查询请求失败:', err);
        reject(new Error(`网络请求失败: ${err.errMsg || '未知错误'}`));
      }
    });
  });
}

module.exports = {
  GUANJIAPO_CONFIG,
  guanjiapoLogin,
  queryStockList,
  queryBrandList,
  getToken,
  getTokenWithoutBearer,
  setToken,
  clearAuth,
  hasValidToken,
  getBrowserId,
  setBrowserId
};