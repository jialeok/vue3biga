import { state } from './app-state.js';

export function getCurrentFilter() {
  return state.currentFilter;
}
export function setCurrentFilter(filter) {
  state.currentFilter = filter;
}
export function getIsStockListCollapsed() {
  return !!state.isStockListCollapsed;
}
export function setIsStockListCollapsed(val) {
  state.isStockListCollapsed = val;
}