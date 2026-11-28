<!--
  TvrbDevTrend.vue — 「官方偏离值 · 5 日趋势」展开图（只在用户点开徽标时才挂载）

  【用户口径 2026-11-28】
    「在题材量比的选股侧的买点和卖点侧的股票下面添加官方偏离值的趋势图，五日的……
      上面是竞价口径，下面是收盘口径。五日曲线图，连在一起。比如小标签是 10 日，就做
      10 日偏离值的……如果逼近红线用橙色，触发用红色。」

  【职责边界（§3 / §21）】
    · 本组件只负责【画】：点位、颜色档、红线、日期全部由 Logic 层
      `logic/auction/deviation-trend.js` 算好，模板里没有任何阈值判断；
    · 取数走 Logic 层 `loadDeviationTrend()`（内部再走 Data 层），⛔ 组件不碰 Supabase；
    · 默认收起：父组件用 v-if 控制挂载，所以「没点开 = 零请求、零 DOM、零计算」；
    · §10：读失败 / 判不出 ⇒ 如实显示原因，⛔ 不画一条 0 线冒充「没有异动」。

  【性能】
    · 挂在行下方，一张图最多 5 个点 × 2 条曲线 = 10 个圆点，纯 SVG + 绝对定位，
      不引入任何图表库、不建定时器、不建 Realtime；
    · Logic 层有会话缓存：同一只票同一天同一窗口反复展开 = 0 请求 0 计算。
-->
<template>
  <div class="tvrb-devt">
    <div class="tvrb-devt-head">
      <span class="tvrb-devt-t">官方偏离值 5 日趋势</span>
      <span class="tvrb-devt-win">{{ windowLabel }}<template v-if="thrText"> · 红线 {{ thrText }}</template></span>
      <span
        class="tvrb-devt-x"
        title="收起趋势图"
        @click.stop="$emit('close')"
      >×</span>
    </div>

    <div
      v-if="loading"
      class="tvrb-devt-state"
    >
      读取中…
    </div>
    <div
      v-else-if="errorText"
      class="tvrb-devt-state tvrb-devt-err"
    >
      {{ errorText }}
    </div>
    <template v-else>
      <!-- 上半：竞价口径 -->
      <div class="tvrb-devt-sec">
        <span class="tvrb-devt-cap">竞价口径</span>
        <div class="tvrb-devt-plot">
          <svg
            class="tvrb-devt-svg"
            viewBox="0 0 100 40"
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <line
              v-if="thrY !== null"
              class="tvrb-devt-thr"
              x1="0"
              :y1="thrY"
              x2="100"
              :y2="thrY"
            />
            <polyline
              v-for="(seg, si) in auctionSegments"
              :key="'a' + si"
              class="tvrb-devt-line"
              :class="'tvrb-devt-' + seg.tone"
              :points="seg.points"
            />
          </svg>
          <i
            v-for="(p, i) in auctionDots"
            :key="'ad' + i"
            class="tvrb-devt-dot"
            :class="'tvrb-devt-' + p.tone"
            :style="{ left: p.x + '%', top: p.y + '%' }"
            :title="p.date + ' 竞价口径 ' + (p.ok ? p.text : '判不出')"
          />
          <span
            v-for="(p, i) in auctionDots"
            :key="'av' + i"
            class="tvrb-devt-v"
            :class="'tvrb-devt-' + p.tone"
            :style="{ left: p.vx + '%', top: p.y + '%' }"
          >{{ p.ok ? p.text : '—' }}</span>
        </div>
      </div>

      <!-- 下半：收盘口径 -->
      <div class="tvrb-devt-sec">
        <span class="tvrb-devt-cap">收盘口径</span>
        <div class="tvrb-devt-plot">
          <svg
            class="tvrb-devt-svg"
            viewBox="0 0 100 40"
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <line
              v-if="thrY !== null"
              class="tvrb-devt-thr"
              x1="0"
              :y1="thrY"
              x2="100"
              :y2="thrY"
            />
            <polyline
              v-for="(seg, si) in closeSegments"
              :key="'c' + si"
              class="tvrb-devt-line"
              :class="'tvrb-devt-' + seg.tone"
              :points="seg.points"
            />
          </svg>
          <i
            v-for="(p, i) in closeDots"
            :key="'cd' + i"
            class="tvrb-devt-dot"
            :class="'tvrb-devt-' + p.tone"
            :style="{ left: p.x + '%', top: p.y + '%' }"
            :title="p.date + ' 收盘口径 ' + (p.ok ? p.text : '判不出')"
          />
          <span
            v-for="(p, i) in closeDots"
            :key="'cv' + i"
            class="tvrb-devt-v"
            :class="'tvrb-devt-' + p.tone"
            :style="{ left: p.vx + '%', top: p.y + '%' }"
          >{{ p.ok ? p.text : '—' }}</span>
        </div>
      </div>

      <!-- 日期轴 + 图例 -->
      <div class="tvrb-devt-foot">
        <span class="tvrb-devt-dates">
          <span
            v-for="(d, i) in dates"
            :key="'dt' + i"
            class="tvrb-devt-date"
          >{{ d.slice(5) }}</span>
        </span>
        <span class="tvrb-devt-legend">
          <i class="tvrb-devt-lg tvrb-devt-lg-near" />逼近
          <i class="tvrb-devt-lg tvrb-devt-lg-severe" />触发
        </span>
      </div>
      <div
        v-if="noteText"
        class="tvrb-devt-state"
      >
        {{ noteText }}
      </div>
    </template>
  </div>
