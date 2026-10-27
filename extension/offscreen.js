/**
 * 一键滚动长截图 —— 离屏文档：负责把逐屏画面拼接成一张长图。
 *
 * 画布尺寸有上限（高度约 32767px、总面积约 2.68 亿像素），
 * 超出时会自动等比缩小，保证超长页面也能导出。
 */
'use strict';

const MAX_OUT_HEIGHT = 30000;
const MAX_OUT_AREA = 90000000;

let capture = null;
let lastObjectUrl = null;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.target !== 'offscreen' || typeof message.type !== 'string') return;
  handle(message).then(
    (result) => sendResponse(result || { ok: true }),
    (error) => sendResponse({ ok: false, error: String((error && error.message) || error) })
  );
  return true;
});

async function handle(message) {
  switch (message.type) {
    case 'OFFSCREEN_PING':
      return { ok: true };
    case 'OFFSCREEN_INIT':
      initCapture(message);
      return { ok: true };
    case 'OFFSCREEN_FRAME':
      return addFrame(message);
    case 'OFFSCREEN_FINISH':
      return finishCapture();
    case 'OFFSCREEN_REVOKE':
      revokeUrl(message.url);
      return { ok: true };
    default:
      return { ok: false, error: '未知指令：' + message.type };
  }
}

function initCapture(message) {
  capture = {
    mode: message.mode === 'viewport' ? 'viewport' : 'stitch',
    pageHeightCss: Math.max(1, Number(message.pageHeightCss) || 1),
    viewportWidthCss: Math.max(1, Number(message.viewportWidthCss) || 1),
    dpr: Number(message.dpr) || 1,
    ratio: null,
    scale: null,
    outW: 0,
    canvas: null,
    ctx: null,
    usedBottom: 0,
    drawnBottom: 0,
    frames: 0,
  };
}

function computeScale(ratio, viewportWidthCss, pageHeightCss) {
  let scale = Math.min(ratio, MAX_OUT_HEIGHT / Math.max(1, pageHeightCss));
  const areaScale = Math.sqrt(MAX_OUT_AREA / Math.max(1, viewportWidthCss * pageHeightCss));
  scale = Math.min(scale, areaScale);
  if (!isFinite(scale) || scale <= 0) scale = ratio;
  return Math.max(0.02, Math.min(scale, 4));
}

function createCanvas(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建画布，页面可能过长');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  return { canvas, ctx };
}

function ensureHeight(requiredCssHeight) {
  const c = capture;
  if (!c || !c.scale) return;
  const wanted = Math.min(MAX_OUT_HEIGHT, Math.max(1, Math.ceil(requiredCssHeight * c.scale)));
  if (c.canvas && c.canvas.height >= wanted) return;

  const next = createCanvas(c.outW, wanted);
  if (c.canvas) next.ctx.drawImage(c.canvas, 0, 0);
  c.canvas = next.canvas;
  c.ctx = next.ctx;
}

