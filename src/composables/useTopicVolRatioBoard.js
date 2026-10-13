// useTopicVolRatioBoard.js — 「题材量比」看板的组合式（§14 UI 瘦身 / §34 UI 状态与业务数据分离）
//
// 分层（§2）：
//   views/TopicVolRatioBoard.vue（模板）→ 本文件（UI 状态 + 触发重算 / 触发取数的时机）
//     → logic/decision/decision-collect.js#collectDecisionTopics(actionContext)
//       （读内存真相：题材块 + 龙位名册 + 买卖点标签上下文 + 卖点候选行）
//     → logic/topicvolratio/topic-vol-ratio-rules.js（本看板的选股 + 标签收口，纯规则，可单测）
//     → logic/decision/decision-collect.js#decorateDecisionRows（量比趋势 / 名次变化 / 封单额）
//     → logic/tick/tick-minute-store.js（分笔取数编排，与「分笔买卖」看板共用同一份内存真相）
//     → logic/tick/tick-minute.js#decorateTickRow（展开面板的每一行 / 每一段文案）
//
// ★ [2026-10-11 第二轮 用户口径] 本看板只替换【选股】，标签与展开面板全部复用别人的同一份实现：
//   用户原话「要模仿决策看板的占比，卖出，持有，竞价卖，竞价买，尾盘买，尾盘卖，龙持有，跟龙
//     等所有的标签逻辑基本一样。因为买入和卖出基本逻辑一样，只是选股不同。把股票下方点击展开的
//     量比图换成，分笔图（设计和分笔买卖看板的股票展开图一样，包括图上文字）」。
//   ⇒ 「不复用其它看板」这条以前的原则，现在只适用于【组件类名前缀】（Tvrb* / tvrb-）；
//     **业务实现一律复用**（§6 单一真相）：标签走 decision-rules，分笔走 tick-minute。
//
// ⛔ 本文件【不抓早盘竞价 / 决策的数据、不落库、不消费猫抓额度】：那些数据全在内存里。
//   ⚠️ 唯一的例外是【分笔明细】：它与「分笔买卖」看板共用 tick-minute-store 这份单例，
//      同一只票同一天只会抓一次（§32 相同数据不得重复请求），额度不会因为本看板翻倍。
//
// §34：expanded / rulesOpen / compactOpen / penOpenSet 都是纯展示态 ——
//      不落 localStorage（§8）、不进全局 store（§6）。
// §17：数据刷新（抓取 / 导入 / 收盘覆盖）后要跟着更新，因此监听事件总线 auction-refresh。
//      ⚠️ collectDecisionTopics 读的 getTodayGroupList 是【非响应式内存缓存】⇒
//         必须靠下面的 version 手动信号驱动重算（与决策看板 useDecisionBoard 同一套路）；
//         分笔那份是【响应式单例】⇒ 直接 void 它的 ref 即可自动重算。

import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
import { useUiStore } from '../stores/uiStore.js';
import { _on, _off } from '../stores/eventBus.js';
import {
  collectDecisionTopics,
  decorateDecisionRows
} from '../logic/decision/decision-collect.js';
// §6：题材组序口径的常量只有一处定义（decision-mode.js），⛔ 别在本文件写字面量 'volRatio'。
import { MODE_VOL_RATIO } from '../logic/decision/decision-mode.js';
import {
  buildTopicVolRatioPlan,
  buildTvrbRulesLines,
  TVRB_CASH_ALERT_NONE
} from '../logic/topicvolratio/topic-vol-ratio-rules.js';
// ★ 分笔：与「分笔买卖」看板【同一份取数编排 + 同一份逐行实现】（§6 单一真相，⛔ 不另写一份）
import { decorateTickRow } from '../logic/tick/tick-minute.js';
import {
  tickMinuteDate,
  tickMinuteMap,
  tickMinuteAttempted,
  tickMinuteSkipMap,
  tickMinuteError,
  tickMinuteLoading,
  loadTickMinute,
  ensureTickMinute,
  refreshTickMinute,
  resetTickMinuteTransient,
  isTickMinuteReadable
} from '../logic/tick/tick-minute-store.js';
// ⛔ 刻意【不引入】tick-minute-store#stopTickMinuteRetry：那是整份 store 的定时重试，
//    「分笔买卖」看板也持有同一份 ⇒ 本看板卸载时调它会误伤那个看板（见下面 onUnmounted 的注释）。

