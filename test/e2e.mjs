/**
 * 端到端测试：用本机 Edge（Chromium）加载扩展，打开测试页，真实触发一次截屏，
 * 等待下载完成，把生成的 PNG 复制到 test/out/ 供进一步校验。
 *
 * 运行（需要放宽沙箱，因为 Chromium 多进程 IPC 在受限沙箱中无法工作）：
 *   node test/e2e.mjs            # 先试 headless，失败自动回退到有窗口模式
 *   node test/e2e.mjs --headed   # 直接使用有窗口模式（窗口放到屏幕外）
 *
 * 只依赖 Node 内置模块（Node >= 22）。
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const EXT_SRC = path.join(ROOT, 'extension');
const TEST_SITE = path.join(ROOT, 'test', 'site');
const OUT_DIR = path.join(ROOT, 'test', 'out');
const TMP = path.join(ROOT, '.tmp');
const WORK_EXT = path.join(TMP, 'e2e-ext');
const WORK_EXT_FALLBACK = path.join(TMP, 'e2e-ext-fallback');
const PROFILE_BASE = path.join(TMP, 'e2e-profile');
const DOWNLOADS = path.join(TMP, 'e2e-downloads');
const EDGE_LOG = path.join(TMP, 'edge-e2e.log');
const DEBUG_PORT = 9411;
const FORCE_HEADED = process.argv.includes('--headed');

const CASES_NORMAL = [
  { name: 'index', file: 'index.html', kind: 'blocks', waitMs: 600 },
  { name: 'grow', file: 'grow.html', kind: 'grow', waitMs: 600 },
  { name: 'short', file: 'short.html', kind: 'short', waitMs: 400 },
  { name: 'sandbox', file: 'sandbox.html', kind: 'csp', waitMs: 400 },
  { name: 'transient', file: 'transient.html', kind: 'transient', waitMs: 500 },
];

const CASES_FALLBACK = [
  { name: 'fallback', file: 'fallback.html', kind: 'fallback', waitMs: 400 },
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function log(...args) {
  console.log('[e2e]', ...args);
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------ 静态站点服务 ------------------------------ */

function startServer() {
  const mime = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
  };
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
      const relative = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
      const file = path.join(TEST_SITE, relative);
      if (!file.startsWith(TEST_SITE) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      res.writeHead(200, {
        'content-type': mime[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'cache-control': 'no-store',
        ...(relative === 'sandbox.html' ? { 'content-security-policy': 'sandbox' } : {}),
      });
      res.end(fs.readFileSync(file));
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port, base: `http://127.0.0.1:${port}` });
    });
  });
}

/* --------------------------------- CDP --------------------------------- */

class CDP {
  constructor(url) {
    this.url = url;
    this.id = 0;
    this.pending = new Map();
    this.ws = null;
  }

  async connect() {
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      ws.addEventListener('open', () => resolve(), { once: true });
      ws.addEventListener('error', (event) => reject(new Error('CDP websocket error: ' + String(event.message || event))), {
        once: true,
      });
      ws.addEventListener('message', (event) => {
        let message;
        try {
          message = JSON.parse(String(event.data));
        } catch {
          return;
        }
        if (message.id && this.pending.has(message.id)) {
          const { resolve: ok, reject: fail } = this.pending.get(message.id);
          this.pending.delete(message.id);
          if (message.error) fail(new Error(JSON.stringify(message.error)));
          else ok(message.result);
        }
      });
    });
  }

  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
    });
  }

  async close() {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

async function fetchJson(url, timeoutMs = 2000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function waitForBrowser(port) {
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    try {
      const version = await fetchJson(`http://127.0.0.1:${port}/json/version`);
      if (version && version.webSocketDebuggerUrl) return version;
    } catch {
      /* not ready */
    }
    await sleep(400);
  }
  throw new Error('浏览器调试端口未就绪');
}

async function attach(cdp, targetId) {
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Runtime.enable', {}, sessionId);
  return sessionId;
}

async function evaluate(cdp, sessionId, expression, options = {}) {
  const result = await cdp.send(
    'Runtime.evaluate',
    {
      expression,
      awaitPromise: options.awaitPromise !== false,
      returnByValue: true,
    },
    sessionId
  );
  if (result.exceptionDetails) {
    const details = result.exceptionDetails;
    const text = (details.exception && details.exception.description) || details.text || 'evaluate error';
    throw new Error(text);
  }
  return result.result ? result.result.value : undefined;
}

async function waitForDocument(cdp, sessionId, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const state = await evaluate(cdp, sessionId, 'document.readyState', { awaitPromise: false });
      if (state === 'complete') return;
    } catch {
      /* page might still be creating */
    }
    await sleep(200);
  }
  throw new Error('页面加载超时');
}

