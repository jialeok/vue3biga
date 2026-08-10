/**
 * eventBus.js — 事件总线（迁移批次 3.5）
 * 基于 mitt，向后兼容 window._emit / window._on / window._off
 * 用于 data/logic 层向 ui 层发通知，避免跨层直接调用
 */
import mitt from 'mitt';

const emitter = mitt();

export function _emit(event, data) {
  emitter.emit(event, data);
}

export function _on(event, handler) {
  emitter.on(event, handler);
}

export function _off(event, handler) {
  emitter.off(event, handler);
}


export default emitter;
