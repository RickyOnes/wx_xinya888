// pages/detail/detail.js
const duoduomai = require('../../utils/duoduomai.js');

Page({
  data: {
    // 测试相关数据
    testStatus: '等待测试',
    testResults: [],
    lastTestTime: '未测试',
    
    // 拼多多多多买菜测试相关数据
    showDuoduomaiTest: false,
    showDuoduomaiConfig: false,
    
    // 配置数据
    duoduomaiCookie: '',
    duoduomaiAntiContent: '',
    duoduomaiPassword: '',
    duoduomaiUsername: 'wangxh04',
    duoduomaiDebugMode: false,
    duoduomaiLoginPayload: '',
    
    // 连通性测试
    duoduomaiConnectivityStatus: 'default',
    duoduomaiConnectivityStatusText: '未测试',
    duoduomaiConnectivityResult: '',
    testingConnectivity: false,
    
    // 登录测试
    duoduomaiLoginStatus: 'default',
    duoduomaiLoginStatusText: '未测试',
    duoduomaiLoginResult: '',
    testingLogin: false,
    
    // 订单查询测试
    duoduomaiOrderQueryStatus: 'default',
    duoduomaiOrderQueryStatusText: '未测试',
    duoduomaiOrderQueryResult: '',
    testingOrderQuery: false,
    
    // 测试日志
    duoduomaiTestLogs: []
  },

  // 使用完整的登录Payload进行测试
  testLoginWithPayload() {
    if (this.data.testingLogin) return;
    
    const payloadStr = this.data.duoduomaiLoginPayload.trim();
    if (!payloadStr) {
      wx.showToast({
        title: '请输入登录Payload',
        icon: 'none'
      });
      return;
    }
    
    let loginData;
    try {
      loginData = JSON.parse(payloadStr);
    } catch (err) {
      wx.showToast({
        title: 'JSON格式错误',
        icon: 'none'
      });
      this.addTestLog('登录Payload JSON解析失败: ' + err.message, 'error');
      return;
    }
    
    // 验证必要字段
    if (!loginData.username || !loginData.password) {
      wx.showToast({
        title: '缺少用户名或密码',
        icon: 'none'
      });
      this.addTestLog('登录Payload缺少必要字段', 'error');
      return;
    }
    
    this.setData({ 
      testingLogin: true,
      duoduomaiLoginStatus: 'default',
      duoduomaiLoginStatusText: '测试中...',
      duoduomaiLoginResult: ''
    });
    
    this.addTestLog('开始使用完整登录Payload进行测试...');
    this.addTestLog('注意：使用浏览器中复制的完整登录数据', 'info');
    
    const loginConfig = {
      loginData: loginData,
      debug: this.data.duoduomaiDebugMode
    };
    
    duoduomai.testLoginWithConfig(loginConfig)
      .then(result => {
        result.testType = 'login_payload';
        duoduomai.saveTestResult(result);
        
        const status = result.success ? 'success' : 'error';
        const statusText = result.success ? '测试完成' : '测试失败';
        
        this.addTestLog(result.message, status);
        if (!result.success && result.error) {
          this.addTestLog('错误详情: ' + (result.errorMsg || result.error), 'error');
        }
        
        // 如果登录失败且需要验证码，提供更详细的建议
        if (result.errorCode === 54001) {
          this.addTestLog('拼多多检测到异常登录行为，需要图形验证码', 'warning');
          this.addTestLog('建议：在浏览器中正常登录拼多多商家后台，然后从开发者工具中复制最新的cookie和anti-content值', 'warning');
        }
        
        this.setData({ 
          duoduomaiLoginStatus: status,
          duoduomaiLoginStatusText: statusText,
          duoduomaiLoginResult: result.message,
          testingLogin: false
        });
        
        this.loadTestStatus();
      })
      .catch(err => {
        const errorResult = {
          success: false,
          message: '登录测试过程中发生异常',
          error: err.message || err,
          testType: 'login_payload'
        };
        
        duoduomai.saveTestResult(errorResult);
        this.addTestLog('登录测试过程中发生异常: ' + err.message, 'error');
        this.setData({ 
          duoduomaiLoginStatus: 'error',
          duoduomaiLoginStatusText: '测试异常',
          duoduomaiLoginResult: '登录测试过程中发生异常: ' + err.message,
          testingLogin: false
        });
        
        this.loadTestStatus();
      });
  },

  onLoad() {
    // 页面加载时尝试设置tabbar选中状态
    this.setTabBarSelected();
    // 加载测试状态
    this.loadTestStatus();
    // 加载配置
    this.loadConfig();
  },

  // 使用完整的登录Payload进行测试
  testLoginWithPayload() {
    if (this.data.testingLogin) return;
    
    const payloadStr = this.data.duoduomaiLoginPayload.trim();
    if (!payloadStr) {
      wx.showToast({
        title: '请输入登录Payload',
        icon: 'none'
      });
      return;
    }
    
    let loginData;
    try {
      loginData = JSON.parse(payloadStr);
    } catch (err) {
      wx.showToast({
        title: 'JSON格式错误',
        icon: 'none'
      });
      this.addTestLog('登录Payload JSON解析失败: ' + err.message, 'error');
      return;
    }
    
    // 验证必要字段
    if (!loginData.username || !loginData.password) {
      wx.showToast({
        title: '缺少用户名或密码',
        icon: 'none'
      });
      this.addTestLog('登录Payload缺少必要字段', 'error');
      return;
    }
    
    this.setData({ 
      testingLogin: true,
      duoduomaiLoginStatus: 'default',
      duoduomaiLoginStatusText: '测试中...',
      duoduomaiLoginResult: ''
    });
    
    this.addTestLog('开始使用完整登录Payload进行测试...');
    this.addTestLog('注意：使用浏览器中复制的完整登录数据', 'info');
    
    const loginConfig = {
      loginData: loginData,
      debug: this.data.duoduomaiDebugMode
    };
    
    duoduomai.testLoginWithConfig(loginConfig)
      .then(result => {
        result.testType = 'login_payload';
        duoduomai.saveTestResult(result);
        
        const status = result.success ? 'success' : 'error';
        const statusText = result.success ? '测试完成' : '测试失败';
        
        this.addTestLog(result.message, status);
        if (!result.success && result.error) {
          this.addTestLog('错误详情: ' + (result.errorMsg || result.error), 'error');
        }
        
        // 如果登录失败且需要验证码，提供更详细的建议
        if (result.errorCode === 54001) {
          this.addTestLog('拼多多检测到异常登录行为，需要图形验证码', 'warning');
          this.addTestLog('建议：在浏览器中正常登录拼多多商家后台，然后从开发者工具中复制最新的cookie和anti-content值', 'warning');
        }
        
        this.setData({ 
          duoduomaiLoginStatus: status,
          duoduomaiLoginStatusText: statusText,
          duoduomaiLoginResult: result.message,
          testingLogin: false
        });
        
        this.loadTestStatus();
      })
      .catch(err => {
        const errorResult = {
          success: false,
          message: '登录测试过程中发生异常',
          error: err.message || err,
          testType: 'login_payload'
        };
        
        duoduomai.saveTestResult(errorResult);
        this.addTestLog('登录测试过程中发生异常: ' + err.message, 'error');
        this.setData({ 
          duoduomaiLoginStatus: 'error',
          duoduomaiLoginStatusText: '测试异常',
          duoduomaiLoginResult: '登录测试过程中发生异常: ' + err.message,
          testingLogin: false
        });
        
        this.loadTestStatus();
      });
  },

  onShow() {
    // 更新tabbar选中状态
    this.setTabBarSelected();
  },

  // 使用完整的登录Payload进行测试
  testLoginWithPayload() {
    if (this.data.testingLogin) return;
    
    const payloadStr = this.data.duoduomaiLoginPayload.trim();
    if (!payloadStr) {
      wx.showToast({
        title: '请输入登录Payload',
        icon: 'none'
      });
      return;
    }
    
    let loginData;
    try {
      loginData = JSON.parse(payloadStr);
    } catch (err) {
      wx.showToast({
        title: 'JSON格式错误',
        icon: 'none'
      });
      this.addTestLog('登录Payload JSON解析失败: ' + err.message, 'error');
      return;
    }
    
    // 验证必要字段
    if (!loginData.username || !loginData.password) {
      wx.showToast({
        title: '缺少用户名或密码',
        icon: 'none'
      });
      this.addTestLog('登录Payload缺少必要字段', 'error');
      return;
    }
    
    this.setData({ 
      testingLogin: true,
      duoduomaiLoginStatus: 'default',
      duoduomaiLoginStatusText: '测试中...',
      duoduomaiLoginResult: ''
    });
    
    this.addTestLog('开始使用完整登录Payload进行测试...');
    this.addTestLog('注意：使用浏览器中复制的完整登录数据', 'info');
    
    const loginConfig = {
      loginData: loginData,
      debug: this.data.duoduomaiDebugMode
    };
    
    duoduomai.testLoginWithConfig(loginConfig)
      .then(result => {
        result.testType = 'login_payload';
        duoduomai.saveTestResult(result);
        
        const status = result.success ? 'success' : 'error';
        const statusText = result.success ? '测试完成' : '测试失败';
        
        this.addTestLog(result.message, status);
        if (!result.success && result.error) {
          this.addTestLog('错误详情: ' + (result.errorMsg || result.error), 'error');
        }
        
        // 如果登录失败且需要验证码，提供更详细的建议
        if (result.errorCode === 54001) {
          this.addTestLog('拼多多检测到异常登录行为，需要图形验证码', 'warning');
          this.addTestLog('建议：在浏览器中正常登录拼多多商家后台，然后从开发者工具中复制最新的cookie和anti-content值', 'warning');
        }
        
        this.setData({ 
          duoduomaiLoginStatus: status,
          duoduomaiLoginStatusText: statusText,
          duoduomaiLoginResult: result.message,
          testingLogin: false
        });
        
        this.loadTestStatus();
      })
      .catch(err => {
        const errorResult = {
          success: false,
          message: '登录测试过程中发生异常',
          error: err.message || err,
          testType: 'login_payload'
        };
        
        duoduomai.saveTestResult(errorResult);
        this.addTestLog('登录测试过程中发生异常: ' + err.message, 'error');
        this.setData({ 
          duoduomaiLoginStatus: 'error',
          duoduomaiLoginStatusText: '测试异常',
          duoduomaiLoginResult: '登录测试过程中发生异常: ' + err.message,
          testingLogin: false
        });
        
        this.loadTestStatus();
      });
  },

  onReady() {
    // 页面初次渲染完成时执行
  },

  // 使用完整的登录Payload进行测试
  testLoginWithPayload() {
    if (this.data.testingLogin) return;
    
    const payloadStr = this.data.duoduomaiLoginPayload.trim();
    if (!payloadStr) {
      wx.showToast({
        title: '请输入登录Payload',
        icon: 'none'
      });
      return;
    }
    
    let loginData;
    try {
      loginData = JSON.parse(payloadStr);
    } catch (err) {
      wx.showToast({
        title: 'JSON格式错误',
        icon: 'none'
      });
      this.addTestLog('登录Payload JSON解析失败: ' + err.message, 'error');
      return;
    }
    
    // 验证必要字段
    if (!loginData.username || !loginData.password) {
      wx.showToast({
        title: '缺少用户名或密码',
        icon: 'none'
      });
      this.addTestLog('登录Payload缺少必要字段', 'error');
      return;
    }
    
    this.setData({ 
      testingLogin: true,
      duoduomaiLoginStatus: 'default',
      duoduomaiLoginStatusText: '测试中...',
      duoduomaiLoginResult: ''
    });
    
    this.addTestLog('开始使用完整登录Payload进行测试...');
    this.addTestLog('注意：使用浏览器中复制的完整登录数据', 'info');
    
    const loginConfig = {
      loginData: loginData,
      debug: this.data.duoduomaiDebugMode
    };
    
    duoduomai.testLoginWithConfig(loginConfig)
      .then(result => {
        result.testType = 'login_payload';
        duoduomai.saveTestResult(result);
        
        const status = result.success ? 'success' : 'error';
        const statusText = result.success ? '测试完成' : '测试失败';
        
        this.addTestLog(result.message, status);
        if (!result.success && result.error) {
          this.addTestLog('错误详情: ' + (result.errorMsg || result.error), 'error');
        }
        
        // 如果登录失败且需要验证码，提供更详细的建议
        if (result.errorCode === 54001) {
          this.addTestLog('拼多多检测到异常登录行为，需要图形验证码', 'warning');
          this.addTestLog('建议：在浏览器中正常登录拼多多商家后台，然后从开发者工具中复制最新的cookie和anti-content值', 'warning');
        }
        
        this.setData({ 
          duoduomaiLoginStatus: status,
          duoduomaiLoginStatusText: statusText,
          duoduomaiLoginResult: result.message,
          testingLogin: false
        });
        
        this.loadTestStatus();
      })
      .catch(err => {
        const errorResult = {
          success: false,
          message: '登录测试过程中发生异常',
          error: err.message || err,
          testType: 'login_payload'
        };
        
        duoduomai.saveTestResult(errorResult);
        this.addTestLog('登录测试过程中发生异常: ' + err.message, 'error');
        this.setData({ 
          duoduomaiLoginStatus: 'error',
          duoduomaiLoginStatusText: '测试异常',
          duoduomaiLoginResult: '登录测试过程中发生异常: ' + err.message,
          testingLogin: false
        });
        
        this.loadTestStatus();
      });
  },

  onHide() {
    // 页面隐藏时执行
  },

  // 使用完整的登录Payload进行测试
  testLoginWithPayload() {
    if (this.data.testingLogin) return;
    
    const payloadStr = this.data.duoduomaiLoginPayload.trim();
    if (!payloadStr) {
      wx.showToast({
        title: '请输入登录Payload',
        icon: 'none'
      });
      return;
    }
    
    let loginData;
    try {
      loginData = JSON.parse(payloadStr);
    } catch (err) {
      wx.showToast({
        title: 'JSON格式错误',
        icon: 'none'
      });
      this.addTestLog('登录Payload JSON解析失败: ' + err.message, 'error');
      return;
    }
    
    // 验证必要字段
    if (!loginData.username || !loginData.password) {
      wx.showToast({
        title: '缺少用户名或密码',
        icon: 'none'
      });
      this.addTestLog('登录Payload缺少必要字段', 'error');
      return;
    }
    
    this.setData({ 
      testingLogin: true,
      duoduomaiLoginStatus: 'default',
      duoduomaiLoginStatusText: '测试中...',
      duoduomaiLoginResult: ''
    });
    
    this.addTestLog('开始使用完整登录Payload进行测试...');
    this.addTestLog('注意：使用浏览器中复制的完整登录数据', 'info');
    
    const loginConfig = {
      loginData: loginData,
      debug: this.data.duoduomaiDebugMode
    };
    
    duoduomai.testLoginWithConfig(loginConfig)
      .then(result => {
        result.testType = 'login_payload';
        duoduomai.saveTestResult(result);
        
        const status = result.success ? 'success' : 'error';
        const statusText = result.success ? '测试完成' : '测试失败';
        
        this.addTestLog(result.message, status);
        if (!result.success && result.error) {
          this.addTestLog('错误详情: ' + (result.errorMsg || result.error), 'error');
        }
        
        // 如果登录失败且需要验证码，提供更详细的建议
        if (result.errorCode === 54001) {
          this.addTestLog('拼多多检测到异常登录行为，需要图形验证码', 'warning');
          this.addTestLog('建议：在浏览器中正常登录拼多多商家后台，然后从开发者工具中复制最新的cookie和anti-content值', 'warning');
        }
        
        this.setData({ 
          duoduomaiLoginStatus: status,
          duoduomaiLoginStatusText: statusText,
          duoduomaiLoginResult: result.message,
          testingLogin: false
        });
        
        this.loadTestStatus();
      })
      .catch(err => {
        const errorResult = {
          success: false,
          message: '登录测试过程中发生异常',
          error: err.message || err,
          testType: 'login_payload'
        };
        
        duoduomai.saveTestResult(errorResult);
        this.addTestLog('登录测试过程中发生异常: ' + err.message, 'error');
        this.setData({ 
          duoduomaiLoginStatus: 'error',
          duoduomaiLoginStatusText: '测试异常',
          duoduomaiLoginResult: '登录测试过程中发生异常: ' + err.message,
          testingLogin: false
        });
        
        this.loadTestStatus();
      });
  },

  onUnload() {
    // 页面卸载时执行
  },

  // 使用完整的登录Payload进行测试
  testLoginWithPayload() {
    if (this.data.testingLogin) return;
    
    const payloadStr = this.data.duoduomaiLoginPayload.trim();
    if (!payloadStr) {
      wx.showToast({
        title: '请输入登录Payload',
        icon: 'none'
      });
      return;
    }
    
    let loginData;
    try {
      loginData = JSON.parse(payloadStr);
    } catch (err) {
      wx.showToast({
        title: 'JSON格式错误',
        icon: 'none'
      });
      this.addTestLog('登录Payload JSON解析失败: ' + err.message, 'error');
      return;
    }
    
    // 验证必要字段
    if (!loginData.username || !loginData.password) {
      wx.showToast({
        title: '缺少用户名或密码',
        icon: 'none'
      });
      this.addTestLog('登录Payload缺少必要字段', 'error');
      return;
    }
    
    this.setData({ 
      testingLogin: true,
      duoduomaiLoginStatus: 'default',
      duoduomaiLoginStatusText: '测试中...',
      duoduomaiLoginResult: ''
    });
    
    this.addTestLog('开始使用完整登录Payload进行测试...');
    this.addTestLog('注意：使用浏览器中复制的完整登录数据', 'info');
    
    const loginConfig = {
      loginData: loginData,
      debug: this.data.duoduomaiDebugMode
    };
    
    duoduomai.testLoginWithConfig(loginConfig)
      .then(result => {
        result.testType = 'login_payload';
        duoduomai.saveTestResult(result);
        
        const status = result.success ? 'success' : 'error';
        const statusText = result.success ? '测试完成' : '测试失败';
        
        this.addTestLog(result.message, status);
        if (!result.success && result.error) {
          this.addTestLog('错误详情: ' + (result.errorMsg || result.error), 'error');
        }
        
        // 如果登录失败且需要验证码，提供更详细的建议
        if (result.errorCode === 54001) {
          this.addTestLog('拼多多检测到异常登录行为，需要图形验证码', 'warning');
          this.addTestLog('建议：在浏览器中正常登录拼多多商家后台，然后从开发者工具中复制最新的cookie和anti-content值', 'warning');
        }
        
        this.setData({ 
          duoduomaiLoginStatus: status,
          duoduomaiLoginStatusText: statusText,
          duoduomaiLoginResult: result.message,
          testingLogin: false
        });
        
        this.loadTestStatus();
      })
      .catch(err => {
        const errorResult = {
          success: false,
          message: '登录测试过程中发生异常',
          error: err.message || err,
          testType: 'login_payload'
        };
        
        duoduomai.saveTestResult(errorResult);
        this.addTestLog('登录测试过程中发生异常: ' + err.message, 'error');
        this.setData({ 
          duoduomaiLoginStatus: 'error',
          duoduomaiLoginStatusText: '测试异常',
          duoduomaiLoginResult: '登录测试过程中发生异常: ' + err.message,
          testingLogin: false
        });
        
        this.loadTestStatus();
      });
  },

  // 设置tabbar选中状态，支持重试机制
  setTabBarSelected() {
    const maxRetries = 5;
    const retryInterval = 100; // 毫秒
    
    const trySetSelected = (retryCount = 0) => {
      if (typeof this.getTabBar === 'function' && this.getTabBar()) {
        // "关于"页面是第四个tab，索引为3（因为tabbar有4个：0,1,2,3）
        this.getTabBar().setSelected(3);
      } else if (retryCount < maxRetries) {
        // 如果tabbar组件尚未就绪，延迟重试
        setTimeout(() => {
          trySetSelected(retryCount + 1);
        }, retryInterval);
      } else {
        console.warn('TabBar组件未找到，无法设置选中状态');
      }
    };
    
    trySetSelected();
  },

  // 使用完整的登录Payload进行测试
  testLoginWithPayload() {
    if (this.data.testingLogin) return;
    
    const payloadStr = this.data.duoduomaiLoginPayload.trim();
    if (!payloadStr) {
      wx.showToast({
        title: '请输入登录Payload',
        icon: 'none'
      });
      return;
    }
    
    let loginData;
    try {
      loginData = JSON.parse(payloadStr);
    } catch (err) {
      wx.showToast({
        title: 'JSON格式错误',
        icon: 'none'
      });
      this.addTestLog('登录Payload JSON解析失败: ' + err.message, 'error');
      return;
    }
    
    // 验证必要字段
    if (!loginData.username || !loginData.password) {
      wx.showToast({
        title: '缺少用户名或密码',
        icon: 'none'
      });
      this.addTestLog('登录Payload缺少必要字段', 'error');
      return;
    }
    
    this.setData({ 
      testingLogin: true,
      duoduomaiLoginStatus: 'default',
      duoduomaiLoginStatusText: '测试中...',
      duoduomaiLoginResult: ''
    });
    
    this.addTestLog('开始使用完整登录Payload进行测试...');
    this.addTestLog('注意：使用浏览器中复制的完整登录数据', 'info');
    
    const loginConfig = {
      loginData: loginData,
      debug: this.data.duoduomaiDebugMode
    };
    
    duoduomai.testLoginWithConfig(loginConfig)
      .then(result => {
        result.testType = 'login_payload';
        duoduomai.saveTestResult(result);
        
        const status = result.success ? 'success' : 'error';
        const statusText = result.success ? '测试完成' : '测试失败';
        
        this.addTestLog(result.message, status);
        if (!result.success && result.error) {
          this.addTestLog('错误详情: ' + (result.errorMsg || result.error), 'error');
        }
        
        // 如果登录失败且需要验证码，提供更详细的建议
        if (result.errorCode === 54001) {
          this.addTestLog('拼多多检测到异常登录行为，需要图形验证码', 'warning');
          this.addTestLog('建议：在浏览器中正常登录拼多多商家后台，然后从开发者工具中复制最新的cookie和anti-content值', 'warning');
        }
        
        this.setData({ 
          duoduomaiLoginStatus: status,
          duoduomaiLoginStatusText: statusText,
          duoduomaiLoginResult: result.message,
          testingLogin: false
        });
        
        this.loadTestStatus();
      })
      .catch(err => {
        const errorResult = {
          success: false,
          message: '登录测试过程中发生异常',
          error: err.message || err,
          testType: 'login_payload'
        };
        
        duoduomai.saveTestResult(errorResult);
        this.addTestLog('登录测试过程中发生异常: ' + err.message, 'error');
        this.setData({ 
          duoduomaiLoginStatus: 'error',
          duoduomaiLoginStatusText: '测试异常',
          duoduomaiLoginResult: '登录测试过程中发生异常: ' + err.message,
          testingLogin: false
        });
        
        this.loadTestStatus();
      });
  },

  // 加载测试状态
  loadTestStatus() {
    const status = duoduomai.getTestStatus();
    this.setData({
      lastTestTime: status.lastTestTime,
      testResults: status.testResults
    });
  },

  // 使用完整的登录Payload进行测试
  testLoginWithPayload() {
    if (this.data.testingLogin) return;
    
    const payloadStr = this.data.duoduomaiLoginPayload.trim();
    if (!payloadStr) {
      wx.showToast({
        title: '请输入登录Payload',
        icon: 'none'
      });
      return;
    }
    
    let loginData;
    try {
      loginData = JSON.parse(payloadStr);
    } catch (err) {
      wx.showToast({
        title: 'JSON格式错误',
        icon: 'none'
      });
      this.addTestLog('登录Payload JSON解析失败: ' + err.message, 'error');
      return;
    }
    
    // 验证必要字段
    if (!loginData.username || !loginData.password) {
      wx.showToast({
        title: '缺少用户名或密码',
        icon: 'none'
      });
      this.addTestLog('登录Payload缺少必要字段', 'error');
      return;
    }
    
    this.setData({ 
      testingLogin: true,
      duoduomaiLoginStatus: 'default',
      duoduomaiLoginStatusText: '测试中...',
      duoduomaiLoginResult: ''
    });
    
    this.addTestLog('开始使用完整登录Payload进行测试...');
    this.addTestLog('注意：使用浏览器中复制的完整登录数据', 'info');
    
    const loginConfig = {
      loginData: loginData,
      debug: this.data.duoduomaiDebugMode
    };
    
    duoduomai.testLoginWithConfig(loginConfig)
      .then(result => {
        result.testType = 'login_payload';
        duoduomai.saveTestResult(result);
        
        const status = result.success ? 'success' : 'error';
        const statusText = result.success ? '测试完成' : '测试失败';
        
        this.addTestLog(result.message, status);
        if (!result.success && result.error) {
          this.addTestLog('错误详情: ' + (result.errorMsg || result.error), 'error');
        }
        
        // 如果登录失败且需要验证码，提供更详细的建议
        if (result.errorCode === 54001) {
          this.addTestLog('拼多多检测到异常登录行为，需要图形验证码', 'warning');
          this.addTestLog('建议：在浏览器中正常登录拼多多商家后台，然后从开发者工具中复制最新的cookie和anti-content值', 'warning');
        }
        
        this.setData({ 
          duoduomaiLoginStatus: status,
          duoduomaiLoginStatusText: statusText,
          duoduomaiLoginResult: result.message,
          testingLogin: false
        });
        
        this.loadTestStatus();
      })
      .catch(err => {
        const errorResult = {
          success: false,
          message: '登录测试过程中发生异常',
          error: err.message || err,
          testType: 'login_payload'
        };
        
        duoduomai.saveTestResult(errorResult);
        this.addTestLog('登录测试过程中发生异常: ' + err.message, 'error');
        this.setData({ 
          duoduomaiLoginStatus: 'error',
          duoduomaiLoginStatusText: '测试异常',
          duoduomaiLoginResult: '登录测试过程中发生异常: ' + err.message,
          testingLogin: false
        });
        
        this.loadTestStatus();
      });
  },

  // 添加测试日志
  addTestLog(message, type = 'info') {
    const timestamp = new Date().toLocaleTimeString();
    const log = {
      time: timestamp,
      message: message,
      level: type  // WXML中使用level而不是type
    };
    
    const logs = [...this.data.duoduomaiTestLogs, log];
    // 只保留最近20条日志
    if (logs.length > 20) {
      logs.shift();
    }
    
    this.setData({
      duoduomaiTestLogs: logs
    });
    
    console.log(`[${timestamp}] ${message}`);
  },

  // 使用完整的登录Payload进行测试
  testLoginWithPayload() {
    if (this.data.testingLogin) return;
    
    const payloadStr = this.data.duoduomaiLoginPayload.trim();
    if (!payloadStr) {
      wx.showToast({
        title: '请输入登录Payload',
        icon: 'none'
      });
      return;
    }
    
    let loginData;
    try {
      loginData = JSON.parse(payloadStr);
    } catch (err) {
      wx.showToast({
        title: 'JSON格式错误',
        icon: 'none'
      });
      this.addTestLog('登录Payload JSON解析失败: ' + err.message, 'error');
      return;
    }
    
    // 验证必要字段
    if (!loginData.username || !loginData.password) {
      wx.showToast({
        title: '缺少用户名或密码',
        icon: 'none'
      });
      this.addTestLog('登录Payload缺少必要字段', 'error');
      return;
    }
    
    this.setData({ 
      testingLogin: true,
      duoduomaiLoginStatus: 'default',
      duoduomaiLoginStatusText: '测试中...',
      duoduomaiLoginResult: ''
    });
    
    this.addTestLog('开始使用完整登录Payload进行测试...');
    this.addTestLog('注意：使用浏览器中复制的完整登录数据', 'info');
    
    const loginConfig = {
      loginData: loginData,
      debug: this.data.duoduomaiDebugMode
    };
    
    duoduomai.testLoginWithConfig(loginConfig)
      .then(result => {
        result.testType = 'login_payload';
        duoduomai.saveTestResult(result);
        
        const status = result.success ? 'success' : 'error';
        const statusText = result.success ? '测试完成' : '测试失败';
        
        this.addTestLog(result.message, status);
        if (!result.success && result.error) {
          this.addTestLog('错误详情: ' + (result.errorMsg || result.error), 'error');
        }
        
        // 如果登录失败且需要验证码，提供更详细的建议
        if (result.errorCode === 54001) {
          this.addTestLog('拼多多检测到异常登录行为，需要图形验证码', 'warning');
          this.addTestLog('建议：在浏览器中正常登录拼多多商家后台，然后从开发者工具中复制最新的cookie和anti-content值', 'warning');
        }
        
        this.setData({ 
          duoduomaiLoginStatus: status,
          duoduomaiLoginStatusText: statusText,
          duoduomaiLoginResult: result.message,
          testingLogin: false
        });
        
        this.loadTestStatus();
      })
      .catch(err => {
        const errorResult = {
          success: false,
          message: '登录测试过程中发生异常',
          error: err.message || err,
          testType: 'login_payload'
        };
        
        duoduomai.saveTestResult(errorResult);
        this.addTestLog('登录测试过程中发生异常: ' + err.message, 'error');
        this.setData({ 
          duoduomaiLoginStatus: 'error',
          duoduomaiLoginStatusText: '测试异常',
          duoduomaiLoginResult: '登录测试过程中发生异常: ' + err.message,
          testingLogin: false
        });
        
        this.loadTestStatus();
      });
  },

  // 测试域名连通性
  testConnectivity() {
    if (this.data.testingConnectivity) return;
    
    this.setData({ 
      testingConnectivity: true,
      duoduomaiConnectivityStatus: 'default',
      duoduomaiConnectivityStatusText: '测试中...',
      duoduomaiConnectivityResult: ''
    });
    this.addTestLog('开始测试域名连通性...');
    
    duoduomai.testConnectivity()
      .then(result => {
        result.testType = 'connectivity';
        duoduomai.saveTestResult(result);
        
        const status = result.success ? 'success' : 'error';
        const statusText = result.success ? '测试通过' : '测试失败';
        
        this.addTestLog(result.message, status);
        this.setData({ 
          duoduomaiConnectivityStatus: status,
          duoduomaiConnectivityStatusText: statusText,
          duoduomaiConnectivityResult: result.message,
          testingConnectivity: false
        });
        
        this.loadTestStatus();
      })
      .catch(err => {
        const errorResult = {
          success: false,
          message: '测试过程中发生异常',
          error: err.message || err,
          testType: 'connectivity'
        };
        
        duoduomai.saveTestResult(errorResult);
        this.addTestLog('测试过程中发生异常: ' + err.message, 'error');
        this.setData({ 
          duoduomaiConnectivityStatus: 'error',
          duoduomaiConnectivityStatusText: '测试异常',
          duoduomaiConnectivityResult: '测试过程中发生异常: ' + err.message,
          testingConnectivity: false
        });
        
        this.loadTestStatus();
      });
  },

  // 使用完整的登录Payload进行测试
  testLoginWithPayload() {
    if (this.data.testingLogin) return;
    
    const payloadStr = this.data.duoduomaiLoginPayload.trim();
    if (!payloadStr) {
      wx.showToast({
        title: '请输入登录Payload',
        icon: 'none'
      });
      return;
    }
    
    let loginData;
    try {
      loginData = JSON.parse(payloadStr);
    } catch (err) {
      wx.showToast({
        title: 'JSON格式错误',
        icon: 'none'
      });
      this.addTestLog('登录Payload JSON解析失败: ' + err.message, 'error');
      return;
    }
    
    // 验证必要字段
    if (!loginData.username || !loginData.password) {
      wx.showToast({
        title: '缺少用户名或密码',
        icon: 'none'
      });
      this.addTestLog('登录Payload缺少必要字段', 'error');
      return;
    }
    
    this.setData({ 
      testingLogin: true,
      duoduomaiLoginStatus: 'default',
      duoduomaiLoginStatusText: '测试中...',
      duoduomaiLoginResult: ''
    });
    
    this.addTestLog('开始使用完整登录Payload进行测试...');
    this.addTestLog('注意：使用浏览器中复制的完整登录数据', 'info');
    
    const loginConfig = {
      loginData: loginData,
      debug: this.data.duoduomaiDebugMode
    };
    
    duoduomai.testLoginWithConfig(loginConfig)
      .then(result => {
        result.testType = 'login_payload';
        duoduomai.saveTestResult(result);
        
        const status = result.success ? 'success' : 'error';
        const statusText = result.success ? '测试完成' : '测试失败';
        
        this.addTestLog(result.message, status);
        if (!result.success && result.error) {
          this.addTestLog('错误详情: ' + (result.errorMsg || result.error), 'error');
        }
        
        // 如果登录失败且需要验证码，提供更详细的建议
        if (result.errorCode === 54001) {
          this.addTestLog('拼多多检测到异常登录行为，需要图形验证码', 'warning');
          this.addTestLog('建议：在浏览器中正常登录拼多多商家后台，然后从开发者工具中复制最新的cookie和anti-content值', 'warning');
        }
        
        this.setData({ 
          duoduomaiLoginStatus: status,
          duoduomaiLoginStatusText: statusText,
          duoduomaiLoginResult: result.message,
          testingLogin: false
        });
        
        this.loadTestStatus();
      })
      .catch(err => {
        const errorResult = {
          success: false,
          message: '登录测试过程中发生异常',
          error: err.message || err,
          testType: 'login_payload'
        };
        
        duoduomai.saveTestResult(errorResult);
        this.addTestLog('登录测试过程中发生异常: ' + err.message, 'error');
        this.setData({ 
          duoduomaiLoginStatus: 'error',
          duoduomaiLoginStatusText: '测试异常',
          duoduomaiLoginResult: '登录测试过程中发生异常: ' + err.message,
          testingLogin: false
        });
        
        this.loadTestStatus();
      });
  },

  // 测试登录功能
  testLogin() {
    if (this.data.testingLogin) return;
    
    this.setData({ 
      testingLogin: true,
      duoduomaiLoginStatus: 'default',
      duoduomaiLoginStatusText: '测试中...',
      duoduomaiLoginResult: ''
    });
    this.addTestLog('开始测试登录功能...');
    this.addTestLog('注意：密码加密方式未知，实际登录可能失败', 'warning');
    
    // 检查用户是否输入了自定义配置
    const useCustomConfig = this.data.duoduomaiCookie || this.data.duoduomaiAntiContent || 
                           this.data.duoduomaiPassword || this.data.duoduomaiUsername !== 'wangxh04';
    
    let loginPromise;
    
    if (useCustomConfig) {
      this.addTestLog('使用用户自定义配置进行登录测试', 'info');
      const loginConfig = {
        username: this.data.duoduomaiUsername,
        password: this.data.duoduomaiPassword,
        antiContent: this.data.duoduomaiAntiContent,
        timestamp: Date.now(),
        debug: this.data.duoduomaiDebugMode
      };
      loginPromise = duoduomai.testLoginWithConfig(loginConfig);
    } else {
      this.addTestLog('使用默认配置进行登录测试', 'info');
      if (this.data.duoduomaiDebugMode) {
        this.addTestLog('调试模式已开启，详细请求信息将输出到控制台', 'info');
      }
      loginPromise = duoduomai.testLogin(this.data.duoduomaiDebugMode);
    }
    
    loginPromise
      .then(result => {
        result.testType = 'login';
        duoduomai.saveTestResult(result);
        
        const status = result.success ? 'success' : 'error';
        const statusText = result.success ? '测试完成' : '测试失败';
        
        this.addTestLog(result.message, status);
        if (!result.success && result.error) {
          this.addTestLog('错误详情: ' + (result.errorMsg || result.error), 'error');
        }
        
        // 如果登录失败且需要验证码，提供更详细的建议
        if (result.errorCode === 54001) {
          this.addTestLog('拼多多检测到异常登录行为，需要图形验证码', 'warning');
          this.addTestLog('建议：在浏览器中正常登录拼多多商家后台，然后从开发者工具中复制最新的cookie和anti-content值', 'warning');
        }
        
        this.setData({ 
          duoduomaiLoginStatus: status,
          duoduomaiLoginStatusText: statusText,
          duoduomaiLoginResult: result.message,
          testingLogin: false
        });
        
        this.loadTestStatus();
      })
      .catch(err => {
        const errorResult = {
          success: false,
          message: '登录测试过程中发生异常',
          error: err.message || err,
          testType: 'login'
        };
        
        duoduomai.saveTestResult(errorResult);
        this.addTestLog('登录测试过程中发生异常: ' + err.message, 'error');
        this.setData({ 
          duoduomaiLoginStatus: 'error',
          duoduomaiLoginStatusText: '测试异常',
          duoduomaiLoginResult: '登录测试过程中发生异常: ' + err.message,
          testingLogin: false
        });
        
        this.loadTestStatus();
      });
  },

  // 使用完整的登录Payload进行测试
  testLoginWithPayload() {
    if (this.data.testingLogin) return;
    
    const payloadStr = this.data.duoduomaiLoginPayload.trim();
    if (!payloadStr) {
      wx.showToast({
        title: '请输入登录Payload',
        icon: 'none'
      });
      return;
    }
    
    let loginData;
    try {
      loginData = JSON.parse(payloadStr);
    } catch (err) {
      wx.showToast({
        title: 'JSON格式错误',
        icon: 'none'
      });
      this.addTestLog('登录Payload JSON解析失败: ' + err.message, 'error');
      return;
    }
    
    // 验证必要字段
    if (!loginData.username || !loginData.password) {
      wx.showToast({
        title: '缺少用户名或密码',
        icon: 'none'
      });
      this.addTestLog('登录Payload缺少必要字段', 'error');
      return;
    }
    
    this.setData({ 
      testingLogin: true,
      duoduomaiLoginStatus: 'default',
      duoduomaiLoginStatusText: '测试中...',
      duoduomaiLoginResult: ''
    });
    
    this.addTestLog('开始使用完整登录Payload进行测试...');
    this.addTestLog('注意：使用浏览器中复制的完整登录数据', 'info');
    
    const loginConfig = {
      loginData: loginData,
      debug: this.data.duoduomaiDebugMode
    };
    
    duoduomai.testLoginWithConfig(loginConfig)
      .then(result => {
        result.testType = 'login_payload';
        duoduomai.saveTestResult(result);
        
        const status = result.success ? 'success' : 'error';
        const statusText = result.success ? '测试完成' : '测试失败';
        
        this.addTestLog(result.message, status);
        if (!result.success && result.error) {
          this.addTestLog('错误详情: ' + (result.errorMsg || result.error), 'error');
        }
        
        // 如果登录失败且需要验证码，提供更详细的建议
        if (result.errorCode === 54001) {
          this.addTestLog('拼多多检测到异常登录行为，需要图形验证码', 'warning');
          this.addTestLog('建议：在浏览器中正常登录拼多多商家后台，然后从开发者工具中复制最新的cookie和anti-content值', 'warning');
        }
        
        this.setData({ 
          duoduomaiLoginStatus: status,
          duoduomaiLoginStatusText: statusText,
          duoduomaiLoginResult: result.message,
          testingLogin: false
        });
        
        this.loadTestStatus();
      })
      .catch(err => {
        const errorResult = {
          success: false,
          message: '登录测试过程中发生异常',
          error: err.message || err,
          testType: 'login_payload'
        };
        
        duoduomai.saveTestResult(errorResult);
        this.addTestLog('登录测试过程中发生异常: ' + err.message, 'error');
        this.setData({ 
          duoduomaiLoginStatus: 'error',
          duoduomaiLoginStatusText: '测试异常',
          duoduomaiLoginResult: '登录测试过程中发生异常: ' + err.message,
          testingLogin: false
        });
        
        this.loadTestStatus();
      });
  },

  // 测试订单查询
  testOrderQuery() {
    if (this.data.testingOrderQuery) return;
    
    this.setData({ 
      testingOrderQuery: true,
      duoduomaiOrderQueryStatus: 'default',
      duoduomaiOrderQueryStatusText: '测试中...',
      duoduomaiOrderQueryResult: ''
    });
    this.addTestLog('开始测试订单查询功能...');
    this.addTestLog('注意：使用用户提供的cookie，可能已过期', 'warning');
    
    // 检查用户是否输入了自定义配置
    const useCustomConfig = this.data.duoduomaiCookie || this.data.duoduomaiAntiContent;
    
    let orderQueryPromise;
    
    if (useCustomConfig) {
      this.addTestLog('使用用户自定义配置进行订单查询测试', 'info');
      if (this.data.duoduomaiDebugMode) {
        this.addTestLog('调试模式已开启，详细请求信息将输出到控制台', 'info');
      }
      const queryConfig = {
        cookie: this.data.duoduomaiCookie,
        antiContent: this.data.duoduomaiAntiContent,
        debug: this.data.duoduomaiDebugMode
      };
      orderQueryPromise = duoduomai.testOrderQueryWithConfig(queryConfig);
    } else {
      this.addTestLog('使用默认配置进行订单查询测试', 'info');
      if (this.data.duoduomaiDebugMode) {
        this.addTestLog('调试模式已开启，详细请求信息将输出到控制台', 'info');
      }
      orderQueryPromise = duoduomai.testOrderQueryWithCookie({}, this.data.duoduomaiDebugMode);
    }
    
    orderQueryPromise
      .then(result => {
        result.testType = 'order_query';
        duoduomai.saveTestResult(result);
        
        const status = result.success ? 'success' : 'error';
        const statusText = result.success ? '测试完成' : '测试失败';
        
        this.addTestLog(result.message, status);
        if (result.success) {
          this.addTestLog(`查询到 ${result.total} 条订单记录`, 'success');
          if (result.records && result.records.length > 0) {
            this.addTestLog(`第一条订单: ${JSON.stringify(result.records[0])}`, 'info');
          }
        } else if (result.error || result.errorMsg) {
          this.addTestLog('错误详情: ' + (result.errorMsg || result.error), 'error');
        }
        
        // 如果返回302重定向，说明cookie过期
        if (result.statusCode === 302) {
          this.addTestLog('Cookie已过期，请重新登录获取新的Cookie', 'warning');
        }
        
        this.setData({ 
          duoduomaiOrderQueryStatus: status,
          duoduomaiOrderQueryStatusText: statusText,
          duoduomaiOrderQueryResult: result.message,
          testingOrderQuery: false
        });
        
        this.loadTestStatus();
      })
      .catch(err => {
        const errorResult = {
          success: false,
          message: '订单查询测试过程中发生异常',
          error: err.message || err,
          testType: 'order_query'
        };
        
        duoduomai.saveTestResult(errorResult);
        this.addTestLog('订单查询测试过程中发生异常: ' + err.message, 'error');
        this.setData({ 
          duoduomaiOrderQueryStatus: 'error',
          duoduomaiOrderQueryStatusText: '测试异常',
          duoduomaiOrderQueryResult: '订单查询测试过程中发生异常: ' + err.message,
          testingOrderQuery: false
        });
        
        this.loadTestStatus();
      });
  },

  // 使用完整的登录Payload进行测试
  testLoginWithPayload() {
    if (this.data.testingLogin) return;
    
    const payloadStr = this.data.duoduomaiLoginPayload.trim();
    if (!payloadStr) {
      wx.showToast({
        title: '请输入登录Payload',
        icon: 'none'
      });
      return;
    }
    
    let loginData;
    try {
      loginData = JSON.parse(payloadStr);
    } catch (err) {
      wx.showToast({
        title: 'JSON格式错误',
        icon: 'none'
      });
      this.addTestLog('登录Payload JSON解析失败: ' + err.message, 'error');
      return;
    }
    
    // 验证必要字段
    if (!loginData.username || !loginData.password) {
      wx.showToast({
        title: '缺少用户名或密码',
        icon: 'none'
      });
      this.addTestLog('登录Payload缺少必要字段', 'error');
      return;
    }
    
    this.setData({ 
      testingLogin: true,
      duoduomaiLoginStatus: 'default',
      duoduomaiLoginStatusText: '测试中...',
      duoduomaiLoginResult: ''
    });
    
    this.addTestLog('开始使用完整登录Payload进行测试...');
    this.addTestLog('注意：使用浏览器中复制的完整登录数据', 'info');
    
    const loginConfig = {
      loginData: loginData,
      debug: this.data.duoduomaiDebugMode
    };
    
    duoduomai.testLoginWithConfig(loginConfig)
      .then(result => {
        result.testType = 'login_payload';
        duoduomai.saveTestResult(result);
        
        const status = result.success ? 'success' : 'error';
        const statusText = result.success ? '测试完成' : '测试失败';
        
        this.addTestLog(result.message, status);
        if (!result.success && result.error) {
          this.addTestLog('错误详情: ' + (result.errorMsg || result.error), 'error');
        }
        
        // 如果登录失败且需要验证码，提供更详细的建议
        if (result.errorCode === 54001) {
          this.addTestLog('拼多多检测到异常登录行为，需要图形验证码', 'warning');
          this.addTestLog('建议：在浏览器中正常登录拼多多商家后台，然后从开发者工具中复制最新的cookie和anti-content值', 'warning');
        }
        
        this.setData({ 
          duoduomaiLoginStatus: status,
          duoduomaiLoginStatusText: statusText,
          duoduomaiLoginResult: result.message,
          testingLogin: false
        });
        
        this.loadTestStatus();
      })
      .catch(err => {
        const errorResult = {
          success: false,
          message: '登录测试过程中发生异常',
          error: err.message || err,
          testType: 'login_payload'
        };
        
        duoduomai.saveTestResult(errorResult);
        this.addTestLog('登录测试过程中发生异常: ' + err.message, 'error');
        this.setData({ 
          duoduomaiLoginStatus: 'error',
          duoduomaiLoginStatusText: '测试异常',
          duoduomaiLoginResult: '登录测试过程中发生异常: ' + err.message,
          testingLogin: false
        });
        
        this.loadTestStatus();
      });
  },

  // 运行完整测试套件（暂未使用）
  // runFullTestSuite() {
  //   if (this.data.testingConnectivity || this.data.testingLogin || this.data.testingOrderQuery) return;
    
  //   this.addTestLog('开始运行完整测试套件...');
    
  //   // 按顺序执行测试
  //   this.testConnectivity();
    
  //   setTimeout(() => {
  //     this.testLogin();
      
  //     setTimeout(() => {
  //       this.testOrderQuery();
  //       this.addTestLog('完整测试套件执行完成', 'success');
  //     }, 2000);
  //   }, 2000);
  // },

  // 切换测试区域显示
  toggleTestSection() {
    this.setData({
      showDuoduomaiTest: !this.data.showDuoduomaiTest
    });
  },
  
  // 切换配置区域显示
  toggleConfigSection() {
    this.setData({
      showDuoduomaiConfig: !this.data.showDuoduomaiConfig
    });
  },
  
  // 更新cookie
  updateCookie(e) {
    this.setData({
      duoduomaiCookie: e.detail.value
    });
  },
  
  // 更新anti-content
  updateAntiContent(e) {
    this.setData({
      duoduomaiAntiContent: e.detail.value
    });
  },
  
  // 更新密码
  updatePassword(e) {
    this.setData({
      duoduomaiPassword: e.detail.value
    });
  },
  
  // 更新用户名
  updateUsername(e) {
    this.setData({
      duoduomaiUsername: e.detail.value
    });
  },

  // 使用完整的登录Payload进行测试
  testLoginWithPayload() {
    if (this.data.testingLogin) return;
    
    const payloadStr = this.data.duoduomaiLoginPayload.trim();
    if (!payloadStr) {
      wx.showToast({
        title: '请输入登录Payload',
        icon: 'none'
      });
      return;
    }
    
    let loginData;
    try {
      loginData = JSON.parse(payloadStr);
    } catch (err) {
      wx.showToast({
        title: 'JSON格式错误',
        icon: 'none'
      });
      this.addTestLog('登录Payload JSON解析失败: ' + err.message, 'error');
      return;
    }
    
    // 验证必要字段
    if (!loginData.username || !loginData.password) {
      wx.showToast({
        title: '缺少用户名或密码',
        icon: 'none'
      });
      this.addTestLog('登录Payload缺少必要字段', 'error');
      return;
    }
    
    this.setData({ 
      testingLogin: true,
      duoduomaiLoginStatus: 'default',
      duoduomaiLoginStatusText: '测试中...',
      duoduomaiLoginResult: ''
    });
    
    this.addTestLog('开始使用完整登录Payload进行测试...');
    this.addTestLog('注意：使用浏览器中复制的完整登录数据', 'info');
    
    const loginConfig = {
      loginData: loginData,
      debug: this.data.duoduomaiDebugMode
    };
    
    duoduomai.testLoginWithConfig(loginConfig)
      .then(result => {
        result.testType = 'login_payload';
        duoduomai.saveTestResult(result);
        
        const status = result.success ? 'success' : 'error';
        const statusText = result.success ? '测试完成' : '测试失败';
        
        this.addTestLog(result.message, status);
        if (!result.success && result.error) {
          this.addTestLog('错误详情: ' + (result.errorMsg || result.error), 'error');
        }
        
        // 如果登录失败且需要验证码，提供更详细的建议
        if (result.errorCode === 54001) {
          this.addTestLog('拼多多检测到异常登录行为，需要图形验证码', 'warning');
          this.addTestLog('建议：在浏览器中正常登录拼多多商家后台，然后从开发者工具中复制最新的cookie和anti-content值', 'warning');
        }
        
        this.setData({ 
          duoduomaiLoginStatus: status,
          duoduomaiLoginStatusText: statusText,
          duoduomaiLoginResult: result.message,
          testingLogin: false
        });
        
        this.loadTestStatus();
      })
      .catch(err => {
        const errorResult = {
          success: false,
          message: '登录测试过程中发生异常',
          error: err.message || err,
          testType: 'login_payload'
        };
        
        duoduomai.saveTestResult(errorResult);
        this.addTestLog('登录测试过程中发生异常: ' + err.message, 'error');
        this.setData({ 
          duoduomaiLoginStatus: 'error',
          duoduomaiLoginStatusText: '测试异常',
          duoduomaiLoginResult: '登录测试过程中发生异常: ' + err.message,
          testingLogin: false
        });
        
        this.loadTestStatus();
      });
  },

  // 更新调试模式
  updateDebugMode(e) {
    this.setData({
      duoduomaiDebugMode: e.detail.value
    });
  },

  // 使用完整的登录Payload进行测试
  testLoginWithPayload() {
    if (this.data.testingLogin) return;
    
    const payloadStr = this.data.duoduomaiLoginPayload.trim();
    if (!payloadStr) {
      wx.showToast({
        title: '请输入登录Payload',
        icon: 'none'
      });
      return;
    }
    
    let loginData;
    try {
      loginData = JSON.parse(payloadStr);
    } catch (err) {
      wx.showToast({
        title: 'JSON格式错误',
        icon: 'none'
      });
      this.addTestLog('登录Payload JSON解析失败: ' + err.message, 'error');
      return;
    }
    
    // 验证必要字段
    if (!loginData.username || !loginData.password) {
      wx.showToast({
        title: '缺少用户名或密码',
        icon: 'none'
      });
      this.addTestLog('登录Payload缺少必要字段', 'error');
      return;
    }
    
    this.setData({ 
      testingLogin: true,
      duoduomaiLoginStatus: 'default',
      duoduomaiLoginStatusText: '测试中...',
      duoduomaiLoginResult: ''
    });
    
    this.addTestLog('开始使用完整登录Payload进行测试...');
    this.addTestLog('注意：使用浏览器中复制的完整登录数据', 'info');
    
    const loginConfig = {
      loginData: loginData,
      debug: this.data.duoduomaiDebugMode
    };
    
    duoduomai.testLoginWithConfig(loginConfig)
      .then(result => {
        result.testType = 'login_payload';
        duoduomai.saveTestResult(result);
        
        const status = result.success ? 'success' : 'error';
        const statusText = result.success ? '测试完成' : '测试失败';
        
        this.addTestLog(result.message, status);
        if (!result.success && result.error) {
          this.addTestLog('错误详情: ' + (result.errorMsg || result.error), 'error');
        }
        
        // 如果登录失败且需要验证码，提供更详细的建议
        if (result.errorCode === 54001) {
          this.addTestLog('拼多多检测到异常登录行为，需要图形验证码', 'warning');
          this.addTestLog('建议：在浏览器中正常登录拼多多商家后台，然后从开发者工具中复制最新的cookie和anti-content值', 'warning');
        }
        
        this.setData({ 
          duoduomaiLoginStatus: status,
          duoduomaiLoginStatusText: statusText,
          duoduomaiLoginResult: result.message,
          testingLogin: false
        });
        
        this.loadTestStatus();
      })
      .catch(err => {
        const errorResult = {
          success: false,
          message: '登录测试过程中发生异常',
          error: err.message || err,
          testType: 'login_payload'
        };
        
        duoduomai.saveTestResult(errorResult);
        this.addTestLog('登录测试过程中发生异常: ' + err.message, 'error');
        this.setData({ 
          duoduomaiLoginStatus: 'error',
          duoduomaiLoginStatusText: '测试异常',
          duoduomaiLoginResult: '登录测试过程中发生异常: ' + err.message,
          testingLogin: false
        });
        
        this.loadTestStatus();
      });
  },

  // 更新登录Payload
  updateLoginPayload(e) {
    this.setData({
      duoduomaiLoginPayload: e.detail.value
    });
  },

  // 使用完整的登录Payload进行测试
  testLoginWithPayload() {
    if (this.data.testingLogin) return;
    
    const payloadStr = this.data.duoduomaiLoginPayload.trim();
    if (!payloadStr) {
      wx.showToast({
        title: '请输入登录Payload',
        icon: 'none'
      });
      return;
    }
    
    let loginData;
    try {
      loginData = JSON.parse(payloadStr);
    } catch (err) {
      wx.showToast({
        title: 'JSON格式错误',
        icon: 'none'
      });
      this.addTestLog('登录Payload JSON解析失败: ' + err.message, 'error');
      return;
    }
    
    // 验证必要字段
    if (!loginData.username || !loginData.password) {
      wx.showToast({
        title: '缺少用户名或密码',
        icon: 'none'
      });
      this.addTestLog('登录Payload缺少必要字段', 'error');
      return;
    }
    
    this.setData({ 
      testingLogin: true,
      duoduomaiLoginStatus: 'default',
      duoduomaiLoginStatusText: '测试中...',
      duoduomaiLoginResult: ''
    });
    
    this.addTestLog('开始使用完整登录Payload进行测试...');
    this.addTestLog('注意：使用浏览器中复制的完整登录数据', 'info');
    
    const loginConfig = {
      loginData: loginData,
      debug: this.data.duoduomaiDebugMode
    };
    
    duoduomai.testLoginWithConfig(loginConfig)
      .then(result => {
        result.testType = 'login_payload';
        duoduomai.saveTestResult(result);
        
        const status = result.success ? 'success' : 'error';
        const statusText = result.success ? '测试完成' : '测试失败';
        
        this.addTestLog(result.message, status);
        if (!result.success && result.error) {
          this.addTestLog('错误详情: ' + (result.errorMsg || result.error), 'error');
        }
        
        // 如果登录失败且需要验证码，提供更详细的建议
        if (result.errorCode === 54001) {
          this.addTestLog('拼多多检测到异常登录行为，需要图形验证码', 'warning');
          this.addTestLog('建议：在浏览器中正常登录拼多多商家后台，然后从开发者工具中复制最新的cookie和anti-content值', 'warning');
        }
        
        this.setData({ 
          duoduomaiLoginStatus: status,
          duoduomaiLoginStatusText: statusText,
          duoduomaiLoginResult: result.message,
          testingLogin: false
        });
        
        this.loadTestStatus();
      })
      .catch(err => {
        const errorResult = {
          success: false,
          message: '登录测试过程中发生异常',
          error: err.message || err,
          testType: 'login_payload'
        };
        
        duoduomai.saveTestResult(errorResult);
        this.addTestLog('登录测试过程中发生异常: ' + err.message, 'error');
        this.setData({ 
          duoduomaiLoginStatus: 'error',
          duoduomaiLoginStatusText: '测试异常',
          duoduomaiLoginResult: '登录测试过程中发生异常: ' + err.message,
          testingLogin: false
        });
        
        this.loadTestStatus();
      });
  },

  // 加载配置
  loadConfig() {
    const cookie = wx.getStorageSync('duoduomai_cookie') || '';
    const antiContent = wx.getStorageSync('duoduomai_anti_content') || '';
    const password = wx.getStorageSync('duoduomai_password') || '';
    const username = wx.getStorageSync('duoduomai_username') || 'wangxh04';
    const debugMode = wx.getStorageSync('duoduomai_debug_mode') || false;
    
    this.setData({
      duoduomaiCookie: cookie,
      duoduomaiAntiContent: antiContent,
      duoduomaiPassword: password,
      duoduomaiUsername: username,
      duoduomaiDebugMode: debugMode
    });
  },
  
  // 保存配置
  saveConfig() {
    wx.setStorageSync('duoduomai_cookie', this.data.duoduomaiCookie);
    wx.setStorageSync('duoduomai_anti_content', this.data.duoduomaiAntiContent);
    wx.setStorageSync('duoduomai_password', this.data.duoduomaiPassword);
    wx.setStorageSync('duoduomai_username', this.data.duoduomaiUsername);
    wx.setStorageSync('duoduomai_debug_mode', this.data.duoduomaiDebugMode);
    
    this.addTestLog('配置已保存', 'success');
    wx.showToast({
      title: '配置已保存',
      icon: 'success'
    });
  },

  // 使用完整的登录Payload进行测试
  testLoginWithPayload() {
    if (this.data.testingLogin) return;
    
    const payloadStr = this.data.duoduomaiLoginPayload.trim();
    if (!payloadStr) {
      wx.showToast({
        title: '请输入登录Payload',
        icon: 'none'
      });
      return;
    }
    
    let loginData;
    try {
      loginData = JSON.parse(payloadStr);
    } catch (err) {
      wx.showToast({
        title: 'JSON格式错误',
        icon: 'none'
      });
      this.addTestLog('登录Payload JSON解析失败: ' + err.message, 'error');
      return;
    }
    
    // 验证必要字段
    if (!loginData.username || !loginData.password) {
      wx.showToast({
        title: '缺少用户名或密码',
        icon: 'none'
      });
      this.addTestLog('登录Payload缺少必要字段', 'error');
      return;
    }
    
    this.setData({ 
      testingLogin: true,
      duoduomaiLoginStatus: 'default',
      duoduomaiLoginStatusText: '测试中...',
      duoduomaiLoginResult: ''
    });
    
    this.addTestLog('开始使用完整登录Payload进行测试...');
    this.addTestLog('注意：使用浏览器中复制的完整登录数据', 'info');
    
    const loginConfig = {
      loginData: loginData,
      debug: this.data.duoduomaiDebugMode
    };
    
    duoduomai.testLoginWithConfig(loginConfig)
      .then(result => {
        result.testType = 'login_payload';
        duoduomai.saveTestResult(result);
        
        const status = result.success ? 'success' : 'error';
        const statusText = result.success ? '测试完成' : '测试失败';
        
        this.addTestLog(result.message, status);
        if (!result.success && result.error) {
          this.addTestLog('错误详情: ' + (result.errorMsg || result.error), 'error');
        }
        
        // 如果登录失败且需要验证码，提供更详细的建议
        if (result.errorCode === 54001) {
          this.addTestLog('拼多多检测到异常登录行为，需要图形验证码', 'warning');
          this.addTestLog('建议：在浏览器中正常登录拼多多商家后台，然后从开发者工具中复制最新的cookie和anti-content值', 'warning');
        }
        
        this.setData({ 
          duoduomaiLoginStatus: status,
          duoduomaiLoginStatusText: statusText,
          duoduomaiLoginResult: result.message,
          testingLogin: false
        });
        
        this.loadTestStatus();
      })
      .catch(err => {
        const errorResult = {
          success: false,
          message: '登录测试过程中发生异常',
          error: err.message || err,
          testType: 'login_payload'
        };
        
        duoduomai.saveTestResult(errorResult);
        this.addTestLog('登录测试过程中发生异常: ' + err.message, 'error');
        this.setData({ 
          duoduomaiLoginStatus: 'error',
          duoduomaiLoginStatusText: '测试异常',
          duoduomaiLoginResult: '登录测试过程中发生异常: ' + err.message,
          testingLogin: false
        });
        
        this.loadTestStatus();
      });
  },

  // 清空测试日志
  clearTestLogs() {
    this.setData({
      duoduomaiTestLogs: []
    });
    this.addTestLog('测试日志已清空', 'info');
  },

  // 使用完整的登录Payload进行测试
  testLoginWithPayload() {
    if (this.data.testingLogin) return;
    
    const payloadStr = this.data.duoduomaiLoginPayload.trim();
    if (!payloadStr) {
      wx.showToast({
        title: '请输入登录Payload',
        icon: 'none'
      });
      return;
    }
    
    let loginData;
    try {
      loginData = JSON.parse(payloadStr);
    } catch (err) {
      wx.showToast({
        title: 'JSON格式错误',
        icon: 'none'
      });
      this.addTestLog('登录Payload JSON解析失败: ' + err.message, 'error');
      return;
    }
    
    // 验证必要字段
    if (!loginData.username || !loginData.password) {
      wx.showToast({
        title: '缺少用户名或密码',
        icon: 'none'
      });
      this.addTestLog('登录Payload缺少必要字段', 'error');
      return;
    }
    
    this.setData({ 
      testingLogin: true,
      duoduomaiLoginStatus: 'default',
      duoduomaiLoginStatusText: '测试中...',
      duoduomaiLoginResult: ''
    });
    
    this.addTestLog('开始使用完整登录Payload进行测试...');
    this.addTestLog('注意：使用浏览器中复制的完整登录数据', 'info');
    
    const loginConfig = {
      loginData: loginData,
      debug: this.data.duoduomaiDebugMode
    };
    
    duoduomai.testLoginWithConfig(loginConfig)
      .then(result => {
        result.testType = 'login_payload';
        duoduomai.saveTestResult(result);
        
        const status = result.success ? 'success' : 'error';
        const statusText = result.success ? '测试完成' : '测试失败';
        
        this.addTestLog(result.message, status);
        if (!result.success && result.error) {
          this.addTestLog('错误详情: ' + (result.errorMsg || result.error), 'error');
        }
        
        // 如果登录失败且需要验证码，提供更详细的建议
        if (result.errorCode === 54001) {
          this.addTestLog('拼多多检测到异常登录行为，需要图形验证码', 'warning');
          this.addTestLog('建议：在浏览器中正常登录拼多多商家后台，然后从开发者工具中复制最新的cookie和anti-content值', 'warning');
        }
        
        this.setData({ 
          duoduomaiLoginStatus: status,
          duoduomaiLoginStatusText: statusText,
          duoduomaiLoginResult: result.message,
          testingLogin: false
        });
        
        this.loadTestStatus();
      })
      .catch(err => {
        const errorResult = {
          success: false,
          message: '登录测试过程中发生异常',
          error: err.message || err,
          testType: 'login_payload'
        };
        
        duoduomai.saveTestResult(errorResult);
        this.addTestLog('登录测试过程中发生异常: ' + err.message, 'error');
        this.setData({ 
          duoduomaiLoginStatus: 'error',
          duoduomaiLoginStatusText: '测试异常',
          duoduomaiLoginResult: '登录测试过程中发生异常: ' + err.message,
          testingLogin: false
        });
        
        this.loadTestStatus();
      });
  },

  // 查看详细测试结果
  viewTestResultDetail(e) {
    const index = e.currentTarget.dataset.index;
    const result = this.data.testResults[index];
    
    if (result) {
      wx.showModal({
        title: `测试结果 - ${result.testType}`,
        content: JSON.stringify(result.details, null, 2),
        showCancel: false,
        confirmText: '关闭'
      });
    }
  }
})