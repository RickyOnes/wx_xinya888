// Supabase Edge Function for PDD return/retrieval data query
// 查询所有账户指定日期范围内的退货数据（两个仓库），按 goodsId 合并退货数量后返回
// 返回字段说明：【data数组中的每个对象包含：goodsId（商品ID，数字），retrievalNum（退货数量，数字）】
/* 结果样本
{
  "success": true,
  "data": [
    { "goodsId": 855257494830, "retrievalNum": 36 },
    { "goodsId": 855317696448, "retrievalNum": 39 },
    { "goodsId": 855184905239, "retrievalNum": 61 }
  ],
  "summary": { "successCount": 2, "failCount": 0, "totalItems": 3 },
  "errors": []
}
*/

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
}

// 将日期字符串（YYYY-MM-DD）转换为北京时间的起始和结束毫秒时间戳
function getBeijingTimestampRange(dateStr: string, isEnd = false): number {
  if (isEnd) {
    // 结束日期：当天的 23:59:59.999
    return new Date(dateStr + 'T23:59:59.999+08:00').getTime()
  } else {
    // 开始日期：当天的 00:00:00.000
    return new Date(dateStr + 'T00:00:00.000+08:00').getTime()
  }
}

// 定义仓库查询结果类型
interface SuccessResult {
  warehouseId: number;
  success: true;
  data: Array<{ goodsId: number; retrievalNum: number }>;
}
interface FailureResult {
  warehouseId: number;
  success: false;
  error: string;
}
type WarehouseResult = SuccessResult | FailureResult;

// 查询单个账户单个仓库的所有分页退货数据
async function fetchAllReturnPages(
  account: { account_name: string; anti_content: string; cookie_string: string },
  warehouseId: number,
  startTime: number,
  endTime: number,
  maxPages = 100
): Promise<Array<{ goodsId: number; retrievalNum: number }>> {
  const { account_name, anti_content, cookie_string } = account

  // 检查凭证是否为空
  if (!anti_content || anti_content.trim() === '') {
    throw new Error(`账户 ${account_name} 的 anti-content 为空`)
  }
  if (!cookie_string || cookie_string.trim() === '') {
    throw new Error(`账户 ${account_name} 的 cookie 为空`)
  }

  const apiUrl = 'https://mc.pinduoduo.com/churchill-mms/return/retrieval/pageQueryDetail'

  let allGoodsItems: Array<{ goodsId: number; retrievalNum: number }> = []
  let currentPage = 1
  let totalPages = 1
  const pageSize = 10

  while (currentPage <= totalPages && currentPage <= maxPages) {
    const requestBody = {
      pageNumber: currentPage,
      pageSize: pageSize,
      startTime: startTime,
      endTime: endTime,
      areaId: 19881233,
      warehouseType: 2,
      warehouseId: warehouseId
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
          'origin': 'https://mc.pinduoduo.com',
          'referer': 'https://mc.pinduoduo.com/ddmc-mms/refundOrder',
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36'
        },
        body: JSON.stringify(requestBody)
      })

      if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`退货API请求失败: ${response.status} ${response.statusText}, 响应: ${errorText}`)
      }

      const data = await response.json()
      if (!data.success) {
        throw new Error(data.errorMsg || `查询失败: ${JSON.stringify(data)}`)
      }

      const result = data.result
      if (!result) {
        break
      }

      if (currentPage === 1) {
        const total = result.total || 0
        totalPages = Math.ceil(total / pageSize)
      }

      const orderList = result.result || []   // 退货订单列表
      orderList.forEach((order: any) => {
        const details = order.retrievalGoodsDetails || []
        details.forEach((goods: any) => {
          const goodsId = goods.goodsId
          const retrievalNum = goods.retrievalNum
          if (goodsId != null && retrievalNum != null) {
            allGoodsItems.push({
              goodsId: goodsId,
              retrievalNum: retrievalNum
            })
          }
        })
      })

      currentPage++
    } catch (error) {
      throw error
    }
  }

  return allGoodsItems
}

