// utils/util.js
const formatNumber = n => {
  n = n.toString()
  return n[1] ? n : '0' + n
}

const formatTime = date => {
  const year = date.getFullYear()
  const month = date.getMonth() + 1
  const day = date.getDate()
  const hour = date.getHours()
  const minute = date.getMinutes()
  const second = date.getSeconds()

  return [year, month, day].map(formatNumber).join('/') + ' ' + [hour, minute, second].map(formatNumber).join(':')
}

const formatDate = date => {
  const year = date.getFullYear()
  const month = (date.getMonth() + 1).toString().padStart(2, '0')
  const day = date.getDate().toString().padStart(2, '0')
  return `${year}-${month}-${day}`
}

// 修复：不使用 toLocaleString，手动实现千位分隔符
const formatNumberUtil = (num, decimals = 2) => {
  // 处理空值
  if (num === null || num === undefined || num === '') {
    return decimals === 0 ? '0' : '0.' + '0'.repeat(decimals)
  }
  
  // 转换为字符串并清理
  let numStr = String(num).trim()
  
  // 如果是科学计数法，转换为普通数字
  if (numStr.includes('e') || numStr.includes('E')) {
    const number = Number(num)
    if (isNaN(number)) {
      return decimals === 0 ? '0' : '0.' + '0'.repeat(decimals)
    }
    numStr = number.toString()
  }
  
  // 解析为数字
  const number = Number(numStr)
  
  // 检查是否有效数字
  if (isNaN(number)) {
    return decimals === 0 ? '0' : '0.' + '0'.repeat(decimals)
  }
  
  // 使用 toFixed 进行四舍五入并确保指定小数位数
  const fixedStr = number.toFixed(decimals)
  
  // 分离整数和小数部分
  let [integerPart, decimalPart = ''] = fixedStr.split('.')
  
  // 处理负数
  let isNegative = false
  if (integerPart.startsWith('-')) {
    isNegative = true
    integerPart = integerPart.substring(1)
  }
  
  // 添加千位分隔符
  let formattedInteger = ''
  const length = integerPart.length
  
  for (let i = 0; i < length; i++) {
    // 从右往左每三位加逗号
    if (i > 0 && (length - i) % 3 === 0) {
      formattedInteger += ','
    }
    formattedInteger += integerPart.charAt(i)
  }
  
  // 恢复负号
  if (isNegative) {
    formattedInteger = '-' + formattedInteger
  }
  
  // 返回格式化字符串
  if (decimals === 0) {
    return formattedInteger
  }
  return formattedInteger + '.' + decimalPart
}

module.exports = {
  formatTime: formatTime,
  formatDate: formatDate,
  formatNumber: formatNumberUtil
}