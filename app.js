// app.js主程序，最先加载
const { logout } = require('./utils/request.js')

App({
  globalData: {
    // 可以完全清空，或者只保留必要的标志
    appVersion: '1.1.0',
    longqiaoCachedData: null,
    longqiaoInitialized: false,
    userIconCache: null  // 用户图标缓存，避免重复加载
  },
  
  onLaunch() {
    console.log('小程序启动')
    
    // 预加载tabBar图标，避免页面切换时重复加载
    try {
      const iconPaths = [
        '/images/icon64-gray.png',
        '/images/icon64.png'
      ]
      
      iconPaths.forEach(path => {
        wx.getImageInfo({
          src: path,
          success: () => {
          },
          fail: (err) => {
            console.warn('预加载图标失败:', path, err)
          }
        })
      })
    } catch (error) {
      console.error('预加载图标异常:', error)
    }
  },
  
  // 全局退出登录函数
  async globalLogout() {
    return new Promise((resolve) => {
      wx.showModal({
        title: '确认退出',
        content: '确定要退出登录吗？',
        success: async (res) => {
          if (res.confirm) {
            try {
              await logout()
              
              // 清除所有本地缓存数据
              wx.clearStorageSync()
              
              // 清除全局缓存
              this.globalData.userIconCache = null
              this.globalData.longqiaoCachedData = null
              this.globalData.longqiaoInitialized = false

              setTimeout(() => {
                wx.reLaunch({
                  url: '/pages/login/login'
                })
                resolve()
              }, 1000)
              
            } catch (error) {
              console.error('退出登录失败:', error)
              // 即使退出失败，也清除本地缓存
              wx.clearStorageSync()
              this.globalData.userIconCache = null
              this.globalData.longqiaoCachedData = null
              this.globalData.longqiaoInitialized = false
              
              wx.showToast({
                title: '退出失败，已清除本地缓存',
                icon: 'none'
              })
              resolve()
            }
          } else {
            resolve()
          }
        }
      })
    })
  }
})