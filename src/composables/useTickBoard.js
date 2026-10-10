// useTickBoard.js — 「分笔买卖」看板的组合式（§14 UI 瘦身 / §34 UI 状态与业务数据分离）
//
// 分层（§2）：
//   views/TickBoard.vue（模板）→ 本文件（UI 状态 + 触发抓取的时机）
//     → logic/tick/tick-minute-store.js（读库 / 抓取编排 / 闸门）
//     → logic/tick/tick-minute.js       （纯逻辑：快照→一笔一笔、决策行→看板行）
//     → logic/decision/decision-collect.js（买点 / 卖点行 —— 与决策看板【同一函数、同一份内存真相】）
//
// ⛔ 本文件【不实现任何业务判断】：红/绿/平怎么算、什么算一笔、强弱怎么判、
//    哪些列要显示 —— 全在 logic/tick/tick-minute.js 一处（§6 / §21 模板与组合式零计算）。
//
// ⛔ 与「决策」看板【完全独立】：本文件不 provide 任何东西、不复用它的组合式，
//    也不改它的任何状态；只是【再调一次】collectDecisionData 拿同一份结论
//    （纯内存计算、无请求、不消费额度；同一个纯函数 + 同一份内存真相 ⇒ 两边逐字一致，§6）。
//
// §34：expanded（看板展开）/ penOpenSet（哪几只展开了分笔明细）是纯展示态 ——
//      不落 localStorage（§8）、不进全局 store（§6）。
// §17：抓取是异步的，⛔ 不 await 阻塞渲染 —— 数据到了靠 tickMinuteMap 换引用自动重算。

import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
import { useUiStore } from '../stores/uiStore.js';
import { _on, _off } from '../stores/eventBus.js';
import { collectDecisionData } from '../logic/decision/decision-collect.js';
import { MODE_YIZI } from '../logic/decision/decision-mode.js';
import { buildTickBoard } from '../logic/tick/tick-minute.js';
import {
  tickMinuteDate,
  tickMinuteMap,
  tickMinuteAttempted,
  tickMinuteSkipMap,
  tickMinuteError,
  tickMinuteLoading,
  tickMinuteUpdatedAt,
  tickMinuteFetchNote,
  loadTickMinute,
  ensureTickMinute,
  refreshTickMinute,
  resetTickMinuteTransient,
  stopTickMinuteRetry,
  isTickMinuteReadable,
  TICK_PROBE_URL
} from '../logic/tick/tick-minute-store.js';

/** 稳定的空集合 / 空 Map（避免每次 computed 都 new 一个 → 白白触发下游重算） */
const EMPTY_SET = new Set();
const EMPTY_MAP = new Map();

/** §10：任何一次计算失败都要【可见】，绝不静默成「今天没有信号」 */
function _empty(reason) {
  return { ready: false, reason: reason, buyBlocks: [], sellGroups: [], targets: [] };
}

