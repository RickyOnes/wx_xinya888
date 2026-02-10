// utils/request.js
// 缓存配置
const getConfig = () => {
  return {
    supabaseUrl: 'https://iglmqwpagzjadwauvchh.supabase.co',
    supabaseKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlnbG1xd3BhZ3pqYWR3YXV2Y2hoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTA4ODk4NDAsImV4cCI6MjA2NjQ2NTg0MH0.Mtiwp31mJvbLRTotbrb4_DobjjpM4kg9f4-G8oWz85E'
  }
}

// 检查token是否有效
const isTokenValid = () => {
  const token = wx.getStorageSync('access_token')
  const tokenExpiry = wx.getStorageSync('token_expiry')
  
  if (!token || !tokenExpiry) {
    return false
  }
  
  const currentTime = Math.floor(Date.now() / 1000)
  const expiryTime = parseInt(tokenExpiry)
  
  // expiryTim是对应 access_token 的过期时间戳，提前5分钟检查，大于5则未过期返回True，否则认为过期
  return expiryTime > currentTime - 300
}

// 自动刷新token（如果需要）
const autoRefreshToken = async () => {
  if (!isTokenValid()) { //访问令牌没过期，则跳过，过期则往下执行
    const refreshToken = wx.getStorageSync('refresh_token')
    
    if (refreshToken) {
      try {
        const config = getConfig()
        
        const response = await new Promise((resolve, reject) => {
          wx.request({
            url: `${config.supabaseUrl}/auth/v1/token?grant_type=refresh_token`,
            method: 'POST',
            data: { refresh_token: refreshToken },
            header: {
              'Content-Type': 'application/json',
              'apikey': config.supabaseKey
            },
            success: resolve,
            fail: reject
          })
        })
        
        if (response.statusCode >= 200 && response.statusCode < 300) {
          const newTokenData = response.data
          
          // 保存新的token
          wx.setStorageSync('access_token', newTokenData.access_token)
          
          // 如果有新的refresh_token也保存
          if (newTokenData.refresh_token) {
            wx.setStorageSync('refresh_token', newTokenData.refresh_token)
          }

          const nowSec = Math.floor(Date.now() / 1000)
          const newExpiry = newTokenData.expires_at
          ? parseInt(newTokenData.expires_at): nowSec + (newTokenData.expires_in || 1800)
                  
          // 更新过期时间
          wx.setStorageSync('token_expiry', newExpiry.toString())  

          return newTokenData.access_token
        }
      } catch (error) {
        console.error('自动刷新token失败:', error)
        // 刷新失败，清除token
        clearAuthData()
        throw error
      }
    } else {
      // 没有refresh_token，需要重新登录
      clearAuthData()
      throw new Error('需要重新登录')
    }
  }
  
  // token仍然有效
  return wx.getStorageSync('access_token')
}

// 清除认证数据
const clearAuthData = () => {
  wx.removeStorageSync('access_token')
  wx.removeStorageSync('refresh_token')
  wx.removeStorageSync('token_expiry')
  wx.removeStorageSync('user_info')
  wx.removeStorageSync('login_timestamp')
}

// 冷启动刷新函数 - 用于登录页面的自动刷新
const coldStartRefresh = async () => {
  
  const refreshToken = wx.getStorageSync('refresh_token')
  
  // 没有refresh_token，直接返回失败
  if (!refreshToken) {
    return false
  }
  
  try {
    const config = getConfig()
    
    const response = await new Promise((resolve, reject) => {
      wx.request({
        url: `${config.supabaseUrl}/auth/v1/token?grant_type=refresh_token`,
        method: 'POST',
        data: { refresh_token: refreshToken },
        header: {
          'Content-Type': 'application/json',
          'apikey': config.supabaseKey
        },
        success: resolve,
        fail: reject
      })
    })
    
    if (response.statusCode >= 200 && response.statusCode < 300) {
      const newTokenData = response.data
      
      // 保存新的token
      wx.setStorageSync('access_token', newTokenData.access_token)
      
      // 如果有新的refresh_token也保存
      if (newTokenData.refresh_token) {
        wx.setStorageSync('refresh_token', newTokenData.refresh_token)
      }

      const nowSec = Math.floor(Date.now() / 1000)
      const newExpiry = newTokenData.expires_at
        ? parseInt(newTokenData.expires_at)
        : nowSec + (newTokenData.expires_in || 1800)
              
      // 更新过期时间
      wx.setStorageSync('token_expiry', newExpiry.toString())  

      console.log('冷启动刷新成功')
      return true
    } else {
      console.log('冷启动刷新失败，状态码:', response.statusCode)
      // 刷新失败，清除token
      clearAuthData()
      return false
    }
  } catch (error) {
    console.error('冷启动刷新失败:', error)
    // 刷新失败，清除token
    clearAuthData()
    return false
  }
}