/** 稳定的空集合 / 空 Map（避免每次 computed 都 new 一个 → 白白触发下游重算） */
const EMPTY_SET = new Set();
const EMPTY_MAP = new Map();

/**
 * 分笔取数失败后的一次性重试延迟（ms）。
 *
 * ⚠️ 为什么本看板要自己排一次重试：tick-minute-store 与「分笔买卖」看板共用，
 *    而那次抓取有 20s 的最小间隔闸门（MIN_INTERVAL_MS）。两个看板的【目标票不同】时，
 *    先跑的那个会把闸门占掉 ⇒ 后跑的这个当场抓不到。
 *    ⇒ 这里等闸门过了（25s）再试一次，把本看板自己的票补上。
 *    ⛔ 不会因此多烧额度：store 里同一日最多抓 5 次、且同一日同一票抓过就跳过（§32/§36）。
 */
const TVRB_TICK_RETRY_MS = 25000;
/** 最多重试几次（够跨过闸门即可；再多就是异常，交给用户点刷新 / 红字提示） */
const TVRB_TICK_RETRY_MAX = 3;

/** §10：任何一次「未就绪 / 失败」都要【可见】，绝不静默成「今天没有入选股票」 */
function _empty(reason) {
  return {
    ready: false,
    reason: reason,
    plan: {
      topics: [], blocks: [], buy: null, sell: [], excludedTopics: [], notes: [],
      pickCount: 0, buyNames: new Set(),
      // ⛔ 未就绪 / 计算失败时【绝不给空仓结论】：那会拿「没数据」当「量比太低」用（§10）。
      //    形状仍保留，值 = 冻结的「不提示」，引用稳定（§19）。
      cashAlert: TVRB_CASH_ALERT_NONE
    }
  };
}

/** 分笔抓不了的原因 → 只取【本日】的那些（store 里的 key 形如 `${date}|${name}`，与 useTickBoard 同款） */
function _skipMapOf(date) {
  const out = new Map();
  tickMinuteSkipMap.value.forEach(function(v, k) {
    const i = k.indexOf('|');
    if (i === date.length && k.slice(0, i) === date) out.set(k.slice(i + 1), v);
  });
  return out;
}

