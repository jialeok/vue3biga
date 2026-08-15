// 竞价编辑模态框（AuctionEditModal.vue）的纯逻辑助手
//
// 本文件只做「数据与字符串变换」，不依赖 Vue、不引入 window 业务全局（§16）、
// 不写 localStorage（§8），也不直接操作 DOM。所有副作用（落库、store 刷新、
// 弹窗提示、云推送）仍由调用方组件负责，从而保证 UI 行为 / 用户流程完全不变。
//
// 这里的函数都是纯函数或可预测的就地变换，便于在 Logic 层集中维护（§15 可维护性）。

import { parseNoteToFields } from '../note/helpers.js';

/**
 * 把当日竞价分组列表（getTodayGroupList('auction') 的结果）转换为可编辑行。
 * 与组件原 refreshRows() 的 map 完全一致。
 * @param {Array} groupList 竞价分组列表
 * @returns {Array<{stock:string, volume:string, yestVolume:string}>}
 */
export function buildAuctionRows(groupList) {
  const list = Array.isArray(groupList) ? groupList : [];
  return list.map(item => ({
    stock: item.stock || '',
    volume: item.volume || '',
    yestVolume: item.yestVolume || ''
  }));
}

/**
 * 从编辑行构造保存负载：过滤掉名称为空的行，并对名称做 trim。
 * 与组件原 save() 内联的 forEach 推送逻辑完全一致。
 * @param {Array} editRows 编辑行数组
 * @returns {Array<{stock:string, volume:string, yestVolume:string}>}
 */
export function buildAuctionSaveList(editRows) {
  const rows = Array.isArray(editRows) ? editRows : [];
  const out = [];
  rows.forEach(row => {
    if (row.stock && row.stock.trim()) {
      out.push({
        stock: row.stock.trim(),
        volume: row.volume || '',
        yestVolume: row.yestVolume || ''
      });
    }
  });
  return out;
}

/**
 * 判定接口进度文本是否为终止消息（含 ✅ 成功 或 ❌ 失败）。
 * 与组件原 isTerminal() 完全一致。
 * @param {string} msg
 * @returns {boolean}
 */
export function isTerminalStatus(msg) {
  return typeof msg === 'string' && (msg.indexOf('✅') >= 0 || msg.indexOf('❌') >= 0);
}

/**
 * 从 apiStatusMap 条目读取进度文本。
 * 与组件原 statusMsg() 的查表逻辑一致（条目为空时返回 ''）。
 * @param {*} entry apiStatusMap[elId]
 * @returns {string}
 */
export function apiStatusMsg(entry) {
  return entry ? entry.msg : '';
}

/**
 * 从 apiStatusMap 条目读取成功 / 失败样式类。
 * 与组件原 statusCls() 一致：ok 仅当 entry.ok === true，err 仅当 entry.ok === false。
 * @param {*} entry apiStatusMap[elId]
 * @returns {{ok:boolean, err:boolean}}
 */
export function apiStatusCls(entry) {
  return { ok: !!(entry && entry.ok === true), err: !!(entry && entry.ok === false) };
}

/**
 * 计算「清除题材」结果：
 *  - 原地修改命中项（去掉 note 中的 (...) 括号内容、topics 置空、重新解析 changePct）；
 *  - 返回 { clearCount, patch }，patch 与组件原 _clearAllConcepts() 构造完全一致。
 *
 * 注意：patch 覆盖 existingList 中所有「有股票名」的项（与原版一致），
 * 其中未命中的项也会带上 topics:''，这是为了严格还原原版行为，不要「顺手修复」。
 *
 * @param {Array} existingList auctionData[targetDate]（会被原地修改）
 * @returns {{clearCount:number, patch:Array}}
 */
export function computeConceptClear(existingList) {
  const list = Array.isArray(existingList) ? existingList : [];
  let clearCount = 0;
  list.forEach(item => {
    if ((item.note && item.note.includes('(')) || item.topics) {
      let newNote = item.note || '';
      newNote = newNote.replace(/\(([^)]+)\)/g, '');
      item.note = newNote;
      item.topics = '';
      const parsed = parseNoteToFields(newNote);
      item.changePct = parsed.changePct;
      clearCount++;
    }
  });
  const patch = list
    .filter(i => i.stock)
    .map(i => ({ stock: i.stock.trim(), note: i.note || '', topics: '', change_pct: i.changePct || '' }));
  return { clearCount, patch };
}

/**
 * 计算「清除文字」结果：
 *  - 仅保留 note 中的 涨幅% / 涨停|跌停 / (...) 括号内容；
 *  - 原地修改命中项并重新解析 changePct / topics；
 *  - 返回 { clearCount, patch }，patch 与原版 _clearAllText() 构造完全一致。
 * @param {Array} existingList auctionData[targetDate]（会被原地修改）
 * @returns {{clearCount:number, patch:Array}}
 */
export function computeTextClear(existingList) {
  const list = Array.isArray(existingList) ? existingList : [];
  let clearCount = 0;
  list.forEach(item => {
    if (item.note) {
      const percentMatches = item.note.match(/-?\d+\.?\d*%/g) || [];
      const bracketMatches = item.note.match(/\([^)]+\)/g) || [];
      const ztDtMatches = item.note.match(/涨停|跌停/g) || [];
      const uniqueZtDt = [...new Set(ztDtMatches)];
      const newNote = percentMatches.join('') + uniqueZtDt.join('') + bracketMatches.join('');
      if (newNote !== item.note) {
        item.note = newNote;
        const parsed = parseNoteToFields(newNote);
        item.changePct = parsed.changePct;
        item.topics = parsed.topics;
        clearCount++;
      }
    }
  });
  const patch = list
    .filter(i => i.stock)
    .map(i => ({ stock: i.stock.trim(), note: i.note || '', change_pct: i.changePct || '', topics: i.topics || '' }));
  return { clearCount, patch };
}

/**
 * 计算「清除注释」结果：
 *  - 把命中项的 note 置空；
 *  - 返回 { clearCount, patch }，patch 与原版 _clearAllNotes() 构造完全一致。
 * @param {Array} existingList auctionData[targetDate]（会被原地修改）
 * @returns {{clearCount:number, patch:Array}}
 */
export function computeNotesClear(existingList) {
  const list = Array.isArray(existingList) ? existingList : [];
  let clearCount = 0;
  list.forEach(item => {
    if (item.note) { item.note = ''; clearCount++; }
  });
  const patch = list
    .filter(i => i.stock)
    .map(i => ({ stock: i.stock.trim(), note: '' }));
  return { clearCount, patch };
}
