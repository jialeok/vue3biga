// useDecisionBoard.js — 「决策」看板的组合式（§14 UI 瘦身 / §34 UI 状态与业务数据分离）
//
// 分层（§2）：
//   views/DecisionBoard.vue（模板）→ 本文件（UI 状态 + 触发重算的时机）
//     → logic/decision/decision-collect.js（读内存真相、组装 entries）
//     → logic/decision/decision-rules.js（纯规则，可单测）
//   ⛔ 本文件【不抓数据、不消费猫抓额度】；⛔ 不复用任何其它看板的组件或组合式。
//   ⚠️ [CHART-JUDGE 2026-10-09 用户口径] 唯一例外 = 手动「竞价图形判断」：
//      那是【用户自己输入 + 要持久化】的业务数据（§8 必须上云），不属于「抓数据」。
//      但本文件【依然不直接发请求】—— 读写与状态都在 logic/decision/decision-chart-judge-store.js，
//      本文件只负责「什么时候加载 / 什么时候订阅 / 出错怎么说给用户听」这三件 UI 时机的事
//      （与 useLimitBoard → logic/limitpool/limit-pool.js 同一分工）。
//
// §34：expanded / rulesOpen 是纯展示态 —— 不落 localStorage（§8）、不进全局 store（§6）。
//      ⚠️ 手动判断【不是】展示态：它要跨设备同步，所以进 Logic 层状态 + Supabase（见上）。
// §17：数据刷新（抓取 / 导入 / 收盘覆盖）后要跟着更新，因此监听事件总线 auction-refresh。

