#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const DEFAULT_BASE_DIR = process.env.PUPPETEER_USER_DATA_DIR || '/app/puppeteer_user_data';
const args = process.argv.slice(2);
const showHelp = args.includes('--help') || args.includes('-h');
const dryRun = args.includes('--dry-run');
const aggressive = args.includes('--aggressive');
const targetArg = args.find(arg => !arg.startsWith('--'));
const baseDir = path.resolve(targetArg || DEFAULT_BASE_DIR);

const SKIP_TOP_LEVEL_DIRS = new Set(['.config', 'Desktop', 'Downloads', 'lost+found']);
const BROWSER_ROOT_MARKERS = ['Default', 'Local State', 'First Run', 'Last Version', 'SingletonLock', 'Crashpad'];

// 需要清空内容（但保留文件夹名）的目录列表（相对于浏览器根目录）,已优化！！
const SAFE_DIRS_TO_EMPTY = [
  // NOTE: 不再清空 Local Storage / WebStorage / Session Storage / Web Applications，否则会触发风控而要验证码
  // 'Default/Local Storage',
  // 'Default/Session Storage',
  // 'Default/WebStorage',
  // 'Default/Web Applications',
  'Default/Cache',
  'Default/Code Cache',
  'Default/GPUCache',
  'Default/Media Cache',
  'Default/Offline Cache',
  'Default/Crashpad',
  'Default/DawnWebGPU Cache',
  'Default/DawnGraphiteCache',
  'Default/GPU Cache',
  'Default/Sessions',
  'Default/shared_proto_db',
  'Default/Shared Dictionary',
  'Default/Extension State',
  'Default/Extension Scripts',
  'Default/Extension Rules',
  'Default/Sync Data',
  'GrShaderCache',
  'ShaderCache',
  'DawnCache',
  'Crashpad',
  'component_crx_cache',
  'WasmTtsEngine',
  'hyphen-data',
  'ZxcvbnData',
  'CertificateRevocation',
  'ActorSafetyLists',
  'GraphiteDawnCache',
  'Subresource Filter',
  'PKIMetadata',
  'Crowd Deny',
  'SafetyTips',
  'segmentation_platform',
  'FirstPartySetsPreloaded',
  'TrustTokenKeyCommitments',
  'MEIPreload',
  'FileTypePolicies',
  'SSLErrorAssistant',
  'AmountExtractionHeuristicRegexes',
  'CaptchaProviders',
  'Dictionaries',
  'Crash Reports'
];

const AGGRESSIVE_DIRS_TO_EMPTY = [
  'Default/blob_storage',
  'Default/File System'
];

// 注意：IndexedDB 不在此列表中，完全保留

const MAX_SCAN_DEPTH = 3;

if (showHelp) {
  console.log(`用法:
  node scripts/clean-browser-profiles.js [目录] [--dry-run] [--aggressive]

说明:
  - 默认清理 /app/puppeteer_user_data 下的浏览器缓存目录（清空内部所有内容，但保留文件夹名）
  - 完全保留 Cookies、IndexedDB、Local State 等登录态数据和配置文件
  - 保留 User Data 根目录下的所有文件（如 Local State, Variations 等）
  - --dry-run 只显示将清空的目录，不实际删除内容
  - --aggressive 额外清空 blob_storage 和 File System（站点本地缓存会丢失，不影响登录）
`);
  process.exit(0);
}

if (!fs.existsSync(baseDir) || !fs.statSync(baseDir).isDirectory()) {
  console.error(`目录不存在或不是文件夹: ${baseDir}`);
  process.exit(1);
}

if (path.parse(baseDir).root === baseDir) {
  console.error(`拒绝直接操作根目录: ${baseDir}`);
  process.exit(1);
}

const summary = {
  rootsFound: 0,
  dirsEmptied: 0,
  failed: 0
};

function exists(targetPath) {
  try {
    fs.accessSync(targetPath);
    return true;
  } catch {
    return false;
  }
}

