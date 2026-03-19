// Supabase Edge Function for PDD order query
// 返回精简后的订单数据（所有账户合并后的数据，已按同一天的id、单价一样的会合并计算商品数量、金额）
// 返回字段说明：【data数组中的每个对象包含：sessionDate（销售日期，格式YYYY-MM-DD），productName（产品名称，已清理），
// productId（产品ID，'无ID前缀'），sellUnitTotal（销售数量，数字），supplierPrice（供货价，数字），amount（总金额，数字）】
/*  结果样本{
  "success": true,
  "data": [
    {
      "sessionDate": "2025-03-07",
      "productName": "可口可乐500mL*24瓶/件",
      "productId": "853507968797",
      "sellUnitTotal": 168,
      "supplierPrice": 12.34,
      "amount": 2073.12,
    }
  ],
  "summary": { "successCount": 2, "failCount": 0, "totalItems": 1 },
  "errors": []
}
*/

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
}

// 获取某个账户的所有分页数据
async function fetchAllOrderPages(account, startDate, endDate, maxPages = 100, warehouseIds = [18902, 19099]) {
  const { account_name, anti_content, cookie_string } = account

  // 检查凭证是否为空
  if (!anti_content || anti_content.trim() === '') {
    throw new Error(`账户 ${account_name} 的anti-content为空，请先更新账户凭证`)
  }
  if (!cookie_string || cookie_string.trim() === '') {
    throw new Error(`账户 ${account_name} 的cookie为空，请先更新账户凭证`)
  }

  const apiUrl = 'https://mms.pinduoduo.com/cartman-mms/orderManagement/pageQueryDetail'

  // 将日期转换为时间戳（毫秒）
  const startSessionTime = new Date(startDate).getTime()
  const endSessionTime = new Date(endDate).getTime()

  let allFormattedData = []
  let currentPage = 1
  let totalPages = 1
  const pageSize = 100

  while (currentPage <= totalPages && currentPage <= maxPages) {
    const requestBody = {
      areaId: 19881233,
      warehouseIds: warehouseIds,// 使用参数
      startSessionTime,
      endSessionTime,
      page: currentPage,
      pageSize,
    }

    try {
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'accept': '*/*',
          'accept-language': 'zh-CN,zh;q=0.9',
          'anti-content': anti_content,
          'cache-control': 'max-age=0',
          'content-type': 'application/json',
          'cookie': cookie_string,
          'origin': 'https://mms.pinduoduo.com',
          'referer': 'https://mms.pinduoduo.com/',
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36'
        },
        body: JSON.stringify(requestBody)
      })

      if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`PDD API请求失败: ${response.status} ${response.statusText}, 响应: ${errorText}`)
      }

      const orderData = await response.json()
      if (!orderData.success) {
        throw new Error(orderData.errorMsg || `查询失败: ${JSON.stringify(orderData)}`)
      }

      // 获取总页数（仅第一页）
      if (currentPage === 1) {
        const total = orderData.result?.total || 0
        totalPages = Math.ceil(total / pageSize)
      }

      const resultList = orderData.result?.resultList || []

      // 格式化当前页数据
      const formattedData = []
      resultList.forEach(item => {
        // 销售日期：时间戳转 YYYY-MM-DD
        let sessionDate = '未知日期'
        if (item.sessionDate) {
          try {
            const date = new Date(item.sessionDate)
            if (!isNaN(date.getTime())) {
              const adjustedDate = new Date(date.getTime() + 8 * 60 * 60 * 1000) // 转为东八区
              sessionDate = adjustedDate.toISOString().split('T')[0]
            }
          } catch (error) { /* 保持默认值 */ }
        }

        // 产品名称清理
        const productName = item.productName
          ? item.productName
              .replace(/[（(](塑|纸)[^）)]*[）)]/g, '$1·')
              .replace(/[（(][^）)]*[）)]/g, '')
              .replace(/\/(件|箱|提|组|扎).*/g, '')
              .trim()
          : '未知产品'

        const productId = item.productId || ''

        // 价格详情（可能多个价格）
        const priceDetails = item.specQuantityDetails?.[0]?.priceDetail || []

        if (priceDetails.length > 0) {
          priceDetails.forEach(priceDetail => {
            const sellUnitTotal = priceDetail.sellUnitTotal || 0          // 数字
            const supplierPriceCents = priceDetail.supplierPrice || 0
            const supplierPrice = supplierPriceCents / 100                // 转为元，数字
            const amount = supplierPrice * sellUnitTotal                  // 金额，数字

            if (sellUnitTotal > 0) {
              formattedData.push({
                sessionDate,
                productName,
                productId,
                sellUnitTotal,          // 数字
                supplierPrice,           // 数字
                amount                   // 数字
              })
            }
          })
        } else {
          // 无价格详情时，使用总销售数量，供货价默认为0
          const sellUnitTotal = item.sellUnitTotal || 0
          if (sellUnitTotal > 0) {
            formattedData.push({
              sessionDate,
              productName,
              productId,
              sellUnitTotal,
              supplierPrice: 0,
              amount: 0
            })
          }
        }
      })

      allFormattedData = allFormattedData.concat(formattedData)
      currentPage++
    } catch (error) {
      throw error
    }
  }

  return allFormattedData
}

