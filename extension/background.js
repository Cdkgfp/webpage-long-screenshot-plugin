/**
 * 一键滚动长截图 —— 后台逻辑
 *
 * 流程：
 *   1. 注入页面代理（page-agent.js），隐藏滚动条 / 固定元素，滚到顶部；
 *   2. 逐屏滚动，用 chrome.tabs.captureVisibleTab 截取画面；
 *   3. 每一帧立即交给离屏文档（offscreen.html）画到同一张画布上；
 *   4. 拼接完成后生成 PNG，用 chrome.downloads 保存到下载目录；
 *   5. 恢复页面原状，显示结果提示。
 */
'use strict';

const OFFSCREEN_PAGE = 'offscreen.html';
const PAGE_AGENT = 'page-agent.js';

/**
 * 截图期间注入页面的样式。
 * 用 chrome.scripting.insertCSS 注入，不受页面自身 CSP 限制；
 * 隐藏滚动条避免右侧出现重复的滚动条，隐藏被标记的 fixed / 吸顶元素避免长图重复。
 */
const CAPTURE_CSS = [
  'html, body { scrollbar-width: none !important; }',
  'html::-webkit-scrollbar, body::-webkit-scrollbar,',
  '*::-webkit-scrollbar {',
  '  display: none !important;',
  '  width: 0 !important;',
  '  height: 0 !important;',
  '  background: transparent !important;',
  '}',
  'html { scroll-behavior: auto !important; }',
  '[data-dsh-ls-hide] { visibility: hidden !important; }',
].join('\n');

/** captureVisibleTab 有「每秒最多 2 次」的配额，这里留足余量 */
const CAPTURE_INTERVAL_MS = 650;
/** 最多截取多少屏，避免无限滚动页面卡死 */
const MAX_FRAMES = 60;
/** 最多截取多高的页面（CSS 像素） */
const MAX_CSS_HEIGHT = 60000;
const BADGE_SUCCESS_MS = 6000;
const BADGE_ERROR_MS = 12000;

let activeJob = null;
let creatingOffscreen = null;
let lastCaptureAt = 0;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function log(...args) {
  try {
    console.log('[滚动长截图]', ...args);
  } catch (_) {
    /* ignore */
  }
}

function broadcast(message) {
  try {
    const promise = chrome.runtime.sendMessage(message);
    if (promise && typeof promise.catch === 'function') promise.catch(() => {});
  } catch (_) {
    /* popup 未打开时忽略 */
  }
}

async function setBadge(tabId, text, color, title) {
  try {
    if (text !== null && text !== undefined) {
      await chrome.action.setBadgeText({ tabId, text: String(text) });
    }
    if (color) {
      await chrome.action.setBadgeBackgroundColor({ tabId, color });
    }
    if (title) {
      await chrome.action.setTitle({ tabId, title });
    }
  } catch (_) {
    /* 标签页可能已关闭 */
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== 'object') return;

  if (message.type === 'START_CAPTURE') {
    if (activeJob) {
      sendResponse({ ok: false, error: '正在截屏中，请稍候' });
      return;
    }
    activeJob = { tabId: message.tabId, startedAt: Date.now() };
    sendResponse({ ok: true });
    runCapture(message.tabId).catch((error) => log('uncaught', error));
    return;
  }

  if (message.type === 'GET_STATUS') {
    sendResponse(activeJob ? { ok: true, busy: true, tabId: activeJob.tabId } : { ok: true, busy: false });
  }
});