/* ------------------------------ 测试扩展构建 ------------------------------ */

function rmrf(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

function buildTestExtension(dir = WORK_EXT, options = {}) {
  rmrf(dir);
  fs.cpSync(EXT_SRC, dir, { recursive: true });
  const manifestPath = path.join(dir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  // 真实版本使用 activeTab；测试里用 host_permissions 以便脚本直接触发，
  // 另外加 tabs 权限，方便在测试脚本里按 URL 找到目标标签页
  manifest.host_permissions = ['<all_urls>'];
  manifest.permissions = [...new Set([...(manifest.permissions || []), 'tabs'])];
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  if (options.breakAgent) {
    // 故意让页面代理注入失败，用来稳定触发「退化为可视区域截图」的分支
    fs.writeFileSync(
      path.join(dir, 'page-agent.js'),
      "throw new Error('e2e: page agent disabled on purpose');\n"
    );
  }
  log('测试扩展已生成', dir);
}

function prepareProfile(dir) {
  rmrf(dir);
  fs.mkdirSync(path.join(dir, 'Default'), { recursive: true });
  fs.mkdirSync(DOWNLOADS, { recursive: true });
  const prefs = {
    download: {
      default_directory: DOWNLOADS,
      prompt_for_download: false,
      directory_upgrade: true,
    },
    savefile: { default_directory: DOWNLOADS },
    profile: { exit_type: 'Normal', exited_cleanly: true },
  };
  fs.writeFileSync(path.join(dir, 'Default', 'Preferences'), JSON.stringify(prefs));
  log('测试 profile 已生成：', dir);
}



/* -------------------------------- 启动浏览器 -------------------------------- */

async function launchBrowser(mode, extensionDir = WORK_EXT, port = DEBUG_PORT) {
  const headless = mode === 'headless';
  const tag = path.basename(extensionDir);
  const profile = `${PROFILE_BASE}-${tag}-${mode}`;
  prepareProfile(profile);
  const logFile = fs.openSync(EDGE_LOG, 'a');
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    `--disable-extensions-except=${extensionDir}`,
    `--load-extension=${extensionDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-default-apps',
    '--disable-session-crashed-bubble',
    '--hide-crash-restore-bubble',
    '--mute-audio',
    '--password-store=basic',
    '--window-size=1280,900',
    '--force-device-scale-factor=1',
    '--disable-features=Translate,MediaRouter,CalculateNativeWinOcclusion',
    headless ? '--headless' : '--window-position=-32000,-32000',
    ...(headless ? ['--disable-gpu'] : ['--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding']),
    'about:blank',
  ];
  log(`启动 Edge（${mode}）`);
  const child = spawn(EDGE, args, { cwd: ROOT, stdio: ['ignore', logFile, logFile], windowsHide: true });
  child.on('exit', (code) => log(`Edge 退出 code=${code}`));

  let cdp = null;
  try {
    const version = await waitForBrowser(port);
    cdp = new CDP(version.webSocketDebuggerUrl);
    await cdp.connect();
    log('CDP 已连接：', version.Browser);
    return { child, cdp, mode, profile, port };
  } catch (error) {
    if (cdp) await cdp.close();
    killTree(child.pid);
    for (let i = 0; i < 20 && alive(child.pid); i += 1) await sleep(200);
    throw error;
  }
}

function readExtensionIdFromProfile(profileDir, extensionDir = WORK_EXT) {
  const workPath = path.resolve(extensionDir).toLowerCase();
  for (const fileName of ['Secure Preferences', 'Preferences']) {
    try {
      const raw = fs.readFileSync(path.join(profileDir, 'Default', fileName), 'utf8');
      const parsed = JSON.parse(raw);
      const settings = parsed && parsed.extensions && parsed.extensions.settings;
      if (!settings) continue;
      for (const [id, value] of Object.entries(settings)) {
        const extensionPath = value && value.path;
        if (typeof extensionPath === 'string' && path.resolve(extensionPath).toLowerCase() === workPath) {
          return id;
        }
      }
    } catch {
      /* 文件可能还没写入 */
    }
  }
  return null;
}

async function discoverExtension(cdp, profileDir, extensionDir = WORK_EXT) {
  const tried = new Set();
  const deadline = Date.now() + 25000;
  let candidates = [];

  while (Date.now() < deadline) {
    const ids = new Set();
    const fromProfile = readExtensionIdFromProfile(profileDir, extensionDir);
    if (fromProfile) ids.add(fromProfile);
    try {
      const { targetInfos } = await cdp.send('Target.getTargets');
      for (const target of targetInfos) {
        const match = /^chrome-extension:\/\/([a-p]{32})\//.exec(target.url || '');
        if (match) ids.add(match[1]);
      }
    } catch {
      /* ignore */
    }
    candidates = [...ids];
    const ordered = fromProfile ? [fromProfile, ...candidates.filter((id) => id !== fromProfile)] : candidates;
    for (const id of ordered) {
      if (tried.has(id)) continue;
      tried.add(id);
      const page = await tryOpenExtensionPage(cdp, id);
      if (page) {
        log('确认扩展 ID：', id);
        return page;
      }
    }
    await sleep(500);
  }

  throw new Error('无法定位已加载的扩展页面（候选：' + candidates.join(', ') + '）');
}

async function tryOpenExtensionPage(cdp, id) {
  let targetId = null;
  try {
    ({ targetId } = await cdp.send('Target.createTarget', {
      url: `chrome-extension://${id}/popup.html`,
      newWindow: false,
      background: false,
    }));
  } catch {
    return null;
  }

  try {
    const sessionId = await attach(cdp, targetId);
    await waitForDocument(cdp, sessionId, 8000);
    const info = await evaluate(
      cdp,
      sessionId,
      `({ id: (chrome.runtime && chrome.runtime.id) || '', title: document.title || '', ready: !!document.getElementById('capture') })`,
      { awaitPromise: false }
    );
    if (info && info.id === id && (info.ready || String(info.title).includes('滚动长截图'))) {
      return { id, targetId, sessionId };
    }
  } catch {
    /* 不是我们的扩展 */
  }
  if (targetId) await cdp.send('Target.closeTarget', { targetId }).catch(() => {});
  return null;
}