export function useTopicVolRatioBoard() {
  const uiStore = useUiStore();
  const currentDate = computed(() => uiStore.currentDate);

  // 规则面板文案（与判定同处一处：topic-vol-ratio-rules.js，§6）
  const rulesLines = computed(() => buildTvrbRulesLines());

  // 纯展示态（§34）
  // 看板默认【收起】（与决策看板 / 分笔看板一致：打开页面不用再手动一个个关）
  const expanded = ref(false);
  const rulesOpen = ref(false);
  // 「简洁」开关：打开后只留【题材行 + 股票行 + 行内标签】，隐藏解释性文字；
  // 默认【打开】（与决策看板一致，早盘快速浏览）。实际隐藏由 tvrb-compact 的 CSS 完成。
  const compactOpen = ref(true);

  // 「分笔明细」面板的展开态：Set<股票名>（买点 / 卖点两侧共用同一个开关 ——
  //   同一只票在两处是同一个开关，与分笔看板 penOpenSet 同一范式）。
  // 用名字而不是下标（翻页 / 刷新后下标会漂移）；换【引用】驱动重渲染（§20 不做 deep watch）。
  const penOpenSet = ref(new Set());

  // 手动版本号：auction 数据刷新后 bump，让下面的 computed 重跑一次（见文件头 §17 注释）。
  const version = ref(0);
  const errorText = ref('');

  const data = computed(function() {
    void version.value;                 // 显式声明对刷新信号的依赖
    // 分笔那份是响应式单例 ⇒ 显式声明依赖，数据到了自动重算（§17 不阻塞渲染）
    void tickMinuteMap.value;
    void tickMinuteDate.value;
    void tickMinuteAttempted.value;
    void tickMinuteSkipMap.value;

    const d = currentDate.value;
    if (!d) return _empty('未选择日期');
    try {
      // [TVRB] 题材排名恒为「平均竞价量比降序」⇒ 模式固定传 MODE_VOL_RATIO
      //   （⛔ 不跟早盘竞价的「题材 / 一字」toggle 联动：本看板的定义就是按量比排）。
      // actionContext=true → 额外取回买卖点标签上下文 + 卖点候选行（见 decision-collect 的出口注释）
      const rec = collectDecisionTopics(d, { mode: MODE_VOL_RATIO, actionContext: true });
      if (!rec || !rec.ready) return _empty((rec && rec.reason) || '暂无数据');

      // ① 本看板自己的选股 + 标签收口（标签管线 = 决策看板的同一份实现）
      const plan = buildTopicVolRatioPlan(rec.topics, rec.dragonMap, {
        date: d,
        ctx: {
          prevDragonNames: rec.prevDragonNames,
          prevBuyNames: rec.prevBuyNames,
          prevBought: rec.prevBought,
          prevBoughtTopics: rec.prevBoughtTopics,
          topicStreakPast: rec.topicStreakPast
        },
        sellRows: rec.sellRows || []
      });

      // ② 逐行装饰（竞价量比趋势 / 龙标名次变化 / 封单额 + 连板）——与决策看板同一份实现
      decorateDecisionRows(plan.buy, plan.sell, d, rec.prevDate, rec.dragonMap);

      // ③ 分笔明细（与「分笔买卖」看板同一份取数 + 同一份逐行实现）
      // ⚠️ 只认【属于这一天】的那份分笔（tickMinuteDate 单独一格：读库是异步的，
      //    切换日期的瞬间它还留着上一天的数据）。⛔ 用错日期会给出一个看着很像真的假统计。
      const map = (tickMinuteDate.value === d) ? tickMinuteMap.value : EMPTY_MAP;
      const attempted = tickMinuteAttempted.value.get(d) || EMPTY_SET;
      const skipMap = _skipMapOf(d);
      // ⛔ 买点 pick 自带 code（由本看板的候选构造透传）⇒ 不需要 memberMap 反查；
      //    卖点行同样自带 code ⇒ 两边都传 null（与分笔看板的 buy 侧传 memberMap 等价，
      //    只是本看板在建 pick 时已经带上 code，省掉一次反查）。
      plan.blocks.forEach(function(b) {
        (b.picks || []).forEach(function(p) {
          Object.assign(p, decorateTickRow(p, map, attempted, skipMap, null, 'buy'));
        });
      });
      plan.sell.forEach(function(g) {
        (g.items || []).forEach(function(it) {
          Object.assign(it, decorateTickRow(it, map, attempted, skipMap, null, 'sell'));
        });
      });

      return { ready: true, reason: '', plan: plan };
    } catch (e) {
      // §10：计算失败必须可见，绝不能返回「空结果」伪装成「今天没有入选股票」
      errorText.value = '题材量比计算失败：' + (e && e.message ? e.message : String(e));
      console.error('[TVRB] 计算失败', e);
      return _empty('计算失败，请看控制台');
    }
  });

  const ready = computed(() => !!data.value.ready);
  const reasonText = computed(() => (data.value.ready ? '' : (data.value.reason || '暂无数据')));
  const blocks = computed(() => (data.value.plan ? data.value.plan.blocks : []));
  const sellGroups = computed(() => (data.value.plan ? (data.value.plan.sell || []) : []));
  const notes = computed(() => (data.value.plan ? data.value.plan.notes : []));
  const excludedTopics = computed(() => (data.value.plan ? data.value.plan.excludedTopics : []));
  const pickCount = computed(() => (data.value.plan ? data.value.plan.pickCount : 0));
  /**
   * ★ [CASH-ALERT 2026-10-13 用户口径] 空仓提醒 —— 判据全在 Logic 层（buildCashAlert），
   *   本处只把它透给模板（§21：模板零计算；§34：UI 不判业务）。
   *   ⛔ 未就绪时是「不提示」（见 _empty）：绝不能因为「数据没算出来」就喊空仓。
   */
  const cashAlert = computed(function() {
    const a = data.value.plan && data.value.plan.cashAlert;
    return a || TVRB_CASH_ALERT_NONE;
  });
  /** 卖点股票数（头部摘要用） */
  const sellCount = computed(function() {
    return sellGroups.value.reduce(function(n, g) { return n + ((g.items || []).length); }, 0);
  });
  /** 读库 / 抓取的失败原文（§10 失败必须可见；与计算错误分开，含义不同） */
  const fetchError = computed(() => tickMinuteError.value);
  const loading = computed(() => tickMinuteLoading.value);

  const summaryText = computed(function() {
    if (!ready.value) return reasonText.value;
    let s = '选股 ' + pickCount.value + ' 只';
    if (sellCount.value > 0) s += ' · 卖点 ' + sellCount.value + ' 只';
    if (loading.value) s += ' · 分笔抓取中…';
    return s;
  });

  /**
   * 点看板条（三角）展开 / 收起时，顺手把规则说明板收起（与决策看板同一口径）——
   * 说明文字要跟着一起消失，否则收起后还悬一块面板很难看。§34：只动展示态。
   */
  function toggleExpand() {
    expanded.value = !expanded.value;
    rulesOpen.value = false;
  }
  function toggleCompact() { compactOpen.value = !compactOpen.value; }
  /** 规则面板自己上报开合（子组件无内部状态，开合真相在本文件，§6） */
  function setRulesOpen(v) { rulesOpen.value = !!v; }

  /**
   * 点【序号 / 股票名】展开或收起该股的【分笔明细】面板。
   * §34：只动纯展示态，不碰业务数据、不发请求。
   * @param {string} name 股票名
   */
  function togglePens(name) {
    const key = String(name || '').trim();
    if (!key) return;
    const next = new Set(penOpenSet.value);
    if (next.has(key)) next.delete(key); else next.add(key);
    penOpenSet.value = next;   // 换引用 → 驱动重渲染
  }

  /** 只重算（供事件总线的高频刷新用；不碰任何展示态） */
  function bumpVersion() {
    version.value++;
    errorText.value = '';
  }

  // ── 分笔取数时机（只决定「什么时候」，取数本身在 store）────────────────────
  /** 本看板要抓的票 = 买点 + 卖点里出现过、且拿得到代码的股票（与分笔看板同一口径，§6） */
  const tickTargets = computed(function() {
    const seen = new Map();
    blocks.value.forEach(function(b) {
      (b.picks || []).forEach(function(p) {
        if (p && p.name && !seen.has(p.name)) seen.set(p.name, String(p.code || ''));
      });
    });
    sellGroups.value.forEach(function(g) {
      (g.items || []).forEach(function(it) {
        if (it && it.name && !seen.has(it.name)) seen.set(it.name, String(it.code || ''));
      });
    });
    return Array.from(seen.entries()).map(function(e) { return { name: e[0], code: e[1] }; });
  });

  let _tickRetryTimer = null;
  let _tickRetryCount = 0;

  function _clearTickRetry() {
    if (_tickRetryTimer) {
      clearTimeout(_tickRetryTimer);
      _tickRetryTimer = null;
    }
    _tickRetryCount = 0;
  }

  /**
   * 需要就去抓一只不落。
   * ⚠️ 必须先 `isTickMinuteReadable(date)`：读库失败（典型现场 = 表还没建）时
   *    store 的 tickMinuteDate 也已经等于该日，若不拦，就会去打一次必然失败的上游。
   */
  function _tryFetch() {
    const d = currentDate.value;
    if (!d) return;
    const targets = tickTargets.value;
    if (targets.length === 0) return;
    if (!isTickMinuteReadable(d)) return;
    // 还有「库里没有 + 本次会话没抓过」的票 ⇒ 过一会儿再试一次（见 TVRB_TICK_RETRY_MS 注释）
    ensureTickMinute(d, targets).then(function() {
      if (!tickTargets.value.some(function(t) { return _stillMissing(d, t.name); })) return;
      if (_tickRetryTimer || _tickRetryCount >= TVRB_TICK_RETRY_MAX) return;
      _tickRetryCount++;
      _tickRetryTimer = setTimeout(function() {
        _tickRetryTimer = null;
        loadTickMinute(d).then(function() { _tryFetch(); });
      }, TVRB_TICK_RETRY_MS);
    });
  }

  /** 这一只还没拿到（库里没有、也没标过「已抓过」）——只读判断，无副作用 */
  function _stillMissing(date, name) {
    const have = (tickMinuteDate.value === date) ? tickMinuteMap.value : EMPTY_MAP;
    if (have.has(name)) return false;
    const att = tickMinuteAttempted.value.get(date) || EMPTY_SET;
    return !att.has(name);
  }

  /** 读一次库 →（读成功的话）再考虑要不要抓 */
  function _loadThenMaybeFetch(date) {
    return loadTickMinute(date).then(function() { _tryFetch(); });
  }

  /** 供父级在「刷新」时调用（与其它看板同款契约：defineExpose({ refresh })） */
  function refresh() {
    bumpVersion();
    const d = currentDate.value;
    if (!d) return Promise.resolve();
    _clearTickRetry();
    return refreshTickMinute(d, tickTargets.value);
  }

  // 目标名单变化（首次算出发现在选谁、或结论变了）→ 补一次抓取。
  // ⛔ 用「名字串」而不是数组引用：数组每次 computed 都是新的，会导致无限循环。
  const targetSig = computed(function() {
    return tickTargets.value.map(function(t) { return t.name; }).join('|');
  });
  watch(targetSig, function() { _clearTickRetry(); _tryFetch(); });

  onMounted(function() {
    // §33 首次加载：读一次该日的分笔（读成功后才可能触发抓取）
    _loadThenMaybeFetch(currentDate.value);
  });

  // §26 日期切换 → 规则面板 / 分笔面板收起（新的一天是全新的结论，旧展开态会误导）+ 重新读分笔
  watch(currentDate, function(d) {
    rulesOpen.value = false;
    errorText.value = '';
    penOpenSet.value = new Set();
    _clearTickRetry();
    resetTickMinuteTransient();
    _loadThenMaybeFetch(d);
  });

  // §17 数据刷新（早盘竞价抓取 / 导入 / 收盘覆盖）→ 重算 + 补一次分笔读取。
  const _onRefresh = function() {
    bumpVersion();
    const d = currentDate.value;
    if (!d) return;
    _clearTickRetry();
    loadTickMinute(d).then(function() { _tryFetch(); });
  };
  _on('auction-refresh', _onRefresh);
  // §31 成对清理：本看板订阅的事件 / 自己的定时器由本看板清理
  onUnmounted(function() {
    _off('auction-refresh', _onRefresh);
    _clearTickRetry();
    // ⚠️ 这里【不】调 stopTickMinuteRetry()：「分笔买卖」看板也持有同一份 store 的定时重试，
    //    本看板卸载时把它掐掉会误伤那个看板（两个看板同页共存）。它自己的 onUnmounted 会收。
  });

  return {
    expanded,
    rulesOpen,
    compactOpen,
    rulesLines,
    penOpenSet,
    errorText,
    fetchError,
    loading,
    ready,
    reasonText,
    blocks,
    sellGroups,
    notes,
    excludedTopics,
    pickCount,
    sellCount,
    cashAlert,
    summaryText,
    toggleExpand,
    toggleCompact,
    setRulesOpen,
    togglePens,
    refresh
  };
}
