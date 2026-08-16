<template>
  <svg
    :viewBox="`0 0 ${width} ${height + 12}`"
    style="width:100%; height:auto; display:block;"
  >
    <line
      v-if="zeroLine"
      :x1="zeroLine.x1"
      :y1="zeroLine.y1"
      :x2="zeroLine.x2"
      :y2="zeroLine.y2"
      stroke="#cbd5e1"
      stroke-width="1"
      stroke-dasharray="2,2"
    />
    <path
      v-for="(d, i) in pathDs"
      :key="'p' + i"
      :d="d"
      fill="none"
      :stroke="color"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
    <circle
      v-for="(dot, i) in dots"
      :key="'d' + i"
      :cx="dot.cx"
      :cy="dot.cy"
      r="2.6"
      :fill="dot.color"
    />
    <text
      v-for="(lbl, i) in valueLabels"
      :key="'v' + i"
      :x="lbl.x"
      :y="lbl.y"
      font-size="9"
      :fill="lbl.color"
      text-anchor="middle"
      font-weight="600"
    >{{ lbl.text }}</text>
    <text
      v-for="(lbl, i) in dateLabels"
      :key="'dt' + i"
      :x="lbl.x"
      :y="lbl.y"
      font-size="8.5"
      fill="#94a3b8"
      text-anchor="middle"
    >{{ lbl.text }}</text>
  </svg>
</template>

<script setup>
import { computed } from 'vue';

const props = defineProps({
  points: { type: Array, default: () => [] },
  color: { type: String, default: '#f59e0b' },
  percent: { type: Boolean, default: false },
  // [FEAT 2026-08-17] 每点水平间距（px）。不传或 <=0 时使用原固定宽度 320（向后兼容周统计等）。
  // 传较大值（如 44）时，宽度随点数动态增长，配合外层 overflow-x:auto 容器实现横向滑动，
  // 解决月统计「天数多→文字密麻看不清」的问题（用户需求）。
  pointSpacing: { type: Number, default: 0 }
});

// 动态宽度：有 pointSpacing 时按点数计算，否则保持原 320 固定宽（§15 向后兼容）。
const isDynamic = computed(() => props.pointSpacing > 0);
const dynamicWidth = computed(() => {
  if (!isDynamic.value) return 320;
  const n = props.points.length;
  return Math.max(320, paddingX * 2 + props.pointSpacing * Math.max(n - 1, 1));
});
const width = computed(() => dynamicWidth.value);
const height = 56;
const paddingX = 28;
const paddingTop = 16;
const paddingBottom = 8;

const isPercent = computed(() => props.percent);

const validValues = computed(() => props.points.filter(p => p.value !== null).map(p => p.value));
const maxV = computed(() => validValues.value.length ? Math.max(...validValues.value) : 1);
const minV = computed(() => {
  let v = validValues.value.length ? Math.min(...validValues.value) : 0;
  if (isPercent.value) v = Math.min(v, 0);
  return v;
});
const maxVAdj = computed(() => isPercent.value ? Math.max(maxV.value, 0) : maxV.value);
const range = computed(() => (maxVAdj.value - minV.value) || 1);

const n = computed(() => props.points.length);
const stepX = computed(() => (width.value - paddingX * 2) / (n.value - 1 || 1));

const coords = computed(() => {
  return props.points.map((p, i) => {
    const x = paddingX + stepX.value * i;
    if (p.value === null) return { x, y: null };
    const y = paddingTop + (height - paddingTop - paddingBottom) * (1 - (p.value - minV.value) / range.value);
    return { x: x.toFixed(1), y: y.toFixed(1) };
  });
});

const zeroLine = computed(() => {
  if (!isPercent.value || minV.value >= 0 || maxVAdj.value <= 0) return null;
  const zeroY = paddingTop + (height - paddingTop - paddingBottom) * (1 - (0 - minV.value) / range.value);
  return {
    x1: paddingX.toFixed(1),
    y1: zeroY.toFixed(1),
    x2: (width.value - paddingX).toFixed(1),
    y2: zeroY.toFixed(1)
  };
});

const pathDs = computed(() => {
  const segments = [];
  let currentSeg = [];
  coords.value.forEach(c => {
    if (c.y === null) {
      if (currentSeg.length > 1) segments.push(currentSeg);
      currentSeg = [];
    } else {
      currentSeg.push(c);
    }
  });
  if (currentSeg.length > 1) segments.push(currentSeg);
  return segments.map(seg =>
    seg.map((c, i) => (i === 0 ? 'M' : 'L') + c.x + ',' + c.y).join(' ')
  );
});

const dots = computed(() => {
  const result = [];
  coords.value.forEach((c, i) => {
    if (c.y === null) return;
    let dotColor = props.color;
    if (isPercent.value) {
      const v = props.points[i].value;
      dotColor = v > 0 ? '#dc2626' : (v < 0 ? '#16a34a' : '#64748b');
    }
    result.push({ cx: c.x, cy: c.y, color: dotColor });
  });
  return result;
});

const valueLabels = computed(() => {
  const result = [];
  coords.value.forEach((c, i) => {
    const p = props.points[i];
    if (p.value === null) {
      result.push({ x: c.x, y: String(paddingTop - 4), color: '#cbd5e1', text: '--' });
      return;
    }
    let displayVal, labelColor;
    if (isPercent.value) {
      const v = p.value;
      displayVal = (v > 0 ? '+' : '') + v.toFixed(1) + '%';
      labelColor = v > 0 ? '#dc2626' : (v < 0 ? '#16a34a' : '#64748b');
    } else {
      displayVal = String(Math.round(p.value));
      labelColor = props.color;
    }
    result.push({ x: c.x, y: (parseFloat(c.y) - 6).toFixed(1), color: labelColor, text: displayVal });
  });
  return result;
});

const dateLabels = computed(() => {
  return coords.value.map((c, i) => {
    const parts = (props.points[i].date || '').split('-');
    const text = parts.length >= 3 ? parts[1] + '-' + parts[2] : '';
    return { x: c.x, y: String(height + 2), text };
  });
});
</script>