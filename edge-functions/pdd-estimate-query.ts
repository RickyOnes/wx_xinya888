// supabase/functions/pdd-estimate-query/index.ts
import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// 配置参数
const CONFIG = {
  MAX_CONCURRENT: 3,      // 最大并发数（避免API限制）
  MAX_RETRIES: 2,         // 最大重试次数
  RETRY_DELAY_MS: 1000,   // 重试延迟（毫秒）
  PAGE_SIZE: 100,         // 每页大小
  MAX_PAGES: 10,          // 最大分页数
}

// 清理产品名称
function cleanProductName(name: string): string {
  if (!name) return '未知产品'
  return name
    .replace(/[（(](塑|纸)[^）)]*[）)]/g, '$1·')
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/\/(件|箱|提|组|扎).*/g, '')
    .trim()
}

// 构建请求配置
function buildEstimateConfig(requestData: any, account: any) {
  return {
    url: 'https://mc.pinduoduo.com/cartman-mms/appointment/queryAppointmentGoodsList',
    headers: {
      'accept': '*/*',
      'accept-language': 'zh-CN,zh;q=0.9',
      //'anti-content': account.anti_content_Plan || account.anti_content || '',
      'anti-content':  account.anti_content || '', //修改为统一使用anti_content字段值
      'cache-control': 'max-age=0',
      'content-type': 'application/json',
      'cookie': account.cookie_string,
      'origin': 'https://mc.pinduoduo.com',
      'priority': 'u=1, i',
      'referer': 'https://mc.pinduoduo.com/ddmc-mms/appointment-delivery',
      'sec-ch-ua': '"Not(A:Brand";v="8", "Chromium";v="144", "Google Chrome";v="144"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-origin',
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36'
    },
    data: {
      page: requestData.page || 1,
      pageSize: CONFIG.PAGE_SIZE,
      sessionDate: requestData.sessionDate,
      areaId: 19881233,
      warehouseGroupId: requestData.warehouseGroupId || 123  // 使用参数或默认值
    }
  }
}

// 格式化预估数据 - 直接返回原始数值
function formatEstimateData(goodsItem: any) {
  const rows: any[] = []
  const goodsName = cleanProductName(goodsItem.goodsName)
  const goodsId = goodsItem.goodsId || 0
  
  // 创建仓库销售量的映射
  const warehouseSalesMap: { [key: number]: number } = {}
  const warehouseSalesList = goodsItem.warehouseSales || []
  
  warehouseSalesList.forEach((salesItem: any) => {
    const warehouseId = salesItem.warehouseId
    const specInfo = salesItem.productSpecSellInfoList && salesItem.productSpecSellInfoList[0]
    const goodsTotal = specInfo ? specInfo.goodsTotal || 0 : 0
    warehouseSalesMap[warehouseId] = goodsTotal
  })
  
  const warehouseInboundList = goodsItem.warehouseInboundVOList || []
  
  warehouseInboundList.forEach((inboundItem: any) => {
    const warehouseName = inboundItem.warehouseName || '未知仓库'
    const actualInbound = inboundItem.actualInbound || 0
    const salePlanNum = inboundItem.salePlanNum || 0
    const planShortGoodsQuantity = inboundItem.planShortGoodsQuantity || 0
    const warehouseId = inboundItem.warehouseId
    const pickMoreGoodsQuantity = inboundItem.pickMoreGoodsQuantity || 0
    const goodsTotal = warehouseSalesMap[warehouseId] || 0
    
    rows.push({
      goodsId: `ID:${goodsId}`,
      goodsName,
      warehouseName,
      salePlanNum: salePlanNum,           // 直接返回原始数值-预估销售
      actualInbound: actualInbound,       // 直接返回原始数值-实际入库  
      planShortGoodsQuantity: planShortGoodsQuantity,  // 直接返回原始数值-预估缺货
      pickMoreGoodsQuantity: pickMoreGoodsQuantity,    // 直接返回原始数值-分拣差异
      goodsTotal: goodsTotal              // 直接返回原始数值-实际销售
    })
  })
  
  return rows
}