async function runCapture(tabId) {
  let blobUrl = null;
  let agentInjected = false;
  let cssInjected = false;

  try {
    const tab = await chrome.tabs.get(tabId);
    const windowId = tab.windowId;

    broadcast({ type: 'LONG_SHOT_STATUS', state: 'preparing', message: '正在准备截屏…' });
    await setBadge(tabId, '…', '#2563eb', '正在准备截屏…');

    await ensureOffscreen();

    // 先尝试注入页面代理做「滚动长截图」。
    // 新标签页、浏览器内部页面、其他扩展页面等无法注入脚本，
    // 这时不直接报错，而是退化为「截取当前可视区域」的普通截图。
    let metrics = null;
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: [PAGE_AGENT] });
      agentInjected = true;

      try {
        await chrome.scripting.insertCSS({ target: { tabId }, css: CAPTURE_CSS });
        cssInjected = true;
      } catch (_) {
        cssInjected = false;
      }

      metrics = await pageCall(tabId, 'prepare');
      if (!metrics || !metrics.ok) {
        throw new Error((metrics && metrics.error) || '页面准备失败');
      }
    } catch (setupError) {
      metrics = null;
      log('页面无法注入脚本，改为截取可视区域：', setupError);
      try {
        if (agentInjected) await pageCall(tabId, 'restore');
      } catch (_) {
        /* ignore */
      }
      agentInjected = false;
      await captureViewport(tab, tabId, windowId);
      return;
    }

    log('metrics', metrics);

    await offscreenCall({
      type: 'OFFSCREEN_INIT',
      pageHeightCss: metrics.pageHeight,
      viewportWidthCss: metrics.viewportWidth,
      dpr: metrics.dpr,
    });

    const job = await captureFrames(tab, tabId, metrics, windowId);

    broadcast({ type: 'LONG_SHOT_STATUS', state: 'stitching', message: '正在拼接长图…' });
    await setBadge(tabId, '…', '#2563eb', '正在拼接长图…');
    const result = await offscreenCall({ type: 'OFFSCREEN_FINISH' });
    blobUrl = result.url;

    await pageCall(tabId, 'restore').catch(() => {});
    agentInjected = false;

    const filename = buildFilename(tab.url);
    broadcast({
      type: 'LONG_SHOT_STATUS',
      state: 'saving',
      message: '正在保存…',
      width: result.width,
      height: result.height,
      frames: job.frameCount,
    });
    await saveImage(result.url, filename);

    broadcast({
      type: 'LONG_SHOT_STATUS',
      state: 'done',
      filename,
      width: result.width,
      height: result.height,
      bytes: result.bytes,
      frames: job.frameCount,
      truncated: job.truncated,
    });
    await setBadge(tabId, '✓', '#16a34a', '长截图已保存');
    setTimeout(() => setBadge(tabId, '', null, '一键滚动长截图'), BADGE_SUCCESS_MS);
    await showPageToast(
      tabId,
      job.truncated ? `页面过长，已截取前 ${job.frameCount} 屏` : '长截图已保存到下载目录',
      job.truncated ? 'warn' : 'success'
    );
    log('done', filename, result.width, result.height, result.bytes);
  } catch (error) {
    const message = normalizeError(error);
    log('error', error);
    broadcast({ type: 'LONG_SHOT_STATUS', state: 'error', error: message });
    await setBadge(tabId, '!', '#dc2626', message);
    setTimeout(() => setBadge(tabId, '', null, '一键滚动长截图'), BADGE_ERROR_MS);
    try {
      if (agentInjected) await pageCall(tabId, 'restore');
    } catch (_) {
      /* ignore */
    }
    await showPageToast(tabId, message, 'error');
  } finally {
    if (cssInjected) {
      try {
        await chrome.scripting.removeCSS({ target: { tabId }, css: CAPTURE_CSS });
      } catch (_) {
        /* 页面可能已关闭 */
      }
    }
    if (blobUrl) await revokeBlob(blobUrl);
    try {
      await chrome.offscreen.closeDocument();
    } catch (_) {
      /* ignore */
    }
    activeJob = null;
  }
}

/**
 * 兜底：页面无法注入脚本时，只截取当前可视区域，保存为普通截图。
 */
async function captureViewport(tab, tabId, windowId) {
  await offscreenCall({ type: 'OFFSCREEN_INIT', mode: 'viewport' });

  broadcast({ type: 'LONG_SHOT_STATUS', state: 'capturing', current: 1, total: 1, percent: 60 });
  await setBadge(tabId, '…', '#2563eb', '正在截取当前屏幕…');

  const dataUrl = await captureVisible(windowId, tabId);
  await offscreenCall({ type: 'OFFSCREEN_FRAME', dataUrl, scrollY: 0 });
  const result = await offscreenCall({ type: 'OFFSCREEN_FINISH' });

  const filename = buildFilename(tab.url, '屏幕截图');
  broadcast({
    type: 'LONG_SHOT_STATUS',
    state: 'saving',
    message: '正在保存…',
    width: result.width,
    height: result.height,
    frames: 1,
  });
  await saveImage(result.url, filename);

  broadcast({
    type: 'LONG_SHOT_STATUS',
    state: 'done',
    filename,
    width: result.width,
    height: result.height,
    bytes: result.bytes,
    frames: 1,
    fallback: true,
  });
  await setBadge(tabId, '✓', '#16a34a', '屏幕截图已保存');
  setTimeout(() => setBadge(tabId, '', null, '一键滚动长截图'), BADGE_SUCCESS_MS);
  await showPageToast(tabId, '此页面无法滚动截取，已保存当前屏幕截图', 'warn');
  log('fallback done', filename, result.width, result.height, result.bytes);
}

