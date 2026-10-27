#!/usr/bin/env node
/**
 * 仓库静态校验：Manifest 引用、图标尺寸、README 本地图片链接等。
 * 供本地和 GitHub Actions 的 static job 使用。
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const errors = [];
let checks = 0;

function fail(message) {
  errors.push(message);
}

function check(condition, message) {
  checks += 1;
  if (!condition) fail(message);
}

function fileExists(relativePath) {
  return fs.existsSync(path.join(ROOT, relativePath)) && fs.statSync(path.join(ROOT, relativePath)).isFile();
}

function readPngSize(relativePath) {
  const buffer = fs.readFileSync(path.join(ROOT, relativePath));
  if (buffer.toString('ascii', 1, 4) !== 'PNG') return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

/* ---------------------------------- Manifest ---------------------------------- */

const manifestRelative = 'extension/manifest.json';
let manifest = null;
try {
  manifest = JSON.parse(fs.readFileSync(path.join(ROOT, manifestRelative), 'utf8'));
} catch (error) {
  fail(`${manifestRelative} 解析失败：${error.message}`);
}

if (manifest) {
  check(manifest.manifest_version === 3, 'manifest_version 必须为 3');
  check(typeof manifest.name === 'string' && manifest.name.length > 0, '缺少 name');
  check(typeof manifest.version === 'string' && /^\d+\.\d+\.\d+/.test(manifest.version), 'version 需为 x.y.z 格式');
  check(typeof manifest.description === 'string' && manifest.description.length > 0, '缺少 description');

  const permissions = new Set(manifest.permissions || []);
  for (const required of ['activeTab', 'scripting', 'downloads', 'offscreen']) {
    check(permissions.has(required), `permissions 缺少 ${required}`);
  }

  const action = manifest.action || {};
  check(typeof action.default_popup === 'string', 'action.default_popup 缺失');
  check(typeof (manifest.background || {}).service_worker === 'string', 'background.service_worker 缺失');

  const referencedFiles = new Set();
  if (action.default_popup) referencedFiles.add(action.default_popup);
  if ((manifest.background || {}).service_worker) referencedFiles.add(manifest.background.service_worker);

  const iconSets = [manifest.icons || {}, action.default_icon || {}];
  for (const iconSet of iconSets) {
    for (const [size, iconPath] of Object.entries(iconSet)) {
      referencedFiles.add(iconPath);
      if (!fileExists(`extension/${iconPath}`)) {
        fail(`图标文件缺失：extension/${iconPath}`);
        continue;
      }
      const png = readPngSize(`extension/${iconPath}`);
      if (!png) {
        fail(`图标不是合法 PNG：extension/${iconPath}`);
      } else if (png.width !== Number(size) || png.height !== Number(size)) {
        fail(`图标尺寸不符：extension/${iconPath} 为 ${png.width}x${png.height}，期望 ${size}x${size}`);
      }
    }
  }

  // 扩展运行时会加载的固定文件
  for (const requiredFile of ['popup.html', 'popup.css', 'popup.js', 'page-agent.js', 'offscreen.html', 'offscreen.js']) {
    referencedFiles.add(requiredFile);
  }
  for (const relativePath of referencedFiles) {
    check(fileExists(`extension/${relativePath}`), `扩展文件缺失：extension/${relativePath}`);
  }

  for (const jsFile of fs.readdirSync(path.join(ROOT, 'extension')).filter((name) => name.endsWith('.js'))) {
    check(fs.statSync(path.join(ROOT, 'extension', jsFile)).size > 0, `扩展脚本为空：extension/${jsFile}`);
  }
}

/* ---------------------------------- README ---------------------------------- */

const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
const localImages = [...readme.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)]
  .map((match) => match[1].replace(/^<|>$/g, ''))
  .filter((target) => !/^https?:\/\//i.test(target));
for (const image of localImages) {
  check(fileExists(image), `README 本地图片不存在：${image}`);
}
check(readme.includes('MIT'), 'README 应注明 MIT 协议');

/* ---------------------------------- 结果 ---------------------------------- */

if (errors.length > 0) {
  console.error(`校验失败（${errors.length} 个问题）：`);
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}

console.log(`静态校验通过（${checks} 项检查）`);
