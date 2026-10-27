/**
 * 一键滚动长截图 —— 页面代理（注入到当前标签页的隔离世界）
 *
 * 只负责页面侧的动作：测量、滚动、隐藏滚动条与 fixed/sticky 元素、恢复现场、提示。
 * 截图与拼接由后台 / 离屏文档完成。
 */
(() => {
  'use strict';

  const KEY = '__DSH_LONG_SHOT__';
  const VERSION = '1.0.0';
  const HIDE_ATTR = 'data-dsh-ls-hide';
  const TOAST_ID = '__dsh-ls-toast';

  const existing = globalThis[KEY];
  if (existing && existing.version === VERSION) return;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const nextFrame = () =>
    Promise.race([
      new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      sleep(400),
    ]);

  const state = {
    scrollEl: null,
    useElement: false,
    origWindowScroll: 0,
    origWindowScrollX: 0,
    origElementScroll: 0,
    sticky: [],
    frameIndex: 0,
    domSize: 0,
    prepared: false,
  };

  /* ------------------------------- 基础测量 ------------------------------- */

  function getDocEl() {
    return document.scrollingElement || document.documentElement;
  }

  function getTop() {
    if (state.useElement && state.scrollEl) return state.scrollEl.scrollTop;
    return window.scrollY || (getDocEl() ? getDocEl().scrollTop : 0) || 0;
  }

  function getViewportHeight() {
    if (state.useElement && state.scrollEl) return Math.max(1, state.scrollEl.clientHeight);
    return Math.max(1, window.innerHeight);
  }

  function getPageHeight() {
    if (state.useElement && state.scrollEl) return state.scrollEl.scrollHeight;
    const docEl = document.documentElement;
    const body = document.body;
    const docHeight = docEl ? docEl.scrollHeight : 0;
    const bodyHeight = body ? body.scrollHeight : 0;
    return Math.max(docHeight, bodyHeight, getViewportHeight());
  }

  function scrollToTop(top) {
    const y = Math.max(0, Math.round(Number(top) || 0));
    if (state.useElement && state.scrollEl) {
      const el = state.scrollEl;
      try {
        el.scrollTo({ top: y, left: el.scrollLeft, behavior: 'instant' });
      } catch (_) {
        el.scrollTop = y;
      }
      return;
    }
    try {
      window.scrollTo({ top: y, left: window.scrollX || 0, behavior: 'instant' });
    } catch (_) {
      window.scrollTo(window.scrollX || 0, y);
    }
  }

  /* --------------------------- 固定 / 吸附元素处理 --------------------------- */

  function isHtmLElement(node) {
    return node instanceof HTMLElement;
  }

  function scanFixedElements() {
    if (!document.body) return 0;
    const viewportWidth = Math.max(1, window.innerWidth);
    const viewportHeight = Math.max(1, window.innerHeight);
    const all = document.body.getElementsByTagName('*');
    let hiddenCount = 0;

    for (let i = 0; i < all.length; i += 1) {
      const el = all[i];
      if (!isHtmLElement(el) || el.hasAttribute(HIDE_ATTR)) continue;
      let computed;
      try {
        computed = getComputedStyle(el);
      } catch (_) {
        continue;
      }
      if (computed.position !== 'fixed') continue;
      if (computed.display === 'none') continue;

      const rect = el.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) continue;

      // 跳过占满视口、直接挂在 body 上的布局外壳（某些 SPA 用它撑起页面）
      const coversViewport = rect.width * rect.height > viewportWidth * viewportHeight * 0.85;
      if (coversViewport && el.parentElement === document.body) continue;

      el.setAttribute(HIDE_ATTR, '');
      hiddenCount += 1;
    }
    return hiddenCount;
  }

  /**
   * 测量元素在「正常文档流」中的位置。
   * 吸顶元素（尤其是底部吸附的评论框）在页面顶部时可能已经处于吸附状态，
   * 直接取 getBoundingClientRect 会把吸附位置当成原始位置，所以临时改成 static 再测一次。
   */
  function measureStaticTop(el) {
    const previousPosition = el.style.getPropertyValue('position');
    const previousPriority = el.style.getPropertyPriority('position');
    let top = 0;
    try {
      el.style.setProperty('position', 'static', 'important');
      top = el.getBoundingClientRect().top + getTop();
    } finally {
      if (previousPosition) el.style.setProperty('position', previousPosition, previousPriority);
      else el.style.removeProperty('position');
    }
    return top;
  }

  function collectStickyElements() {
    state.sticky = [];
    if (!document.body) return;
    const all = document.body.getElementsByTagName('*');

    for (let i = 0; i < all.length; i += 1) {
      const el = all[i];
      if (!isHtmLElement(el)) continue;
      let computed;
      try {
        computed = getComputedStyle(el);
      } catch (_) {
        continue;
      }
      if (computed.position !== 'sticky') continue;
      const rect = el.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) continue;
      state.sticky.push({ el, flowTop: measureStaticTop(el) });
    }
  }

  function updateStickyElements(top) {
    if (!state.sticky.length) return;
    for (let i = 0; i < state.sticky.length; i += 1) {
      const item = state.sticky[i];
      const el = item.el;
      if (!el.isConnected) continue;
      const rect = el.getBoundingClientRect();
      const expectedTop = item.flowTop - top;
      // 顶部吸附、底部吸附、或者被容器推着走，都会让实际位置偏离正常文档流位置。
      // 偏离时说明它正以「悬浮/吸附」形态重复出现，隐藏；回到正常位置时再显示。
      const shifted = Math.abs(rect.top - expectedTop) > 3;
      if (shifted) {
        el.setAttribute(HIDE_ATTR, '');
      } else {
        if (el.getAttribute(HIDE_ATTR) === '') el.removeAttribute(HIDE_ATTR);
        // 顺带校准，抵消懒加载图片等造成的轻微布局位移
        item.flowTop = rect.top + top;
      }
    }
  }

  function restoreHiddenElements() {
    try {
      const hidden = document.querySelectorAll(`[${HIDE_ATTR}]`);
      for (let i = 0; i < hidden.length; i += 1) hidden[i].removeAttribute(HIDE_ATTR);
    } catch (_) {
      /* ignore */
    }
  }

  /* ------------------------------- 滚动容器 ------------------------------- */

  function findScrollTarget() {
    const docEl = getDocEl();
    if (docEl && docEl.scrollHeight > docEl.clientHeight + 20) return null;

    // 页面本身不滚动时，尝试寻找内部可滚动的容器（常见于后台类应用）
    let best = null;
    let bestScore = 0;
    if (!document.body) return null;
    const all = document.body.querySelectorAll('*');
    const limit = Math.min(all.length, 40000);

    for (let i = 0; i < limit; i += 1) {
      const el = all[i];
      if (!isHtmLElement(el)) continue;
      if (el.clientHeight < window.innerHeight * 0.45) continue;
      if (el.scrollHeight - el.clientHeight < 60) continue;
      let computed;
      try {
        computed = getComputedStyle(el);
      } catch (_) {
        continue;
      }
      if (!/(auto|scroll|overlay)/.test(computed.overflowY)) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width < 60 || rect.height < 60) continue;
      const score = Math.min(el.scrollHeight, 60000) * Math.min(rect.width, 2000);
      if (score > bestScore) {
        bestScore = score;
        best = el;
      }
    }
    return best;
  }

  /* --------------------------------- 接口 --------------------------------- */

  async function prepare() {
    // 清理上一次可能残留的状态
    restoreHiddenElements();
    state.scrollEl = null;
    state.useElement = false;
    state.sticky = [];
    state.frameIndex = 0;
    state.prepared = false;

    // 滚动条隐藏、动效关闭等样式由后台通过 chrome.scripting.insertCSS 注入
    // （不受页面自身 CSP 限制），这里只需要等待样式生效
    await nextFrame();
    await sleep(50);

    state.origWindowScroll = window.scrollY || 0;
    state.origWindowScrollX = window.scrollX || 0;

    const target = findScrollTarget();
    if (target) {
      state.scrollEl = target;
      state.useElement = true;
      state.origElementScroll = target.scrollTop;
    } else {
      state.origElementScroll = 0;
    }

    scrollToTop(0);
    await nextFrame();
    await sleep(60);

    // 预热滚动：先向下滚一小段再回到顶部。
    // 很多站点的「悬浮评论框 / 浮动工具条」只有在发生滚动后才会被站点自己隐藏，
    // 提前触发一次滚动，避免它们被截进首帧、残留在长图中部。
    const warmViewportHeight = getViewportHeight();
    const warmDistance = Math.min(
      Math.max(0, getPageHeight() - warmViewportHeight),
      Math.round(warmViewportHeight * 1.2)
    );
    if (warmDistance > 0) {
      scrollToTop(warmDistance);
      await nextFrame();
      await sleep(150);
      scrollToTop(0);
      await nextFrame();
      await sleep(150);
    }

    // 清掉旧标记，重新收集
    restoreHiddenElements();
    state.domSize = document.getElementsByTagName('*').length;
    scanFixedElements();
    collectStickyElements();
    updateStickyElements(0);
    await nextFrame();
    scanFixedElements();
    state.frameIndex = 0;
    state.prepared = true;

    return {
      ok: true,
      pageHeight: getPageHeight(),
      viewportHeight: getViewportHeight(),
      viewportWidth: Math.max(1, window.innerWidth),
      dpr: window.devicePixelRatio || 1,
      scrollKind: state.useElement ? 'element' : 'document',
      title: document.title || '',
      url: location.href,
    };
  }

  async function setScroll(payload) {
    const y = payload && typeof payload.y === 'number' ? payload.y : 0;
    scrollToTop(y);
    await nextFrame();
    await sleep(state.useElement ? 110 : 90);

    const top = getTop();
    state.frameIndex += 1;

    // 页面元素极多时降低全量扫描频率，避免拖慢截图；首帧无论如何都要扫一次
    const stride = state.domSize > 12000 ? 3 : state.domSize > 6000 ? 2 : 1;
    const firstFrame = state.frameIndex === 1;
    if (firstFrame || state.frameIndex % stride === 0) scanFixedElements();
    if (firstFrame) {
      // 首帧再补扫一次，兜住滚动后才渲染出来的浮层
      await nextFrame();
      await sleep(30);
      scanFixedElements();
    }
    updateStickyElements(top);

    const pageHeight = getPageHeight();
    const viewportHeight = getViewportHeight();
    return {
      ok: true,
      scrollY: top,
      pageHeight,
      viewportHeight,
      atBottom: top + viewportHeight >= pageHeight - 1,
    };
  }

  function measure() {
    return {
      ok: true,
      pageHeight: getPageHeight(),
      viewportHeight: getViewportHeight(),
      scrollY: getTop(),
    };
  }

  async function restore() {
    restoreHiddenElements();
    state.sticky = [];
    state.frameIndex = 0;
    state.prepared = false;

    try {
      if (state.useElement && state.scrollEl) {
        state.scrollEl.scrollTo({ top: state.origElementScroll || 0, behavior: 'instant' });
      } else {
        window.scrollTo({
          top: state.origWindowScroll || 0,
          left: state.origWindowScrollX || 0,
          behavior: 'instant',
        });
      }
    } catch (_) {
      /* ignore */
    }

    await nextFrame();
    state.scrollEl = null;
    state.useElement = false;
    return { ok: true };
  }

  function removeToast() {
    const current = document.getElementById(TOAST_ID);
    if (current) current.remove();
  }

  function toast(payload) {
    const text = payload && payload.text ? String(payload.text) : '';
    const kind = (payload && payload.kind) || 'success';
    if (!text || !document.body) return { ok: false };
    removeToast();

    const background = kind === 'error' ? '#dc2626' : kind === 'warn' ? '#d97706' : '#111827';
    const el = document.createElement('div');
    el.id = TOAST_ID;
    el.textContent = text;
    el.style.cssText = [
      'position:fixed',
      'z-index:2147483647',
      'left:50%',
      'top:20px',
      'transform:translate(-50%,-8px)',
      'max-width:82vw',
      'padding:10px 20px',
      'border-radius:12px',
      `background:${background}`,
      'color:#fff',
      'font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif',
      'box-shadow:0 10px 40px rgba(0,0,0,.35)',
      'opacity:0',
      'transition:opacity .18s ease,transform .18s ease',
      'pointer-events:none',
      'white-space:nowrap',
      'overflow:hidden',
      'text-overflow:ellipsis',
    ].join(';');
    document.body.appendChild(el);

    requestAnimationFrame(() => {
      el.style.opacity = '1';
      el.style.transform = 'translate(-50%,0)';
    });

    setTimeout(() => {
      el.style.opacity = '0';
      el.style.transform = 'translate(-50%,-8px)';
      setTimeout(() => el.remove(), 260);
    }, 3600);

    return { ok: true };
  }

  globalThis[KEY] = {
    version: VERSION,
    prepare,
    setScroll,
    measure,
    restore,
    toast,
  };
})();
