// useDecisionBoard.js — 「决策」看板的组合式（§14 UI 瘦身 / §34 UI 状态与业务数据分离）
//
// 分层（§2）：
//   views/DecisionBoard.vue（模板）→ 本文件（UI 状态 + 触发重算的时机）
//     → logic/decision/decision-collect.js（读内存真相、组装 entries）
//     → logic/decision/decision-rules.js（纯规则，可单测）
//   ⛔ 本文件不发请求、不写库、不消费猫抓额度；⛔ 不复用任何其它看板的组件或组合式。
//
// §34：expanded / rulesOpen 都是纯展示态 —— 不落 localStorage（§8）、不进全局 store（§6）。
// §17：数据刷新（抓取 / 导入 / 收盘覆盖）后要跟着更新，因此监听事件总线 auction-refresh。

import { ref, computed, watch, onUnmounted } from 'vue';
import { useUiStore } from '../stores/uiStore.js';
import { useAuctionStore } from '../stores/auctionStore.js';
import { _on, _off } from '../stores/eventBus.js';
import { collectDecisionData } from '../logic/decision/decision-collect.js';
// [TWO-MODES 2026-10-02] 买点模式由早盘竞价的题材 / 一字 toggle 决定；
//   ⛔ 判定与分派都在 Logic 层（decision-mode.js），复合式只负责「把 store 状态喂进去」（§14 瘦身）。
import { resolveDecisionMode, buildRulesLines } from '../logic/decision/decision-mode.js';

/** §10：任何一次计算失败都要【可见】，绝不静默成「今天没有信号」 */
function _empty(reason) {
  return {
    ready: false,
    reason: reason,
    topics: [],
    buy: { heavy: null, light: null, candidates: [], noYizi: null, smallTopic: null, bigTopic: null },
    sell: [],
    sellTimes: []
  };
}

