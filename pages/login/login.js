// pages/login/login.js
const { login, coldStartRefresh, isTokenValid } = require('../../utils/request.js')

Page({
  data: {
    email: '',
    password: '',
    isLoading: false,
    isAutoRefreshing: false
  },

  onLoad() {
    // 检查并尝试自动登录
    this.attemptAutoLogin()
  },

  // 简化的自动登录函数
  async attemptAutoLogin() {
    const token = wx.getStorageSync('access_token')
    const refreshToken = wx.getStorageSync('refresh_token')
    
    // 情况1: 完全没有token，需要手动登录
    if (!token && !refreshToken) {
      return
    }
    
    // 情况2: 有token且有效，直接跳转
    if (token && isTokenValid()) {
      this.autoLoginSuccess()
      return
    }
    
    // 情况3: token无效但有refresh_token，尝试刷新
    if (refreshToken) {
      this.setData({ isAutoRefreshing: true })
      
      try {
        const refreshSuccess = await coldStartRefresh()
        
        if (refreshSuccess) {
          this.autoLoginSuccess()
        } else {
          // 刷新失败，显示登录界面
          this.setData({ isAutoRefreshing: false })
          wx.showToast({
            title: '自动登录失败，请手动登录',
            icon: 'none',
            duration: 2000
          })
        }
      } catch (error) {
        console.error('自动登录失败:', error)
        this.setData({ isAutoRefreshing: false })
      }
    }
  },

  // 自动登录成功后的统一处理
  autoLoginSuccess() {
    // 获取用户信息
    const userInfo = wx.getStorageSync('user_info')
    const displayName = userInfo ? userInfo.display_name || '品牌用户' : '品牌用户'
    
    // 如果正在显示加载，先停止
    if (this.data.isAutoRefreshing) {
      this.setData({ isAutoRefreshing: false })
    }
    
    wx.showToast({
      title: `欢迎回来，${displayName}！`,
      icon: 'success',
      duration: 1500
    })
    
    // 延迟跳转到首页
    setTimeout(() => {
      wx.switchTab({
        url: '/pages/index/index'
      })
    }, 1500)
  },

  onEmailInput(e) {
    this.setData({ email: e.detail.value })
  },

  onPasswordInput(e) {
    this.setData({ password: e.detail.value })
  },

  async onLogin() {
    const { email, password } = this.data
    
    if (!email || !password) {
      wx.showToast({
        title: '请输入邮箱和密码',
        icon: 'none'
      })
      return
    }
    
    this.setData({ isLoading: true })
    
    try {
      const result = await login(email, password)
      
      if (result.access_token) {
        // 保存access_token
        wx.setStorageSync('access_token', result.access_token)
        
        // 保存refresh_token（用于刷新）
        if (result.refresh_token) {
          wx.setStorageSync('refresh_token', result.refresh_token)
        }
        
        // 保存过期时间
        const expiresIn = Math.floor(Date.now() / 1000) + (result.expires_in || 1800)
        wx.setStorageSync('token_expiry', expiresIn.toString())

        // 保存完整的用户信息
        const user = result.user || {}
        const userInfo = {
          id: user.id || '',
          email: user.email || '',
          role: user.role || '',
          display_name: user.user_metadata.display_name || '',
          created_at: user.created_at,
          last_sign_in_at: user.last_sign_in_at
        }        
        wx.setStorageSync('user_info', userInfo)
        
        // 设置登录时间戳
        wx.setStorageSync('login_timestamp', Date.now().toString())
        
        wx.showToast({
          title: '登录成功',
          icon: 'success',
          duration: 1500
        })
        
        // 延迟跳转，确保storage已保存
        setTimeout(() => {
          wx.switchTab({
            url: '/pages/index/index'
          })
        }, 1500)
      } else {
        throw new Error('登录响应中没有access_token')
      }
      
    } catch (error) {
      console.error('登录失败:', error)
      
      let errorMsg = '登录失败，请重试'
      
      if (error.data) {
        try {
          const errorData = typeof error.data === 'string' ? JSON.parse(error.data) : error.data
          errorMsg = errorData.error_description || errorData.message || errorMsg
        } catch (e) {
          errorMsg = error.data || errorMsg
        }
      } else if (error.message) {
        errorMsg = error.message
      }
      
      wx.showToast({
        title: errorMsg,
        icon: 'none',
        duration: 3000
      })
      
    } finally {
      this.setData({ isLoading: false })
    }
  },

  onForgotPassword() {
    wx.showModal({
      title: '提示',
      content: '暂不支持重置密码，请与管理员联系！',
      showCancel: false,
      confirmText: '知道了'
    })
  }
})