function killTree(pid) {
  if (!pid) return;
  try {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  } catch {
    try {
      process.kill(pid);
    } catch {
      /* ignore */
    }
  }
}

/* -------------------------------- 单页测试 -------------------------------- */

async function capturePage({ cdp, extensionPageSession, base, testCase, index }) {
  const url = `${base}/${testCase.file}`;
  log(`\n=== 用例 ${testCase.name}: ${url} ===`);

  const { targetId } = await cdp.send('Target.createTarget', { url, newWindow: false, background: false });
  const sessionId = await attach(cdp, targetId);
  await waitForDocument(cdp, sessionId);
  await sleep(testCase.waitMs);

  const metrics = await evaluate(
    cdp,
    sessionId,
    `(() => {
      const scrollHeight = Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0);
      return {
        dpr: window.devicePixelRatio,
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        scrollHeight,
        readyState: document.readyState,
        fixedHeader: !!document.querySelector('.fixed-header'),
        bands: document.querySelectorAll('.band').length,
      };
    })()`,
    { awaitPromise: false }
  );
  log('页面指标', metrics);

  const trigger = `(async () => {
    window.__e2e = { statuses: [], done: null, error: null };
    chrome.runtime.onMessage.addListener((message) => {
      if (!message || message.type !== 'LONG_SHOT_STATUS') return;
      window.__e2e.statuses.push({
        state: message.state,
        current: message.current,
        total: message.total,
        percent: message.percent,
      });
      if (message.state === 'done') window.__e2e.done = {
        filename: message.filename,
        width: message.width,
        height: message.height,
        bytes: message.bytes,
        frames: message.frames,
        fallback: !!message.fallback,
        truncated: !!message.truncated,
      };
      if (message.state === 'error') window.__e2e.error = message.error;
    });
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((item) => (item.url || '').includes(${JSON.stringify(testCase.file)}));
    if (!tab) return { ok: false, error: '未找到测试标签页', urls: tabs.map((item) => item.url) };
    await chrome.tabs.update(tab.id, { active: true });
    await new Promise((resolve) => setTimeout(resolve, 500));
    const response = await chrome.runtime.sendMessage({ type: 'START_CAPTURE', tabId: tab.id, tabUrl: tab.url });
    return { ok: true, response, tabId: tab.id };
  })()`;
  const started = await evaluate(cdp, extensionPageSession, trigger);
  if (!started || !started.ok) throw new Error('触发截屏失败：' + JSON.stringify(started));
  if (!started.response || !started.response.ok) throw new Error('后台拒绝截屏：' + JSON.stringify(started));

  const deadline = Date.now() + 180000;
  let state = null;
  while (Date.now() < deadline) {
    await sleep(500);
    state = await evaluate(
      cdp,
      extensionPageSession,
      `JSON.stringify({
        done: window.__e2e.done,
        error: window.__e2e.error,
        last: window.__e2e.statuses[window.__e2e.statuses.length - 1] || null,
        count: window.__e2e.statuses.length,
      })`,
      { awaitPromise: false }
    );
    const parsed = JSON.parse(state);
    if (parsed.done || parsed.error) break;
  }
  const parsed = JSON.parse(state || '{}');
  if (parsed.error) throw new Error('截屏失败：' + parsed.error);
  if (!parsed.done) throw new Error('截屏超时');
  if (testCase.kind === 'fallback' && !parsed.done.fallback) {
    throw new Error('期望走「可视区域截图」兜底，但实际走了滚动长截图');
  }
  if (testCase.kind !== 'fallback' && parsed.done.fallback) {
    throw new Error('不应走兜底截图，但返回了 fallback');
  }

  // 等下载完成
  const downloadInfo = await waitForDownload(cdp, extensionPageSession, parsed.done.filename);
  log('下载信息', downloadInfo);

  const targetFile = path.join(OUT_DIR, `${String(index + 1).padStart(2, '0')}-${testCase.name}.png`);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  if (downloadInfo.filename && fs.existsSync(downloadInfo.filename)) {
    fs.copyFileSync(downloadInfo.filename, targetFile);
    try {
      if (!downloadInfo.filename.startsWith(ROOT)) fs.unlinkSync(downloadInfo.filename);
    } catch {
      /* ignore */
    }
  } else {
    throw new Error('找不到下载文件：' + JSON.stringify(downloadInfo));
  }

  const png = readPngSize(targetFile);
  log('PNG 尺寸', png, '文件', targetFile);

  await cdp.send('Target.closeTarget', { targetId }).catch(() => {});
  return {
    case: testCase.name,
    kind: testCase.kind,
    url,
    metrics,
    status: parsed.done,
    download: downloadInfo,
    png,
    file: targetFile,
  };
}

