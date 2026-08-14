// §19/§31 响应式化：pattern 数据的响应式视图层（独占领地 pattern/，不触碰 app-state.js）
//
// 背景：pattern 真实缓存位于 state._patternMemCache（普通对象，非 reactive），
// 由 remaining-boards.js 的 Realtime 订阅在 pattern_data 变化时写回并 emit('board-refresh')。
// 原 PatternBoard 把缓存值拷进本地 ref，导致 Realtime 写入后 UI 不刷新（A9-03）。
//
// 本模块提供：
//   - reactive 的 byDate 容器（compute 依赖它，满足「pattern 数据经 reactive 状态/store 暴露，compute 依赖它」）
//   - 模块级订阅 EventBus('board-refresh')，Realtime 写入后重新从缓存同步，驱动 UI 刷新（§31 模块级统一管理）
//   - 本页保存时通过 setPatternReactive 立即乐观更新（§31：自己保存立即更新自己 Store，不等 Realtime）
import { reactive } from 'vue';
import { getPatternData } from './pattern.js';
import { _on } from '../../stores/eventBus.js';

const store = reactive({
  byDate: {},
});

// 从真实缓存（state._patternMemCache）重新同步到响应式 store，
// 处理新增与删除的日期，避免 store 与缓存不一致（§6 单一真相）。
export function hydratePatternStore() {
  const data = getPatternData() || {};
  const keys = Object.keys(data);
  for (const k of Object.keys(store.byDate)) {
    if (!keys.includes(k)) delete store.byDate[k];
  }
  for (const date of keys) {
    const p = data[date] || {};
    store.byDate[date] = { content: p.content || '', update: !!p.update, keep: !!p.keep };
  }
}

// 本页保存后立即乐观写入响应式 store（§31：不等待 Realtime 才显示）。
export function setPatternReactive(date, val) {
  if (!date) return;
  store.byDate[date] = { content: val.content || '', update: !!val.update, keep: !!val.keep };
}

export function getPatternStore() {
  return store;
}

// 模块级订阅：remaining-boards 在 pattern_data Realtime 变化后 emit('board-refresh')，
// 此处统一接收并重新同步，保证 UI 随 Realtime 刷新（§31 模块级统一管理，避免重复订阅）。
_on('board-refresh', hydratePatternStore);
