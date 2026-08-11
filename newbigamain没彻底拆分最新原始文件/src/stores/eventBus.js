/**
 * eventBus.js — 简单事件总线
 * 用于 data/logic 层向 ui 层发通知，避免跨层直接调用
 */
window._eventBus = window._eventBus || {};
window._eventListeners = window._eventListeners || {};

export function _emit(event, data) {
    const listeners = window._eventListeners[event];
    if (!listeners) return;
    for (let i = 0; i < listeners.length; i++) {
        try { listeners[i](data); } catch (e) { console.warn('[eventBus] ' + event + ' handler error:', e); }
    }
}

export function _on(event, handler) {
    if (!window._eventListeners[event]) window._eventListeners[event] = [];
    window._eventListeners[event].push(handler);
}

export function _off(event, handler) {
    const listeners = window._eventListeners[event];
    if (!listeners) return;
    const idx = listeners.indexOf(handler);
    if (idx >= 0) listeners.splice(idx, 1);
}