</template>

<script setup>
import { ref, computed, watch } from 'vue';
import { loadDeviationTrend } from '../../logic/auction/deviation-trend.js';

const props = defineProps({
  /** 股票名（`stock_daily_pct` / `market_metrics` 的唯一键之一） */
  stock: { type: String, required: true },
  /** 6 位代码（决定对应哪只官方指数；空 ⇒ 直接如实报错） */
  code: { type: String, default: '' },
  /** 徽标上是哪一档：10 / 30（由 Logic 层 `deviationBadgeWindow` 给，⛔ 组件不判） */
  days: { type: Number, default: 10 },
  /** 窗口末日（历史复盘 = 那一天的日期） */
  asOf: { type: String, default: '' }
});
defineEmits(['close']);

const loading = ref(true);
const errorText = ref('');
const trend = ref(null);
let _seq = 0;

const windowLabel = computed(() => (props.days === 30 ? '30 日窗口' : '10 日窗口'));

const pointsOf = (key) => ((trend.value && Array.isArray(trend.value[key])) ? trend.value[key] : []);
const dates = computed(() => ((trend.value && trend.value.dates) || []));
const thrText = computed(() => (trend.value && trend.value.thrText) || '');
const noteText = computed(() => (trend.value && trend.value.note) || '');

/** 统一的纵轴范围：两条曲线共用一把尺子（含红线，才能看出「离红线还有多远」） */
const domain = computed(() => {
  const t = trend.value;
  const vals = [];
  ['auction', 'close'].forEach((k) => {
    pointsOf(k).forEach((p) => { if (p.ok && p.dev !== null) vals.push(p.dev); });
  });
  if (vals.length === 0) return { lo: 0, hi: 1 };
  let lo = Math.min.apply(null, vals.concat([0]));
  let hi = Math.max.apply(null, vals.concat([0]));
  const thr = t ? t.thr : null;
  if (thr !== null && thr !== undefined && isFinite(Number(thr))) {
    if (Number(thr) >= 0) hi = Math.max(hi, Number(thr));
    else lo = Math.min(lo, Number(thr));
  }
  const pad = Math.max(1, (hi - lo) * 0.15);
  return { lo: lo - pad, hi: hi + pad };
});

/** 值 → 纵轴百分比（0 = 顶部，100 = 底部） */
function yPctOf(dev) {
  const d = domain.value;
  const span = d.hi - d.lo;
  if (!(span > 0)) return 50;
  return Math.min(100, Math.max(0, ((d.hi - dev) / span) * 100));
}

/** 一根曲线 → 圆点（带 x/y 百分比）；vx = 数值文字的横向位置（首尾夹住，避免溢出到口径标题上） */
function dotsOf(key) {
  const list = pointsOf(key);
  const n = Math.max(1, list.length - 1);
  return list.map((p, i) => {
    const x = (i / n) * 100;
    return {
      date: p.date,
      ok: p.ok,
      text: p.text,
      tone: p.tone || 'muted',
      x: x,
      vx: Math.min(90, Math.max(10, x)),
      y: p.ok && p.dev !== null ? yPctOf(p.dev) : 50
    };
  });
}

/**
 * 一根曲线 → 折线【逐段着色】：相邻两点成一段，颜色取后一点自己的色阶。
 * 判不出的点 ⇒ 那一段直接断开（⛔ 不跨着连，也不拿 0 冒充）。
 */
function segmentsOf(key) {
  const list = pointsOf(key);
  const n = Math.max(1, list.length - 1);
  const segs = [];
  for (let i = 1; i < list.length; i++) {
    const a = list[i - 1];
    const b = list[i];
    if (!(a.ok && a.dev !== null && b.ok && b.dev !== null)) continue;
    const x1 = ((i - 1) / n) * 100;
    const y1 = (yPctOf(a.dev) / 100) * 40;
    const x2 = (i / n) * 100;
    const y2 = (yPctOf(b.dev) / 100) * 40;
    segs.push({
      tone: b.tone || 'muted',
      points: x1.toFixed(2) + ',' + y1.toFixed(2) + ' ' + x2.toFixed(2) + ',' + y2.toFixed(2)
    });
  }
  return segs;
}

const auctionDots = computed(() => dotsOf('auction'));
const closeDots = computed(() => dotsOf('close'));
const auctionSegments = computed(() => segmentsOf('auction'));
const closeSegments = computed(() => segmentsOf('close'));
const thrY = computed(() => {
  const t = trend.value;
  if (!t || t.thr === null || t.thr === undefined || !isFinite(Number(t.thr))) return null;
  return (yPctOf(Number(t.thr)) / 100) * 40;
});

async function load() {
  const my = ++_seq;
  loading.value = true;
  errorText.value = '';
  const res = await loadDeviationTrend({
    name: props.stock,
    code: props.code,
    windowDays: props.days === 30 ? 30 : 10,
    asOf: props.asOf
  });
  if (my !== _seq) return;              // 组件已换票 / 已卸载
  if (!res || res.ok !== true) {
    errorText.value = (res && res.error) || '偏离值趋势读取失败';
    trend.value = null;
  } else {
    trend.value = res.trend;
  }
  loading.value = false;
}

watch(
  () => [props.stock, props.code, props.days, props.asOf],
  () => { load(); },
  { immediate: true }
);
</script>
