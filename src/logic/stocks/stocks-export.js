// stocks-export.js — 导出「当前日期」的股票数据为 JSON 文件（Logic 层）
//
// 【为什么单独搬到 Logic 层 / 2026-10-26】
//   这个导出原本内联在 `composables/useHomeStocksState.js#exportData()` 里 ——
//   而那一整套（自选股：统计小方框 / 列表 / 添加·编辑弹窗）已按用户要求整体下线。
//   但底部操作栏的 📤 导出按钮用户明确要求「全部保留」。
//   如果沿用旧实现（`stocksRef.value.exportData()`），stocksRef 会恒为 null
//   ⇒ 按钮点了毫无反应 —— 那是「静默失败」，违反 §10。
//   ⇒ 把这段「只依赖 Data 的纯导出」搬到 Logic 层，UI 只管触发 + toast：
//        UI（DashboardView.onExport）→ Logic（本模块）→ Data（getStocksData）
//   ⛔ 语义逐字保持不变：导出内容、文件名、触发方式与旧版完全一致。
import { getStocksData } from '../../data/supabase-client.js';
import { getCurrentDate } from '../app-core.js';

/**
 * 导出当前日期的股票数据（浏览器下载 JSON）。
 * 纯副作用函数：不写库、不改内存状态（§6 只读）。
 *
 * @returns {{ok:boolean, date:string, count:number, reason?:string}}
 *   调用方据此决定 toast 文案 —— 拿不到数据时如实返回 ok:false，⛔ 不伪装成功。
 */
export function exportStocksData() {
  const date = getCurrentDate();
  let allData;
  try {
    allData = getStocksData();
  } catch (e) {
    return { ok: false, date: date, count: 0, reason: (e && e.message) || '读取本地缓存失败' };
  }
  // §10：读不到 就 如实报错，绝不拿空对象当"已导出"
  if (!allData || typeof allData !== 'object') {
    return { ok: false, date: date, count: 0, reason: '本地缓存尚未就绪' };
  }

  const list = Array.isArray(allData[date]) ? allData[date] : [];
  const json = JSON.stringify(allData, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'stocks-export-' + date + '.json';
  a.click();
  URL.revokeObjectURL(url);
  return { ok: true, date: date, count: list.length };
}
