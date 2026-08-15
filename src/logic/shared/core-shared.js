// §42 解环共享模块（叶子模块，不反向 import app-core / auction / stocks / hotspot）
// 抽出 app-core 与 auction / stocks 双方共同依赖的纯工具函数与常量，
// 让 app-core、auction、stocks 都从本模块导入，从而打断 app-core↔auction、app-core↔stocks 两个循环依赖。
// 本文件仅承载“被多个域共享、且不依赖任何业务域”的通用能力，函数体与原 app-core 实现逐字一致，行为不变。

import { state } from '../app-state.js';
import { useAuctionStore } from '../../stores/auctionStore.js';
import { useUiStore } from '../../stores/uiStore.js';
import { remainingBoards } from '../../data/remaining-boards.js';
import { showToast } from '../../composables/useToast.js';
import { _moduleKey } from '../../data/supabase-client.js';
import { pushToCloud } from '../workflows/auction-sync.js';
import { scheduleJiwangPush } from '../../data/jiwang-data.js';
import { _dbgLog } from '../../data/debug-log.js';

// 模块键集合（原 app-core 内 MODULE_KEYS，被 saveData / _migrateFromV41 使用）
export const MODULE_KEYS = ['stocks', 'auction', 'jiwang', 'rank', 'multi', 'hotspot', 'pattern', 'bidding', 'tagTitles', 'holidays', 'tradingDays'];

// 安全读取当前 auction store（Pinia 未激活时返回 null）
export function _getAuctionStore() {
    try { return useAuctionStore(); } catch { return null; }
}

// 获取指定数据源的分组内存缓存（'hot' 走 _hotAuctionData，否则走 _auctionMemCache）
export function getGroupData(dataSource = 'auction') {
    if (dataSource === 'hot') return state._hotAuctionData || {};
    return state._auctionMemCache;
}

// 集中写入守卫：调用栈快照
export function _guardStack() {
    try { return ' stack=' + (new Error().stack || '').split('\n').slice(2, 7).join(' <- '); }
    catch (e) { return ''; }
}

// 集中写入守卫：校验日期与当前日期一致性
export function _guardAssertDate(date, source) {
    try {
        if (!_getAuctionStore()) return;
        if (date === _getAuctionStore().currentDate) return;
        var OK = ['pullAuctionFromTable', 'clearAllAuctionDates', 'restore', 'handleFileImport', 'importAuctionHistoryFill'];
        if (OK.indexOf(source) >= 0) {
            _dbgLog('[AUCTION-GUARD] cross-date-ok date=' + date + ' source=' + source);
            return;
        }
        _dbgLog('[AUCTION-GUARD] ⚠️ date=' + date + ' ≠ _getAuctionStore().currentDate=' + _getAuctionStore().currentDate + ' source=' + source);
    } catch (e) {}
}

// 集中写入守卫：dump 当前各日期正式/影子成员快照
export function _dumpAuctionSnapshot(label) {
    try {
        var keys = Object.keys(state._auctionMemCache).sort();
        var parts = keys.map(function (d) {
            var arr = state._auctionMemCache[d] || [];
            var wset = state._auctionWatchlistIndex[d] || new Set();
            var formal = arr.filter(function (s) { return s && s.stock && wset.has(s.stock.trim()); }).length;
            return d + ':' + formal + '/' + arr.length;
        });
        _dbgLog('[AUCTION-GUARD] snapshot ' + label + ' dates=' + keys.length + ' | ' + parts.join(', '));
    } catch (e) {}
}

// 云端数据推送（防抖，操作停止 2 秒后触发）
export function scheduleCloudPush() {
    clearTimeout(state._pushDebounceTimer);
    state._pushDebounceTimer = setTimeout(pushToCloud, 2000);
}