function safeReadDir(dirPath) {
  try {
    return fs.readdirSync(dirPath, { withFileTypes: true });
  } catch (error) {
    console.warn(`⚠️ 无法读取目录: ${dirPath} -> ${error.message}`);
    summary.failed += 1;
    return [];
  }
}

function rel(targetPath) {
  const relative = path.relative(baseDir, targetPath);
  return relative || '.';
}

function looksLikeBrowserRoot(dirPath) {
  const entries = safeReadDir(dirPath);
  if (!entries.length) return false;
  const names = new Set(entries.map(entry => entry.name));
  return BROWSER_ROOT_MARKERS.some(marker => names.has(marker));
}

function collectBrowserRoots(startDir, depth, roots) {
  if (!exists(startDir) || depth < 0) return;

  if (looksLikeBrowserRoot(startDir)) {
    roots.add(startDir);
    return;
  }

  if (depth === 0) return;

  const entries = safeReadDir(startDir);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === 'Default') continue;
    collectBrowserRoots(path.join(startDir, entry.name), depth - 1, roots);
  }
}

// 递归删除目录内的所有内容，但保留目录本身
function emptyDirectory(targetPath) {
  if (!exists(targetPath)) return false;

  let entries;
  try {
    entries = fs.readdirSync(targetPath);
  } catch (err) {
    console.warn(`⚠️ 无法读取目录内容: ${rel(targetPath)} -> ${err.message}`);
    summary.failed += 1;
    return false;
  }

  for (const entry of entries) {
    const fullPath = path.join(targetPath, entry);
    try {
      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) {
        // 递归删除子目录及其内容
        fs.rmSync(fullPath, { recursive: true, force: true });
      } else {
        fs.unlinkSync(fullPath);
      }
    } catch (err) {
      console.warn(`⚠️ 删除失败: ${rel(fullPath)} -> ${err.message}`);
      summary.failed += 1;
    }
  }
  return true;
}

function cleanBrowserRoot(rootDir) {
  console.log(`\n🔍 清理浏览器目录: ${rel(rootDir)}`);

  const dirsToEmpty = aggressive
    ? SAFE_DIRS_TO_EMPTY.concat(AGGRESSIVE_DIRS_TO_EMPTY)
    : SAFE_DIRS_TO_EMPTY;

  for (const relativePath of dirsToEmpty) {
    const targetPath = path.join(rootDir, relativePath);
    if (!exists(targetPath)) continue;

    if (dryRun) {
      console.log(`📝 将清空目录: ${rel(targetPath)} (保留文件夹)`);
      summary.dirsEmptied += 1;
    } else {
      const success = emptyDirectory(targetPath);
      if (success) {
        console.log(`✅ 已清空目录: ${rel(targetPath)}`);
        summary.dirsEmptied += 1;
      }
    }
  }
}

console.log(`开始清理浏览器缓存目录: ${baseDir}`);
console.log(`模式: ${dryRun ? '预览' : '执行'}${aggressive ? ' + 深度清理' : ' + 安全清理'}`);
console.log('保留项: Cookies / IndexedDB / Local State / 根目录文件 / 所有文件夹结构\n');

const topLevelEntries = safeReadDir(baseDir);
const browserRoots = new Set();

for (const entry of topLevelEntries) {
  if (!entry.isDirectory()) continue;
  if (SKIP_TOP_LEVEL_DIRS.has(entry.name)) continue;
  collectBrowserRoots(path.join(baseDir, entry.name), MAX_SCAN_DEPTH, browserRoots);
}

summary.rootsFound = browserRoots.size;

if (browserRoots.size === 0) {
  console.log('未发现可清理的浏览器用户目录。');
  process.exit(0);
}

for (const rootDir of Array.from(browserRoots).sort()) {
  cleanBrowserRoot(rootDir);
}

console.log('\n=== 清理完成 ===');
console.log(`浏览器目录: ${summary.rootsFound}`);
console.log(`清空目录数: ${summary.dirsEmptied}`);
console.log(`失败次数: ${summary.failed}`);