async function waitForDownload(cdp, sessionId, expectedName) {
  const deadline = Date.now() + 40000;
  while (Date.now() < deadline) {
    const raw = await evaluate(
      cdp,
      sessionId,
      `(async () => {
        const items = await chrome.downloads.search({ orderBy: ['-startTime'], limit: 10 });
        return JSON.stringify(items.map((item) => ({
          id: item.id,
          state: item.state,
          filename: item.filename,
          bytes: item.bytesReceived,
          error: item.error,
          byExtension: item.byExtensionId || '',
        })));
      })()`
    );
    const items = JSON.parse(raw || '[]');
    const match = items.find((item) => /(长截图|屏幕截图)/.test(item.filename || '')) || items[0];
    if (match && match.state === 'complete') return match;
    if (match && match.state === 'interrupted') throw new Error('下载被中断：' + (match.error || 'unknown'));
    if (match && match.filename && fs.existsSync(match.filename) && match.bytes > 0 && match.state !== 'in_progress') {
      return match;
    }
    await sleep(400);
  }
  throw new Error('等待下载超时');
}

function readPngSize(file) {
  const buffer = fs.readFileSync(file);
  if (buffer.toString('ascii', 1, 4) !== 'PNG') throw new Error('不是 PNG 文件：' + file);
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20), bytes: buffer.length };
}

async function capturePopupScreenshot(cdp, sessionId) {
  try {
    const contentHeight = await evaluate(
      cdp,
      sessionId,
      'Math.ceil(document.body.getBoundingClientRect().height) || 260',
      { awaitPromise: false }
    );
    const height = Math.min(640, Math.max(200, Number(contentHeight) + 16));
    await cdp.send(
      'Emulation.setDeviceMetricsOverride',
      { width: 320, height, deviceScaleFactor: 2, mobile: false },
      sessionId
    );
    await sleep(400);
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true }, sessionId);
    const file = path.join(OUT_DIR, '00-popup.png');
    fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
    log('弹窗 UI 截图：', file, readPngSize(file));
    await cdp.send('Emulation.clearDeviceMetricsOverride', {}, sessionId);
  } catch (error) {
    log('弹窗 UI 截图失败（不影响主流程）：', (error && error.message) || error);
  }
}

/* --------------------------------- 主流程 --------------------------------- */