// 记录“确实发生过增删股票操作”的 auction 日期集合（原 app-core 内 _auctionDirtyDates 初始化保留在 app-core）
// 统一 localStorage 落盘入口（仅遗留未拆表模块到达此分支；拆表模块改标记脏并异步推送 Supabase）
export function saveModule(name) {
    if (!state.allData || !state.allData[name]) return;
    // bidding 已改为纯云端表 + 内存缓存，不再落 localStorage
    if (name === 'bidding') return;
    // auction 同样改为纯云端表 + 内存缓存，不再落 localStorage
    if (name === 'auction') return;
    // stocks / rank / multi / hotspot / pattern / tagTitles 已独立拆表，不落 localStorage，改为异步推送 Supabase
    if (name === 'stocks' || name === 'rank' || name === 'multi' ||
        name === 'hotspot' || name === 'pattern' || name === 'tagTitles') {
        if (typeof remainingBoards !== 'undefined' && remainingBoards.markDirty) {
            remainingBoards.markDirty(name, useUiStore().currentDate);
            remainingBoards.schedulePush();
        }
        return;
    }
    try {
        // 序列化内存缓存别名 state.allData[name]（非真相源）落 localStorage，仅遗留未拆表模块到达此分支。
        localStorage.setItem(_moduleKey(name), JSON.stringify(state.allData[name]));
    } catch (e) {
        console.error('saveModule 失败 [' + name + ']:', e);
        if (e.name === 'QuotaExceededError' || e.code === 22) {
            showToast('⚠️ 存储空间不足，数据可能未保存！请导出备份后清理旧数据。');
        }
    }
}

// 统一保存入口：遍历各模块键，未拆表模块落 localStorage；拆表模块标记脏并异步推送 Supabase
export function saveData() {
    MODULE_KEYS.forEach(key => {
        // bidding 已改为纯云端表，不再落 localStorage
        if (key === 'bidding') return;
        // jiwang 同理，已改为纯云端表
        if (key === 'jiwang') return;
        // auction 同样不再落 localStorage
        if (key === 'auction') return;
        // stocks / rank / multi / hotspot / pattern / tagTitles 已独立拆表，不走 localStorage
        if (key === 'stocks' || key === 'rank' || name === 'multi' ||
            name === 'hotspot' || name === 'pattern' || name === 'tagTitles') {
            return;
        }
        // 读内存缓存别名 state.allData[key]（非真相源）落 localStorage，仅遗留未拆表模块到达此分支。
        if (state.allData && state.allData[key] !== undefined) {
            try {
                localStorage.setItem(_moduleKey(key), JSON.stringify(state.allData[key]));
            } catch (e) {
                console.error('saveData 失败 [' + key + ']:', e);
                if (e.name === 'QuotaExceededError' || e.code === 22) {
                    showToast('⚠️ 存储空间不足，数据可能未保存！请导出备份后清理旧数据。');
                }
            }
        }
    });
    // 阶段八：触发剩余看板的云端同步
    if (typeof remainingBoards !== 'undefined' && remainingBoards.markAllDirty && useUiStore().currentDate) {
        remainingBoards.markAllDirty(useUiStore().currentDate);
        remainingBoards.schedulePush();
    }
    localStorage.setItem('lastEditedDate_' + state.DATA_VERSION, useUiStore().currentDate);
    // jiwang 数据独立防抖推送到 jiwang_data 表：遍历所有被标记为脏的日期
    if (state._jiwangDirtyDates && state._jiwangDirtyDates.size > 0) {
        Array.from(state._jiwangDirtyDates).forEach(function (d) {
            scheduleJiwangPush(d);
        });
        state._jiwangDirtyDates.clear();
    }
    // 已解锁状态下，触发防抖云同步（2秒后推送）
    if (localStorage.getItem('unlocked') === '1') {
        scheduleCloudPush();
    }
}

// 按钮禁用/恢复（传入按钮元素和原始文本）
export function setBtnLoading(btn, loading, originalText) {
    if (!btn) return;
    if (loading) {
        btn.disabled = true;
        btn.dataset.originalText = btn.textContent;
        btn.textContent = '处理中...';
    } else {
        btn.disabled = false;
        if (originalText) btn.textContent = originalText;
        else if (btn.dataset.originalText) btn.textContent = btn.dataset.originalText;
    }
}
