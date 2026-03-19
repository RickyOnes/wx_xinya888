// Supabase Edge Function for PDD product date query
// This function queries product date data from PDD for all accounts
// 基于旧版备份文件 pages/pdd-query/pdd-query-old.js 的参数构建

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
}

// 实际调用PDD产品日期API的函数，支持分页
async function fetchAllProductDatePages(account, bizDate, maxPages = 10, warehouseGroupId = 123) {
  const { account_name, anti_content, cookie_string } = account
  
  // 检查anti-content是否为空
  if (!anti_content || anti_content.trim() === '') {
    throw new Error(`账户 ${account_name} 的anti-content为空，请先更新账户凭证`)
  }
  
  // 检查cookie是否为空
  if (!cookie_string || cookie_string.trim() === '') {
    throw new Error(`账户 ${account_name} 的cookie为空，请先更新账户凭证`)
  }
  
  // PDD产品日期API端点
  const apiUrl = 'https://mms.pinduoduo.com/orianna-mms/goods/schedule/pageQuery'
  
  let allData = []
  let currentPage = 1
  let totalPages = 1
  const pageSize = 100 // 与旧版保持一致
  
  while (currentPage <= totalPages && currentPage <= maxPages) {
    // 构建请求参数（严格按旧版参数）
    const requestBody = {
      page: currentPage,
      pageSize: pageSize,
      bizDate: bizDate, // 旧版中使用bizDate参数
      warehouseGroupId: warehouseGroupId, // 使用参数
      submitStatus: 'ALL', // 固定值
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
          'priority': 'u=1, i',
          'referer': 'https://mms.pinduoduo.com/',
          'sec-ch-ua': '"Not(A:Brand";v="8", "Chromium";v="144", "Google Chrome";v="144"',
          'sec-ch-ua-mobile': '?0',
          'sec-ch-ua-platform': '"Windows"',
          'sec-fetch-dest': 'empty',
          'sec-fetch-mode': 'cors',
          'sec-fetch-site': 'same-origin',
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36'
        },
        body: JSON.stringify(requestBody)
      })
      
      if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`PDD API请求失败: ${response.status} ${response.statusText}, 响应: ${errorText}`)
      }
      
      const data = await response.json()
      
      // 检查API响应是否成功
      if (!data.success) {
        throw new Error(data.errorMsg || `查询失败: ${JSON.stringify(data)}`)
      }
      
      // 如果是第一页，获取总记录数和总页数
      if (currentPage === 1) {
        const total = (data.result && data.result.total) || 0
        totalPages = Math.ceil(total / pageSize)
      }
      
      // 提取数据
      const rawData = data.result && data.result.data ? data.result.data : []
      
      // 格式化数据，添加账户信息
      const formattedData = []
      
      rawData.forEach(item => {
        // 处理goodsName，参考旧版逻辑
        const goodsId = `ID:${item.goodsId}`
        const goodsName = item.goodsName 
          ? item.goodsName
              .replace(/[（(](塑|纸)[^）)]*[）)]/g, '$1·')  // 保留首字+中文间隔号·
              .replace(/[（(][^）)]*[）)]/g, '')            // 其他括号全删
              .replace(/\/(件|箱|提|组|扎).*/g, '')
              .trim()
          : '未知产品'
        
        // 提取productionTime（北京时间戳）并转换为日期
        let productionTime = '';
        const extraAttr = item.skuVegetableExtraAttrVO;
        if (extraAttr && extraAttr.productionTime) {
          const timestamp = extraAttr.productionTime;
          const beijingDate = new Date(timestamp + 8 * 3600 * 1000);
          if (!isNaN(beijingDate.getTime())) {
            const year = beijingDate.getUTCFullYear();
            const month = (beijingDate.getUTCMonth() + 1).toString().padStart(2, '0');
            const day = beijingDate.getUTCDate().toString().padStart(2, '0');
            productionTime = `${year}-${month}-${day}`;
          } else {
            productionTime = '无效日期';
          }
        }
        
        formattedData.push({
          goodsId,
          goodsName,
          productionTime,
          account: account_name // 添加账户信息
        })
      })
      
      allData = allData.concat(formattedData)
      currentPage++
      
    } catch (error) {
      throw error // 抛出错误，由外层处理
    }
  }
  
  return allData
}

Deno.serve(async (req) => {
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  try {
    // Parse request body - 参数与前端一致
    const { sessionDate, maxPages = 10, warehouseGroupId = 123, accountName } = await req.json()
    
    if (!sessionDate) {
      return new Response(
        JSON.stringify({ 
          success: false, 
          error: 'Missing required parameter: sessionDate' 
        }),
        { 
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          status: 400 
        }
      )
    }

    // Initialize Supabase client
    const supabaseUrl = Deno.env.get('SUPABASE_URL') || ''
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
    
    if (!supabaseUrl || !supabaseKey) {
      return new Response(
        JSON.stringify({ 
          success: false, 
          error: 'Server configuration error' 
        }),
        { 
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          status: 500 
        }
      )
    }

    const supabase = createClient(supabaseUrl, supabaseKey)

    // Get PDD accounts - 支持按账户名称过滤
    let query = supabase
      .from('pdd_accounts')
      .select('account_name, anti_content, cookie_string') // 只选择必要字段
      .order('updated_at', { ascending: false })
    
    // 如果指定了账户名称，则过滤
    if (accountName) {
      query = query.eq('account_name', accountName)
    }
    
    const { data: accounts, error: accountsError } = await query

    if (accountsError) {
      return new Response(
        JSON.stringify({ 
          success: false, 
          error: 'Failed to fetch accounts' 
        }),
        { 
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 500 
        }
      )
    }



    if (!accounts || accounts.length === 0) {
      console.log('数据库中未找到账户数据')
      return new Response(
        JSON.stringify({ 
          success: true, 
          data: [], 
          summary: { successCount: 0, failCount: 0, totalItems: 0 },
          errors: ['No accounts available']
        }),
        { 
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        }
      )
    }

    // 实际数据收集（多账户并行查询）
    let allData = []
    let errors = []
    let successCount = 0
    let failCount = 0

    // 使用Promise.allSettled进行并行查询
    const accountPromises = accounts.map(async (account) => {
      try {
        // 调用PDD API获取产品日期数据（支持分页）
        const formattedData = await fetchAllProductDatePages(account, sessionDate, maxPages, warehouseGroupId)
        return {
          account: account.account_name,
          success: true,
          data: formattedData
        }
      } catch (error) {
        return {
          account: account.account_name,
          success: false,
          error: error.message || '请求异常',
          data: []
        }
      }
    })

    // 等待所有账户查询完成
    const accountResults = await Promise.allSettled(accountPromises)
    
    // 汇总所有成功的数据
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

    return new Response(
      JSON.stringify({
        success: true,
        data: allData,  // 直接使用已格式化的数据
        summary: {
          successCount,
          failCount,
          totalItems: allData.length
        },
        errors: errors
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  } catch (error) {
    return new Response(
      JSON.stringify({ 
        success: false, 
        error: error.message || 'Internal server error' 
      }),
      { 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 500 
      }
    )
  }
})
