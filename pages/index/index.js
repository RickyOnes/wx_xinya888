// pages/index/index.js
const { supabaseQuery, isTokenValid } = require('../../utils/request.js')
const { formatNumber, formatDate, formatTime } = require('../../utils/util.js')
const { getCurrentUserIcon } = require('../../utils/iconMapper.js')

Page({
  data: {
    // 用户信息
    userEmail: '',
    userAvatar: '',
    isLoggedIn: false,
    
    // 日期相关
    startDate: '',
    endDate: '',
    startDateStr: '',
    endDateStr: '',
    
    // 筛选选项（从本地数据提取）
    products: ['全部商品'],
    originalProducts: ['全部商品'],
    brands: ['全部品牌'],
    selectedProductIndex: 0,
    selectedBrandIndex: 0,
    
    // 统计数据
    totalQuantity: 0,
    totalAmount: '0.00',
    totalBrands: 0,
    totalProducts: 0,
    quantityDisplayMode: 'pieces',
    
    // 品牌汇总数据
    brandSummary: [],
    
    // 商品映射数据
    productInfoMap: [],
    
    // 数据管理
    cachedData: [],          // 原始服务器数据
    filteredData: [],        // 筛选后的数据
    detailList: [],          // 显示的数据
    
    // 状态
    isLoading: false,
    showDetail: false,
    detailCount: 0,
    isInitialized: false,     // 新增：标记是否已经初始化
    userInfoLoaded: false     // 新增：标记用户信息是否已加载
  },

  onLoad() {
    // 只在onLoad中初始化，避免重复调用
    this.initPage()
  },

  onShow() {
    // 设置自定义tabBar选中状态
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setSelected(0)
    }
    
    // onShow只检查token有效性，如果无效则跳转
    // 不重新加载用户信息，避免不必要的setData
    if (!this.checkTokenValidity()) {
      this.redirectToLogin()
    }
  },

  // 页面初始化（只在onLoad中调用）
  async initPage() {
    // 1. 检查登录状态
    const isLoggedIn = await this.checkLoginStatus()
    
    if (isLoggedIn) {
      // 2. 初始化页面
      await this.initData()
    }
  },

  // 检查token有效性（不加载用户信息）
  checkTokenValidity() {
    const token = wx.getStorageSync('access_token')
    return token && isTokenValid()
  },

  // 加载用户信息到页面data（只在需要时调用）
  loadUserInfo() {
    if (this.data.isLoggedIn && this.data.userInfoLoaded) {
      return // 用户信息已加载，无需重复加载
    }
    
    const userInfo = wx.getStorageSync('user_info')
    if (!userInfo) {
      console.warn('用户信息不存在，可能需要重新登录')
      return
    }
    
    // 使用全局图标缓存，避免重复加载
    const app = getApp()
    let userIcon
    
    if (app.globalData.userIconCache) {
      userIcon = app.globalData.userIconCache
    } else {
      userIcon = getCurrentUserIcon()
      app.globalData.userIconCache = userIcon
    }
    
    this.setData({
      userEmail: userInfo.display_name,
      userAvatar: userIcon.icon,
      isLoggedIn: true,
      userInfoLoaded: true
    })
  },

  // 检查登录状态（兼容现有调用）
  async checkLoginStatus() {
    try {
      if (this.checkTokenValidity()) {
        this.loadUserInfo()
        return true
      } else {
        this.redirectToLogin()
        return false
      }
    } catch (error) {
      console.error('检查登录状态时出错:', error)
      this.redirectToLogin()
      return false
    }
  },

  // 初始化日期
  initDate() {
    const endDate = new Date()
    const startDate = new Date()
    
    // 如果是每月1号，显示上个月数据
    if (endDate.getDate() === 1) {
      startDate.setMonth(startDate.getMonth() - 1)
      startDate.setDate(1)
      
      const lastDay = new Date(endDate.getFullYear(), endDate.getMonth(), 0).getDate()
      endDate.setMonth(endDate.getMonth() - 1)
      endDate.setDate(lastDay)
    } else {
      // 否则显示本月1号到昨天的数据
      startDate.setDate(1)
      endDate.setDate(endDate.getDate() - 1)
    }
    
    const startDateStr = formatDate(startDate)
    const endDateStr = formatDate(endDate)
    
    this.setData({
      startDate: startDateStr,
      endDate: endDateStr,
      startDateStr: startDateStr,
      endDateStr: endDateStr
    })
    
    return { startDate: startDateStr, endDate: endDateStr }
  },

  // 初始化数据（只在页面初始化时调用一次）
  async initData() {
    if (!this.data.isLoggedIn || this.data.isInitialized) {
      return
    }
    
    this.setData({ isLoading: true })
    
    try {
      // 1. 初始化日期
      const dateRange = this.initDate()
      
      // 2. 从服务器获取原始数据
      await this.fetchServerData(dateRange)
      
      // 3. 从本地数据提取仓库和品牌列表
      this.extractFilterOptions()
      
      // 4. 处理并显示数据
      this.filterAndProcessData()
      
      // 5. 标记已初始化
      this.setData({ isInitialized: true })
      
    } catch (error) {
      console.error('初始化数据失败:', error)
      wx.showToast({
        title: '数据加载失败',
        icon: 'none'
      })
    } finally {
      this.setData({ isLoading: false })
    }
  },

  // 从服务器获取数据
  async fetchServerData(dateRange) {
    try {
      const { startDate, endDate } = dateRange
      
      // 1. 先获取第一批数据（最多50000条）
      const limit = 50000
      const firstBatch = await supabaseQuery.getRawSalesData({
        startDate: startDate,
        endDate: endDate,
        limit: limit,
        offset: 0
      })
      
      if (!Array.isArray(firstBatch.data)) {
        throw new Error('服务器返回数据格式错误')
      }
      
      // 2. 从响应头中获取总记录数
      const totalCount = firstBatch.totalCount
      
      // 3. 根据总数决定是否需要继续分批
      let allData = firstBatch.data
      
      if (totalCount > limit) {
        // 计算还需要多少个批次
        const batchCount = Math.ceil(totalCount / limit)
        
        // 从第二批次开始获取（因为第一批已经获取了）
        for (let i = 1; i < batchCount; i++) {
          const offset = i * limit

          const batchResult = await supabaseQuery.getRawSalesData({
            startDate: startDate,
            endDate: endDate,
            limit: limit,
            offset: offset
          })
          
          if (!Array.isArray(batchResult.data)) {
            throw new Error(`第${i + 1}批数据格式错误`)
          }
          
          allData = allData.concat(batchResult.data)
          
          // 每批完成后短暂延迟，避免请求过快
          if (i < batchCount - 1) {
            await new Promise(resolve => setTimeout(resolve, 100))
          }
        }
      }
      
      // 4. 验证数据完整性
      if (allData.length !== totalCount) {
        console.warn(`数据可能不完整: 实际获取${allData.length}条，但总数应为${totalCount}条`)
      }
      
      this.setData({
        cachedData: allData || []
      })
      
      wx.hideLoading()
      
      
    } catch (error) {
      console.error('获取服务器数据失败:', error)
      wx.hideLoading()
      throw error
    }
  },

  // 从缓存数据中提取筛选选项
  extractFilterOptions() {
    const { cachedData } = this.data
    
    if (!Array.isArray(cachedData) || cachedData.length === 0) {
      return
    }
    
    // 存储商品映射：internal_id -> {displayName, brand}
    const productMap = new Map()
    const brandSet = new Set(['全部品牌'])
    
    // 第一遍：收集所有品牌
    cachedData.forEach(item => {
      if (item.brand != null) {
        const brandStr = item.brand.toString().trim()
        if (brandStr) brandSet.add(brandStr)
      }
    })
    
    // 第二遍：按internal_id分组，找到pieces等于quantity的记录
    const internalIdGroups = {}
    
    cachedData.forEach(item => {
      const internalId = item.internal_id
      if (!internalId) return
      
      if (!internalIdGroups[internalId]) {
        internalIdGroups[internalId] = []
      }
      internalIdGroups[internalId].push(item)
    })
    
    // 处理每个internal_id分组
    Object.keys(internalIdGroups).forEach(internalId => {
      const items = internalIdGroups[internalId]
      let selectedItem = null
      
      // 1. 优先选择pieces等于quantity的记录
      for (const item of items) {
        const pieces = Number(item.pieces) || 0
        const quantity = Number(item.quantity) || 0
        if (pieces === quantity) {
          selectedItem = item
          break
        }
      }
      
      // 2. 如果没有pieces等于quantity的记录，选择第一个记录
      if (!selectedItem && items.length > 0) {
        selectedItem = items[0]
      }
      
      if (selectedItem) {
        // 处理商品名称：去掉"/"及后面的字符
        let productName = selectedItem.product_name ? selectedItem.product_name.toString().trim() : ''
        if (productName.includes('/')) {
          productName = productName.split('/')[0].trim()
        }
        
        const brand = selectedItem.brand ? selectedItem.brand.toString().trim() : ''
        
        productMap.set(internalId, {
          internalId: internalId,
          displayName: productName || `商品${internalId}`,
          brand: brand
        })
      }
    })
    
    // 生成商品列表（按displayName排序）
    const products = ['全部商品']
    const productInfoList = []
    
    productMap.forEach((value, key) => {
      productInfoList.push({
        internalId: value.internalId,
        displayName: value.displayName,
        brand: value.brand
      })
    })
    
    // 按显示名称排序
    productInfoList.sort((a, b) => a.displayName.localeCompare(b.displayName))
    productInfoList.forEach(item => {
      products.push(item.displayName)
    })
    
    // 存储商品映射信息，用于连锁筛选
    const brandsArray = Array.from(brandSet)
    
    // 检查品牌数量：如果只有一个具体品牌（即除了"全部品牌"外只有一个品牌），则自动选中该品牌
    let selectedBrandIndex = 0 // 默认选中"全部品牌"
    if (brandsArray.length === 2) {
      // 数组长度为2，说明除了"全部品牌"外只有一个具体品牌
      selectedBrandIndex = 1 // 选中具体品牌
    }
    
    this.setData({
      products: products,
      originalProducts: products, // 保存完整商品列表
      brands: brandsArray,
      productInfoMap: productInfoList,  // 存储商品信息列表
      selectedBrandIndex: selectedBrandIndex
    })
  },

  // 筛选并处理数据
  filterAndProcessData() {
    const {
      cachedData,
      selectedProductIndex,
      selectedBrandIndex,
      products,
      brands,
      productInfoMap = []
    } = this.data

    if (!Array.isArray(cachedData) || cachedData.length === 0) {
      this.resetDisplayData()
      return
    }

    // 1. 筛选数据（每次都从原始数据 cachedData 开始筛选）
    let filteredData = [...cachedData]

    // 获取选择的商品和品牌
    const selectedProduct = products[selectedProductIndex]
    const selectedBrand = brands[selectedBrandIndex]
    
    // 如果选择了具体的商品（不是"全部商品"），筛选商品（按internal_id）
    if (selectedProduct && selectedProduct !== '全部商品') {
      
      // 从productInfoMap中找到对应的internal_id
      let selectedInternalId = null
      for (const productInfo of productInfoMap) {
        if (productInfo.displayName === selectedProduct) {
          selectedInternalId = productInfo.internalId
          break
        }
      }
      
      if (selectedInternalId) {
        filteredData = filteredData.filter(item => {
          const itemInternalId = item.internal_id ? item.internal_id.toString().trim() : ''
          return itemInternalId === selectedInternalId
        })
      } 
    } 
    // 如果选择了具体的品牌（不是"全部品牌"），筛选品牌
    if (selectedBrand && selectedBrand !== '全部品牌') {
      filteredData = filteredData.filter(item => {
        const itemBrand = item.brand ? item.brand.toString().trim() : ''
        return itemBrand === selectedBrand
      })
    } 

    // 2. 保存筛选后的数据
    this.setData({
      filteredData: filteredData,
      detailCount: filteredData.length
    })
    
    // 3. 计算统计数据
    this.calculateStatistics(filteredData)
  },

  // 计算统计数据
  calculateStatistics(data) {
    
    if (!Array.isArray(data) || data.length === 0) {
      this.resetDisplayData()
      return
    }
    
    const {
      selectedBrandIndex,
      brands,
      productInfoMap = [],
      quantityDisplayMode: displayMode
    } = this.data
    
    let totalQuantity = 0
    let cardTotal = 0
    let totalAmount = 0
    const uniqueBrands = new Set()
    const uniqueProducts = new Set()
    
    // 根据是否选中具体品牌，决定汇总维度
    const selectedBrand = selectedBrandIndex > 0 ? brands[selectedBrandIndex] : null
    const isSpecificBrandSelected = selectedBrand && selectedBrand !== '全部品牌'
    
    // 汇总映射：如果选中具体品牌，按商品汇总；否则按品牌汇总
    const summaryMap = {}
    
    // 处理每条数据
    const detailList = data.map(record => {
      const quantity = Number(record.quantity) || 0
      const pieces = Number(record.pieces) || 0
      const unitPrice = Number(record.unit_price) || 0
      const amount = quantity * unitPrice
      
      totalQuantity += quantity
      totalAmount += amount
      
      // 根据显示模式累加卡片总值
      if (displayMode === 'pieces') {
        cardTotal += pieces
      } else {
        cardTotal += quantity
      }
      
      if (record.brand) {
        uniqueBrands.add(record.brand)
      }
      
      if (record.internal_id) {
        uniqueProducts.add(record.internal_id.toString())
      }
      
      // 确定汇总键和显示名称
      let summaryKey, displayName
      if (isSpecificBrandSelected) {
        // 按商品汇总：使用 internal_id 作为键
        summaryKey = record.internal_id ? record.internal_id.toString().trim() : null
        if (summaryKey) {
          // 从 productInfoMap 中查找商品显示名称
          const productInfo = productInfoMap.find(p => p.internalId === summaryKey)
          displayName = productInfo ? productInfo.displayName : (record.product_name || '未知商品')
        }
      } else {
        // 按品牌汇总
        summaryKey = record.brand ? record.brand.toString().trim() : null
        displayName = summaryKey || '未知品牌'
      }
      
      if (summaryKey) {
        if (!summaryMap[summaryKey]) {
          summaryMap[summaryKey] = {
            key: summaryKey,
            name: displayName,
            quantity: 0,
            amount: 0
          }
        }
        
        // 根据显示模式累加汇总值
        if (displayMode === 'pieces') {
          summaryMap[summaryKey].quantity += pieces
        } else {
          summaryMap[summaryKey].quantity += quantity
        }
        summaryMap[summaryKey].amount += amount
      }
      
      return {
        ...record,
        amount: amount.toFixed(2)
      }
    })
    
    // 生成汇总列表
    const brandSummary = Object.values(summaryMap)
      .map(item => ({
        brand: item.name, // 注意：这里仍然使用brand字段名，但实际内容可能是商品名称
        quantity: item.quantity,
        amount: item.amount,
        amountFormatted: formatNumber(item.amount.toFixed(2)),
        quantityFormatted: formatNumber(item.quantity, displayMode === 'pieces' ? 2 : 0),
        percentage: totalAmount > 0 ? (item.amount / totalAmount * 100).toFixed(1) : 0
      }))
      .sort((a, b) => b.amount - a.amount)
    
    this.setData({
      totalQuantity: formatNumber(cardTotal, displayMode === 'pieces' ? 2 : 0),
      totalAmount: formatNumber(totalAmount.toFixed(2)),
      totalBrands: uniqueBrands.size,
      totalProducts: uniqueProducts.size,
      brandSummary: brandSummary,
      detailList: detailList
    })
  },

  // 重置显示数据
  resetDisplayData() {
    this.setData({
      totalQuantity: formatNumber(0, this.data.quantityDisplayMode === 'pieces' ? 2 : 0),
      totalAmount: '0.00',
      totalBrands: 0,
      totalProducts: 0,
      brandSummary: [],
      detailList: [],
      filteredData: [],
      detailCount: 0
    })
  },

  // 事件处理函数
  onStartDateChange(e) {
    const startDate = e.detail.value
    this.setData({
      startDate,
      startDateStr: startDate
    })
  },

  onEndDateChange(e) {
    const endDate = e.detail.value
    this.setData({
      endDate,
      endDateStr: endDate
    })
  },

  onProductChange(e) {
    const selectedIndex = e.detail.value
    const { products, brands, productInfoMap = [], selectedBrandIndex } = this.data
    
    // 获取选中的商品名称
    const selectedProduct = products[selectedIndex]
    
    let brandIndex = selectedBrandIndex // 默认保持当前品牌选择
    
    // 连锁筛选：如果选择了具体商品，自动设置对应的品牌
    if (selectedProduct && selectedProduct !== '全部商品') {
      // 找到选中商品的信息
      for (const productInfo of productInfoMap) {
        if (productInfo.displayName === selectedProduct) {
          const brand = productInfo.brand
          if (brand) {
            // 在品牌列表中查找该品牌的索引
            const foundIndex = brands.findIndex(b => b === brand)
            if (foundIndex !== -1) {
              brandIndex = foundIndex
            } else {
              // 如果品牌不在列表中，保持当前选择
              brandIndex = selectedBrandIndex
            }
          }
          break
        }
      }
    }
    
    this.setData({
      selectedProductIndex: selectedIndex,
      selectedBrandIndex: brandIndex
    }, () => {
      this.filterAndProcessData()
    })
  },

  onBrandChange(e) {
    const selectedBrandIndex = e.detail.value
    const { brands, productInfoMap = [], selectedProductIndex, products } = this.data
    
    const selectedBrand = brands[selectedBrandIndex]
    
    // 根据品牌过滤商品列表
    let newProducts = ['全部商品']
    if (selectedBrand && selectedBrand !== '全部品牌') {
      // 从productInfoMap中筛选出该品牌的商品
      const filteredProducts = productInfoMap.filter(item => item.brand === selectedBrand)
      // 按显示名称排序
      filteredProducts.sort((a, b) => a.displayName.localeCompare(b.displayName))
      filteredProducts.forEach(item => {
        newProducts.push(item.displayName)
      })
    } else {
      // 恢复完整商品列表
      newProducts = this.data.originalProducts || ['全部商品']
    }
    
    // 检查当前选择的商品是否在新的商品列表中
    const currentProduct = products[selectedProductIndex]
    let newSelectedProductIndex = 0 // 默认选择"全部商品"
    if (currentProduct && newProducts.includes(currentProduct)) {
      newSelectedProductIndex = newProducts.indexOf(currentProduct)
    }
    
    this.setData({
      selectedBrandIndex: selectedBrandIndex,
      products: newProducts,
      selectedProductIndex: newSelectedProductIndex
    }, () => {
      this.filterAndProcessData()
    })
  },

  onClearFilter() {
    this.setData({
      selectedProductIndex: 0,
      selectedBrandIndex: 0,
      products: this.data.originalProducts || ['全部商品']
    }, () => {
      this.filterAndProcessData()
    })
  },



  // 查询数据（重新从服务器获取）
  async onQueryData() {
    if (!this.data.isLoggedIn) return
    this.setData({ 
      isLoading: true ,
      showDetail: false
    })
    
    try {
      const dateRange = {
        startDate: this.data.startDate,
        endDate: this.data.endDate
      }
      
      // 保存当前选择的品牌和商品名称（用于重新查询后恢复）
      const { brands, products, selectedBrandIndex, selectedProductIndex } = this.data
      const currentBrand = brands[selectedBrandIndex]
      const currentProduct = products[selectedProductIndex]
      
      // 重新从服务器获取数据
      await this.fetchServerData(dateRange)
      
      // 重新提取筛选选项（这会重置products为原始完整列表）
      this.extractFilterOptions()
      
      // 重新应用品牌过滤（如果之前选择了具体品牌）
      if (currentBrand && currentBrand !== '全部品牌') {
        const { brands: newBrands, productInfoMap = [] } = this.data
        
        // 找到品牌在新品牌列表中的索引
        const newBrandIndex = newBrands.indexOf(currentBrand)
        if (newBrandIndex !== -1) {
          // 根据品牌过滤商品列表
          let newProducts = ['全部商品']
          const filteredProducts = productInfoMap.filter(item => item.brand === currentBrand)
          filteredProducts.sort((a, b) => a.displayName.localeCompare(b.displayName))
          filteredProducts.forEach(item => {
            newProducts.push(item.displayName)
          })
          
          // 在新过滤的商品列表中查找当前商品
          let newProductIndex = 0 // 默认选择"全部商品"
          if (currentProduct && newProducts.includes(currentProduct)) {
            newProductIndex = newProducts.indexOf(currentProduct)
          }
          
          this.setData({
            selectedBrandIndex: newBrandIndex,
            products: newProducts,
            selectedProductIndex: newProductIndex
          })
        }
      } else {
        // 如果之前选择的是"全部品牌"，确保商品列表是完整列表
        // 并在完整商品列表中查找当前商品
        const { originalProducts } = this.data
        let newProductIndex = 0
        if (currentProduct && originalProducts.includes(currentProduct)) {
          newProductIndex = originalProducts.indexOf(currentProduct)
        }
        
        this.setData({
          products: originalProducts,
          selectedProductIndex: newProductIndex
        })
      }
      
      // 处理数据
      this.filterAndProcessData()
      
    } catch (error) {
      console.error('查询数据失败:', error)
      wx.showToast({
        title: error.message || '数据加载失败',
        icon: 'none'
      })
    } finally {
      this.setData({ isLoading: false })
    }
  },

  // 退出登录
  async onLogout() {
    this.setData({ isLoading: true })
    try {
      await getApp().globalLogout()
      // 退出成功后，页面数据会随页面卸载自动清除，无需手动重置
    } catch (error) {
      console.error('退出失败:', error)
    } finally {
      this.setData({ isLoading: false })
    }
  },

  // 跳转到登录页面
  redirectToLogin() {
    // 清除全局图标缓存
    const app = getApp()
    app.globalData.userIconCache = null
    
    setTimeout(() => {
      wx.reLaunch({
        url: '/pages/login/login'
      })
    }, 200)
  },

  // 展开/收起详情
  async toggleDetail() {
    if (!this.data.showDetail) {
      // 展开时显示加载动画
      this.setData({ isDetailLoading: true })
      
      // 模拟加载过程
      setTimeout(() => {
        this.setData({
          showDetail: true,
          isDetailLoading: false
        })
      }, 500)
    } else {
      this.setData({
        showDetail: false
      })
    }
  },

  // 导出数据功能
  async exportData() {
    if (this.data.detailList.length === 0) {
      wx.showToast({
        title: '没有数据可导出',
        icon: 'none',
        duration: 2000
      })
      return
    }
    
    wx.showLoading({
      title: '准备数据中...',
      mask: true
    })
    
    try {
      // 准备CSV内容
      const headers = ['日期', '商品ID', '商品名称', '仓库', '销量', '单价', '金额']
      const csvRows = this.data.detailList.map(item => [
        item.sale_date || '',
        item.product_id || '',
        item.product_name || '',
        item.warehouse || '',
        item.quantity || 0,
        item.unit_price || 0,
        item.amount || 0
      ])
      
      // 生成CSV内容
      let csvContent = '\uFEFF' // UTF-8 BOM
      csvContent += headers.join(',') + '\n'
      csvRows.forEach(row => {
        csvContent += row.join(',') + '\n'
      })
      
      // 获取当前时间
      const now = new Date()
      const timestamp = `${now.getFullYear()}${(now.getMonth()+1).toString().padStart(2, '0')}${now.getDate().toString().padStart(2, '0')}_${now.getHours().toString().padStart(2, '0')}${now.getMinutes().toString().padStart(2, '0')}`
      
      // 文件路径
      const fileName = `sales_data_${timestamp}.csv`
      const tempPath = `${wx.env.USER_DATA_PATH}/${fileName}`
      
      // 写入临时文件
      const fs = wx.getFileSystemManager()
      fs.writeFileSync(tempPath, csvContent, 'utf8')
      
      wx.hideLoading()
      
      // 保存文件到手机
      this.saveFileToPhone(tempPath, fileName)
      
    } catch (error) {
      wx.hideLoading()
      console.error('导出数据失败:', error)
      wx.showToast({
        title: '导出失败: ' + error.message,
        icon: 'none',
        duration: 3000
      })
    }
  },

  // 保存文件到手机 - 使用微信分享文件接口
  saveFileToPhone(tempPath, fileName) {
    // 使用微信分享文件功能，用户可以选择保存到设备
    wx.shareFileMessage({
      filePath: tempPath,
      fileName: fileName,
      success: (res) => {
        // 提示用户文件已准备就绪
        wx.showModal({
          title: '导出成功',
          content: `文件已准备就绪: ${fileName}\n\n您已成功分享文件，可以选择保存到手机。`,
          showCancel: false,
          confirmText: '知道了'
        })
      },
      fail: (err) => {
        console.error('分享文件失败:', err)
        // 备选方案：使用openDocument打开文件
        wx.openDocument({
          filePath: tempPath,
          fileType: 'csv', // 微信小程序支持csv文件类型
          success: (res) => {
            wx.showModal({
              title: '导出成功',
              content: `文件已准备就绪: ${fileName}\n\n系统已打开文件查看器，您可以选择保存到手机。`,
              showCancel: false,
              confirmText: '知道了'
            })
          },
          fail: (openErr) => {
            console.error('打开文档也失败:', openErr)
            // 最后方案：提示用户文件保存位置
            wx.showModal({
              title: '导出完成',
              content: `文件已保存至小程序临时目录:\n${tempPath}\n\n如需长期保存，请使用系统文件管理器查找或联系开发人员。`,
              showCancel: false,
              confirmText: '知道了'
            })
          }
        })
      }
    })
  },

  // 手动刷新数据
  onRefresh() {
    this.onQueryData()
  },

  // 用户信息下拉菜单
  onUserMenu() {
    wx.showActionSheet({
      itemList: ['用户信息', '退出登录'],
      success: (res) => {
        if (res.tapIndex === 0) {
          this.showUserInfo()
        } else if (res.tapIndex === 1) {
          this.onLogout()
        }
      }
    })
  },

  // 显示用户信息
  showUserInfo() {
    const userInfo = wx.getStorageSync('user_info')
    if (userInfo) {
      const lines = [
        `登录邮箱: ${userInfo.email || '未知'}`,
        `用户权限: ${userInfo.display_name===''|| userInfo.display_name==='可口可乐' ? '品牌用户':'系统管理员'} `,
        `创建时间: ${userInfo.created_at ? formatTime(new Date(userInfo.created_at)) : '未知'}`,
        `最后登录: ${userInfo.last_sign_in_at ? formatTime(new Date(userInfo.last_sign_in_at)): '未知'}`
      ]
      
      const content = lines.join('\n')
      
      wx.showModal({
        title: '用户信息',
        content: content,
        showCancel: false
      })
    } else {
      wx.showToast({
        title: '未获取到用户信息',
        icon: 'none'
      })
    }
  },

  // 切换总件数/总份数显示模式
  toggleQuantityDisplay() {
    const currentMode = this.data.quantityDisplayMode
    const newMode = currentMode === 'pieces' ? 'quantity' : 'pieces'
    this.setData({
      quantityDisplayMode: newMode
    }, () => {
      // 重新计算统计数据以更新显示
      if (this.data.filteredData && this.data.filteredData.length > 0) {
        this.calculateStatistics(this.data.filteredData)
      }
    })
  }
})