// 合并相同产品（按日期、产品ID、供货价）的数据
function mergeDataByProductId(data) {
  if (!data || data.length === 0) return []

  const mergedMap = new Map()

  data.forEach(item => {
    // 确保数值为数字（以防万一）
    const sellUnitTotal = typeof item.sellUnitTotal === 'number' ? item.sellUnitTotal : 0
    const supplierPrice = typeof item.supplierPrice === 'number' ? item.supplierPrice : 0
    const amount = typeof item.amount === 'number' ? item.amount : 0

    const key = `${item.sessionDate}|${item.productId}|${supplierPrice}`

    if (mergedMap.has(key)) {
      const existing = mergedMap.get(key)
      existing.sellUnitTotal += sellUnitTotal
      existing.amount += amount
    } else {
      mergedMap.set(key, {
        sessionDate: item.sessionDate,
        productName: item.productName,
        productId: item.productId,
        sellUnitTotal,
        supplierPrice,
        amount
      })
    }
  })

  // 转换为数组并按日期降序排序
  return Array.from(mergedMap.values()).sort((a, b) =>
    b.sessionDate.localeCompare(a.sessionDate)
  )
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  try {
    const { startDate, endDate, maxPages = 100, warehouseIds = [18902, 19099], accountName } = await req.json()
    if (!startDate || !endDate) {
      return new Response(
        JSON.stringify({ success: false, error: 'Missing required parameters: startDate and endDate' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400 }
      )
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL') || ''
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
    if (!supabaseUrl || !supabaseKey) {
      return new Response(
        JSON.stringify({ success: false, error: 'Server configuration error' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500 }
      )
    }

    const supabase = createClient(supabaseUrl, supabaseKey)

    // 获取PDD账户（仅需要凭证字段），支持按账户名称过滤
    let query = supabase
      .from('pdd_accounts')
      .select('account_name, anti_content, cookie_string')
      .order('updated_at', { ascending: false })
    
    if (accountName) {
      query = query.eq('account_name', accountName)
    }
    
    const { data: accounts, error: accountsError } = await query

    if (accountsError) {
      return new Response(
        JSON.stringify({ success: false, error: 'Failed to fetch accounts' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500 }
      )
    }

    if (!accounts || accounts.length === 0) {
      return new Response(
        JSON.stringify({
          success: true,
          data: [],
          summary: { successCount: 0, failCount: 0, totalItems: 0 },
          errors: ['No accounts available']
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // 并行查询所有账户
    let allData = []
    let errors = []
    let successCount = 0
    let failCount = 0

    const accountPromises = accounts.map(async (account) => {
      try {
        const formattedData = await fetchAllOrderPages(account, startDate, endDate, maxPages, warehouseIds)
        return { account: account.account_name, success: true, data: formattedData }
      } catch (error) {
        return { account: account.account_name, success: false, error: error.message, data: [] }
      }
    })

    const accountResults = await Promise.allSettled(accountPromises)

    accountResults.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        const accountResult = result.value
        if (accountResult.success) {
          successCount++
          allData = allData.concat(accountResult.data)
        } else {
          failCount++
          errors.push(`${accountResult.account}: ${accountResult.error}`)
        }
      } else {
        failCount++
        const account = accounts[index]
        errors.push(`${account.account_name || '未知账户'}: ${result.reason || '查询失败'}`)
      }
    })

    // 合并相同产品数据
    const mergedData = mergeDataByProductId(allData)

    return new Response(
      JSON.stringify({
        success: true,
        data: mergedData,
        summary: { successCount, failCount, totalItems: mergedData.length },
        errors
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (error) {
    return new Response(
      JSON.stringify({ success: false, error: error.message || 'Internal server error' }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500 }
    )
  }
})