export function useTickBoard() {
  const uiStore = useUiStore();
  const currentDate = computed(() => uiStore.currentDate);

  // 纯展示态（§34）
  // 与决策看板同口径：默认【收起】（打开页面不用一个个手动关）。
  const expanded = ref(false);
  // 展开「这一分钟的分笔明细」的股票名集合（Set<名字>，与 useDecisionBoard#trendOpenSet 同一范式：
  //   用名字而不是下标 —— 刷新后列表重算会让下标漂移；换【引用】而不是原地 add/delete（§20 只做 shallow 比较）。
  const penOpenSet = ref(new Set());

  // 手动版本号：内存真相（getTodayGroupList 读的是非响应式缓存）刷新后 bump，驱动 computed 重跑
  const version = ref(0);
  /** 本看板自己的计算错误（与抓取/读库错误分开显示：两者可能同时存在，含义也不同） */
  const computeError = ref('');
  /** 用户点「重试」进行中（纯按钮态，⛔ 不参与渲染阻塞 §17） */
  const retrying = ref(false);

  const data = computed(function() {
    void version.value;
    // 显式声明对分笔数据的依赖（store 里的 ref 换引用 ⇒ 这里自动重算，§17 不阻塞渲染）
    void tickMinuteMap.value;
    void tickMinuteDate.value;
    void tickMinuteAttempted.value;
    void tickMinuteSkipMap.value;

    const d = currentDate.value;
    if (!d) return _empty('未选择日期');
    try {
      // ⚠️ 只认【属于这一天】的那份分笔（tickMinuteDate 是单独一格：读某天的库是异步的，
      //    切换日期的瞬间它还留着上一天的数据）。⛔ 用错日期会给出一个看着很像真的假统计。
      const map = (tickMinuteDate.value === d) ? tickMinuteMap.value : EMPTY_MAP;
      const attempted = tickMinuteAttempted.value.get(d) || EMPTY_SET;
      // 抓不了的原因（如缺代码）：只取这一天的（key 形如 `${date}|${name}`）
      const skipMap = new Map();
      tickMinuteSkipMap.value.forEach(function(v, k) {
        const i = k.indexOf('|');
        if (i === d.length && k.slice(0, i) === d) skipMap.set(k.slice(i + 1), v);
      });
      // 与决策看板【同一个】采集函数、同一套模式（一字）⇒ 行内容逐字一致（§6）
      const decided = collectDecisionData(d, { mode: MODE_YIZI });
      return buildTickBoard(decided, map, { attempted: attempted, skipMap: skipMap });
    } catch (e) {
      // §10：计算失败必须可见，⛔ 绝不返回「空结果」伪装成「今天没有信号」
      computeError.value = '分笔买卖计算失败：' + ((e && e.message) ? e.message : String(e));
      console.error('[TICK] 计算失败', e);
      return _empty('计算失败，请看控制台');
    }
  });

  const ready = computed(() => !!data.value.ready);
  const reasonText = computed(() => (data.value.ready ? '' : (data.value.reason || '暂无数据')));
  const buyBlocks = computed(() => data.value.buyBlocks || []);
  const sellGroups = computed(() => data.value.sellGroups || []);
  const errorText = computed(() => computeError.value);
  /** 读库 / 抓取的失败原文（§10 失败必须可见；与上面的计算错误分开一块显示） */
  const fetchError = computed(() => tickMinuteError.value);
  const loading = computed(() => tickMinuteLoading.value);

  const buyCount = computed(function() {
    return buyBlocks.value.reduce(function(n, b) { return n + (b.picks ? b.picks.length : 0); }, 0);
  });
  const sellCount = computed(function() {
    return sellGroups.value.reduce(function(n, g) { return n + (g.items ? g.items.length : 0); }, 0);
  });
  /** 还没抓到（也没抓到过）的股票数 —— 头部摘要用 */
  const pendingCount = computed(function() {
    let n = 0;
    buyBlocks.value.forEach(function(b) {
      (b.picks || []).forEach(function(p) { if (!p.hasTick) n++; });
    });
    sellGroups.value.forEach(function(g) {
      (g.items || []).forEach(function(it) { if (!it.hasTick) n++; });
    });
    return n;
  });

  const summaryText = computed(function() {
    if (!ready.value) return reasonText.value;
    if (buyCount.value === 0 && sellCount.value === 0) return '无买卖信号';
    var s = '买' + buyCount.value + ' 卖' + sellCount.value;
    if (loading.value) s += ' · 抓取中…';
    else if (tickMinuteFetchNote.value) s += ' · ' + tickMinuteFetchNote.value;
    else if (pendingCount.value > 0) s += ' · 待抓 ' + pendingCount.value;
    return s;
  });

  /** 数据落库时间（头部小字；空串则不显示） */
  const updatedText = computed(() => tickMinuteUpdatedAt.value || '');

  // ── 纯展示态开关（§34：只动 UI，不碰任何业务数据）────────────────────────
  /** 点看板条（三角）展开 / 收起内容区 */
  function toggleExpand() { expanded.value = !expanded.value; }
  /**
   * 点【序号 / 股票名】展开 / 收起该股这一分钟的分笔明细（用户口径）。
   * @param {string} name 股票名（空名直接忽略）
   */
  function togglePens(name) {
    const key = String(name || '').trim();
    if (!key) return;
    const next = new Set(penOpenSet.value);
    if (next.has(key)) next.delete(key); else next.add(key);
    penOpenSet.value = next;   // 换引用 → 驱动重渲染
  }

  // ── 抓取时机（本文件只决定「什么时候」，抓取本身在 store）──────────────
  /**
   * 需要就去抓一只不落。
   * ⚠️ 必须先 `isTickMinuteReadable(date)`：读库失败（典型现场 = 表还没建）时
   *    store 的 tickMinuteDate 也已经等于该日，若不拦，就会去打一次必然失败的上游。
   */
  function _tryFetch(dateOverride) {
    const d = dateOverride || currentDate.value;
    if (!d) return;
    const targets = data.value.targets || [];
    if (targets.length === 0) return;
    if (!isTickMinuteReadable(d)) return;
    ensureTickMinute(d, targets);
  }

  /** 读一次库 →（读成功的话）再考虑要不要抓 */
  function _loadThenMaybeFetch(date) {
    return loadTickMinute(date).then(function() { _tryFetch(date); });
  }

  /**
   * 供父级在「刷新」时调用（与早盘竞价 / 涨跌停 / 决策看板同款契约：defineExpose({ refresh })）。
   * ⚠️ 这条是【用户主动】路径，会把 store 里的失败重试次数 / 冷却重置一次 —— 所以只有点刷新才走它。
   */
  function refresh() {
    version.value++;
    computeError.value = '';
    const d = currentDate.value;
    if (!d) return Promise.resolve();
    retrying.value = true;
    return refreshTickMinute(d, data.value.targets || []).finally(function() {
      retrying.value = false;
    });
  }

  // 目标名单变化（首个买点/卖点到货、或选票结论变了）→ 补一次抓取。
  // ⛔ 用「名字串」而不是数组引用：数组每次 computed 都是新的，会导致无限循环。
  const targetSig = computed(function() {
    return (data.value.targets || []).map(function(t) { return t.name; }).join('|');
  });
  watch(targetSig, function() { _tryFetch(); });

  onMounted(function() {
    // §33 首次加载：读一次该日的分笔（读成功后才可能触发抓取）
    _loadThenMaybeFetch(currentDate.value);
  });

  watch(currentDate, function(d) {
    computeError.value = '';
    penOpenSet.value = new Set();       // §26 换日期 ⇒ 明细面板全部收起（上一天的行已不存在）
    resetTickMinuteTransient();
    _loadThenMaybeFetch(d);
  });

  // 数据刷新（抓取 / 导入 / 收盘覆盖）后跟着更新（§17）
  const _onRefresh = function() {
    version.value++;
    const d = currentDate.value;
    loadTickMinute(d).then(function() { _tryFetch(d); });
  };
  _on('auction-refresh', _onRefresh);

  onUnmounted(function() {
    _off('auction-refresh', _onRefresh);
    // 清理本看板持有的定时重试（§31 成对清理，⛔ 不留给下一个页面）
    stopTickMinuteRetry();
  });

  /**
   * 用户点了头部「刷新」按钮 / 父级调 refresh。
   * ⛔ 失败一律由看板红字块如实呈现（§10 可见即可），本看板不额外弹 toast、不刷屏。
   */
  return {
    expanded,
    penOpenSet,
    errorText,
    fetchError,
    loading,
    ready,
    reasonText,
    buyBlocks,
    sellGroups,
    buyCount,
    sellCount,
    pendingCount,
    summaryText,
    updatedText,
    toggleExpand,
    togglePens,
    refresh,
    // 失败时给用户的下一步：重试 + 自检（2026-10-10 加：光有红字、没有动作，用户只能干瞪眼）
    retrying,
    probeUrl: TICK_PROBE_URL
  };
}