async function addFrame(message) {
  if (!capture) throw new Error('拼接器尚未初始化');
  const c = capture;
  let bitmap = null;

  try {
    const response = await fetch(message.dataUrl);
    const blob = await response.blob();
    bitmap = await createImageBitmap(blob);

    // 普通截图模式：页面无法注入脚本时，直接保存当前可视区域
    if (c.mode === 'viewport') {
      if (!c.canvas) {
        const created = createCanvas(bitmap.width, bitmap.height);
        c.canvas = created.canvas;
        c.ctx = created.ctx;
        c.ratio = 1;
        c.scale = 1;
        c.outW = bitmap.width;
        c.pageHeightCss = bitmap.height;
      }
      c.ctx.drawImage(bitmap, 0, 0);
      c.usedBottom = c.canvas.height;
      c.frames += 1;
      return { ok: true, frames: c.frames, width: c.canvas.width, height: c.canvas.height };
    }

    if (!c.canvas) {
      c.ratio = bitmap.width / c.viewportWidthCss;
      if (!isFinite(c.ratio) || c.ratio <= 0) c.ratio = c.dpr || 1;

      c.pageHeightCss = Math.max(c.pageHeightCss, Number(message.pageHeightCss) || 0);
      c.scale = computeScale(c.ratio, c.viewportWidthCss, c.pageHeightCss);
      c.outW = Math.max(1, Math.round((bitmap.width * c.scale) / c.ratio));
      const outHeight = Math.min(
        MAX_OUT_HEIGHT,
        Math.max(1, Math.round(c.pageHeightCss * c.scale))
      );
      const created = createCanvas(c.outW, outHeight);
      c.canvas = created.canvas;
      c.ctx = created.ctx;
    }

    const pageHeight = Math.max(c.pageHeightCss, Number(message.pageHeightCss) || 0);
    if (pageHeight > c.pageHeightCss) {
      c.pageHeightCss = pageHeight;
      ensureHeight(pageHeight);
    }

    // 输出像素 / 输入像素 的缩放比。
    // 常规情况（未超过画布上限）scale === ratio，可以 1:1 直接拷贝，避免重采样导致发虚/错位。
    const pixelScale = c.scale / c.ratio;
    const oneToOne = Math.abs(pixelScale - 1) < 1e-6;
    const destWidth = oneToOne
      ? bitmap.width
      : Math.max(1, Math.ceil(bitmap.width * pixelScale));
    let destHeight = oneToOne
      ? bitmap.height
      : Math.max(1, Math.ceil(bitmap.height * pixelScale));
    const destY = oneToOne
      ? Math.max(0, Math.round((Number(message.scrollY) || 0) * c.ratio))
      : Math.max(0, Math.round((Number(message.scrollY) || 0) * c.scale));

    // 正常情况下相邻帧是首尾相接的；万一取整产生 1px 缝隙，向下补足，避免出现白线
    if (destY > c.drawnBottom) destHeight += destY - c.drawnBottom;

    c.ctx.drawImage(bitmap, 0, destY, destWidth, destHeight);

    c.drawnBottom = destY + destHeight;
    c.usedBottom = Math.max(c.usedBottom, Math.min(c.canvas.height, c.drawnBottom));
    c.frames += 1;

    return { ok: true, frames: c.frames, width: c.canvas.width, height: c.canvas.height };
  } finally {
    if (bitmap) {
      try {
        bitmap.close();
      } catch (_) {
        /* ignore */
      }
    }
  }
}

async function finishCapture() {
  const c = capture;
  if (!c || !c.canvas) throw new Error('没有截取到任何画面');

  let canvas = c.canvas;
  const contentHeight = Math.max(1, Math.min(canvas.height, Math.round(c.usedBottom)));
  if (contentHeight < canvas.height - 1) {
    const cropped = document.createElement('canvas');
    cropped.width = canvas.width;
    cropped.height = contentHeight;
    const ctx = cropped.getContext('2d');
    if (!ctx) throw new Error('无法生成图片');
    ctx.drawImage(canvas, 0, 0, canvas.width, contentHeight, 0, 0, canvas.width, contentHeight);
    canvas = cropped;
  }

  const blob = await new Promise((resolve, reject) => {
    try {
      canvas.toBlob((result) => {
        if (result) resolve(result);
        else reject(new Error('图片编码失败，页面可能过长'));
      }, 'image/png');
    } catch (error) {
      reject(new Error('图片编码失败：' + String((error && error.message) || error)));
    }
  });

  const url = URL.createObjectURL(blob);
  lastObjectUrl = url;
  const result = {
    ok: true,
    url,
    width: canvas.width,
    height: canvas.height,
    bytes: blob.size,
    frames: c.frames,
    scale: c.scale,
  };
  capture = null;
  return result;
}

function revokeUrl(url) {
  if (!url) return;
  if (url === lastObjectUrl) lastObjectUrl = null;
  try {
    URL.revokeObjectURL(url);
  } catch (_) {
    /* ignore */
  }
}
