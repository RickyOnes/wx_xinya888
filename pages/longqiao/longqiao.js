// pages/longqiao/longqiao.js
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
    salespersons: ['全部人员'],
    customers: ['全部客户'],
    products: ['全部商品'],
    brands: ['全部品牌'],
    selectedSalespersonIndex: 0,
    selectedCustomerIndex: 0,
    selectedProductIndex: 0,
    selectedBrandIndex: 0,
    
    // 统计数据
    totalQuantity: 0,
    freeQuantity: 0,            // 免费发放商品数量（销售金额为0的商品）
    totalAmount: '0.00',
    totalGrossProfit: '0.00',   // 总毛利
    totalCost: '0.00',          // 总费用（销售金额为0的商品的总成本）
    
    // 品牌汇总数据（增加总毛利、总费用列）
    brandSummary: [],
    
    // 商品映射数据
    productInfoMap: [],
    
    // 数据管理
    cachedData: [],          // 原始服务器数据
    filteredData: [],        // 筛选后的数据
    detailList: [],          // 详细记录显示的数据
    
    // 状态
    isLoading: false,
    showDetail: false,
    detailCount: 0,
    isInitialized: false,
    userInfoLoaded: false     // 新增：标记用户信息是否已加载
  },

  onLoad() {
    this.initPage()
  },

  onShow() {
    // 设置自定义tabBar选中状态
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setSelected(1)
    }
    
    // 只检查token有效性，如果无效则跳转
    // 不重新加载用户信息，避免不必要的setData
    if (!this.checkTokenValidity()) {
      this.redirectToLogin()
    }
  },

  // 页面初始化
  async initPage() {
    const isLoggedIn = await this.checkLoginStatus()
    
    if (isLoggedIn) {
      // 初始化日期（无论是否已初始化）
      this.initDate()
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

  // 初始化数据
  async initData() {
    this.setData({ isLoading: true })
    
    try {
      // 初始化日期
      this.initDate()
      
      const app = getApp()
      const { startDate, endDate } = this.data
      
      // 检查全局缓存是否存在且日期范围匹配
      if (app.globalData.longqiaoInitialized && 
          app.globalData.longqiaoCachedData &&
          app.globalData.longqiaoCachedData.startDate === startDate &&
          app.globalData.longqiaoCachedData.endDate === endDate) {
        
        // 使用缓存数据
        const cachedData = app.globalData.longqiaoCachedData.data
        this.setData({
          cachedData: cachedData,
          filteredData: cachedData
        })
        
        // 提取筛选选项
        this.extractFilterOptions()
        
        // 处理数据
        this.filterAndProcessData()
        
        this.setData({ isInitialized: true })
      } else {
        // 获取服务器数据
        await this.fetchServerData({
          startDate: startDate,
          endDate: endDate
        })
        
        // 提取筛选选项
        this.extractFilterOptions()
        
        // 处理数据
        this.filterAndProcessData()
        
        this.setData({ isInitialized: true })
      }
    } catch (error) {
      console.error('初始化数据失败:', error)
      wx.showToast({
        title: error.message || '数据加载失败',
        icon: 'none'
      })
    } finally {
      this.setData({ isLoading: false })
    }
  },

  // 获取服务器数据（隆桥仓库专用）
  async fetchServerData(dateRange = {}) {
    try {
      const { startDate, endDate } = dateRange

      // 1. 先获取第一批数据（最多50000条）
      const limit = 50000
      const firstBatch = await supabaseQuery.getLongqiaoData({
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

          const batchResult = await supabaseQuery.getLongqiaoData({
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
        cachedData: allData,
        filteredData: allData
      })
      
      // 存储到全局缓存
      const app = getApp()
      app.globalData.longqiaoCachedData = {
        data: allData,
        startDate: startDate,
        endDate: endDate
      }
      app.globalData.longqiaoInitialized = true
      
      wx.hideLoading()
      
      return allData
    } catch (error) {
      console.error('获取服务器数据失败:', error)
      wx.hideLoading()
      throw error
    }
  },

  // 提取筛选选项（可指定数据源和排除字段）
  extractFilterOptions(dataSource = null, excludeFields = []) {
    const data = dataSource || this.data.cachedData
    if (!Array.isArray(data) || data.length === 0) {
      this.resetDisplayData()
      return
    }

    const salespersonSet = new Set()
    const customerSet = new Set()
    const brandSet = new Set()
    const productInfoMap = new Map()

    data.forEach(item => {
      // 销售人员
      if (item.sales) {
        salespersonSet.add(item.sales.toString().trim())
      }
      
      // 客户名称
      if (item.customer) {
        customerSet.add(item.customer.toString().trim())
      }
      
      // 品牌
      if (item.brand) {
        brandSet.add(item.brand.toString().trim())
      }
      
      // 商品信息 - 按product_id去重
      if (item.product_id && item.product_name) {
        const productId = item.product_id.toString().trim()
        if (!productInfoMap.has(productId)) {
          productInfoMap.set(productId, {
            productId: productId,
            displayName: item.product_name.toString().trim(),
            brand: item.brand ? item.brand.toString().trim() : ''
          })
        }
      }
    })

    // 生成筛选列表
    const salespersons = ['全部人员', ...Array.from(salespersonSet).sort()]
    const customers = ['全部客户', ...Array.from(customerSet).sort()]
    const brands = ['全部品牌', ...Array.from(brandSet).sort()]
    
    // 商品列表（按显示名称排序）
    const products = ['全部商品']
    // 将Map转换为数组并按显示名称排序
    const productInfoList = Array.from(productInfoMap.values())
    productInfoList.sort((a, b) => a.displayName.localeCompare(b.displayName))
    productInfoList.forEach(item => {
      products.push(item.displayName)
    })

    // 获取当前选择的值（名称）
    const currentSalesperson = this.data.salespersons[this.data.selectedSalespersonIndex]
    const currentCustomer = this.data.customers[this.data.selectedCustomerIndex]
    const currentBrand = this.data.brands[this.data.selectedBrandIndex]
    const currentProduct = this.data.products[this.data.selectedProductIndex]
    
    // 检查当前选择的索引是否有效
    const updateData = {
      productInfoMap: productInfoList,
      originalProducts: products  // 保存完整商品列表
    }
    
    // 只更新不在排除列表中的字段
    if (!excludeFields.includes('salespersons')) {
      updateData.salespersons = salespersons
      // 重新计算销售人员选择索引
      let newSalespersonIndex = 0
      if (currentSalesperson && currentSalesperson !== '全部人员') {
        newSalespersonIndex = salespersons.indexOf(currentSalesperson)
        if (newSalespersonIndex === -1) newSalespersonIndex = 0
      }
      updateData.selectedSalespersonIndex = newSalespersonIndex
    }
    
    if (!excludeFields.includes('customers')) {
      updateData.customers = customers
      // 重新计算客户选择索引
      let newCustomerIndex = 0
      if (currentCustomer && currentCustomer !== '全部客户') {
        newCustomerIndex = customers.indexOf(currentCustomer)
        if (newCustomerIndex === -1) newCustomerIndex = 0
      }
      updateData.selectedCustomerIndex = newCustomerIndex
    }
    
    if (!excludeFields.includes('brands')) {
      updateData.brands = brands
      // 重新计算品牌选择索引
      let newBrandIndex = 0
      
      // 检查品牌数量：如果只有一个具体品牌（即除了"全部品牌"外只有一个品牌），则自动选中该品牌
      if (brands.length === 2) {
        // 数组长度为2，说明除了"全部品牌"外只有一个具体品牌
        newBrandIndex = 1 // 选中具体品牌
      } else if (currentBrand && currentBrand !== '全部品牌') {
        // 有多个品牌，保持用户当前选择（如果有效）
        newBrandIndex = brands.indexOf(currentBrand)
        if (newBrandIndex === -1) newBrandIndex = 0
      }
      
      updateData.selectedBrandIndex = newBrandIndex
    }
    
    if (!excludeFields.includes('products')) {
      updateData.products = products
      // 重新计算商品选择索引
      let newProductIndex = 0
      if (currentProduct && currentProduct !== '全部商品') {
        newProductIndex = products.indexOf(currentProduct)
        if (newProductIndex === -1) newProductIndex = 0
      }
      updateData.selectedProductIndex = newProductIndex
    }

    this.setData(updateData)

  },
  
  // 根据当前筛选结果更新筛选选项（实现联动）
  updateFilterOptionsFromCurrentFilter(excludeField = null) {
    const {
      cachedData,
      selectedSalespersonIndex,
      selectedCustomerIndex,
      selectedBrandIndex,
      selectedProductIndex,
      salespersons,
      customers,
      brands,
      products,
      productInfoMap = []
    } = this.data
    
    if (!Array.isArray(cachedData) || cachedData.length === 0) {
      return
    }
    
    // 为每个字段计算数据源：应用除了该字段本身之外的所有有效筛选条件
    const updateData = {}
    
    // 销售人员字段：应用除销售人员外的所有有效筛选条件
    if (excludeField !== 'salespersons') {
      const salespersonDataSource = cachedData.filter(item => {
        // 客户筛选（如果有效）
        if (selectedCustomerIndex > 0) {
          const selectedCustomer = customers[selectedCustomerIndex]
          if (item.customer !== selectedCustomer) return false
        }
        
        // 品牌筛选（如果有效）
        if (selectedBrandIndex > 0) {
          const selectedBrand = brands[selectedBrandIndex]
          if (item.brand !== selectedBrand) return false
        }
        
        // 商品筛选（如果有效）
        if (selectedProductIndex > 0) {
          const selectedProduct = products[selectedProductIndex]
          const productInfo = productInfoMap.find(p => p.displayName === selectedProduct)
          if (!productInfo || item.product_name !== productInfo.displayName) return false
        }
        
        return true
      })
      
      // 从数据源中提取唯一的销售人员
      const salespersonSet = new Set()
      salespersonDataSource.forEach(item => {
        if (item.sales) {
          salespersonSet.add(item.sales.toString().trim())
        }
      })
      
      const newSalespersons = ['全部人员', ...Array.from(salespersonSet).sort()]
      
      // 计算新的选择索引
      const currentSalesperson = salespersons[selectedSalespersonIndex]
      let newSalespersonIndex = 0
      if (currentSalesperson && currentSalesperson !== '全部人员') {
        newSalespersonIndex = newSalespersons.indexOf(currentSalesperson)
        if (newSalespersonIndex === -1) newSalespersonIndex = 0
      }
      
      updateData.salespersons = newSalespersons
      updateData.selectedSalespersonIndex = newSalespersonIndex
    }
    
    // 客户字段：应用除客户外的所有有效筛选条件
    if (excludeField !== 'customers') {
      const customerDataSource = cachedData.filter(item => {
        // 销售人员筛选（如果有效）
        if (selectedSalespersonIndex > 0) {
          const selectedSalesperson = salespersons[selectedSalespersonIndex]
          if (item.sales !== selectedSalesperson) return false
        }
        
        // 品牌筛选（如果有效）
        if (selectedBrandIndex > 0) {
          const selectedBrand = brands[selectedBrandIndex]
          if (item.brand !== selectedBrand) return false
        }
        
        // 商品筛选（如果有效）
        if (selectedProductIndex > 0) {
          const selectedProduct = products[selectedProductIndex]
          const productInfo = productInfoMap.find(p => p.displayName === selectedProduct)
          if (!productInfo || item.product_name !== productInfo.displayName) return false
        }
        
        return true
      })
      
      // 从数据源中提取唯一的客户
      const customerSet = new Set()
      customerDataSource.forEach(item => {
        if (item.customer) {
          customerSet.add(item.customer.toString().trim())
        }
      })
      
      const newCustomers = ['全部客户', ...Array.from(customerSet).sort()]
      
      // 计算新的选择索引
      const currentCustomer = customers[selectedCustomerIndex]
      let newCustomerIndex = 0
      if (currentCustomer && currentCustomer !== '全部客户') {
        newCustomerIndex = newCustomers.indexOf(currentCustomer)
        if (newCustomerIndex === -1) newCustomerIndex = 0
      }
      
      updateData.customers = newCustomers
      updateData.selectedCustomerIndex = newCustomerIndex
    }
    
    // 品牌字段：应用除品牌外的所有有效筛选条件
    if (excludeField !== 'brands') {
      const brandDataSource = cachedData.filter(item => {
        // 销售人员筛选（如果有效）
        if (selectedSalespersonIndex > 0) {
          const selectedSalesperson = salespersons[selectedSalespersonIndex]
          if (item.sales !== selectedSalesperson) return false
        }
        
        // 客户筛选（如果有效）
        if (selectedCustomerIndex > 0) {
          const selectedCustomer = customers[selectedCustomerIndex]
          if (item.customer !== selectedCustomer) return false
        }
        
        // 商品筛选（如果有效）
        if (selectedProductIndex > 0) {
          const selectedProduct = products[selectedProductIndex]
          const productInfo = productInfoMap.find(p => p.displayName === selectedProduct)
          if (!productInfo || item.product_name !== productInfo.displayName) return false
        }
        
        return true
      })
      
      // 从数据源中提取唯一的品牌
      const brandSet = new Set()
      brandDataSource.forEach(item => {
        if (item.brand) {
          brandSet.add(item.brand.toString().trim())
        }
      })
      
      const newBrands = ['全部品牌', ...Array.from(brandSet).sort()]
      
      // 计算新的选择索引
      const currentBrand = brands[selectedBrandIndex]
      let newBrandIndex = 0
      if (currentBrand && currentBrand !== '全部品牌') {
        newBrandIndex = newBrands.indexOf(currentBrand)
        if (newBrandIndex === -1) newBrandIndex = 0
      }
      
      updateData.brands = newBrands
      updateData.selectedBrandIndex = newBrandIndex
    }
    
    // 商品字段：应用除商品外的所有有效筛选条件
    if (excludeField !== 'products') {
      const productDataSource = cachedData.filter(item => {
        // 销售人员筛选（如果有效）
        if (selectedSalespersonIndex > 0) {
          const selectedSalesperson = salespersons[selectedSalespersonIndex]
          if (item.sales !== selectedSalesperson) return false
        }
        
        // 客户筛选（如果有效）
        if (selectedCustomerIndex > 0) {
          const selectedCustomer = customers[selectedCustomerIndex]
          if (item.customer !== selectedCustomer) return false
        }
        
        // 品牌筛选（如果有效）
        if (selectedBrandIndex > 0) {
          const selectedBrand = brands[selectedBrandIndex]
          if (item.brand !== selectedBrand) return false
        }
        
        return true
      })
      
      // 从数据源中提取唯一的商品信息
      const productMap = new Map()
      productDataSource.forEach(item => {
        if (item.product_id && item.product_name) {
          const productId = item.product_id.toString().trim()
          if (!productMap.has(productId)) {
            productMap.set(productId, {
              productId: productId,
              displayName: item.product_name.toString().trim(),
              brand: item.brand ? item.brand.toString().trim() : ''
            })
          }
        }
      })
      
      const productInfoList = Array.from(productMap.values())
      productInfoList.sort((a, b) => a.displayName.localeCompare(b.displayName))
      
      const newProducts = ['全部商品', ...productInfoList.map(item => item.displayName)]
      
      // 计算新的选择索引
      const currentProduct = products[selectedProductIndex]
      let newProductIndex = 0
      if (currentProduct && currentProduct !== '全部商品') {
        newProductIndex = newProducts.indexOf(currentProduct)
        if (newProductIndex === -1) newProductIndex = 0
      }
      
      updateData.products = newProducts
      updateData.selectedProductIndex = newProductIndex
      updateData.productInfoMap = productInfoList
    }
    
    // 批量更新数据
    if (Object.keys(updateData).length > 0) {
      this.setData(updateData)

    }
  },

  // 筛选并处理数据（隆桥仓库专用计算逻辑）
  filterAndProcessData() {
    const {
      cachedData,
      selectedSalespersonIndex,
      selectedCustomerIndex,
      selectedProductIndex,
      selectedBrandIndex,
      salespersons,
      customers,
      products,
      brands,
      productInfoMap = []
    } = this.data

    if (!Array.isArray(cachedData) || cachedData.length === 0) {
      this.resetDisplayData()
      return
    }

    // 1. 筛选数据
    let filtered = cachedData.filter(item => {
      // 销售人员筛选
      if (selectedSalespersonIndex > 0) {
        const selectedSalesperson = salespersons[selectedSalespersonIndex]
        if (item.sales !== selectedSalesperson) return false
      }
      
      // 客户筛选
      if (selectedCustomerIndex > 0) {
        const selectedCustomer = customers[selectedCustomerIndex]
        if (item.customer !== selectedCustomer) return false
      }
      
      // 品牌筛选
      if (selectedBrandIndex > 0) {
        const selectedBrand = brands[selectedBrandIndex]
        if (item.brand !== selectedBrand) return false
      }
      
      // 商品筛选
      if (selectedProductIndex > 0) {
        const selectedProduct = products[selectedProductIndex]
        // 需要从productInfoMap找到对应的商品信息
        const productInfo = productInfoMap.find(p => p.displayName === selectedProduct)
        if (!productInfo || item.product_name !== productInfo.displayName) return false
      }
      
      return true
    })

    this.setData({ filteredData: filtered })

    // 2. 计算统计数据
    let totalQuantity = 0
    let freeQuantity = 0           // 免费发放商品数量（销售金额为0的商品）
    let totalAmount = 0
    let totalGrossProfit = 0
    let totalCost = 0

    // 根据是否选中具体销售人员或具体品牌，决定汇总维度
    const selectedBrand = selectedBrandIndex > 0 ? brands[selectedBrandIndex] : null
    const isSpecificBrandSelected = selectedBrand && selectedBrand !== '全部品牌'
    
    const selectedSalesperson = selectedSalespersonIndex > 0 ? salespersons[selectedSalespersonIndex] : null
    const isSpecificSalespersonSelected = selectedSalesperson && selectedSalesperson !== '全部人员'
    
    const summaryMap = {}

    filtered.forEach(item => {
      const quantity = Number(item.quantity) || 0
      const amount = Number(item.amount) || 0      // amount字段是总金额
      const cost = Number(item.cost) || 0          // cost字段是总成本
      
      // 计算毛利（总金额 - 总成本），排除金额为0的商品（费用）
      const grossProfit = amount === 0 ? 0 : amount - cost
      
      totalQuantity += quantity
      totalAmount += amount
      totalGrossProfit += grossProfit
      
      // 计算总费用和免费发放商品数量：销售金额为0的商品
      if (amount === 0 && quantity > 0) {
        totalCost += cost
        freeQuantity += quantity
      }
      
      // 确定汇总键和显示名称
      let summaryKey, displayName
      if (isSpecificSalespersonSelected) {
        // 按商品汇总：使用 product_name 作为键
        summaryKey = item.product_name ? item.product_name.toString().trim() : null
        displayName = summaryKey || '未知商品'
      } else if (isSpecificBrandSelected) {
        // 按销售人员汇总：使用 sales 作为键
        summaryKey = item.sales ? item.sales.toString().trim() : null
        displayName = summaryKey || '未知销售人员'
      } else {
        // 按品牌汇总
        summaryKey = item.brand ? item.brand.toString().trim() : null
        displayName = summaryKey || '未知品牌'
      }
      
      if (summaryKey) {
        if (!summaryMap[summaryKey]) {
          summaryMap[summaryKey] = {
            key: summaryKey,
            name: displayName,
            quantity: 0,
            amount: 0,
            grossProfit: 0,
            cost: 0,
            freeQuantity: 0
          }
        }
        
        summaryMap[summaryKey].quantity += quantity
        summaryMap[summaryKey].amount += amount
        summaryMap[summaryKey].grossProfit += grossProfit
        
        // 汇总级别的总费用和免费发放商品数量计算
        if (amount === 0 && quantity > 0) {
          summaryMap[summaryKey].cost += cost
          summaryMap[summaryKey].freeQuantity += quantity
        }
      }
    })
    
    // 调整总件数：扣除免费发放的商品数量
    const adjustedTotalQuantity = totalQuantity - freeQuantity
    // 总毛利：总金额 - 总成本
    const adjustedTotalGrossProfit = totalGrossProfit

    // 3. 生成详细记录列表（按照要求的列顺序）
    const detailList = filtered.map(item => {
      const quantity = Number(item.quantity) || 0
      const amount = Number(item.amount) || 0      // 总金额
      const cost = Number(item.cost) || 0          // 总成本
      const grossProfit = amount === 0 ? 0 : amount - cost            // 销售毛利
      
      return {
        sale_date: item.sale_date,
        customer: item.customer || '',
        product_name: item.product_name || '',
        sales: item.sales || '',
        quantity: quantity,
        amount: amount.toFixed(2),
        cost: cost.toFixed(2),
        gross_profit: grossProfit.toFixed(2)
      }
    })

    // 4. 生成汇总（根据选择维度）
    const brandSummary = Object.values(summaryMap)
      .map(item => {
        // 调整汇总级别的数量：扣除免费发放商品数量
        const adjustedQuantity = item.quantity - item.freeQuantity
        // 汇总级别的毛利：总金额 - 总成本
        const adjustedGrossProfit = item.grossProfit
        
        return {
          brand: item.name, // 注意：这里仍然使用brand字段名，但实际内容可能是销售人员名称
          quantity: adjustedQuantity,
          amount: item.amount,
          grossProfit: adjustedGrossProfit,
          cost: item.cost,
          amountFormatted: formatNumber(item.amount.toFixed(2)),
          quantityFormatted: formatNumber(adjustedQuantity),
          grossProfitFormatted: formatNumber(adjustedGrossProfit.toFixed(2)),
          costFormatted: formatNumber(item.cost.toFixed(2)),
          percentage: totalAmount > 0 ? (item.amount / totalAmount * 100).toFixed(1) : 0
        }
      })
      .sort((a, b) => b.amount - a.amount)

    this.setData({
      totalQuantity: formatNumber(adjustedTotalQuantity),
      freeQuantity: formatNumber(freeQuantity),
      totalAmount: formatNumber(totalAmount.toFixed(2)),
      totalGrossProfit: formatNumber(adjustedTotalGrossProfit.toFixed(2)),
      totalCost: formatNumber(totalCost.toFixed(2)),
      brandSummary: brandSummary,
      detailList: detailList,
      detailCount: detailList.length
    })
  },

  // 重置显示数据
  resetDisplayData() {
    this.setData({
      totalQuantity: 0,
      freeQuantity: 0,
      totalAmount: '0.00',
      totalGrossProfit: '0.00',
      totalCost: '0.00',
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

  onSalespersonChange(e) {
    this.setData({
      selectedSalespersonIndex: e.detail.value
    }, () => {
      this.filterAndProcessData()
      // 更新其他筛选框的选项，排除销售人员字段
      this.updateFilterOptionsFromCurrentFilter('salespersons')
    })
  },

  onCustomerChange(e) {
    this.setData({
      selectedCustomerIndex: e.detail.value
    }, () => {
      this.filterAndProcessData()
      // 更新其他筛选框的选项，排除客户字段
      this.updateFilterOptionsFromCurrentFilter('customers')
    })
  },

  onProductChange(e) {
    const selectedIndex = e.detail.value
    const selectedProduct = this.data.products[selectedIndex]
    
    this.setData({
      selectedProductIndex: selectedIndex
    }, () => {
      this.filterAndProcessData()
      // 更新其他筛选框的选项，排除商品字段
      this.updateFilterOptionsFromCurrentFilter('products')
      
      // 如果选择了具体商品，确保品牌正确设置并更新商品列表
      if (selectedIndex > 0 && selectedProduct !== '全部商品') {
        const { productInfoMap = [], brands } = this.data
        const productInfo = productInfoMap.find(p => p.displayName === selectedProduct)
        
        if (productInfo && productInfo.brand) {
          const brandIndex = brands.indexOf(productInfo.brand)
          if (brandIndex !== -1) {
            // 设置品牌索引
            this.setData({
              selectedBrandIndex: brandIndex
            }, () => {
              // 根据品牌重新过滤商品列表
              const filteredProducts = productInfoMap.filter(item => item.brand === productInfo.brand)
              const filteredProductsList = ['全部商品', ...filteredProducts.sort((a,b) => a.displayName.localeCompare(b.displayName)).map(p => p.displayName)]
              const newProductIndex = filteredProductsList.indexOf(selectedProduct)
              
              this.setData({
                products: filteredProductsList,
                selectedProductIndex: newProductIndex !== -1 ? newProductIndex : 0
              }, () => {
                // 重新筛选数据（因为品牌和商品列表已更新）
                this.filterAndProcessData()
              })
            })
          }
        }
      }
    })
  },

  onBrandChange(e) {
    this.setData({
      selectedBrandIndex: e.detail.value
    }, () => {
      this.filterAndProcessData()
      // 更新其他筛选框的选项，排除品牌字段
      this.updateFilterOptionsFromCurrentFilter('brands')
    })
  },

  onClearFilter() {
    this.setData({
      selectedSalespersonIndex: 0,
      selectedCustomerIndex: 0,
      selectedProductIndex: 0,
      selectedBrandIndex: 0
    }, () => {
      this.filterAndProcessData()
      // 清除筛选后，恢复全部选项
      this.extractFilterOptions()
    })
  },

  // 查询数据（重新从服务器获取）
  async onQueryData() {
    if (!this.data.isLoggedIn) return
    
    this.setData({ isLoading: true })
    
    try {
      const dateRange = {
        startDate: this.data.startDate,
        endDate: this.data.endDate
      }
      
      // 保存当前选择的筛选值（名称而不是索引）
      const {
        salespersons, customers, products, brands,
        selectedSalespersonIndex, selectedCustomerIndex,
        selectedProductIndex, selectedBrandIndex
      } = this.data
      
      const currentSelections = {
        salesperson: salespersons[selectedSalespersonIndex],
        customer: customers[selectedCustomerIndex],
        product: products[selectedProductIndex],
        brand: brands[selectedBrandIndex]
      }
      
      // 重新从服务器获取数据
      await this.fetchServerData(dateRange)
      
      // 重新提取筛选选项（获取完整列表）
      this.extractFilterOptions()
      
      // 根据保存的选择名称，在新的完整列表中查找索引
      const { 
        salespersons: newSalespersons, 
        customers: newCustomers, 
        products: newProducts,  // 完整商品列表，与originalProducts相同
        brands: newBrands 
      } = this.data
      
      const newIndices = {
        selectedSalespersonIndex: currentSelections.salesperson && currentSelections.salesperson !== '全部人员' 
          ? newSalespersons.indexOf(currentSelections.salesperson) 
          : 0,
        selectedCustomerIndex: currentSelections.customer && currentSelections.customer !== '全部客户' 
          ? newCustomers.indexOf(currentSelections.customer) 
          : 0,
        selectedBrandIndex: currentSelections.brand && currentSelections.brand !== '全部品牌' 
          ? newBrands.indexOf(currentSelections.brand) 
          : 0,
        selectedProductIndex: currentSelections.product && currentSelections.product !== '全部商品' 
          ? newProducts.indexOf(currentSelections.product) 
          : 0
      }
      
      // 处理负索引（选择项不在新列表中）
      Object.keys(newIndices).forEach(key => {
        if (newIndices[key] === -1) newIndices[key] = 0
      })
      
      // 设置初始筛选索引，然后在回调中继续处理
      this.setData(newIndices, () => {
        
        // 根据当前筛选状态更新所有筛选框选项
        this.updateFilterOptionsFromCurrentFilter()
        
        // 处理数据
        this.filterAndProcessData()
      })
      
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
    // 清除全局缓存
    const app = getApp()
    app.globalData.longqiaoCachedData = null
    app.globalData.longqiaoInitialized = false
    app.globalData.userIconCache = null  // 清除用户图标缓存
    
    setTimeout(() => {
      wx.reLaunch({
        url: '/pages/login/login'
      })
    }, 200)
  },

  // 展开/收起详情
  async toggleDetail() {
    if (!this.data.showDetail) {
      this.setData({ isDetailLoading: true })
      
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
      // 准备CSV内容（隆桥仓库的列顺序）
      const headers = ['销售日期', '客户名称', '商品名称', '销售人员', '销售数量', '销售金额', '商品成本', '销售毛利']
      const csvRows = this.data.detailList.map(item => [
        item.sale_date || '',
        item.customer || '',
        item.product_name || '',
        item.sales || '',
        item.quantity || 0,
        item.amount || 0,
        item.cost || 0,
        item.gross_profit || 0
      ])
      
      // 生成CSV内容
      let csvContent = '\uFEFF'
      csvContent += headers.join(',') + '\n'
      csvRows.forEach(row => {
        csvContent += row.join(',') + '\n'
      })
      
      // 获取当前时间
      const now = new Date()
      const timestamp = `${now.getFullYear()}${(now.getMonth()+1).toString().padStart(2, '0')}${now.getDate().toString().padStart(2, '0')}_${now.getHours().toString().padStart(2, '0')}${now.getMinutes().toString().padStart(2, '0')}`
      
      // 文件路径
      const fileName = `longqiao_sales_${timestamp}.csv`
      const tempPath = `${wx.env.USER_DATA_PATH}/${fileName}`
      
      // 写入临时文件
      const fs = wx.getFileSystemManager()
      fs.writeFileSync(tempPath, csvContent, 'utf8')
      
      wx.hideLoading()
      
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
      
    } catch (error) {
      console.error('导出数据失败:', error)
      wx.hideLoading()
      wx.showToast({
        title: '导出失败',
        icon: 'none'
      })
    }
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
        `用户权限: ${userInfo.display_name === '' || userInfo.display_name === '可口可乐' ? '品牌用户' : '系统管理员'} `,
        `创建时间: ${userInfo.created_at ? formatTime(new Date(userInfo.created_at)) : '未知'}`,
        `最后登录: ${userInfo.last_sign_in_at ? formatTime(new Date(userInfo.last_sign_in_at)) : '未知'}`
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
  }
})