export function useDecisionBoard() {
  const uiStore = useUiStore();
  const auctionStore = useAuctionStore();
  const currentDate = computed(() => uiStore.currentDate);

  /**
   * [TWO-MODES 2026-10-02 用户口径] 当前买点模式 —— ★本看板唯一的模式来源★。
   *
   * 用户原话：「决策看板……只是逻辑要跟随早盘竞价看板的 toggle 变化，相当于两种方式。
   *   其它看板不变。」⇒ 模式 = 早盘竞价第一页那两个题材 toggle 的口径：
   *   · 一字 toggle 打开 → MODE_YIZI（老版完整规则）；
   *   · 题材 toggle 打开 / 两个都关 → MODE_VOL_RATIO（现行规则）。
   *
   * ⚠️ 读的是 Pinia store（app 级、跨页面共享）而不是早盘竞价那套局部 reactive ——
   *    早盘竞价的 toggleSort 每次都会把状态同步进 store（§6 单一真相），
   *    所以这里既是【响应式】的（切 toggle 后本看板自动重算），也不需要跨页面通信。
   * §10：store 还没初始化 / 形状不对 → resolveDecisionMode 内部回落 MODE_VOL_RATIO，绝不抛错。
   */
  const decisionMode = computed(function() {
    const s = auctionStore && auctionStore.sortState ? auctionStore.sortState.auction : null;
    return resolveDecisionMode(s);
  });

  // 规则面板文案：随模式切换（一字模式显示老版条文）。⛔ 只在 Logic 层生成（§6 实现与说明同处一处）。
  const rulesLines = computed(() => buildRulesLines(decisionMode.value));

  // 纯展示态（§34）
  // [DEFAULT-COLLAPSED 2026-09-28] 看板默认【收起】（用户口径：打开 / 刷新页面不用再手动一个个关）。
  //   内容区是 v-show ⇒ 收起不影响决策数据的计算与加载；⛔ 不要改回 true。
  const expanded = ref(false);
  const rulesOpen = ref(false);
  // [COMPACT 2026-09-30 用户口径] 「简洁」开关：打开后只留【题材行 + 股票行 + 行内标签】，
  //   隐藏「选择理由 / 卖出理由 / 辅助说明 / 卖出节奏提示 / 规则问号」这些解释性文字。
  //   §34：纯展示态 —— 不进 store、不落 localStorage（§8），与 expanded 同一口径；
  //   §26：不随日期切换重置（这是显示偏好，不是「新一天的结论」）。
  //   实际隐藏由 decision-board.css 的 .dcb-compact 规则完成，模板不加 v-if 分支（改动面最小）。
  // [COMPACT-DEFAULT 2026-09-30 用户口径] 默认 = 【打开】（用户原话：默认开简洁 toggle，
  //   这样早盘就能快速浏览并买入或卖出）。⛔ 不要改回 false：
  //   解释性文字在小屏幕上要滑很久，早盘根本来不及看；要细节就点一下「简洁」关掉。
  const compactOpen = ref(true);

  // [VRATIO-TREND 2026-10-01 用户口径]「竞价量比 近 5 日」趋势面板的展开态：Set<股票名>。
  //   为什么用 Set<名字>（而不是按下标）：翻页 / 刷新后列表重算会让下标漂移，
  //   名字是稳定标识；与早盘竞价看板同款（useAuctionBoard#expandedSet）。
  //   为什么换【引用】而不是原地 add/delete：只 shallow 比较，不做 deep watch（§20 红线）。
  //   §34：纯展示态 —— 不进 store、不落 localStorage（§8）。
  //   ⛔ 买点与卖点【共用同一份】：同一只票在两处是同一个开关（用户口径「点一下就展开/收起」）。
  const trendOpenSet = ref(new Set());

  // 手动版本号：auction 数据刷新（getTodayGroupList 读的是非响应式内存缓存）后 bump，
  // 让下面的 computed 重跑一次。龙一/龙二（dragonState 是 ref）与标签（Pinia）本身是响应式的，
  // computed 会自动追踪 —— 只有「当日列表」需要这个手动信号（与早盘竞价看板同一套路）。
  const version = ref(0);

  const errorText = ref('');

  const data = computed(function() {
    void version.value;               // 显式声明对刷新信号的依赖
    const d = currentDate.value;
    if (!d) return _empty('未选择日期');
    try {
      // [TWO-MODES 2026-10-02] 把当前模式传下去 —— 题材排名、买点规则、连板天梯采集全部跟着它走
      return collectDecisionData(d, { mode: decisionMode.value });
    } catch (e) {
      // §10：计算失败必须可见，绝不能返回「空结果」伪装成「今天没有信号」
      errorText.value = '决策计算失败：' + (e && e.message ? e.message : String(e));
      console.error('[DECISION] 计算失败', e);
      return _empty('计算失败，请看控制台');
    }
  });

  const ready = computed(() => !!data.value.ready);
  const reasonText = computed(() => (data.value.ready ? '' : (data.value.reason || '暂无数据')));

  const buyHeavy = computed(() => (data.value.buy ? data.value.buy.heavy : null));
  const buyLight = computed(() => (data.value.buy ? data.value.buy.light : null));
  // [NO-YIZI 2026-09-25] 「全部题材竞价一字 0 个」的弱市兜底方案；与 heavy / light 互斥
  const buyNoYizi = computed(() => (data.value.buy ? data.value.buy.noYizi : null));
  // [SMALL-TOPIC 2026-09-25] 「第 1 / 第 2 名题材票太少却有 1~2 个一字」的高风险兜底方案；
  // 与 noYizi 结构完全一致（{hintText, notes, emptyText, blocks}），因此 UI 合并成 buySpecial 一处渲染。
  const buySmallTopic = computed(() => (data.value.buy ? data.value.buy.smallTopic : null));
  // [BIG-TOPIC 2026-09-26] 「全部题材无一字 + 有大题材（≥10 只）」的兜底方案；结构同上
  const buyBigTopic = computed(() => (data.value.buy ? data.value.buy.bigTopic : null));
  /** 三条兜底方案共用同一段模板；与 heavy / light 互斥 */
  const buySpecial = computed(() => buyNoYizi.value || buySmallTopic.value || buyBigTopic.value || null);
  const sellGroups = computed(() => data.value.sell || []);
  /**
   * [MIN-3-PICKS 2026-10-02 用户口径]【候选题材】块数组。
   * 来源两种：① 主线（第 1、2 名）票数不足 3 只 ⇒ 按题材排名往下推的补位题材；
   *          ② 第 1 名题材已选出 3 只 ⇒ 第 2 名降级（= 双主线，只选最强的）。
   * ⓘ 降级后的第 2 名【同时】出现在 buyLight 与 buyCandidates 里 —— 那是同一个对象引用，
   *    渲染时由本数组【不再重复渲染】（模板里用 v-if 排除），只作为「它在候选里」的标记来源。
   */
  const buyCandidates = computed(
    () => ((data.value.buy && data.value.buy.candidates) || [])
      .filter((b) => b && b !== buyLight.value)      // ⛔ 已被降级成 light 的那块不再重复画一遍
  );

  const buyCount = computed(function() {
    const n = buySpecial.value;
    if (n) {
      return n.blocks.reduce(function(s, b) { return s + b.picks.length; }, 0);
    }
    const h = buyHeavy.value;
    const l = buyLight.value;
    const c = (data.value.buy && data.value.buy.candidates) || [];
    // ⚠️ 降级成 light 的第 2 名块【在 candidates 里也有】，这里要按【去重后的块】计数，否则会算两遍
    const candPick = c.reduce(function(s, b) {
      if (!b || b === l) return s;
      return s + (b.picks ? b.picks.length : 0);
    }, 0);
    return (h && h.qualified ? h.picks.length : 0) + (l ? l.picks.length : 0) + candPick;
  });
  const sellCount = computed(function() {
    return sellGroups.value.reduce(function(n, g) { return n + g.items.length; }, 0);
  });

  const summaryText = computed(function() {
    if (!ready.value) return reasonText.value;
    // 兜底判定为「太弱」→ 头部直接写【空仓】，比「无买卖信号」更贴合用户口径
    const n = buySpecial.value;
    if (n && !n.qualified && sellCount.value === 0) return '空仓（题材太弱）';
    if (buyCount.value === 0 && sellCount.value === 0) return '今日无买卖信号';
    return '买' + buyCount.value + ' 卖' + sellCount.value;
  });

  /**
   * [2026-09-26 用户要求] 点看板条（三角）展开 / 收起时，【顺手把灰色问号的规则说明板收起】
   *   —— 说明文字要跟着一起消失，否则收起后还悬一块面板很难看。
   * ⛔ 只动纯展示态（§34），不碰任何业务数据。
   */
  function toggleExpand() {
    expanded.value = !expanded.value;
    rulesOpen.value = false;
  }
  function toggleRules() { rulesOpen.value = !rulesOpen.value; }
  /** [COMPACT 2026-09-30] 「简洁」开关：只切纯展示态，不碰任何业务数据（§34） */
  function toggleCompact() { compactOpen.value = !compactOpen.value; }
  /**
   * [VRATIO-TREND 2026-10-01 用户口径] 点【序号 / 股票名】展开或收起该股的「竞价量比 近 5 日」趋势。
   * §34：只动纯展示态，不碰任何业务数据、不发请求。
   * @param {string} name 股票名（与 auction_watchlist.stock 同口径；空名直接忽略）
   */
  function toggleTrend(name) {
    const key = String(name || '').trim();
    if (!key) return;
    const next = new Set(trendOpenSet.value);
    if (next.has(key)) next.delete(key); else next.add(key);
    trendOpenSet.value = next; // 换引用 → 驱动重渲染（与 useAuctionBoard#onExpandTrend 同一范式）
  }
  /** 供规则面板自己上报开合（子组件无内部状态，开合真相在 composable 里，§6） */
  function setRulesOpen(v) { rulesOpen.value = !!v; }

  /** 供父级在「刷新」时调用（与早盘竞价 / 涨跌停看板同款契约：defineExpose({ refresh })） */
  function refresh() { version.value++; errorText.value = ''; }

  // §26 日期切换 → 规则面板收起（新的一天是全新的结论，旧展开态会误导）
  // [VRATIO-TREND 2026-10-01] 同理把「竞价量比」趋势面板一并收起 —— 换了日期整条曲线都换了，
  //   留着展开态只会让人拿新日期的图去对旧结论。
  watch(currentDate, function() {
    rulesOpen.value = false;
    errorText.value = '';
    trendOpenSet.value = new Set();
  });

  const _onRefresh = function() { refresh(); };
  _on('auction-refresh', _onRefresh);
  onUnmounted(function() { _off('auction-refresh', _onRefresh); });

  return {
    expanded,
    rulesOpen,
    compactOpen,
    // [TWO-MODES 2026-10-02] 当前买点模式（由早盘竞价 toggle 决定）+ 与之配套的规则面板文案。
    //   rulesLines 随模式切换 ⇒ 一字模式点开问号看到的是【老版条文】，量比模式看到现行条文。
    decisionMode,
    rulesLines,
    // [VRATIO-TREND 2026-10-01] 竞价量比趋势面板的展开态与开关（由 DecisionBoard.vue provide 给买卖点两个块组件）
    trendOpenSet,
    errorText,
    data,
    ready,
    reasonText,
    buyHeavy,
    buyLight,
    // [MIN-3-PICKS 2026-10-02] 候选题材（补位 / 降级），渲染在 light 之后
    buyCandidates,
    buyNoYizi,
    buySmallTopic,
    buyBigTopic,
    buySpecial,
    sellGroups,
    buyCount,
    sellCount,
    summaryText,
    toggleExpand,
    toggleRules,
    toggleCompact,
    toggleTrend,
    setRulesOpen,
    refresh
  };
}
