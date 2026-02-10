// utils/iconMapper.js
/**
 * 根据用户邮箱获取对应的图标路径
 * 支持根据邮箱域名、邮箱前缀或完整邮箱地址进行映射
 */

// 图标映射配置
const iconMappings = {
  'coca_cola@xinya.com': {
    icon: '/images/coca_cola.gif',
  },
  '13762405681@139.com': {
    icon: '/images/wangying.jpg',
  },
  '15096086678@139.com': {
    icon: '/images/juanzi.png',
  },
  '162004332@qq.com': {
    icon: '/images/icon.jpg',
  }
};

// 默认图标
const DEFAULT_ICON = {
  icon: '/images/icon64.png',
};

/**
 * 根据用户邮箱获取图标配置
 * @param {string} email - 用户邮箱
 * @returns {Object} 包含 icon 和 grayIcon 的对象
 */
function getIconByEmail(email) {
  if (!email || typeof email !== 'string') {
    console.warn('无效的邮箱地址，使用默认图标');
    return DEFAULT_ICON;
  }

  // 清理邮箱
  const cleanEmail = email.trim().toLowerCase();
  
  // 1. 首先尝试完整邮箱匹配
  if (iconMappings[cleanEmail]) {
    return iconMappings[cleanEmail];
  }
  
  // 2. 尝试域名匹配
  const domain = cleanEmail.split('@')[1];
  if (domain && iconMappings[domain]) {
    return iconMappings[domain];
  }
  
  // 3. 尝试前缀匹配（邮箱@之前的部分）
  const prefix = cleanEmail.split('@')[0];
  if (prefix && iconMappings[prefix]) {
    return iconMappings[prefix];
  }
  
  return DEFAULT_ICON;
}

/**
 * 获取当前登录用户的图标
 * @returns {Object} 包含 icon 和 grayIcon 的对象
 */
function getCurrentUserIcon() {
  try {
    const userInfo = wx.getStorageSync('user_info');
    if (!userInfo) {
      console.warn('未找到用户信息，使用默认图标');
      return DEFAULT_ICON;
    }
    
    const email = userInfo.email || userInfo.display_name || '';
    return getIconByEmail(email);
  } catch (error) {
    console.error('获取用户图标失败:', error);
    return DEFAULT_ICON;
  }
}

/**
 * 添加自定义映射规则
 * @param {string} key - 映射键（邮箱、域名或前缀）
 * @param {Object} iconConfig - 图标配置 {icon, grayIcon}
 */
function addIconMapping(key, iconConfig) {
  if (!key || !iconConfig || !iconConfig.icon || !iconConfig.grayIcon) {
    console.error('添加映射失败：参数无效');
    return;
  }
  iconMappings[key.toLowerCase()] = iconConfig;
}

module.exports = {
  getIconByEmail,
  getCurrentUserIcon,
  addIconMapping,
  DEFAULT_ICON
};