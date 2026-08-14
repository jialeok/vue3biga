/**
 * date-helpers.js — 纯日期工具（§16 域拆分：从 app-core.js 抽离）
 *
 * 这些函数不依赖任何业务状态 / 网络 / Pinia，纯本地日期运算，
 * 因此可安全地从巨型模块 app-core.js 迁到独立域模块。
 *
 * app-core.js 通过 `import` 引入（供内部调用）并 `export ... from` 再导出
 * （供 PatternBoard.vue 等现有调用点零破坏地继续从 app-core 取用）。
 */

// 获取星期几
export function getWeekday(d) {
  return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][new Date(d).getDay()];
}

// 获取前一天日期
export function getPreviousDate(date) {
  const d = new Date(date);
  d.setDate(d.getDate() - 1);
  return d.toISOString().split('T')[0];
}

// 获取后一天日期
export function getNextDate(date) {
  const d = new Date(date);
  d.setDate(d.getDate() + 1);
  return d.toISOString().split('T')[0];
}

// 日期字符串偏移 n 天（本地零时，避免时区漂移）
export function _shiftDateStr(dayStr, n) {
  var d = new Date(dayStr + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

// 基于 todayList（当前显示的表格）构建 yesterdayList
// 保留 auctionData[yesterday] 原有同名股票的业务字段（volume/yestVolume/note 等）
// 这是用户的核心需求：不管股票怎么导入的，只要表格里显示了，就是获取数据的基础
export function buildYesterdayListFromToday(todayList, auctionData, yesterday) {
  const existingYesterdayMap = {};
  (auctionData[yesterday] || []).forEach(function (s) {
    if (s && s.stock) existingYesterdayMap[s.stock.trim()] = s;
  });
  return todayList.map(function (s) {
    const name = (s.stock || '').trim();
    const existing = existingYesterdayMap[name];
    return {
      stock: s.stock,
      code: (s.code || (existing ? (existing.code || '') : '') || '').trim(),
      volume: existing ? (existing.volume || '') : '',
      yestVolume: existing ? (existing.yestVolume || '') : '',
      note: existing ? (existing.note || '') : '',
      changePct: existing ? (existing.changePct || '') : '',
      topics: existing ? (existing.topics || '') : '',
      selected: existing ? existing.selected : false,
      bought: existing ? existing.bought : false,
      sold: existing ? existing.sold : false,
      fixed: existing ? existing.fixed : false
    };
  });
}
