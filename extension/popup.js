/** 一键滚动长截图 —— 弹窗逻辑（只有一个「截屏」按钮） */
'use strict';

const button = document.getElementById('capture');
const buttonLabel = button.querySelector('.btn-label');
const statusEl = document.getElementById('status');
const statusText = document.getElementById('statusText');
const statusPercent = document.getElementById('statusPercent');
const progressBar = document.getElementById('progressBar');

let busy = false;

function showStatus(text, percent) {
  statusEl.hidden = false;
  statusEl.classList.remove('is-done', 'is-error', 'is-warn');
  statusText.textContent = text;
  statusPercent.textContent = typeof percent === 'number' ? `${percent}%` : '';
  progressBar.style.width = typeof percent === 'number' ? `${Math.max(2, Math.min(100, percent))}%` : '0%';
}

function setBusy(value, text, percent) {
  busy = value;
  button.disabled = value;
  button.classList.toggle('busy', value);
  buttonLabel.textContent = value ? '截屏中' : '截屏';
  if (text) showStatus(text, percent);
}

function showDone(meta) {
  busy = false;
  button.disabled = false;
  button.classList.remove('busy');
  buttonLabel.textContent = '截屏';

  statusEl.hidden = false;
  statusEl.classList.remove('is-error', 'is-warn');
  statusEl.classList.add('is-done');
  const size = formatBytes(meta.bytes);
  const dims = meta.width && meta.height ? `${meta.width} × ${meta.height}` : '';
  const parts = [meta.fallback ? '已保存当前屏幕截图' : '已保存到下载目录'];
  if (dims) parts.push(dims);
  if (size) parts.push(size);
  statusText.textContent = parts.join(' · ');
  statusPercent.textContent = '✓';
  progressBar.style.width = '100%';
}

function showError(message) {
  busy = false;
  button.disabled = false;
  button.classList.remove('busy');
  buttonLabel.textContent = '截屏';

  statusEl.hidden = false;
  statusEl.classList.remove('is-done', 'is-warn');
  statusEl.classList.add('is-error');
  statusText.textContent = message || '截屏失败，请重试';
  statusPercent.textContent = '';
}

function formatBytes(bytes) {
  const value = Number(bytes);
  if (!value || !isFinite(value) || value <= 0) return '';
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(0)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

button.addEventListener('click', async () => {
  if (busy) return;

  let tab = null;
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    tab = tabs && tabs[0];
  } catch (_) {
    tab = null;
  }

  if (!tab || typeof tab.id !== 'number') {
    showError('没有找到当前标签页，请刷新后重试');
    return;
  }

  setBusy(true, '正在启动…');

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'START_CAPTURE',
      tabId: tab.id,
      tabUrl: tab.url,
    });
    if (!response || !response.ok) {
      showError((response && response.error) || '启动截屏失败，请重试');
    }
  } catch (_) {
    showError('启动截屏失败，请刷新页面后重试');
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (!message || message.type !== 'LONG_SHOT_STATUS') return;

  switch (message.state) {
    case 'preparing':
      setBusy(true, '正在准备页面…');
      break;
    case 'capturing': {
      const percent = typeof message.percent === 'number' ? message.percent : 0;
      setBusy(true, `正在截屏 ${message.current}/${message.total}`, percent);
      break;
    }
    case 'stitching':
      setBusy(true, '正在拼接长图…', 99);
      break;
    case 'saving':
      setBusy(true, '正在保存长图…', 100);
      break;
    case 'done':
      showDone(message);
      break;
    case 'error':
      showError(message.error);
      break;
    default:
      break;
  }
});

// 弹窗重新打开时，如果后台仍在截图，同步一下进度
(async () => {
  try {
    const status = await chrome.runtime.sendMessage({ type: 'GET_STATUS' });
    if (status && status.busy) {
      await sleep(80);
      setBusy(true, '正在截屏…');
    }
  } catch (_) {
    /* ignore */
  }
})();