// 按 goodsId 合并退货数量
function mergeDataByGoodsId(items: Array<{ goodsId: number; retrievalNum: number }>): Array<{ goodsId: number; retrievalNum: number }> {
  if (!items || items.length === 0) return []

  const mergedMap = new Map<number, number>()

  items.forEach(item => {
    const goodsId = item.goodsId
    const retrievalNum = item.retrievalNum
    const current = mergedMap.get(goodsId) || 0
    mergedMap.set(goodsId, current + retrievalNum)
  })

  return Array.from(mergedMap.entries()).map(([goodsId, retrievalNum]) => ({
    goodsId,
    retrievalNum
  })).sort((a, b) => a.goodsId - b.goodsId)
}

Deno.serve(async (req: Request) => {
  // 处理预检请求
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  try {
    // 1. 解析请求参数
    const { startDate, endDate, maxPages = 100, warehouseIds = [18902, 19099], accountName } = await req.json() as { startDate: string; endDate: string; maxPages?: number, warehouseIds?: number[], accountName?: string }
    if (!startDate || !endDate) {
      return new Response(
        JSON.stringify({ success: false, error: '缺少必要参数: startDate 和 endDate' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400 }
      )
    }

    // 2. 初始化 Supabase 客户端
    const supabaseUrl = Deno.env.get('SUPABASE_URL') || ''
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
    if (!supabaseUrl || !supabaseKey) {
      return new Response(
        JSON.stringify({ success: false, error: '服务器配置错误' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500 }
      )
    }
    const supabase = createClient(supabaseUrl, supabaseKey)

    // 3. 获取拼多多账户（只需凭证字段），支持按账户名称过滤
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
        JSON.stringify({ success: false, error: '获取账户列表失败' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500 }
      )
    }

    if (!accounts || accounts.length === 0) {
      return new Response(
        JSON.stringify({
          success: true,
          data: [],
          summary: { successCount: 0, failCount: 0, totalItems: 0 },
          errors: ['没有可用的账户']
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // 4. 将日期转换为北京时间毫秒时间戳
    const startTime = getBeijingTimestampRange(startDate, false)
    const endTime = getBeijingTimestampRange(endDate, true)

    // 5. 遍历所有账户，每个账户查询两个仓库
    let allGoodsItems: Array<{ goodsId: number; retrievalNum: number }> = []
    let errors: string[] = []
    let successCount = 0
    let failCount = 0

    const requestWarehouseIds = warehouseIds || [18902, 19099] // 使用参数或默认值

    // 类型安全的账户循环
    for (const account of accounts) {
      const warehousePromises = requestWarehouseIds.map(warehouseId =>
        fetchAllReturnPages(account, warehouseId, startTime, endTime, maxPages)
          .then<SuccessResult>(data => ({ warehouseId, success: true, data }))
          .catch<FailureResult>(error => ({ warehouseId, success: false, error: error.message }))
      )

      const warehouseResults = await Promise.all(warehousePromises)
      let accountData: Array<{ goodsId: number; retrievalNum: number }> = []

      for (const result of warehouseResults) {
        if (result.success) {
          // TypeScript 自动推断为 SuccessResult
          accountData = accountData.concat(result.data)
        } else {
          // TypeScript 自动推断为 FailureResult
          errors.push(`${account.account_name} - 仓库${result.warehouseId}: ${result.error}`)
        }
      }

      if (accountData.length > 0) {
        successCount++
        allGoodsItems = allGoodsItems.concat(accountData)
      } else {
        failCount++
      }
    }

    // 6. 按 goodsId 合并所有商品数据
    const mergedData = mergeDataByGoodsId(allGoodsItems)

    // 7. 返回结果
    return new Response(
      JSON.stringify({
        success: true,
        data: mergedData,
        summary: {
          successCount,
          failCount,
          totalItems: mergedData.length
        },
        errors
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (error) {
    // 全局异常处理
    const errorMessage = error instanceof Error ? error.message : '内部服务器错误'
    return new Response(
      JSON.stringify({ success: false, error: errorMessage }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500 }
    )
  }
})