// 修改主请求函数
const request = async (options) => {
  return new Promise(async (resolve, reject) => {
    try {
      // 检查并刷新token
      const token = await autoRefreshToken()
      
      const config = getConfig()
      
      // 构建完整URL
      let fullUrl = options.url
      if (options.url.startsWith('/')) {
        fullUrl = `${config.supabaseUrl}${options.url}`
      }
      
      // 准备请求头
      const headers = {
        'Content-Type': 'application/json',
        'apikey': config.supabaseKey,
        ...options.header
      }
      
      // 添加Authorization头
      if (token) {
        headers['Authorization'] = `Bearer ${token}`
      }
      
      wx.request({
        url: fullUrl,
        method: options.method || 'GET',
        data: options.data || {},
        header: headers,
        success: (res) => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(res)
          } else if (res.statusCode === 401) {
            // 401错误，token无效
            console.error('Token无效，需要重新登录')
            clearAuthData()
            
            // 显示提示并跳转到登录页
            wx.showModal({
              title: '登录已过期',
              content: '您的登录已过期，请重新登录',
              showCancel: false,
              success: () => {
                wx.reLaunch({
                  url: '/pages/login/login'
                })
              }
            })
            reject(new Error('登录已过期'))
          } else {
            console.error('请求失败:', res)
            wx.showToast({
              title: `请求失败: ${res.statusCode}`,
              icon: 'none'
            })
            reject(res)
          }
        },
        fail: (err) => {
          console.error('网络请求失败:', err)
          wx.showToast({
            title: '网络请求失败',
            icon: 'none'
          })
          reject(err)
        }
      })
    } catch (error) {
      console.error('请求准备失败:', error)
      
      if (error.message === '需要重新登录') {
        // 跳转到登录页面
        wx.reLaunch({
          url: '/pages/login/login'
        })
      }
      
      reject(error)
    }
  })
}

// 修改登录函数，确保保存完整信息
const login = async (email, password) => {
  return new Promise((resolve, reject) => {
    const config = getConfig()
    
    wx.request({
      url: `${config.supabaseUrl}/auth/v1/token?grant_type=password`,
      method: 'POST',
      data: { email, password },
      header: {
        'Content-Type': 'application/json',
        'apikey': config.supabaseKey
      },
      success: (res) => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(res.data)
        } else {
          reject(res)
        }
      },
      fail: reject
    })
  })
}

// 获取用户信息
const getUserInfo = async () => {
  return new Promise((resolve, reject) => {
    const token = wx.getStorageSync('access_token')
    if (!token) {
      reject(new Error('未登录'))
      return
    }
    
    const config = getConfig()
    
    wx.request({
      url: `${config.supabaseUrl}/auth/v1/user`,
      method: 'GET',
      header: {
        'Authorization': `Bearer ${token}`,
        'apikey': config.supabaseKey
      },
      success: (res) => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(res.data)
        } else {
          reject(res)
        }
      },
      fail: reject
    })
  })
}

// 退出登录函数
const logout = async () => {
  return new Promise((resolve, reject) => {
    const token = wx.getStorageSync('access_token')
    
    if (!token) {
      clearAuthData()
      resolve()
      return
    }
    
    const config = getConfig()
    
    wx.request({
      url: `${config.supabaseUrl}/auth/v1/logout`,
      method: 'POST',
      header: {
        'Authorization': `Bearer ${token}`,
        'apikey': config.supabaseKey
      },
      success: (res) => {
        clearAuthData()
        resolve(res.data)
      },
      fail: (err) => {
        // 即使请求失败，也清除本地数据
        clearAuthData()
        reject(err)
      }
    })
  })
}

