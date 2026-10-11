// useTopicVolRatioBoard.js — 「题材量比」看板的组合式（§14 UI 瘦身 / §34 UI 状态与业务数据分离）
//
// 分层（§2）：
//   views/TopicVolRatioBoard.vue（模板）→ 本文件（UI 状态 + 触发重算的时机）
//     → logic/decision/decision-collect.js#collectDecisionTopics（读内存真相：题材块 + 龙位名册）
//     → logic/topicvolratio/topic-vol-ratio-rules.js（纯规则，可单测）
//   ⛔ 本文件【不抓数据、不落库、不消费猫抓额度】：只在早盘竞价已有的内存数据上选股。
//   ⛔ 本文件【也不读任何其它看板的 store / 组件】—— 与决策看板 / 分笔看板彻底解耦。
//
// §34：expanded / rulesOpen / compactOpen / trendOpenSet 都是纯展示态 ——
//      不落 localStorage（§8）、不进全局 store（§6）。
// §17：数据刷新（抓取 / 导入 / 收盘覆盖）后要跟着更新，因此监听事件总线 auction-refresh。
//      ⚠️ collectDecisionTopics 读的 getTodayGroupList 是【非响应式内存缓存】⇒
//         必须靠下面的 version 手动信号驱动重算（与决策看板 useDecisionBoard 同一套路）。

import { ref, computed, watch, onUnmounted } from 'vue';
import { useUiStore } from '../stores/uiStore.js';
import { _on, _off } from '../stores/eventBus.js';
import { collectDecisionTopics } from '../logic/decision/decision-collect.js';
// §6：题材组序口径的常量只有一处定义（decision-mode.js），⛔ 别在本文件写字面量 'volRatio'。
import { MODE_VOL_RATIO } from '../logic/decision/decision-mode.js';
import {
  buildTopicVolRatioPlan,
  buildTvrbRulesLines
} from '../logic/topicvolratio/topic-vol-ratio-rules.js';

/** §10：任何一次「未就绪 / 失败」都要【可见】，绝不静默成「今天没有入选股票」 */
function _empty(reason) {
  return {
    ready: false,
    reason: reason,
    plan: { topics: [], blocks: [], excludedTopics: [], notes: [], pickCount: 0 }
  };
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

  // 「竞价量比 近 5 日」趋势面板的展开态：Set<股票名>。
  // 用名字而不是下标（翻页 / 刷新后下标会漂移）；换【引用】驱动重渲染（§20 不做 deep watch）。
  const trendOpenSet = ref(new Set());

  // 手动版本号：auction 数据刷新后 bump，让下面的 computed 重跑一次（见文件头 §17 注释）。
  const version = ref(0);
  const errorText = ref('');

  const data = computed(function() {
    void version.value;                 // 显式声明对刷新信号的依赖
    const d = currentDate.value;
    if (!d) return _empty('未选择日期');
    try {
      // [TVRB] 题材排名恒为「平均竞价量比降序」⇒ 模式固定传 MODE_VOL_RATIO
      //   （⛔ 不跟早盘竞价的「题材 / 一字」toggle 联动：本看板的定义就是按量比排）。
      const rec = collectDecisionTopics(d, { mode: MODE_VOL_RATIO });
      if (!rec || !rec.ready) return _empty((rec && rec.reason) || '暂无数据');
      const plan = buildTopicVolRatioPlan(rec.topics, rec.dragonMap, { date: d });
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
  const notes = computed(() => (data.value.plan ? data.value.plan.notes : []));
  const excludedTopics = computed(() => (data.value.plan ? data.value.plan.excludedTopics : []));
  const pickCount = computed(() => (data.value.plan ? data.value.plan.pickCount : 0));

  const summaryText = computed(function() {
    if (!ready.value) return reasonText.value;
    if (pickCount.value === 0) return '今日无入选股票';
    return '题材 ' + blocks.value.length + ' 个 · 选 ' + pickCount.value + ' 只';
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
   * 点【序号 / 股票名】展开或收起该股的「竞价量比 近 5 日」趋势。
   * §34：只动纯展示态，不碰业务数据、不发请求。
   * @param {string} name 股票名
   */
  function toggleTrend(name) {
    const key = String(name || '').trim();
    if (!key) return;
    const next = new Set(trendOpenSet.value);
    if (next.has(key)) next.delete(key); else next.add(key);
    trendOpenSet.value = next;   // 换引用 → 驱动重渲染
  }

  /** 只重算（供事件总线的高频刷新用；不碰任何展示态） */
  function bumpVersion() {
    version.value++;
    errorText.value = '';
  }

  /** 供父级在「刷新」时调用（与其它看板同款契约：defineExpose({ refresh })） */
  function refresh() {
    bumpVersion();
  }

  // §26 日期切换 → 规则面板 / 趋势面板收起（新的一天是全新的结论，旧展开态会误导）
  watch(currentDate, function() {
    rulesOpen.value = false;
    errorText.value = '';
    trendOpenSet.value = new Set();
  });

  // §17 数据刷新（早盘竞价抓取 / 导入 / 收盘覆盖）→ 重算。
  //   本看板只用内存数据，不需要额外的图表判断 / 封单窗口，所以这里只 bump 版本号。
  const _onRefresh = function() { bumpVersion(); };
  _on('auction-refresh', _onRefresh);
  // §31 成对清理：本看板订阅的事件由本看板退订（⛔ 不留给下一个页面）
  onUnmounted(function() {
    _off('auction-refresh', _onRefresh);
  });

  return {
    expanded,
    rulesOpen,
    compactOpen,
    rulesLines,
    trendOpenSet,
    errorText,
    ready,
    reasonText,
    blocks,
    notes,
    excludedTopics,
    pickCount,
    summaryText,
    toggleExpand,
    toggleCompact,
    setRulesOpen,
    toggleTrend,
    refresh
  };
}