async function captureFrames(tab, tabId, metrics, windowId) {
  let pageHeight = Math.max(Number(metrics.pageHeight) || 0, Number(metrics.viewportHeight) || 1);
  let viewportHeight = Math.max(1, Number(metrics.viewportHeight) || 1);
  let nextY = 0;
  let frameCount = 0;
  let lastY = -1;
  let lastPageHeight = pageHeight;
  let truncated = false;
  let finished = false;

  while (frameCount < MAX_FRAMES) {
    const maxScroll = Math.max(0, pageHeight - viewportHeight);
    const targetY = Math.min(Math.max(0, nextY), maxScroll);

    const position = await pageCall(tabId, 'setScroll', { y: targetY });
    if (!position || !position.ok) {
      throw new Error((position && position.error) || '页面滚动失败');
    }
    pageHeight = Math.max(pageHeight, Number(position.pageHeight) || 0);
    viewportHeight = Math.max(1, Number(position.viewportHeight) || viewportHeight);
    const actualY = Number(position.scrollY) || 0;

    // 滚动位置没有变化、页面也没有变长，说明已经到底
    if (frameCount > 0 && Math.abs(actualY - lastY) < 1 && pageHeight <= lastPageHeight + 1) {
      finished = true;
      break;
    }

    const total = Math.max(1, Math.ceil(pageHeight / viewportHeight));
    const percent = Math.min(99, Math.round((frameCount / total) * 100));
    broadcast({
      type: 'LONG_SHOT_STATUS',
      state: 'capturing',
      current: frameCount + 1,
      total,
      percent,
    });
    await setBadge(tabId, `${percent}%`, '#2563eb', `正在截屏（${frameCount + 1}/${total}）`);

    const dataUrl = await captureVisible(windowId, tabId);
    await offscreenCall({
      type: 'OFFSCREEN_FRAME',
      dataUrl,
      scrollY: actualY,
      viewportHeightCss: viewportHeight,
      pageHeightCss: pageHeight,
    });

    frameCount += 1;
    lastY = actualY;
    lastPageHeight = pageHeight;

    if (actualY + viewportHeight >= MAX_CSS_HEIGHT) {
      truncated = true;
      break;
    }

    const atBottom = actualY + viewportHeight >= pageHeight - 1;
    if (atBottom) {
      // 触底后再确认一次页高，处理图片懒加载导致的页面变长
      await sleep(180);
      const again = await pageCall(tabId, 'measure');
      const grown = again && again.ok ? Number(again.pageHeight) || pageHeight : pageHeight;
      if (grown > pageHeight + 2) {
        pageHeight = grown;
        nextY = actualY + viewportHeight;
        continue;
      }
      finished = true;
      break;
    }

    nextY = actualY + viewportHeight;
  }

  if (!finished) truncated = true;
  return { frameCount, truncated: truncated && frameCount > 0, pageHeightCss: pageHeight };
}

async function captureVisible(windowId, tabId) {
  let lastError = null;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const wait = CAPTURE_INTERVAL_MS - (Date.now() - lastCaptureAt);
    if (wait > 0) await sleep(wait);

    try {
      // 防止用户中途切走标签页，导致截到别的页面
      const [active] = await chrome.tabs.query({ active: true, windowId });
      if (!active || active.id !== tabId) {
        throw new Error('已切换标签页，截屏已取消');
      }
      lastCaptureAt = Date.now();
      return await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
    } catch (error) {
      lastError = error;
      const text = String((error && error.message) || error);
      if (/MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND|quota|too many/i.test(text) && attempt < 3) {
        await sleep(900);
        continue;
      }
      break;
    }
  }

  throw new Error('截取画面失败：' + String((lastError && lastError.message) || lastError || '未知错误'));
}

async function pageCall(tabId, method, arg) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: (name, payload) => {
      const agent = globalThis.__DSH_LONG_SHOT__;
      if (!agent) return { ok: false, error: '截图组件尚未就绪' };
      const fn = agent[name];
      if (typeof fn !== 'function') return { ok: false, error: '未知的页面操作：' + name };
      try {
        return fn(payload);
      } catch (error) {
        return { ok: false, error: String((error && error.message) || error) };
      }
    },
    args: [method, arg === undefined ? null : arg],
  });

  const first = results && results[0];
  if (!first) throw new Error('页面无响应');
  if (first.error) throw new Error(String((first.error && first.error.message) || first.error));
  return first.result;
}