// 精简后的 Supabase 查询函数
const supabaseQuery = {
  // 新增：获取完整销售数据（不筛选品牌和仓库）
  async getRawSalesData(params = {}) {
    const { startDate, endDate, limit = 50000, offset = 0 } = params
    
    const filters = {}
    
    if (startDate && endDate) {
      filters['sale_date'] = [
        { operator: 'gte', value: startDate },
        { operator: 'lte', value: endDate }
      ]
    } else if (startDate) {
      filters['sale_date'] = { operator: 'gte', value: startDate }
    } else if (endDate) {
      filters['sale_date'] = { operator: 'lte', value: endDate }
    }
    
    let queryParams = []
    
    // 处理筛选条件
    Object.keys(filters).forEach(key => {
      const value = filters[key]
      if (value !== undefined && value !== null && value !== '') {
        if (Array.isArray(value)) {
          value.forEach(condition => {
            if (condition && condition.operator && condition.value) {
              queryParams.push(`${key}=${condition.operator}.${encodeURIComponent(condition.value)}`)
            }
          })
        } else if (typeof value === 'object' && value.operator) {
          queryParams.push(`${key}=${value.operator}.${encodeURIComponent(value.value)}`)
        } else {
          queryParams.push(`${key}=eq.${encodeURIComponent(value)}`)
        }
      }
    })
    
    // 添加select、order、limit、offset参数
    queryParams.push('select=sale_date,product_id,product_name,warehouse,quantity,unit_price,brand,pieces,returns,inbounds,difference,internal_id')
    queryParams.push('order=sale_date.desc')
    queryParams.push(`limit=${limit}`)
    if (offset > 0) {
      queryParams.push(`offset=${offset}`)
    }
    
    const queryString = queryParams.length > 0 ? `?${queryParams.join('&')}` : ''
    
    const response = await request({
      url: `/rest/v1/sales_records${queryString}`,
      method: 'GET',
      header: {
        'Prefer': 'count=exact'
      }
    })
    
    // 从响应头中获取总数
    let totalCount = 0
    const contentRange = response.header['Content-Range']
    if (contentRange) {
      const match = contentRange.match(/\/(\d+)$/)
      if (match) {
        totalCount = parseInt(match[1])
      }
    }
    
    return {
      data: response.data,
      totalCount: totalCount,
      header: response.header
    }
  },



  // 隆桥仓库数据查询
  async getLongqiaoData(params = {}) {
    const { startDate, endDate, limit = 50000, offset = 0 } = params
    
    const filters = {}
    
    if (startDate && endDate) {
      filters['sale_date'] = [
        { operator: 'gte', value: startDate },
        { operator: 'lte', value: endDate }
      ]
    } else if (startDate) {
      filters['sale_date'] = { operator: 'gte', value: startDate }
    } else if (endDate) {
      filters['sale_date'] = { operator: 'lte', value: endDate }
    }
    
    let queryParams = []
    
    // 处理筛选条件
    Object.keys(filters).forEach(key => {
      const value = filters[key]
      if (value !== undefined && value !== null && value !== '') {
        if (Array.isArray(value)) {
          value.forEach(condition => {
            if (condition && condition.operator && condition.value) {
              queryParams.push(`${key}=${condition.operator}.${encodeURIComponent(condition.value)}`)
            }
          })
        } else if (typeof value === 'object' && value.operator) {
          queryParams.push(`${key}=${value.operator}.${encodeURIComponent(value.value)}`)
        } else {
          queryParams.push(`${key}=eq.${encodeURIComponent(value)}`)
        }
      }
    })
    
    // 添加select、order、limit、offset参数
    queryParams.push('select=sale_date,product_id,product_name,customer,quantity,amount,cost,sales,brand')
    queryParams.push('order=sale_date.desc')
    queryParams.push(`limit=${limit}`)
    if (offset > 0) {
      queryParams.push(`offset=${offset}`)
    }
    
    const queryString = queryParams.length > 0 ? `?${queryParams.join('&')}` : ''
    
    const response = await request({
      url: `/rest/v1/longqiao_records${queryString}`,
      method: 'GET',
      header: {
        'Prefer': 'count=exact'
      }
    })
    
    // 从响应头中获取总数
    let totalCount = 0
    const contentRange = response.header['Content-Range']
    if (contentRange) {
      const match = contentRange.match(/\/(\d+)$/)
      if (match) {
        totalCount = parseInt(match[1])
      }
    }
    
    return {
      data: response.data,
      totalCount: totalCount,
      header: response.header
    }
  },


}

module.exports = {
  request,
  supabaseQuery,
  login,
  getUserInfo,
  logout,
  autoRefreshToken,
  isTokenValid,
  clearAuthData,
  coldStartRefresh,
  getConfig
}