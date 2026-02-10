// utils/test-pdd-supabase.js
// 测试Supabase拼多多参数功能

const { getPddParamsFromSupabase, testOrderQueryWithSupabase } = require('./duoduomai.js')

// 测试函数
async function testSupabasePddParams() {
  console.log('🧪 开始测试Supabase拼多多参数功能')
  
  try {
    // 测试账号列表
    const testAccounts = ['wangxh03', 'wangxh04', '17752768679']
    
    for (const username of testAccounts) {
      console.log(`\n📋 测试账号: ${username}`)
      
      // 1. 从Supabase获取参数
      console.log('  1. 从Supabase获取参数...')
      const accountData = await getPddParamsFromSupabase(username)
      
      if (!accountData) {
        console.log(`  ❌ 账号 ${username} 在Supabase中未找到数据或已过期`)
        continue
      }
      
      console.log(`  ✅ 获取成功！参数信息:`)
      console.log(`     - anti_content: ${accountData.anti_content ? '✅ 存在' : '❌ 缺失'}`)
      console.log(`     - windows_app_shop_token_23: ${accountData.windows_app_shop_token_23 ? '✅ 存在' : '❌ 缺失'}`)
      console.log(`     - pass_id: ${accountData.pass_id ? '✅ 存在' : '❌ 缺失'}`)
      console.log(`     - cookie_string: ${accountData.cookie_string ? '✅ 存在' : '❌ 缺失'}`)
      console.log(`     - 更新时间: ${accountData.updated_at || '未知'}`)
      console.log(`     - 过期时间: ${accountData.expires_at || '未知'}`)
      
      // 检查是否过期
      if (accountData.expires_at) {
        const expiresAt = new Date(accountData.expires_at)
        const now = new Date()
        const hoursLeft = Math.floor((expiresAt - now) / (1000 * 60 * 60))
        
        if (expiresAt < now) {
          console.log(`  ⚠️  参数已过期 ${Math.abs(hoursLeft)} 小时`)
        } else {
          console.log(`  ⏳ 参数还有约 ${hoursLeft} 小时过期`)
        }
      }
      
      // 2. 测试订单查询
      console.log('\n  2. 测试订单查询...')
      const queryResult = await testOrderQueryWithSupabase(username, {
        page: 1,
        pageSize: 5,
        startSessionTime: Date.now() - 24 * 60 * 60 * 1000, // 24小时内
        endSessionTime: Date.now()
      })
      
      if (queryResult.success) {
        console.log(`  ✅ 订单查询成功！`)
        console.log(`     - 状态码: ${queryResult.statusCode}`)
        console.log(`     - 订单数量: ${queryResult.records.length}`)
        console.log(`     - 总订单数: ${queryResult.total}`)
        
        if (queryResult.records.length > 0) {
          console.log(`     - 最近订单:`)
          queryResult.records.slice(0, 2).forEach((order, index) => {
            console.log(`       ${index + 1}. ${order.orderNo || order.order_id || '未知订单号'}`)
          })
        }
      } else {
        console.log(`  ❌ 订单查询失败:`)
        console.log(`     - 错误: ${queryResult.message}`)
        console.log(`     - 建议: ${queryResult.suggestion}`)
      }
      
      console.log('\n' + '─'.repeat(50))
    }
    
    console.log('\n🎉 所有账号测试完成！')
    
  } catch (error) {
    console.error('❌ 测试过程中出错:', error)
  }
}

// 导出测试函数
module.exports = {
  testSupabasePddParams
}

// 如果直接运行此文件，则执行测试
if (typeof wx !== 'undefined') {
  // 在小程序环境中，提供全局函数
  wx.testSupabasePddParams = testSupabasePddParams
  console.log('✅ Supabase拼多多参数测试函数已加载，使用 wx.testSupabasePddParams() 运行测试')
}