async function ensureOffscreen() {
  if (!chrome.offscreen || typeof chrome.offscreen.createDocument !== 'function') {
    throw new Error('当前浏览器版本过低，不支持长截图（需要 Chromium 116 及以上）');
  }
  if (creatingOffscreen) {
    await creatingOffscreen;
    return;
  }

  creatingOffscreen = (async () => {
    let contexts = [];
    try {
      contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    } catch (_) {
      contexts = [];
    }

    if (!contexts || contexts.length === 0) {
      try {
        await chrome.offscreen.createDocument({
          url: OFFSCREEN_PAGE,
          reasons: ['BLOBS'],
          justification: '把逐屏截图拼接成一张长图，并生成可下载的图片文件',
        });
      } catch (error) {
        const text = String((error && error.message) || error);
        if (!/single offscreen|already exists|Only a single/i.test(text)) throw error;
      }
    }

    for (let i = 0; i < 30; i += 1) {
      try {
        const pong = await chrome.runtime.sendMessage({ type: 'OFFSCREEN_PING', target: 'offscreen' });
        if (pong && pong.ok) return;
      } catch (_) {
        /* 还没就绪 */
      }
      await sleep(80);
    }
    throw new Error('长图拼接模块启动失败');
  })();

  try {
    await creatingOffscreen;
  } finally {
    creatingOffscreen = null;
  }
}

async function offscreenCall(message) {
  let response;
  try {
    response = await chrome.runtime.sendMessage({ ...message, target: 'offscreen' });
  } catch (error) {
    throw new Error('长图拼接模块失去响应：' + String((error && error.message) || error));
  }
  if (!response) throw new Error('长图拼接模块无响应');
  if (!response.ok) throw new Error(response.error || '长图拼接失败');
  return response;
}

async function saveImage(blobUrl, filename) {
  let downloadId;
  try {
    downloadId = await chrome.downloads.download({
      url: blobUrl,
      filename,
      saveAs: false,
      conflictAction: 'uniquify',
    });
  } catch (error) {
    throw new Error('保存长图失败：' + String((error && error.message) || error));
  }
  if (typeof downloadId !== 'number') throw new Error('保存长图失败');

  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const [item] = await chrome.downloads.search({ id: downloadId });
    if (item) {
      if (item.state === 'complete') return item;
      if (item.state === 'interrupted') {
        throw new Error('保存长图失败：' + (item.error || '下载被中断'));
      }
    }
    await sleep(200);
  }
  throw new Error('保存长图超时');
}

async function revokeBlob(blobUrl) {
  try {
    await chrome.runtime.sendMessage({ type: 'OFFSCREEN_REVOKE', target: 'offscreen', url: blobUrl });
  } catch (_) {
    /* ignore */
  }
}

async function showPageToast(tabId, text, kind) {
  try {
    await pageCall(tabId, 'toast', { text, kind });
  } catch (_) {
    /* 页面可能已关闭或无法注入 */
  }
}

function buildFilename(url, prefix = '长截图') {
  let host = '网页';
  try {
    if (typeof url === 'string' && url.startsWith('file:')) {
      host = '本地网页';
    } else if (url) {
      host = new URL(url).hostname.replace(/^www\./i, '');
    }
  } catch (_) {
    /* ignore */
  }
  host = String(host).replace(/[\\/:*?"<>|#%&{}$!'@+`=~^[\];,]+/g, '_').slice(0, 60) || '网页';

  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${prefix}_${host}_${stamp}.png`;
}

function normalizeError(error) {
  const raw = String((error && error.message) || error || '未知错误');
  if (/Cannot access (contents|chrome|a chrome)|cannot be scripted|extensions gallery|The extensions gallery/i.test(raw)) {
    return '无法截取此页面（浏览器内部页面或扩展商店页面）';
  }
  if (/Missing host permission|Cannot access contents of the page/i.test(raw)) {
    return '没有权限截取此页面，请刷新页面后重试';
  }
  if (/No tab with id|Invalid tab ID|The tab was closed|Tab closed/i.test(raw)) {
    return '页面已关闭，截屏已取消';
  }
  if (/Failed to capture|not visible|cannot capture/i.test(raw)) {
    return '浏览器不允许截取此页面，请打开普通网页后重试';
  }
  return raw;
}