import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
import { useUiStore } from '../stores/uiStore.js';
// ⛔ [DROP-VOL-RATIO-PICK 2026-10-07] useAuctionStore 的 import 已删：本看板不再读 topicOrderBy
//   （模式恒为一字）。早盘竞价那份 store 不受影响，它照旧读写同一格。
import { _on, _off } from '../stores/eventBus.js';
import { collectDecisionData } from '../logic/decision/decision-collect.js';
import { showWarningToast } from './useToast.js';
// 🔴 [DROP-VOL-RATIO-PICK 2026-10-07 用户口径] 决策看板【只用一字选股】，「题材·竞价量比」选股已下线。
//   用户原话：「把决策看板中的那个题材，竞价量比选股去掉，这个没有用准确率不高，还会误导，去掉后更加清晰。」
//   ⇒ ① decisionMode 恒为 MODE_YIZI（⛔ 不再读 store 的 topicOrderBy、不再受早盘竞价 toggle 影响）；
//     ② 「切换选股」toggle 连同 switchPickOn / pickModeText / toggleSwitchPick 一并删除。
//   ⛔ Logic 层那套量比规则（decision-rules.js）【代码保留】，只是本看板不再调用 —— 保守优先：
//     日后要恢复，只需把 decisionMode 改回 resolveDecisionMode(store 那一格) 即可。
//   ⚠️ MODE_YIZI 仍从 decision-mode.js 取（§6：模式常量只有一处定义，⛔ 别在 UI 层写字面量）。
import { buildRulesLines, MODE_YIZI } from '../logic/decision/decision-mode.js';
// [CHART-JUDGE 2026-10-09 用户口径] 手动「竞价图形判断」：① 纯映射（把判断套到标签上）
//   ② 状态 + 加载 / 保存 / 订阅。两处都归 Logic 层，本文件不实现任何映射规则（§6 / §21）。
import { applyChartJudge } from '../logic/decision/decision-chart-judge.js';
import {
  chartJudgeState,
  loadChartJudge,
  saveChartJudge,
  startChartJudgeRealtime,
  stopChartJudgeRealtime
} from '../logic/decision/decision-chart-judge-store.js';
// [DRAGON-RANK-CHANGE 2026-10-09 用户口径] 龙标旁边的【名次变化】徽标要一份历史数据
//   （前一交易日的十日涨幅 → 昨日龙位）。本文件只负责【什么时候去取】（§34）；
//   取数 / 计算 / 发布全在 Logic 层（logic/decision/dragon-rank-change-store.js）。
//   ⛔ 依赖方向：composable → store → collect → dragon-rank-change（纯映射），单向，无循环。
import { ensurePrevDragonRank } from '../logic/decision/dragon-rank-change-store.js';

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
  const currentDate = computed(() => uiStore.currentDate);

  /**
   * 🔴 [DROP-VOL-RATIO-PICK 2026-10-07 用户口径] 本看板的买点模式【恒为 MODE_YIZI（一字选股）】。
   *
   * 为什么删掉原先那个「跟 store 的题材 / 一字 toggle 联动」的版本：
   *   用户原话「把决策看板中的那个题材，竞价量比选股去掉，这个没有用准确率不高，还会误导，
   *   去掉后更加清晰。」⇒ 题材（平均竞价量比）选股这条口径整体下线，本看板只剩【一字】一种。
   *
   * ⛔ 因此【不再读 store 的 topicOrderBy】：早盘竞价的「题材 / 一字」toggle 怎么切，
   *   都不再改变决策看板的选股结果（早盘竞价自己那边的排序依旧照常，不受影响）。
   * §6：模式来源改成本常量一处（⛔ 不是把 store 那一格删掉 —— 早盘竞价还在用）；
   *     Logic 层两套规则的代码都留着，恢复只需改回 resolveDecisionMode(store)。
   */
  const decisionMode = computed(function() { return MODE_YIZI; });

  // 规则面板文案：随模式走（现恒为一字模式的老版条文）。⛔ 只在 Logic 层生成（§6 实现与说明同处一处）。
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
    // [CHART-JUDGE 2026-10-09 用户口径] 显式声明对【手动竞价图形判断】的依赖：
    //   判断一变（用户点了一下 / Realtime 从别的设备推过来）⇒ 整块决策重算一次，
    //   标签与说明文字立刻跟着变。⛔ 不用 watch 去「顺便改标签」——那是第二份真相（§6）。
    void chartJudgeState.map;
    const d = currentDate.value;
    if (!d) return _empty('未选择日期');
    try {
      // [TWO-MODES 2026-10-02] 把当前模式传下去 —— 题材排名、买点规则、连板天梯采集全部跟着它走
      const decided = collectDecisionData(d, { mode: decisionMode.value });
      // [CHART-JUDGE 2026-10-09] 最后一步：把用户手动判断覆盖到标签上（默认档一个字节都不动）。
      //   原地写回（collect 每次都返回全新对象，见 applyChartJudge 的注释）。
      return applyChartJudge(decided, chartJudgeState.map);
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

  /**
   * 只重算决策（不碰手动判断）—— 供【事件总线的高频刷新】用。
   *
   * ⚠️ [CHART-JUDGE 2026-10-09] 为什么要把这条从 refresh() 里拆出来：
   *   `auction-refresh` 是【高频事件】—— 早盘 9:25 前后 auction_watchlist / market_metrics 的
   *   每一次 Realtime 变化都会经 useAppBootstrap 转成它（还叠加 morning-sync / auction-sync-pull /
   *   算分流程各自的 emit）。若顺手在里面读一次「竞价图形判断」，就变成「行情每动一下都去云端
   *   读一遍用户的手动判断」—— 那份数据跟行情毫无关系，一秒也不会变（§32 相同数据不得重复请求）。
   */
  function bumpVersion() {
    version.value++;
    errorText.value = '';
  }

  /**
   * 供父级在「刷新」时调用（与早盘竞价 / 涨跌停看板同款契约：defineExpose({ refresh })）。
   * [CHART-JUDGE 2026-10-09] 这条是【用户主动】触发的低频路径，才顺带重读手动判断 ——
   *   用户「刚在 Supabase 里建好建表 SQL」时点一下刷新就能立刻用上，不必整页重载。
   */
  function refresh() {
    bumpVersion();
    reloadChartJudge();
    // [DRAGON-RANK-CHANGE 2026-10-09] 用户主动刷新时也顺带补一次昨日龙位
    //   （store 已算好 / 次数用尽时是 no-op，不会重复请求）
    reloadPrevDragonRank();
  }

  // ══ [CHART-JUDGE 2026-10-09 用户口径] 手动「竞价图形判断」的 UI 时机 ══════════════════════════
  // 本文件只做三件事：① 什么时候加载；② Realtime 通知后重载；③ 失败了怎么让用户知道。
  // 判断值本身、标签映射（符合 ⇒ 竞价买 / 不符 ⇒ 尾盘买）、乐观更新与回滚，
  // 全在 Logic 层（logic/decision/decision-chart-judge*.js），⛔ 本文件一行都不实现（§6 / §21）。
  // §8：判断值存 Supabase（跨设备），⛔ 不用 localStorage 兜。

  /** 错误原文（看板红字直接用；§10 失败必须可见，⛔ 不静默） */
  const chartJudgeError = computed(() => chartJudgeState.error);

  // 同一条错只弹一次 toast：表没建时「切日期 / 收到实时通知」会反复触发加载，
  // 每次都弹会让用户以为出了一堆不同的错（§10 要的是「可见」，不是「刷屏」）。
  let _lastJudgeToast = '';

  function _judgeFailToast(e) {
    const msg = chartJudgeState.error || ('竞价图形判断加载失败：' + ((e && e.message) || e));
    if (msg === _lastJudgeToast) return;
    _lastJudgeToast = msg;
    showWarningToast('❌ ' + msg);
  }

  /** 重新加载当日判断（首次进入 / 日期切换 / 看板刷新 / Realtime 通知共用这一条路径） */
  function reloadChartJudge() {
    return loadChartJudge(currentDate.value).catch(function(e) {
      _judgeFailToast(e);
    });
  }

  // ══ [DRAGON-RANK-CHANGE 2026-10-09 用户口径] 「龙标名次变化」的 UI 时机 ════════════════════════
  // 本文件同样只决定【什么时候去取】：名次差怎么算、昨日龙位从哪来、失败怎么办，
  // 全在 logic/decision/dragon-rank-change*.js（§6 / §21）。⛔ 本文件一行都不实现。
  // §10：取不到就是【不显示徽标】（不猜、也不弹错）—— 它是行情派生的辅助项，不是用户输入的东西；
  //      失败原因由 store 用 console.warn 如实留痕，不占用看板红字（那是留给真正要用户处理的问题的）。
  // §32：这里是【后台补数】，store 内部有单飞 + 冷却 + 次数上限（见该文件 MAX_ATTEMPTS），
  //      所以即使挂在高频事件上也不会变成「行情每动一下就多读一次云端」。
  // §17：不 await（不阻塞渲染）—— 算好之后靠 dragonRankChangeState 换引用自动重算。
  function reloadPrevDragonRank() {
    return ensurePrevDragonRank(currentDate.value, decisionMode.value);
  }

  /**
   * 用户点了选择器某一档 → 落库。
   * §10：保存失败必须【看得见】，并且屏上的值要【回滚】（回滚本身在 Logic 层做，这里负责说清楚）。
   * ⛔ 映射规则不在这里实现：本函数只把 (股票名, 档位) 交给 Logic，标签怎么变由映射表决定。
   *
   * @param {string} name 股票名
   * @param {string} judge 'default' | 'ok' | 'bad'
   * @returns {Promise<void>} 已捕获错误（UI 不因未处理的 rejection 打断渲染）
   */
  function setChartJudge(name, judge) {
    if (!currentDate.value) {
      showWarningToast('未选择日期，无法保存「竞价图形判断」');
      return Promise.resolve();
    }
    return saveChartJudge(currentDate.value, name, judge).then(function() {
      // 保存成功 → 清掉上一次的失败提示（用户接着操作时不该还看到旧错误）
      chartJudgeState.error = '';
      _lastJudgeToast = '';
    }, function(e) {
      const msg = chartJudgeState.error || ('竞价图形判断保存失败：' + ((e && e.message) || e));
      _lastJudgeToast = msg;
      showWarningToast('❌ ' + msg + '（已还原为改之前的值）');
    });
  }

  /** Realtime：别的设备 / 别的标签页改了判断 → 重载（§31 跨设备）。本端自己的保存已在屏上（乐观更新）。 */
  function _onChartJudgeRealtime(payload) {
    if (!payload || !payload.boards || payload.boards === 'all' || payload.boards === 'chartjudge') {
      reloadChartJudge();
    }
  }

  onMounted(function() {
    // §33 首次加载：进来读一次当日判断 + 建立订阅（§31 subscribe 只建一次，onUnmounted 成对清理）
    reloadChartJudge();
    startChartJudgeRealtime();
    // [DRAGON-RANK-CHANGE 2026-10-09] 首次进入补一次【前一交易日龙位表】。
    //   ⚠️ 它可能比首屏的「近 30 天竞价窗口」更早跑完 —— 那种情况下这次会失败（名单未就绪），
    //      由下面的 auction-refresh 分支在数据到货后自动重试（§10：未就绪 ≠ 没有）。
    reloadPrevDragonRank();
  });

  // §26 日期切换 → 规则面板收起（新的一天是全新的结论，旧展开态会误导）
  // [VRATIO-TREND 2026-10-01] 同理把「竞价量比」趋势面板一并收起 —— 换了日期整条曲线都换了，
  //   留着展开态只会让人拿新日期的图去对旧结论。
  // [CHART-JUDGE 2026-10-09] 手动判断也是【按日期】的 ⇒ 换日期必须重读（⛔ 不能把 A 日的判断留在 B 日屏上）。
  watch(currentDate, function() {
    rulesOpen.value = false;
    errorText.value = '';
    trendOpenSet.value = new Set();
    _lastJudgeToast = '';
    reloadChartJudge();
    // [DRAGON-RANK-CHANGE 2026-10-09] 换了展示日 ⇒ 「前一交易日」也换了 ⇒ 必须重新取一份龙位表
    //   （store 内部会先清空上一天的名次，避免把更早一天的名次当成「昨天」算出一个假的变化值）。
    reloadPrevDragonRank();
  });

  // ⛔ [CHART-JUDGE 2026-10-09] 事件总线这条走 bumpVersion【而不是 refresh】：见 bumpVersion 的注释
  //   —— auction-refresh 是高频事件，而手动判断与行情无关，绝不能跟着一起读云端（§32）。
  const _onRefresh = function() {
    bumpVersion();
    // [DRAGON-RANK-CHANGE 2026-10-09] 首屏「近 30 天竞价窗口」到货后会发 auction-refresh ——
    //   这正是「onMounted 那次抢跑了」之后的自愈时机。⚠️ 它是【高频事件】，
    //   所以 store 内部有单飞 + 8 秒冷却 + 每日 8 次上限（§32），这里放心调用：
    //   已算好 / 冷却中 / 次数用尽 ⇒ 立即返回，一次请求都不会发。
    reloadPrevDragonRank();
  };
  _on('auction-refresh', _onRefresh);
  _on('data:realtime-update', _onChartJudgeRealtime);
  onUnmounted(function() {
    _off('auction-refresh', _onRefresh);
    _off('data:realtime-update', _onChartJudgeRealtime);
    // §31 配对清理：本看板持有的 channel 由本看板关掉（⛔ 不留给下一个页面）
    stopChartJudgeRealtime();
  });

  return {
    expanded,
    rulesOpen,
    compactOpen,
    // [TWO-MODES 2026-10-02] 当前买点模式（由题材 / 一字这个排序口径决定）+ 配套的规则面板文案。
    //   rulesLines 随模式切换 ⇒ 一字模式点开问号看到的是【老版条文】，量比模式看到现行条文。
    decisionMode,
    rulesLines,
    // 🔴 [DROP-VOL-RATIO-PICK 2026-10-07 用户口径] 原「切换选股」开关三件套
    //   （switchPickOn / pickModeText / toggleSwitchPick）已随【题材·竞价量比选股】一并下线：
    //   本看板现在只有【一字】一种选股口径，不再需要开关。
    // [VRATIO-TREND 2026-10-01] 竞价量比趋势面板的展开态与开关（由 DecisionBoard.vue provide 给买卖点两个块组件）
    trendOpenSet,
    errorText,
    // [CHART-JUDGE 2026-10-09 用户口径] 手动「竞价图形判断」对外的两个口子：
    //   · chartJudgeError —— 加载 / 保存失败的原文（看板红字用；§10 失败必须可见）
    //   · setChartJudge   —— 用户在行内选择器上点某一档时调用（落库 + 乐观更新 + 失败回滚都在 Logic 层）
    //   ⛔ 不把整份 chartJudgeState 抛出去：组件只该知道「这一行的当前档位」（已由行数据给出），
    //      拿到整张 map 会诱导组件自己去查名字 → 又一处口径（§6 单一真相）。
    chartJudgeError,
    setChartJudge,
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
