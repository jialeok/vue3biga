/**
 * auction-vue.js
 * 早盘竞价看板 Vue 3 挂载层（与现有 DOM 结构兼容版）
 * - 不接管整个 #auctionBoard，而是在原有 content 容器内挂载 Vue 组件
 * - 暴露 mountAuctionBoardSandbox / mountPage2BoardSandbox / mountPage3BoardSandbox / mountStatsBoardSandbox
 * - 原有 renderAuction / renderAuctionPage2 / ... 检测到这些函数后会走 Vue 路径
 * - 原有 header / toolbar / page 切换逻辑（CSS class、toggle、switchGroup）继续工作
 */
(function () {
  'use strict';
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  // [TDZ-FIX] 原写法 `window.Vue || (typeof Vue !== 'undefined' ? Vue : null)` 在 window.Vue 不存在时
  // 会去读取本行正在声明的 const Vue，触发 "Cannot access 'Vue' before initialization" 的 TDZ 错误，
  // 导致 Vue 未就绪时整个 IIFE 抛错中断（虽然被浏览器吞掉，但挂载逻辑全部失效）。CDN 被墙/离线时
  // window.Vue 通常为 undefined，这里直接用 window.Vue（全局 Vue 即 window.Vue），避免自引用 TDZ。
  const Vue = window.Vue || null;
  if (!Vue) { console.warn('[AUCTION-VUE] Vue 未就绪，保留原生 innerHTML 渲染'); return; }

  const store = window.auctionStore;
  if (!store) { console.warn('[AUCTION-VUE] window.auctionStore 未就绪'); return; }

  const AuctionBoard = window.AuctionBoardComponent;
  const Page2Board = window.Page2BoardComponent;
  const Page3Board = window.Page3BoardComponent;
  const StatsBoard = window.StatsBoardComponent;
  const HighRatioStat = window.HighRatioStatComponent;
  if (!AuctionBoard || !Page2Board || !Page3Board || !StatsBoard || !HighRatioStat) {
    console.warn('[AUCTION-VUE] 组件未就绪');
    return;
  }

  const mountedApps = new Map();

  const safeCall = window.safeCall;

  function ensureContainer(containerId) {
    const el = typeof containerId === 'string' ? document.getElementById(containerId) : containerId;
    return el || null;
  }
  window.ensureContainer = ensureContainer;

  function getComponentMarkerSelector(componentName) {
    switch (componentName) {
      case 'AuctionBoard': return '.auction-board-vue';
      case 'Page2Board': return '.page2-board,.auction-topic-placeholder';
      case 'Page3Board': return '.page3-board,.auction-topic-placeholder';
      case 'StatsBoard': return '.stats-board,.star-stats-empty';
      case 'HighRatioStat': return '.auction-highratio-stat-vue';
      default: return null;
    }
  }
  window.getComponentMarkerSelector = getComponentMarkerSelector;

  function mountComponent(component, props, containerId) {
    const el = window.ensureContainer(containerId);
    if (!el) { console.warn('[AUCTION-VUE] 容器不存在:', containerId); return null; }

    // 同一容器 + 同一组件只挂载一次；Vue 响应式会自动处理后续数据更新，
    // 避免原 renderAuction 每次调用都销毁/重建组件导致卡顿。
    const key = containerId + ':' + component.name;
    const existing = mountedApps.get(key);
    if (existing) {
      const marker = window.getComponentMarkerSelector(component.name);
      // 如果外部已把 DOM 清空/卸载（例如 StatsBoard 切 tab 时主动 unmount），
      // 不能继续复用旧 app，否则会出现空白容器。
      if (!marker || el.querySelector(marker)) {
        window.syncStore(props.dataSource);
        return existing;
      }
      try { existing.unmount(); } catch (e) {}
      mountedApps.delete(key);
    }

    el.innerHTML = '';
    const dataSourceRef = Vue.computed(() => props.dataSource);
    const app = Vue.createApp({
      name: 'AuctionSandboxApp',
      components: { [component.name]: component },
      setup() { return { dataSource: dataSourceRef }; },
      template: `<${component.name} :data-source="dataSource"></${component.name}>`
    });
    app.config.errorHandler = (err, vm, info) => { console.warn('[AUCTION-VUE] 渲染错误:', err, info); };
    app.mount(el);
    mountedApps.set(key, app);
    return app;
  }
  window.mountComponent = mountComponent;

  const tabKey = window.tabKey;

  function syncStore(dataSource) {
    if (!store || !store.actions) return;
    // 不再在这里切换 store.currentGroup：
    // 1) index.html 的 switchGroup / renderAuction* 自己会维护当前分组；
    // 2) 后台 tab 的渲染不应把可见分组抢走，否则会造成所有 computed 重算、界面卡顿/闪烁。
    // if (store.currentGroup !== g) store.actions.switchGroup(g);
    try { if (typeof window.currentDate !== 'undefined') store.currentDate = window.currentDate; } catch (e) {}
  }
  window.syncStore = syncStore;

  // ============================================================
  // 对外暴露的 sandbox 挂载函数（与原 renderAuction 兼容）
  // ============================================================
  function mountAuctionBoardSandbox(dataSource, containerId) {
    window.syncStore(dataSource);
    return window.mountComponent(AuctionBoard, { dataSource }, containerId);
  }
  window.mountAuctionBoardSandbox = mountAuctionBoardSandbox;

  function mountPage2BoardSandbox(dataSource, containerId) {
    window.syncStore(dataSource);
    return window.mountComponent(Page2Board, { dataSource }, containerId);
  }
  window.mountPage2BoardSandbox = mountPage2BoardSandbox;

  function mountPage3BoardSandbox(dataSource, containerId) {
    window.syncStore(dataSource);
    return window.mountComponent(Page3Board, { dataSource }, containerId);
  }
  window.mountPage3BoardSandbox = mountPage3BoardSandbox;

  function mountStatsBoardSandbox(dataSource, containerId) {
    window.syncStore(dataSource);
    return window.mountComponent(StatsBoard, { dataSource }, containerId);
  }
  window.mountStatsBoardSandbox = mountStatsBoardSandbox;

  function mountHighRatioStatSandbox(prefix, page, containerId) {
    const el = window.ensureContainer(containerId);
    if (!el) { console.warn('[AUCTION-VUE] HighRatioStat 容器不存在:', containerId); return null; }

    const key = containerId + ':HighRatioStat';
    const existing = mountedApps.get(key);
    if (existing) {
      const marker = window.getComponentMarkerSelector('HighRatioStat');
      if (!marker || el.querySelector(marker)) return existing;
      try { existing.unmount(); } catch (e) {}
      mountedApps.delete(key);
    }

    el.innerHTML = '';
    const app = Vue.createApp({
      name: 'HighRatioStatSandboxApp',
      components: { HighRatioStat },
      setup() { return { prefix, page }; },
      template: `<HighRatioStat :prefix="prefix" :page="page"></HighRatioStat>`
    });
    app.config.errorHandler = (err, vm, info) => { console.warn('[AUCTION-VUE] HighRatioStat 渲染错误:', err, info); };
    app.mount(el);
    mountedApps.set(key, app);
    return app;
  }
  window.mountHighRatioStatSandbox = mountHighRatioStatSandbox;

  window.mountAuctionBoardSandbox = window.mountAuctionBoardSandbox;
  window.mountPage2BoardSandbox = window.mountPage2BoardSandbox;
  window.mountPage3BoardSandbox = window.mountPage3BoardSandbox;
  window.mountStatsBoardSandbox = window.mountStatsBoardSandbox;
  window.mountHighRatioStatSandbox = window.mountHighRatioStatSandbox;

  // ============================================================
  // 自动挂载：页面加载完成后，若 content 容器存在且为空，则自动挂载组件
  // 注意：Page4 (auctionContent4 / hotContent4) 是“复制的题材股票”原生区域，
  //       不由 Vue 接管；StatsBoard 挂载到独立的 #starStatsContent。
  // ============================================================
  function autoMountAll() {
    const slots = [
      { ds: 'auction', page: 1, cid: 'auctionContent' },
      { ds: 'auction', page: 2, cid: 'auctionContent2' },
      { ds: 'auction', page: 3, cid: 'auctionContent3' },
      { ds: 'hot', page: 1, cid: 'hotContent' },
      { ds: 'hot', page: 2, cid: 'hotContent2' },
      { ds: 'hot', page: 3, cid: 'hotContent3' }
    ];
    for (const s of slots) {
      const el = document.getElementById(s.cid);
      if (!el || el.querySelector('.auction-board-vue, .page2-board, .page3-board')) continue;
      try {
        if (s.page === 1) window.mountAuctionBoardSandbox(s.ds, s.cid);
        else if (s.page === 2) window.mountPage2BoardSandbox(s.ds, s.cid);
        else if (s.page === 3) window.mountPage3BoardSandbox(s.ds, s.cid);
      } catch (e) { console.warn('[AUCTION-VUE] 自动挂载失败:', s.cid, e); }
    }

    // 独立的星标签统计看板（与 tab 共用一份 DOM）
    const starStatsEl = document.getElementById('starStatsContent');
    if (starStatsEl && !starStatsEl.querySelector('.stats-board, .star-stats-empty')) {
      try {
        const g = store.currentGroup === 'hot' ? 'hot' : 'auction';
        window.mountStatsBoardSandbox(g, 'starStatsContent');
      } catch (e) { console.warn('[AUCTION-VUE] 自动挂载 StatsBoard 失败:', e); }
    }

    // 顶部"竞/昨数 / 竞放量数"统计条（page1 / page2 各一组）
    const statSlots = [
      { prefix: 'auction', page: 1, cid: 'auctionHighRatioStat' },
      { prefix: 'auction', page: 2, cid: 'auctionHighRatioStat2' },
      { prefix: 'hot', page: 1, cid: 'hotHighRatioStat' },
      { prefix: 'hot', page: 2, cid: 'hotHighRatioStat2' }
    ];
    for (const s of statSlots) {
      const el = document.getElementById(s.cid);
      if (!el || el.querySelector('.auction-highratio-stat-vue')) continue;
      try { window.mountHighRatioStatSandbox(s.prefix, s.page, s.cid); }
      catch (e) { console.warn('[AUCTION-VUE] 自动挂载 HighRatioStat 失败:', s.cid, e); }
    }
  }
  window.autoMountAll = autoMountAll;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', window.autoMountAll);
  } else {
    window.autoMountAll();
  }

  // ============================================================
  // 覆盖遗留 render 函数：Vue 挂载后只同步状态，避免 innerHTML 覆盖
  // ============================================================
  if (typeof window.renderAuction === 'function') {
    const _origRenderAuction = window.renderAuction;
    window.renderAuction = function (dataSource) {
      const ds = (dataSource === 'hot' ? 'hot' : 'auction');
      window.syncStore(ds);
      // 如果 Vue sandbox 已暴露，让原函数走 Vue 路径；否则回退原逻辑
      if (typeof window.mountAuctionBoardSandbox === 'function') {
        return _origRenderAuction(dataSource);
      }
      return _origRenderAuction(dataSource);
    };
  }

  // ============================================================
  // store 与全局状态同步
  // ============================================================
  Vue.watch(() => store.currentDate, (v) => {
    try { if (typeof window.currentDate !== 'undefined' && window.currentDate !== v) window.currentDate = v; } catch (e) {}
  });
  Vue.watch(() => store.currentGroup, (v) => {
    try { if (typeof window.currentGroup !== 'undefined' && window.currentGroup !== v) window.currentGroup = v; } catch (e) {}
  });

  // 全局 window.currentDate / currentGroup 变化时同步回 store
  function syncGlobalToStore() {
    try {
      if (typeof window.currentDate !== 'undefined' && store.currentDate !== window.currentDate) store.currentDate = window.currentDate;
    } catch (e) {}
    try {
      if (typeof window.currentGroup !== 'undefined' && store.currentGroup !== window.currentGroup) store.currentGroup = window.currentGroup;
    } catch (e) {}
  }
  window.syncGlobalToStore = syncGlobalToStore;
  window.syncGlobalToStore();
  // 不再使用 setInterval 轮询：index.html 中的 switchGroup / setCurrentDate / renderAuction*
  // 已主动写入 store；轮询是冗余且造成卡顿/内存泄漏风险的来源。保留一次性同步即可。

  // 当 store 中的全部展开状态被日期切换等逻辑重置时，同步回 DOM 开关，避免开关仍显示开启。
  Vue.watch(() => store.expandAll, (v) => {
    try {
      const ids = ['auctionExpandAllToggle', 'hotExpandAllToggle'];
      ids.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.checked = !!v;
      });
    } catch (e) {}
  });
  Vue.watch(() => store.expandAllP2, (v) => {
    try {
      const ids = ['auctionExpandAllToggle2', 'hotExpandAllToggle2'];
      ids.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.checked = !!v;
      });
    } catch (e) {}
  });

  // ============================================================
  // 早盘竞价标题栏强度数值/箭头（Vue 路径下原 renderAuction 提前 return，需单独维护）
  // ============================================================
  function updateHeaderStrength() {
    const ds = store.currentGroup === 'hot' ? 'hot' : 'auction';
    const valueEl = document.getElementById('auctionStrengthValue');
    const arrowEl = document.getElementById('auctionStrengthArrow');
    if (!valueEl || !arrowEl) return;

    let todayStrength = null;
    let yesterdayStrength = null;
    try {
      const view = typeof window.computeAuctionViewData === 'function' ? window.computeAuctionViewData(ds) : null;
      if (view && view.stats) {
        todayStrength = view.stats.todayStrength;
        yesterdayStrength = view.stats.yesterdayStrength;
      }
    } catch (e) {
      console.warn('[AUCTION-VUE] 计算标题强度失败:', e);
    }

    if (todayStrength != null) {
      valueEl.textContent = todayStrength + '% ';
      if (yesterdayStrength != null) {
        if (todayStrength > yesterdayStrength) arrowEl.textContent = '⬆';
        else if (todayStrength < yesterdayStrength) arrowEl.textContent = '⬇';
        else arrowEl.textContent = '-';
      } else {
        arrowEl.textContent = '-';
      }
    } else {
      valueEl.textContent = '-';
      arrowEl.textContent = '-';
    }
  }
  window.updateHeaderStrength = updateHeaderStrength;

Vue.watch(() => store.currentGroup + '|' + store.currentDate + '|' + (store.dataVersions[store.currentGroup === 'hot' ? 'hot' : 'auction'] || 0), window.updateHeaderStrength, { immediate: true });

  console.log('[AUCTION-VUE] Vue 挂载层初始化完成');
})();