// 带重试的分页获取
async function fetchWithRetry(account: any, requestData: any, retries = CONFIG.MAX_RETRIES): Promise<any[]> {
  let lastError: Error
  
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const allData: any[] = []
      let currentPage = 1
      let totalPages = 1
      
      while (currentPage <= totalPages && currentPage <= CONFIG.MAX_PAGES) {
        const config = buildEstimateConfig({
          ...requestData,
          page: currentPage,
          pageSize: CONFIG.PAGE_SIZE
        }, account)
        
        const response = await fetch(config.url, {
          method: 'POST',
          headers: config.headers,
          body: JSON.stringify(config.data)
        })
        
        if (!response.ok) {
          throw new Error(`API请求失败: ${response.status} ${response.statusText}`)
        }
        
        const result = await response.json()
        
        if (!result.success) {
          throw new Error(result.errorMsg || '查询失败')
        }
        
        // 第一页获取总页数
        if (currentPage === 1) {
          const total = (result.result && result.result.total) || 0
          totalPages = Math.ceil(total / CONFIG.PAGE_SIZE)
        }
        
        // 格式化数据
        const goodsList = (result.result && result.result.goodsAppointmentResultList) || []
        const formattedData = goodsList.flatMap(goodsItem => formatEstimateData(goodsItem))
        
        allData.push(...formattedData)
        currentPage++
        
        // 添加延迟避免过快请求
        if (currentPage <= totalPages) {
          await new Promise(resolve => setTimeout(resolve, 200))
        }
      }
      
      return allData
      
    } catch (error) {
      lastError = error
      
      // 如果不是最后一次尝试，等待后重试
      if (attempt < retries) {
        const delay = CONFIG.RETRY_DELAY_MS * (attempt + 1)
        console.log(`账户 ${account.account_name} 第${attempt + 1}次失败，${delay}ms后重试:`, error.message)
        await new Promise(resolve => setTimeout(resolve, delay))
      }
    }
  }
  
  throw lastError!
}

// 并发队列处理
async function processAccountsWithQueue(accounts: any[], requestData: any) {
  const queue: any[] = [...accounts]
  const results: any[] = []
  const errors: string[] = []
  let activeCount = 0
  
  return new Promise((resolve) => {
    const processNext = async () => {
      if (queue.length === 0 && activeCount === 0) {
        resolve({ results, errors })
        return
      }
      
      while (activeCount < CONFIG.MAX_CONCURRENT && queue.length > 0) {
        const account = queue.shift()
        activeCount++
        
        (async () => {
          try {
            const data = await fetchWithRetry(account, requestData)
            results.push({
              account: account.account_name,
              success: true,
              data,
              count: data.length
            })
          } catch (error) {
            errors.push(`${account.account_name}: ${error.message}`)
            results.push({
              account: account.account_name,
              success: false,
              error: error.message,
              data: []
            })
          } finally {
            activeCount--
            processNext()
          }
        })()
      }
    }
    
    processNext()
  })
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const { sessionDate, maxPages = 10, warehouseGroupId = 123, accountName } = await req.json()
    
    if (!sessionDate) {
      throw new Error('sessionDate 参数必填')
    }
    
    // 创建Supabase客户端
    const supabaseUrl = Deno.env.get('SUPABASE_URL') || ''
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
    const supabase = createClient(supabaseUrl, supabaseKey)

    // 获取PDD账户，支持按账户名称过滤
    let query = supabase
      .from('pdd_accounts')
      .select('*')
    
    // 如果指定了账户名称，则过滤
    if (accountName) {
      query = query.eq('account_name', accountName)
    }
    
    const { data: accounts, error: accountsError } = await query

    if (accountsError || !accounts || accounts.length === 0) {
      throw new Error('未找到PDD账户数据')
    }

    const startTime = Date.now()
    const requestData = { sessionDate, maxPages, warehouseGroupId }
    
    // 使用队列处理并发
    const { results, errors } = await processAccountsWithQueue(accounts, requestData) as any
    
    // 汇总数据
    let allData: any[] = []
    let successCount = 0
    let failCount = 0
    let totalItems = 0

    results.forEach((result: any) => {
      if (result.success) {
        successCount++
        allData = allData.concat(result.data)
        totalItems += result.count
      } else {
        failCount++
      }
    })

    const processingTimeMs = Date.now() - startTime

    return new Response(
      JSON.stringify({
        success: true,
        data: allData,
        summary: {
          totalAccounts: accounts.length,
          successCount,
          failCount,
          totalItems: allData.length,
          processingTimeMs
        },
        errors: errors.length > 0 ? errors : undefined
      }),
      { 
        headers: { 
          ...corsHeaders,
          'Content-Type': 'application/json' 
        } 
      }
    )

  } catch (error) {
    console.error('预估查询Edge Function错误:', error)
    return new Response(
      JSON.stringify({ 
        success: false, 
        error: error.message,
        summary: {
          totalAccounts: 0,
          successCount: 0,
          failCount: 0,
          totalItems: 0,
          processingTimeMs: 0
        }
      }),
      { 
        status: 500,
        headers: { 
          ...corsHeaders,
          'Content-Type': 'application/json' 
        } 
      }
    )
  }
})
