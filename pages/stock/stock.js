// pages/stock/stock.js
const guanjiapo = require('../../utils/guanjiapo.js');
const util = require('../../utils/util.js');

Page({
  data: {
    // 认证状态
    authStatus: {
      text: '未登录',
      class: 'warning'
    },
    // 是否显示登录表单
    showLogin: false,
    // 登录加载状态
    isLoggingIn: false,
    // 查询加载状态
    isQuerying: false,
    // 品牌加载状态
    isBrandLoading: false,
    // 登录表单数据
    loginForm: {
      companyName: '欣雅商贸',
      username: '管理员',
      password: '123456'
    },
    // 查询结果文本
    queryResult: '',
    // 库存数据列表（原始数据）
    stockData: [],
    // 筛选后的数据
    filteredStockData: [],
    // 筛选条件
    filterBrand: '',
    filterProduct: '',
    // 用户信息
    userName: '',
    loginTime: '',
    // 汇总数据
    summaryCards: {
      productTypes: 0,
      totalStock: '0'
    },
    // 品牌筛选数据
    brandList: [],                      // 原始品牌数据
    brandOptions: [{ value: '', text: '全部品牌' }], // 格式化后的选择器选项（默认包含全部品牌）
    selectedBrandId: '',                // 当前选中的品牌ID（空字符串代表"全部品牌"）
    selectedBrandName: '全部品牌',      // 当前选中的品牌名称
    selectedBrandIndex: 0,              // 当前选中的品牌索引（默认0：全部品牌）
    // 商品名称筛选数据
    productList: [],                    // 原始商品数据（按品牌分组）
    productOptions: [{ value: '', text: '全部商品' }], // 格式化后的选择器选项（默认包含全部商品）
    selectedProductId: '',              // 当前选中的商品ID（空字符串代表"全部商品"）
    selectedProductName: '全部商品',    // 当前选中的商品名称
    selectedProductIndex: 0,             // 当前选中的商品索引（默认0：全部商品）
    // 显示模式：'brand'表示品牌汇总模式，'product'表示商品明细模式
    displayMode: 'brand'                 // 初始为品牌汇总模式
  },



  onLoad() {
    // 更新认证状态
    this.updateAuthStatus();
    
    // 检查登录状态，如果已登录则直接查询数据，否则尝试自动登录
    if (guanjiapo.hasValidToken()) {
      // 已登录，设置默认用户信息（如果未设置）
      if (!this.data.userName) {
        this.setData({
          userName: '管理员',
          loginTime: new Date().toLocaleString()
        });
      }
      // 并发加载品牌数据和库存数据
      this.concurrentLoadData();
    } else {
      // 未登录，尝试自动登录
      this.autoLogin();
    }
  },

  onShow() {
    // 更新认证状态
    this.updateAuthStatus();
    // 设置tabbar选中状态
    this.setTabBarSelected();
  },



  // 更新认证状态显示
  updateAuthStatus() {
    const hasToken = guanjiapo.hasValidToken();
    
    this.setData({
      authStatus: {
        text: hasToken ? '已登录' : '未登录',
        class: hasToken ? 'success' : 'warning'
      }
    });
  },

  // 清除管家婆认证信息
  clearGuanjiapoAuth() {
    wx.showModal({
      title: '确认退出',
      content: '确定要退出管家婆.云辉煌系统吗？',
      success: (res) => {
        if (res.confirm) {
          guanjiapo.clearAuth();
          
          this.updateAuthStatus();
          this.setData({ showLogin: true });
          this.setData({
            queryResult: '认证信息已清除',
            stockData: [],
            filteredStockData: [],
            userName: '',
            loginTime: '',
            summaryCards: {
              productTypes: '0',
              totalStock: '0'
            }
          });
          
          wx.showToast({
            title: '已退出系统',
            icon: 'success'
          });
        }
      }
    });
  },

  // 自动登录（使用预设凭证）
  async autoLogin(loadData = true) {
    const companyName = '欣雅商贸';
    const username = '管理员';
    const password = '123456';
    
    this.setData({
      isLoggingIn: true,
      queryResult: '正在尝试自动登录...'
    });
    
    try {
      const result = await guanjiapo.guanjiapoLogin(companyName, username, password, true, '');
      
      if (result.success) {
        this.setData({
          queryResult: `自动登录成功! ${result.message} ${result.token ? '令牌已保存' : ''}`,
          authStatus: {
            text: '已认证',
            class: 'success'
          },
          showLogin: false,
          userName: '管理员',
          loginTime: new Date().toLocaleString()
        });
        
        // 更新认证状态
        this.updateAuthStatus();
        
        // 登录成功后并发加载品牌数据和库存数据（根据参数控制）
        if (loadData) {
          this.concurrentLoadData();
        }
        
        wx.showToast({
          title: '登录成功',
          icon: 'success'
        });
        return true; // 登录成功
      } else {
        this.setData({
          queryResult: `自动登录失败: ${result.message || '未知错误'}`,
          authStatus: {
            text: '登录失败',
            class: 'error'
          },
          showLogin: true,
          userName: '',
          loginTime: ''
        });
        
        wx.showToast({
          title: '登录失败',
          icon: 'none'
        });
        return false; // 登录失败
      }
    } catch (error) {
      console.error('自动登录异常:', error);
      
      this.setData({
        queryResult: `自动登录异常: ${error.message || '未知错误'}`,
        authStatus: {
          text: '登录异常',
          class: 'error'
        },
        showLogin: true,
        userName: '',
        loginTime: ''
      });
      
      wx.showToast({
        title: '登录异常',
        icon: 'none'
      });
      return false; // 登录失败
    } finally {
      this.setData({
        isLoggingIn: false
      });
    }
  },

  // 并发加载品牌数据和库存数据
  async concurrentLoadData() {
    try {
      // 辅助函数：检查错误是否为登录过期
      const isLoginExpiredError = (error) => {
        const errorMsg = error.message || error.msg || '';
        return errorMsg.includes('登录已过期') || 
               errorMsg.includes('用户凭证已失效') ||
               errorMsg.includes('请重新登录') ||
               errorMsg.includes('未授权') ||
               errorMsg.includes('401');
      };
      
      // 共享的登录promise，防止并发自动登录
      let loginPromise = null;
      
      // 辅助函数：带自动登录重试的API调用
      const fetchWithLoginRetry = async (apiCall, apiName) => {
        try {
          return await apiCall();
        } catch (error) {
          console.error(`${apiName}请求失败:`, error);
          
          // 检查是否为登录过期错误
          if (isLoginExpiredError(error)) {
            // 如果已经有登录请求在进行中，等待它
            if (!loginPromise) {
              loginPromise = this.autoLogin(false);
            }
            
            // 等待登录结果
            const loginSuccess = await loginPromise;
            
            // 重置登录promise，以便下次需要时重新登录
            loginPromise = null;
            
            if (loginSuccess) {
              // 重试原始API调用
              return await apiCall();
            } else {
              console.error(`自动登录失败，${apiName}请求无法继续`);
              throw new Error(`自动登录失败，无法获取${apiName}数据`);
            }
          }
          
          // 其他错误直接抛出
          throw error;
        }
      };
      
      // 使用Promise.all并发执行两个API调用，带自动登录重试
      const [brandResult, stockResult] = await Promise.all([
        fetchWithLoginRetry(() => guanjiapo.queryBrandList(), '品牌数据').catch(error => {
          console.error('品牌数据加载失败（含重试）:', error);
          // 返回一个空结果，避免整个Promise.all失败
          return { success: false, data: [], message: error.message };
        }),
        fetchWithLoginRetry(() => guanjiapo.queryStockList(), '库存数据').catch(error => {
          console.error('库存数据加载失败（含重试）:', error);
          // 返回一个空结果，避免整个Promise.all失败
          return { success: false, data: [], message: error.message };
        })
      ]);
      
      // 处理品牌数据
      if (brandResult.success) {
        this.processBrandData(brandResult.data);
      } else {
        console.warn('品牌数据加载失败，使用空品牌列表:', brandResult.message);
        this.setData({
          brandList: [],
          brandOptions: [{ value: '', text: '全部品牌' }]
        });
      }
      
      // 处理库存数据
      if (stockResult.success) {
        // 存储提取后的数据
        const stockData = stockResult.data || [];
        this.setData({
          stockData: stockData,
          queryResult: `数据加载成功! 库存: ${stockResult.total} 条记录`
        });
        
        // 从库存数据中提取商品信息（用于商品名称筛选框）
        this.extractProductInfoFromStockData(stockData);
        
        // 应用筛选（初始无筛选条件）并计算汇总数据
        this.filterStockData();
      } else {
        this.setData({
          queryResult: `库存数据加载失败: ${stockResult.message || '未知错误'}`,
          stockData: [],
          filteredStockData: [],
          summaryCards: {
            productTypes: 0,
            totalStock: '0'
          }
        });
      }
      
      // 显示成功提示
      if (brandResult.success && stockResult.success) {
        wx.showToast({
          title: '数据加载成功',
          icon: 'success'
        });
      }
    } catch (error) {
      console.error('并发数据加载异常:', error);
      this.setData({
        queryResult: `数据加载异常: ${error.message || '未知错误'}`
      });
      
      wx.showToast({
        title: '数据加载异常',
        icon: 'none'
      });
    }
  },

  // 处理品牌数据，构建选择器选项
  processBrandData(brandData) {
    if (!brandData || brandData.length === 0) {
      this.setData({
        brandList: [],
        brandOptions: [{ value: '', text: '全部品牌' }]
      });
      return;
    }
    
    // 按品牌ID（索引号）排序
    const sortedBrandData = [...brandData].sort((a, b) => {
      return (a.brandId || '').localeCompare(b.brandId || '');
    });
    
    // 构建选择器选项：第一个选项是"全部品牌"
    const brandOptions = [
      { value: '', text: '全部品牌' }
    ];
    
    // 添加品牌选项，显示品牌全名（不显示品牌ID）
    sortedBrandData.forEach(brand => {
      if (brand.brandName) {
        brandOptions.push({
          value: brand.brandId,
          text: brand.brandName
        });
      }
    });
    
    // 更新页面数据
    this.setData({
      brandList: sortedBrandData,
      brandOptions: brandOptions
    });
  },

  // 从库存数据中提取商品信息（按品牌分组）
  extractProductInfoFromStockData(stockData) {
    if (!stockData || stockData.length === 0) {
      this.setData({
        productList: [],
        productOptions: [{ value: '', text: '全部商品' }]
      });
      return;
    }
    
    // 使用Map按品牌ID分组商品
    const productMapByBrand = new Map();
    
    // 创建品牌ID到品牌名称的映射（从brandList获取）
    const brandMap = new Map();
    this.data.brandList.forEach(brand => {
      if (brand.brandId && brand.brandName) {
        brandMap.set(brand.brandId, brand.brandName);
      }
    });
    
    // 遍历所有库存数据，提取商品信息
    stockData.forEach((item, index) => {
      if (!item.ptypeId) {
        return;
      }
      
      // 提取品牌ID（ptypeid前5位）和商品ID（ptypeid后位）
      const brandId = item.ptypeId.substring(0, 5); // 品牌ID
      const productId = item.ptypeId.substring(5); // 商品ID
      
      // 如果品牌ID不存在于Map中，创建一个新的品牌分组
      if (!productMapByBrand.has(brandId)) {
        productMapByBrand.set(brandId, {
          brandId: brandId,
          brandName: brandMap.has(brandId) ? brandMap.get(brandId) : (item.ptypeid_pfullname || `品牌 ${brandId}`),
          products: new Map() // 使用Map存储该品牌的商品，key为商品ID
        });
      }
      
      const brandGroup = productMapByBrand.get(brandId);
      
      // 如果商品ID不存在于该品牌的商品Map中，添加它
      if (!brandGroup.products.has(productId)) {
        brandGroup.products.set(productId, {
          productId: productId,
          productName: item.productName || `商品 ${productId}`,
          ptypeId: item.ptypeId,
        });
      } else {
        // 商品已存在，增加计数
        const product = brandGroup.products.get(productId);
        product.count++;
        // 确保ptypeId存在（可能第一次添加时未设置）
        if (!product.ptypeId && item.ptypeId) {
          product.ptypeId = item.ptypeId;
        }
        brandGroup.products.set(productId, product);
      }
    });
    
    // 将Map转换为数组
    const productList = [];
    productMapByBrand.forEach((brandGroup) => {
      // 将该品牌的商品Map转换为数组
      const productsArray = Array.from(brandGroup.products.values());
      // 按商品ID排序
      productsArray.sort((a, b) => a.productId.localeCompare(b.productId));
      
      productList.push({
        brandId: brandGroup.brandId,
        brandName: brandGroup.brandName,
        products: productsArray
      });
    });
    
    // 按品牌ID排序
    productList.sort((a, b) => a.brandId.localeCompare(b.brandId));
    
    // 更新页面数据 - 先设置productList
    this.setData({
      productList: productList
    });
    
    // 更新商品下拉框选项（根据当前选中的品牌，初始为"全部品牌"）
    this.updateProductOptionsByBrand(this.data.selectedBrandId);
  },

  // 根据当前选中的品牌更新商品选项
  updateProductOptionsByBrand(selectedBrandId) {
    const { productList } = this.data;
    
    // 构建默认商品选项（全部商品）
    const productOptions = [
      { value: '', text: '全部商品' }
    ];
    
    if (productList.length > 0) {
      if (selectedBrandId) {
        // 如果选择了具体品牌，只显示该品牌的商品
        const selectedBrand = productList.find(brand => brand.brandId === selectedBrandId);
        
        if (selectedBrand && selectedBrand.products.length > 0) {
          // 添加该品牌下的所有商品选项
          selectedBrand.products.forEach(product => {
            productOptions.push({
              value: product.ptypeId,
              text: `${product.productName}`
            });
          });
        }
      } else {
        // 如果未选择品牌（选择"全部品牌"），显示所有商品
        productList.forEach(brand => {
          if (brand.products && brand.products.length > 0) {
            brand.products.forEach(product => {
              productOptions.push({
                value: product.ptypeId,
                text: `${product.productName} (${brand.brandName})`
              });
            });
          }
        });
      }
    }
    
    this.setData({
      productOptions: productOptions,
      selectedProductId: '',
      selectedProductName: '全部商品',
      selectedProductIndex: 0
    });
  },

  // 品牌选择器改变事件
  onBrandPickerChange(e) {
    const selectedIndex = e.detail.value;
    const { brandOptions } = this.data;
    
    if (selectedIndex >= 0 && selectedIndex < brandOptions.length) {
      const selectedOption = brandOptions[selectedIndex];
      
      this.setData({
        selectedBrandId: selectedOption.value,
        selectedBrandName: selectedOption.text,
        selectedBrandIndex: selectedIndex
      });
      
      // 更新商品选项（根据选中的品牌）
      this.updateProductOptionsByBrand(selectedOption.value);
      
      // 延迟筛选，避免频繁触发
      clearTimeout(this.filterTimer);
      this.filterTimer = setTimeout(() => {
        this.filterStockData();
      }, 300);
    }
  },

  // 商品选择器改变事件
  onProductPickerChange(e) {
    const selectedIndex = e.detail.value;
    const { productOptions } = this.data;
    
    if (selectedIndex >= 0 && selectedIndex < productOptions.length) {
      const selectedOption = productOptions[selectedIndex];
      
      this.setData({
        selectedProductId: selectedOption.value,
        selectedProductName: selectedOption.text,
        selectedProductIndex: selectedIndex
      });
      
      // 延迟筛选，避免频繁触发
      clearTimeout(this.filterTimer);
      this.filterTimer = setTimeout(() => {
        this.filterStockData();
      }, 300);
    }
  },

  // 管家婆登录
  async testGuanjiapoLogin() {
    const { companyName, username, password } = this.data.loginForm;
    
    this.setData({
      isLoggingIn: true,
      queryResult: '正在尝试登录...'
    });
    
    try {
      const result = await guanjiapo.guanjiapoLogin(companyName, username, password, true, '');
      
      if (result.success) {
        this.setData({
          queryResult: `登录成功! ${result.message} ${result.token ? '令牌已保存' : ''}`,
          authStatus: {
            text: '登录成功',
            class: 'success'
          },
          showLogin: false,
          userName: username,
          loginTime: new Date().toLocaleString()
        });
        
        // 更新认证状态
        this.updateAuthStatus();
        
        // 登录成功后并发加载品牌数据和库存数据
        this.concurrentLoadData();
        
        wx.showToast({
          title: '登录成功',
          icon: 'success'
        });
      } else {
        this.setData({
          queryResult: `登录失败: ${result.message || '未知错误'}`,
          authStatus: {
            text: '登录失败',
            class: 'error'
          }
        });
        
        wx.showToast({
          title: '登录失败',
          icon: 'none'
        });
      }
    } catch (error) {
      console.error('登录测试异常:', error);
      
      this.setData({
        queryResult: `登录异常: ${error.message || '未知错误'}`,
        authStatus: {
          text: '登录异常',
          class: 'error'
        },
        userName: '',
        loginTime: ''
      });
      
      wx.showToast({
        title: '登录异常',
        icon: 'none'
      });
    } finally {
      this.setData({
        isLoggingIn: false
      });
    }
  },

  // 查询库存数据
  async queryStockData() {
    // 查询前检查登录状态，如果token无效则尝试自动登录
    if (!guanjiapo.hasValidToken()) {
      wx.showToast({
        title: '检测到登录过期，正在自动重新登录...',
        icon: 'none'
      });
      this.setData({
        queryResult: '检测到登录过期，正在尝试自动重新登录...',
        showLogin: false
      });
      
      // 尝试自动登录，不自动加载数据（登录成功后由当前函数继续执行查询）
      const loginSuccess = await this.autoLogin(false);
      
      if (!loginSuccess) {
        // 自动登录失败，显示登录表单
        this.setData({
          queryResult: '自动登录失败，请手动登录',
          showLogin: true
        });
        return;
      }
      
      // 自动登录成功，继续执行查询
    }
    
    this.setData({
      isQuerying: true,
      queryResult: '正在查询库存数据...'
    });
    
    try {
      const result = await guanjiapo.queryStockList();
      
      if (result.success) {
        // 存储原始数据
        const stockData = result.data || [];
        this.setData({
          stockData: stockData,
          queryResult: `库存查询成功! 共 ${result.total} 条记录`
        });
        
        // 从库存数据中提取商品信息（用于商品名称筛选框）
        this.extractProductInfoFromStockData(stockData);
        
        // 应用筛选（初始无筛选条件）并计算汇总数据
        this.filterStockData();
        
        wx.showToast({
          title: '查询成功',
          icon: 'success'
        });
      } else {
        this.setData({
          queryResult: `库存查询失败: ${result.message || '未知错误'}`,
          stockData: [],
          filteredStockData: [],
          summaryCards: {
            productTypes: 0,
            totalStock: '0'
          }
        });
        
        wx.showToast({
          title: '查询失败',
          icon: 'none'
        });
      }
    } catch (error) {
      console.error('库存查询异常:', error);
      
      // 检查是否为登录过期错误
      const errorMsg = error.message || '';
      if (errorMsg.includes('登录已过期') || errorMsg.includes('凭证已失效') || errorMsg.includes('401') || errorMsg.includes('未授权')) {
        // 登录凭证已失效，自动重新登录
        const loginSuccess = await this.autoLogin(false);
        if (loginSuccess) {
          // 自动登录成功，重新执行查询
          this.queryStockData();
        } else {
          // 自动登录失败，显示登录表单
          this.setData({
            queryResult: '自动登录失败，请手动登录',
            showLogin: true
          });
        }
        return; // 停止后续错误处理
      }
      
      this.setData({
        queryResult: `库存查询异常: ${error.message || '未知错误'}`,
        stockData: [],
        filteredStockData: [],
        summaryCards: {
          productTypes: 0,
          totalStock: '0'
        }
      });
      
      wx.showToast({
        title: '查询异常',
        icon: 'none'
      });
    } finally {
      this.setData({
        isQuerying: false
      });
    }
  },



  // 筛选库存数据
  filterStockData() {
    const { stockData, selectedBrandId, selectedProductId, filterProduct, productList } = this.data;
    
    // 检查是否有筛选条件
    const hasFilter = selectedBrandId || selectedProductId || filterProduct.trim();
    
    let filtered = stockData;
    let displayData = []; // 最终显示的数据
    
    if (hasFilter) {
      // 有筛选条件，执行原有筛选逻辑
      
      // 按品牌ID精确筛选
      if (selectedBrandId) {
        filtered = filtered.filter(item => {
          // 使用ptypeId字段的前5位进行精确匹配（品牌ID）
          return item.ptypeId && item.ptypeId.substring(0, 5) === selectedBrandId;
        });
      }
      
      // 按商品完整ID（ptypeId）精确筛选
      if (selectedProductId) {
        filtered = filtered.filter(item => {
          // 使用完整的ptypeId进行精确匹配
          return item.ptypeId && item.ptypeId === selectedProductId;
        });
      }
      
      // 按商品名称筛选（文本搜索，备用）
      if (filterProduct.trim()) {
        filtered = filtered.filter(item => {
          return item.productName && item.productName.toLowerCase().includes(filterProduct.toLowerCase());
        });
      }
      
      displayData = filtered;
    } else {
      // 没有筛选条件，按品牌分组汇总
      const brandSummaryMap = new Map();
      
      // 遍历所有库存数据，按品牌分组汇总
      stockData.forEach(item => {
        if (!item.ptypeId) return;
        
        const brandId = item.ptypeId.substring(0, 5);
        const productId = item.ptypeId.substring(5);
        const quantity = parseFloat(item.unitQuantity) || 0;
        
        if (!brandSummaryMap.has(brandId)) {
          // 初始化品牌汇总
          const brandInfo = productList.find(brand => brand.brandId === brandId);
          brandSummaryMap.set(brandId, {
            brandId: brandId,
            brandName: brandInfo ? brandInfo.brandName : `品牌 ${brandId}`,
            productCount: 0, // 商品种类数（不同商品数量）
            totalStock: 0,
            productSet: new Set() // 用于统计不同商品
          });
        }
        
        const brandSummary = brandSummaryMap.get(brandId);
        brandSummary.totalStock += quantity;
        
        // 统计不同商品
        if (!brandSummary.productSet.has(productId)) {
          brandSummary.productSet.add(productId);
          brandSummary.productCount++;
        }
      });
      
      // 转换为数组，并按品牌ID排序，添加兼容字段
      const brandSummaries = Array.from(brandSummaryMap.values())
        .map(summary => {
          // 移除临时字段productSet
          const { productSet, ...rest } = summary;
          // 添加兼容字段，用于表格显示
          return {
            ...rest,
            userCode: rest.brandId, // 商品编号显示为品牌ID
            productName: `${rest.brandName} (${rest.productCount}种商品)`, // 品牌名称 + 商品种类数
            unitQuantity: util.formatNumber(rest.totalStock, 0) // 总库存
          };
        })
        .sort((a, b) => a.brandId.localeCompare(b.brandId));
      
      displayData = brandSummaries;
    }
    
    // 设置显示模式：'brand'表示品牌汇总模式，'product'表示商品明细模式
    const displayMode = hasFilter ? 'product' : 'brand';
    
    this.setData({
      filteredStockData: displayData,
      displayMode: displayMode
    });
    
    // 重新计算汇总（基于显示的数据）
    // 商品种类：如果是品牌汇总模式，显示品牌数量；否则显示商品数量
    const productTypes = displayData.length;
    
    // 总库存：计算总库存量
    let totalStock = 0;
    if (hasFilter) {
      // 筛选模式：计算筛选后数据的unitQuantity总和
      displayData.forEach(item => {
        const qty = parseFloat(item.unitQuantity) || 0;
        totalStock += qty;
      });
    } else {
      // 品牌汇总模式：计算所有品牌总库存之和
      displayData.forEach(brand => {
        totalStock += brand.totalStock;
      });
    }
    
    this.setData({
      'summaryCards.productTypes': productTypes,
      'summaryCards.totalStock': util.formatNumber(totalStock, 0)
    });
  },



  // 商品名称筛选输入
  onProductFilterInput(e) {
    const value = e.detail.value;
    this.setData({
      filterProduct: value
    });
    clearTimeout(this.filterTimer);
    this.filterTimer = setTimeout(() => {
      this.filterStockData();
    }, 300);
  },



  // 设置tabbar选中状态
  setTabBarSelected() {
    const maxRetries = 5;
    const retryInterval = 100; // 毫秒
    
    const trySetSelected = (retryCount = 0) => {
      if (typeof this.getTabBar === 'function' && this.getTabBar()) {
        // "库存查询"页面是第三个tab，索引为2
        this.getTabBar().setSelected(2);
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

  // 登录表单输入处理
  onLoginInput(e) {
    const { field } = e.currentTarget.dataset;
    const { value } = e.detail;
    
    this.setData({
      [`loginForm.${field}`]: value
    });
  },

  // 清除筛选条件
  clearFilter() {
    this.setData({
      selectedBrandId: '',
      selectedBrandName: '全部品牌',
      selectedBrandIndex: 0,
      selectedProductId: '',
      selectedProductName: '全部商品',
      selectedProductIndex: 0,
      filterProduct: '',
      displayMode: 'brand'  // 重置为品牌汇总模式
    });
    // 更新商品下拉框为所有商品
    this.updateProductOptionsByBrand('');
    // 筛选数据（显示全部）
    this.filterStockData();
  },

  // 用户信息下拉菜单
  onUserMenu() {
    wx.showActionSheet({
      itemList: ['用户信息', '退出登录'],
      success: (res) => {
        if (res.tapIndex === 0) {
          this.showUserInfo();
        } else if (res.tapIndex === 1) {
          this.clearGuanjiapoAuth();
        }
      }
    });
  },

  // 显示用户信息
  showUserInfo() {
    const userName = this.data.userName || '未知用户';
    const loginTime = this.data.loginTime || '未知时间';
    
    const content = `登录用户名: ${userName}\n登录时间: ${loginTime}`;
    
    wx.showModal({
      title: '管家婆用户信息',
      content: content,
      showCancel: false
    });
  },

  // 将列表数据生成图片并分享
  async shareAsImage() {
    const { filteredStockData, displayMode } = this.data;
    
    if (!filteredStockData || filteredStockData.length === 0) {
      wx.showToast({
        title: '没有数据可分享',
        icon: 'none'
      });
      return;
    }
    
    // 显示加载提示
    wx.showLoading({
      title: '生成图片中...',
      mask: true
    });
    
    try {
      // 获取系统信息，用于rpx转换（兼容新旧API，优先使用新API）
      let screenWidth, dpr;
      
      // 首先尝试使用新API
      try {
        // 检查新API是否可用
        if (wx.getDeviceInfo && wx.getWindowInfo) {
          const deviceInfo = wx.getDeviceInfo();
          const windowInfo = wx.getWindowInfo();
          
          // 验证返回的对象和属性（根据实际API返回值调整）
          // deviceInfo包含设备信息，windowInfo包含屏幕和窗口信息
          // pixelRatio在windowInfo中，screenWidth在windowInfo中
          if (deviceInfo && windowInfo && 
              typeof windowInfo.pixelRatio === 'number' && 
              typeof windowInfo.screenWidth === 'number') {
            // 使用screenWidth作为屏幕宽度（逻辑像素）
            screenWidth = windowInfo.screenWidth;
            dpr = windowInfo.pixelRatio;
          } else {
            throw new Error('新API返回无效数据');
          }
        } else {
          throw new Error('新API不可用');
        }
      } catch (newApiError) {
        console.warn('新API调用失败，使用默认值:', newApiError);
        // 不再使用已废弃的旧API，直接使用默认值
        screenWidth = 375; // iPhone 6/7/8的屏幕宽度
        dpr = 2; // 默认像素比
      }
      
      // 验证数值有效性
      if (!screenWidth || screenWidth <= 0 || !dpr || dpr <= 0) {
        console.error('无效的系统信息，使用默认值');
        screenWidth = 375;
        dpr = 2;
      }
      
      // rpx转px的比例
      // 计算rpx转px的比例，确保有效值
      let rpxToPx = screenWidth / 750;
      
      // 如果rpxToPx无效（NaN、0或负数），使用默认比例（基于375屏幕宽度）
      if (!rpxToPx || rpxToPx <= 0 || isNaN(rpxToPx)) {
        console.warn('rpxToPx无效，使用默认值');
        rpxToPx = 375 / 750; // 0.5
      }
      
      // 计算canvas尺寸（单位：px） - 使用800rpx确保与页面CSS的min-width一致
      const canvasWidthRpx = 780; // 画布宽度780rpx，与stock.wxss中.table-body-content的min-width保持一致
      let canvasWidthPx = canvasWidthRpx * rpxToPx;
      let rowHeightPx = 50 * rpxToPx; // 行高50rpx，与页面表格一致
      let headerHeightPx = 60 * rpxToPx; // 表头高度60rpx
      let paddingPx = 15 * rpxToPx; // 增加内边距确保内容不贴边
      let titleHeightPx = 80 * rpxToPx; // 增加标题高度
      
      // 确保计算出的尺寸是有效正数
      if (!canvasWidthPx || canvasWidthPx <= 0 || isNaN(canvasWidthPx)) {
        console.warn('canvasWidthPx无效，使用默认值');
        canvasWidthPx = 375; // 默认宽度
      }
      if (!rowHeightPx || rowHeightPx <= 0 || isNaN(rowHeightPx)) rowHeightPx = 25;
      if (!headerHeightPx || headerHeightPx <= 0 || isNaN(headerHeightPx)) headerHeightPx = 30;
      if (!paddingPx || paddingPx <= 0 || isNaN(paddingPx)) paddingPx = 15;
      if (!titleHeightPx || titleHeightPx <= 0 || isNaN(titleHeightPx)) titleHeightPx = 40;
      
      const dataRows = filteredStockData.length;
      let canvasHeightPx = titleHeightPx + headerHeightPx + (dataRows * rowHeightPx) + paddingPx * 2 + rowHeightPx; // 为汇总行增加一行高度
      
      // 确保canvas高度有效
      if (!canvasHeightPx || canvasHeightPx <= 0 || isNaN(canvasHeightPx)) {
        console.warn('canvasHeightPx无效，使用默认值');
        canvasHeightPx = 800; // 默认高度
      }
      
      // 限制最大高度，避免超出canvas限制
      const maxCanvasHeightPx = 4000; // 最大高度4000px
      let actualCanvasHeightPx = canvasHeightPx;
      let renderRows = dataRows;
      if (canvasHeightPx > maxCanvasHeightPx) {
        actualCanvasHeightPx = maxCanvasHeightPx;
        // 计算可以显示的行数
        renderRows = Math.floor((actualCanvasHeightPx - titleHeightPx - headerHeightPx - paddingPx * 2 - rowHeightPx) / rowHeightPx); // 预留一行给汇总行
        wx.showToast({
          title: `数据过多，只显示前${renderRows}条`,
          icon: 'none',
          duration: 2000
        });
      }
      
      // 获取canvas节点
      const query = wx.createSelectorQuery();
      query.select('#shareCanvas').fields({ node: true, size: true }).exec(async (res) => {
        if (!res || !res[0]) {
          wx.hideLoading();
          wx.showToast({
            title: 'canvas初始化失败',
            icon: 'none'
          });
          return;
        }
        
        const canvas = res[0].node;
        const ctx = canvas.getContext('2d');
        
        // 设置canvas实际宽高（物理像素）
        canvas.width = canvasWidthPx * dpr;
        canvas.height = actualCanvasHeightPx * dpr;
        ctx.scale(dpr, dpr);
        
        // 验证canvas尺寸
        if (canvas.width <= 0 || canvas.height <= 0) {
          wx.hideLoading();
          wx.showToast({
            title: '画布尺寸无效，无法生成图片',
            icon: 'none'
          });
          return;
        }
        
        // 绘制背景（覆盖整个画布）
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvasWidthPx, actualCanvasHeightPx);
        
        // 绘制标题
        ctx.fillStyle = '#333333';
        // 验证字体大小，确保至少1px
        let titleFontSize = 34 * rpxToPx;
        if (!titleFontSize || titleFontSize <= 0 || isNaN(titleFontSize)) {
          console.warn('标题字体大小无效，使用默认值');
          titleFontSize = 17; // 默认字体大小
        }
        ctx.font = `bold ${titleFontSize}px sans-serif`;
        const titleText = displayMode === 'brand' ? '品牌汇总列表' : '商品汇总列表';
        ctx.fillText(titleText, paddingPx, paddingPx + 40 * rpxToPx);
        
        // 表格宽度（去除内边距）
        const tableWidthPx = canvasWidthPx - paddingPx * 2;
        
        // 列宽比例（与页面CSS保持一致，根据stock.wxss中brand-cell的flex比例）
        const flex1 = 0.7; // 第一列flex
        const flex2 = 2.7; // 第二列flex（品牌名称/商品名称）
        const flex3 = 1.1; // 第三列flex
        const flexSum = flex1 + flex2 + flex3;
        const col1WidthPx = (flex1 / flexSum) * tableWidthPx;
        const col2WidthPx = (flex2 / flexSum) * tableWidthPx;
        const col3WidthPx = (flex3 / flexSum) * tableWidthPx;
        
        const col1X = paddingPx;
        const col2X = col1X + col1WidthPx;
        const col3X = col2X + col2WidthPx;
        
        // 绘制表格表头 - 与页面样式完全一致
        const headerY = titleHeightPx;
        ctx.fillStyle = '#667eea'; // 表头背景色，与页面一致
        ctx.fillRect(col1X, headerY, tableWidthPx, headerHeightPx);
        
        // 表头圆角效果（页面有border-radius: 10rpx 10rpx 0 0）
        ctx.strokeStyle = '#667eea';
        ctx.lineWidth = 1 * rpxToPx;
        ctx.beginPath();
        ctx.moveTo(col1X + 10 * rpxToPx, headerY);
        ctx.lineTo(col1X + tableWidthPx - 10 * rpxToPx, headerY);
        ctx.quadraticCurveTo(col1X + tableWidthPx, headerY, col1X + tableWidthPx, headerY + 10 * rpxToPx);
        ctx.lineTo(col1X + tableWidthPx, headerY + headerHeightPx);
        ctx.lineTo(col1X, headerY + headerHeightPx);
        ctx.lineTo(col1X, headerY + 10 * rpxToPx);
        ctx.quadraticCurveTo(col1X, headerY, col1X + 10 * rpxToPx, headerY);
        ctx.closePath();
        ctx.fill();
        
        ctx.fillStyle = '#ffffff'; // 表头文字颜色白色
        // 验证表头字体大小
        let headerFontSize = 28 * rpxToPx;
        if (!headerFontSize || headerFontSize <= 0 || isNaN(headerFontSize)) {
          console.warn('表头字体大小无效，使用默认值');
          headerFontSize = 14; // 默认字体大小
        }
        ctx.font = `600 ${headerFontSize}px sans-serif`;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        
        // 表头文字
        const header1 = displayMode === 'brand' ? '品牌编号' : '商品编号';
        const header2 = displayMode === 'brand' ? '品牌名称' : '商品名称';
        const header3 = '总件数';
        
        ctx.fillText(header1, col1X + 12 * rpxToPx, headerY + headerHeightPx / 2);
        ctx.fillText(header2, col2X + 24 * rpxToPx, headerY + headerHeightPx / 2);
        ctx.fillText(header3, col3X + 24 * rpxToPx, headerY + headerHeightPx / 2);
        
        // 绘制表格内容
        ctx.fillStyle = '#333333';
        // 验证内容字体大小
        let contentFontSize = 26 * rpxToPx;
        if (!contentFontSize || contentFontSize <= 0 || isNaN(contentFontSize)) {
          console.warn('内容字体大小无效，使用默认值');
          contentFontSize = 13; // 默认字体大小
        }
        ctx.font = `${contentFontSize}px sans-serif`;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        
        for (let i = 0; i < renderRows; i++) {
          const item = filteredStockData[i];
          const rowY = headerY + headerHeightPx + i * rowHeightPx;
          
          // 交替行背景色 - 与页面样式完全一致
          if (i % 2 === 0) {
            ctx.fillStyle = '#ffffff';
          } else {
            ctx.fillStyle = '#f9f9f9'; // 与stock.wxss中.table-row:nth-child(even)的#f9f9f9一致
          }
          ctx.fillRect(col1X, rowY, tableWidthPx, rowHeightPx);
          
          // 绘制文本 - 与页面布局一致
          ctx.fillStyle = '#333333';
          ctx.fillText(item.userCode || '', col1X + 14 * rpxToPx, rowY + rowHeightPx / 2);
          
          // 商品名称 - 使用与页面相同的文本截断逻辑
          // 在canvas中我们需要手动测量和截断，确保不会出现省略号显示问题
          let productName = item.productName || '';
          const maxTextWidth = col2WidthPx - 36 * rpxToPx; // 减去左右内边距
          
          // 测量文本宽度前确保字体已设置（使用已验证的字体大小）
          ctx.font = `${contentFontSize}px sans-serif`;
          const textWidth = ctx.measureText(productName).width;
          
          if (textWidth > maxTextWidth) {
            // 逐字符减少直到宽度合适，并添加省略号
            let truncated = productName;
            while (truncated.length > 1 && ctx.measureText(truncated + '...').width > maxTextWidth) {
              truncated = truncated.substring(0, truncated.length - 1);
            }
            productName = truncated + '...';
          }
          
          ctx.fillText(productName, col2X + 24 * rpxToPx, rowY + rowHeightPx / 2);
          ctx.fillText(item.unitQuantity || '', col3X + 24 * rpxToPx, rowY + rowHeightPx / 2);
          
          // 绘制行分隔线 - 与页面样式一致
          ctx.strokeStyle = '#eeeeee'; // 与stock.wxss中border-bottom颜色一致
          ctx.lineWidth = 1 * rpxToPx;
          ctx.beginPath();
          ctx.moveTo(col1X, rowY + rowHeightPx);
          ctx.lineTo(col1X + tableWidthPx, rowY + rowHeightPx);
          ctx.stroke();
        }
        
        // 计算渲染行的总件数
        let totalQuantity = 0;
        for (let i = 0; i < renderRows; i++) {
          const item = filteredStockData[i];
          // 优先使用totalStock字段（数字），如果没有则解析unitQuantity（可能包含逗号）
          let quantity = 0;
          if (item.totalStock !== undefined) {
            quantity = item.totalStock;
          } else if (item.unitQuantity !== undefined) {
            // 移除千位分隔符（逗号）后再解析
            const cleaned = String(item.unitQuantity).replace(/,/g, '');
            quantity = parseFloat(cleaned) || 0;
          }
          totalQuantity += quantity;
        }
        
        // 绘制汇总行
        const summaryRowY = headerY + headerHeightPx + renderRows * rowHeightPx;
        
        // 汇总行背景色（浅灰色）
        ctx.fillStyle = '#f5f5f5';
        ctx.fillRect(col1X, summaryRowY, tableWidthPx, rowHeightPx);
        
        // 绘制汇总行分隔线
        ctx.strokeStyle = '#dddddd';
        ctx.lineWidth = 1 * rpxToPx;
        ctx.beginPath();
        ctx.moveTo(col1X, summaryRowY);
        ctx.lineTo(col1X + tableWidthPx, summaryRowY);
        ctx.stroke();
        
        // 设置汇总行字体（加粗，红色，比内容字体大20%）
        const summaryFontSize = contentFontSize * 1.1;
        ctx.font = `bold ${summaryFontSize}px sans-serif`;
        ctx.fillStyle = '#ff0000';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        
        // 绘制汇总文本（第二列显示"XX个商品/品牌 件数汇总"，第三列显示总件数）
        const itemType = displayMode === 'brand' ? '品牌' : '商品';
        const summaryText = `${renderRows}个${itemType} 件数汇总`;
        ctx.fillText(summaryText, col2X + 24 * rpxToPx, summaryRowY + rowHeightPx / 2);
        ctx.fillText(util.formatNumber(totalQuantity,0).toString()+'件', col3X + 24 * rpxToPx, summaryRowY + rowHeightPx / 2);
        
        // 生成临时图片路径
        await new Promise((resolve, reject) => {
          wx.canvasToTempFilePath({
            canvas: canvas,
            success: (res) => {
              resolve(res.tempFilePath);
            },
            fail: (err) => {
              reject(err);
            }
          }, this);
        }).then(async (tempFilePath) => {
          wx.hideLoading();
          
          // 构建操作菜单项
          const menuItems = ['保存到相册'];
          
          // 检查是否支持文件分享功能（类似index页面的导出文件方式）
          if (wx.shareFileMessage) {
            menuItems.push('分享文件给好友');
          }
          
          // 显示操作菜单
          wx.showActionSheet({
            itemList: menuItems,
            success: (res) => {
              if (res.tapIndex === 0) {
                // 保存到相册 - 简化授权流程
                this.saveImageToAlbum(tempFilePath);
              } else if (res.tapIndex === 1) {
                // 分享文件给好友（第二个选项）
                this.shareImageFile(tempFilePath);
              }
            }
          });
        }).catch((err) => {
          wx.hideLoading();
          console.error('生成图片失败:', err);
          wx.showToast({
            title: '生成图片失败',
            icon: 'none'
          });
        });
      });
    } catch (error) {
      wx.hideLoading();
      console.error('分享图片异常:', error);
      wx.showToast({
        title: '分享图片异常',
        icon: 'none'
      });
    }
  },

  // 保存图片到相册（完整授权流程）
  saveImageToAlbum(tempFilePath) {
    // 1. 检查是否已经授权
    wx.getSetting({
      success: (res) => {
        if (res.authSetting['scope.writePhotosAlbum']) {
          // 已授权，直接保存
          this.doSaveImageToAlbum(tempFilePath);
        } else {
          // 未授权，请求授权
          wx.authorize({
            scope: 'scope.writePhotosAlbum',
            success: () => {
              // 授权成功，保存图片
              this.doSaveImageToAlbum(tempFilePath);
            },
            fail: (authErr) => {
              console.error('相册授权失败:', authErr);
              // 用户拒绝授权，提示手动开启
              wx.showModal({
                title: '需要相册权限',
                content: '保存图片到相册需要您的授权，请在小程序右上角的设置中开启"保存到相册"权限后再试。',
                showCancel: false,
                confirmText: '知道了',
              });
            }
          });
        }
      },
      fail: (err) => {
        console.error('检查授权设置失败:', err);
        // 检查失败，尝试直接保存（可能会失败）
        this.doSaveImageToAlbum(tempFilePath);
      }
    });
  },
  
  // 实际执行保存图片到相册的操作
  doSaveImageToAlbum(tempFilePath) {
    wx.saveImageToPhotosAlbum({
      filePath: tempFilePath,
      success: () => {
        wx.showToast({
          title: '保存成功',
          icon: 'success',
          duration: 2000
        });
      },
      fail: (err) => {
        console.error('保存到相册失败:', err);
        // 根据错误类型给出不同提示
        if (err.errMsg.includes('auth deny') || err.errMsg.includes('授权') || err.errMsg.includes('privacy api banned')) {
          // 权限问题
          wx.showModal({
            title: '保存失败',
            content: '没有相册写入权限。请在小程序设置中开启"保存到相册"权限。',
            showCancel: false,
            confirmText: '知道了',
            success: () => {
              // 引导用户打开设置页面
              wx.openSetting({
                success: (settingRes) => {
                  if (settingRes.authSetting['scope.writePhotosAlbum']) {
                    // 用户开启了权限，重新尝试保存
                    this.doSaveImageToAlbum(tempFilePath);
                  }
                }
              });
            }
          });
        } else {
          // 其他错误
          wx.showToast({
            title: '保存失败',
            icon: 'none',
            duration: 2000
          });
        }
      }
    });
  },

  // 分享图片文件（类似index页面的导出文件方式）
  shareImageFile(tempFilePath) {
    // 生成文件名
    const now = new Date();
    const timestamp = `${now.getFullYear()}${(now.getMonth()+1).toString().padStart(2, '0')}${now.getDate().toString().padStart(2, '0')}_${now.getHours().toString().padStart(2, '0')}${now.getMinutes().toString().padStart(2, '0')}`;
    const fileName = `库存汇总_${timestamp}.png`;
    
    // 使用微信分享文件功能
    wx.shareFileMessage({
      filePath: tempFilePath,
      fileName: fileName,
      success: (res) => {
      },
      fail: (err) => {
        console.error('分享文件失败:', err);
        // 备选方案：使用openDocument打开图片文件
        wx.openDocument({
          filePath: tempFilePath,
          fileType: 'image',
          success: (res) => {
            wx.showModal({
              title: '分享文件',
              content: `文件已打开: ${fileName}\n\n您可以在文件查看器中选择分享给好友。`,
              showCancel: false,
              confirmText: '知道了'
            });
          },
          fail: (openErr) => {
            console.error('打开文档也失败:', openErr);
            // 最后方案：提示用户文件保存位置
            wx.showModal({
              title: '文件保存位置',
              content: `图片文件已保存至小程序临时目录:\n${tempFilePath}\n\n如需分享，请使用系统文件管理器查找并发送。`,
              showCancel: false,
              confirmText: '知道了'
            });
          }
        });
      }
    });
  }
});