async function closeBrowser(browser) {
  if (!browser) return;
  await browser.cdp.close().catch(() => {});
  killTree(browser.child.pid);
  // taskkill 不一定能带走所有子进程，再按 profile 路径兜底清理
  killByProfile(browser.profile);
  const port = browser.port || DEBUG_PORT;
  for (let i = 0; i < 25; i += 1) {
    let alivePort = false;
    try {
      const version = await fetchJson(`http://127.0.0.1:${port}/json/version`, 500);
      alivePort = !!(version && version.webSocketDebuggerUrl);
    } catch {
      alivePort = false;
    }
    if (!alivePort) return;
    if (i === 10) killByProfile(browser.profile);
    await sleep(300);
  }
  log('警告：浏览器调试端口仍被占用', port);
}

function killByProfile(profile) {
  try {
    const escaped = String(profile).replace(/'/g, "''");
    const script = [
      "Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\"",
      `| Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${escaped}') }`,
      '| ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }',
    ].join(' ');
    spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      stdio: 'ignore',
      windowsHide: true,
    });
  } catch {
    /* ignore */
  }
}

async function launchSession(extensionDir, tag, port) {
  const modes = FORCE_HEADED ? ['headed'] : ['headless', 'headed'];
  let lastError = null;
  for (const mode of modes) {
    let browser = null;
    try {
      browser = await launchBrowser(mode, extensionDir, port);
      const extensionPage = await discoverExtension(browser.cdp, browser.profile, extensionDir);
      log(`会话 ${tag} 就绪（${mode}），扩展 ID：`, extensionPage.id);
      return { browser, extensionPage };
    } catch (error) {
      lastError = error;
      log(`会话 ${tag} 模式 ${mode} 失败：`, (error && error.message) || error);
      if (browser) await closeBrowser(browser);
      await sleep(1500);
    }
  }
  throw lastError || new Error('浏览器启动失败');
}

async function runCases(session, cases, results, base, options = {}) {
  const { browser, extensionPage } = session;
  const cdp = browser.cdp;
  const extensionOk = await evaluate(
    cdp,
    extensionPage.sessionId,
    `JSON.stringify({
      extensionId: chrome.runtime.id,
      tabs: chrome.tabs ? 'tabs-ok' : 'no-tabs',
      url: location.href,
      title: document.title,
    })`
  );
  log('扩展页面信息', extensionOk);
  if (options.popupScreenshot) await capturePopupScreenshot(cdp, extensionPage.sessionId);

  for (const testCase of cases) {
    results.push(
      await capturePage({
        cdp,
        extensionPageSession: extensionPage.sessionId,
        base,
        testCase,
        index: results.length,
      })
    );
  }
}

async function main() {
  if (!fs.existsSync(EDGE)) throw new Error('找不到 Edge：' + EDGE);
  rmrf(DOWNLOADS);
  fs.mkdirSync(DOWNLOADS, { recursive: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(EDGE_LOG, '');
  const { server, base } = await startServer();
  log('测试站点：', base);

  const results = [];
  let session = null;

  try {
    // 第一轮：正常流程（滚动长截图 / CSP 页面 / 首屏浮层）
    buildTestExtension(WORK_EXT);
    session = await launchSession(WORK_EXT, 'normal', DEBUG_PORT);
    log('扩展 ID：', session.extensionPage.id, '| profile：', session.browser.profile);
    await runCases(session, CASES_NORMAL, results, base, { popupScreenshot: true });
    await closeBrowser(session.browser);
    session = null;
    await sleep(800);

    // 第二轮：页面代理被故意破坏，验证「退化为当前可视区域截图」的兜底分支
    buildTestExtension(WORK_EXT_FALLBACK, { breakAgent: true });
    session = await launchSession(WORK_EXT_FALLBACK, 'fallback', DEBUG_PORT + 1);
    await runCases(session, CASES_FALLBACK, results, base, {});
    await closeBrowser(session.browser);
    session = null;

    fs.writeFileSync(path.join(OUT_DIR, 'results.json'), JSON.stringify(results, null, 2));
    log('\n全部用例完成');
    for (const item of results) {
      console.log(
        JSON.stringify({
          case: item.case,
          image: `${item.png.width}x${item.png.height}`,
          reported: `${item.status.width}x${item.status.height}`,
          frames: item.status.frames,
          fallback: !!item.status.fallback,
          file: path.relative(ROOT, item.file),
        })
      );
    }
  } finally {
    if (session) await closeBrowser(session.browser);
    server.close();
  }

  process.exit(0);
}

main().catch((error) => {
  console.error('[e2e] 失败：', error && error.stack ? error.stack : error);
  setTimeout(() => process.exit(1), 100);
});
