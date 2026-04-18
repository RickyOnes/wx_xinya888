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

const SAFE_DIRS_TO_DELETE = [
  'Default/Cache',
  'Default/Code Cache',
  'Default/GPUCache',
  'Default/Media Cache',
  'Default/Offline Cache',
  'Default/Crashpad',
  'GrShaderCache',
  'ShaderCache',
  'DawnCache',
  'Crashpad',
  'Crash Reports'
];

const AGGRESSIVE_DIRS_TO_DELETE = [
  'blob_storage',
  'File System'
];

const EXACT_FILES_TO_DELETE = new Set([
  'SingletonLock',
  'SingletonCookie',
  'SingletonSocket',
  'DevToolsActivePort',
  'last_cache_clean.txt'
]);

const FILE_SUFFIXES_TO_DELETE = ['.sock', '.socket', '.dmp'];
const MAX_SCAN_DEPTH = 3;

if (showHelp) {
  console.log(`用法:
  node scripts/clean-browser-profiles.js [目录] [--dry-run] [--aggressive]

说明:
  - 默认清理 /app/puppeteer_user_data 下的浏览器缓存、锁文件、崩溃文件
  - 默认保留 Cookies、Network、Local Storage、Session Storage、IndexedDB 等登录态数据
  - --dry-run 只显示将删除的内容，不实际删除
  - --aggressive 额外删除 blob_storage 和 File System（更彻底，但站点本地缓存会丢失）
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
  dirsDeleted: 0,
  filesDeleted: 0,
  skipped: 0,
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

function removeEntry(targetPath, type) {
  if (!exists(targetPath)) {
    summary.skipped += 1;
    return;
  }

  try {
    if (!dryRun) {
      if (type === 'dir') {
        fs.rmSync(targetPath, { recursive: true, force: true });
      } else {
        fs.unlinkSync(targetPath);
      }
    }

    if (type === 'dir') {
      summary.dirsDeleted += 1;
      console.log(`${dryRun ? '📝 将删除目录' : '✅ 已删除目录'}: ${rel(targetPath)}`);
    } else {
      summary.filesDeleted += 1;
      console.log(`${dryRun ? '📝 将删除文件' : '✅ 已删除文件'}: ${rel(targetPath)}`);
    }
  } catch (error) {
    summary.failed += 1;
    console.warn(`⚠️ 删除失败: ${rel(targetPath)} -> ${error.message}`);
  }
}

function cleanBrowserRoot(rootDir) {
  console.log(`\n🔍 清理浏览器目录: ${rel(rootDir)}`);

  const dirsToDelete = aggressive
    ? SAFE_DIRS_TO_DELETE.concat(AGGRESSIVE_DIRS_TO_DELETE)
    : SAFE_DIRS_TO_DELETE;

  for (const relativePath of dirsToDelete) {
    removeEntry(path.join(rootDir, relativePath), 'dir');
  }

  const scanDirs = [rootDir, path.join(rootDir, 'Default')];
  for (const scanDir of scanDirs) {
    if (!exists(scanDir)) continue;
    const entries = safeReadDir(scanDir);
    for (const entry of entries) {
      const entryPath = path.join(scanDir, entry.name);
      const shouldDeleteFile =
        entry.isFile() && (
          EXACT_FILES_TO_DELETE.has(entry.name) ||
          entry.name.includes('DevToolsActivePort') ||
          FILE_SUFFIXES_TO_DELETE.some(suffix => entry.name.endsWith(suffix))
        );

      if (shouldDeleteFile) {
        removeEntry(entryPath, 'file');
      }
    }
  }
}

console.log(`开始清理浏览器缓存目录: ${baseDir}`);
console.log(`模式: ${dryRun ? '预览' : '执行'}${aggressive ? ' + 深度清理' : ' + 安全清理'}`);
console.log('保留项: Cookies / Network / Local Storage / Session Storage / IndexedDB / Preferences');

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
console.log(`删除目录: ${summary.dirsDeleted}`);
console.log(`删除文件: ${summary.filesDeleted}`);
console.log(`跳过不存在: ${summary.skipped}`);
console.log(`失败次数: ${summary.failed}`);

if (!dryRun) {
  console.log('\n建议在浏览器完全关闭后执行，效果最好。');
}
