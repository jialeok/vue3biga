import { state } from './app-state.js';

export function clearPushDebounceTimer() {
  if (typeof window !== 'undefined' && state._pushDebounceTimer) {
    clearTimeout(state._pushDebounceTimer);
    state._pushDebounceTimer = null;
  }
}