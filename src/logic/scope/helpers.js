// scope-helpers.js — 早盘竞价(auction)与热门股票(hot)共用的参数化通用函数
// 消除两份几乎一样的逻辑，统一为接受 scope/字段集 的通用版本

import { getCurrentDate } from '../app-core-api.js';

// §8 红线：撤销快照属于有界安全功能（非业务真相源），禁止持久化到 localStorage。
// 改用模块级内存 Map（按 backupKey 覆盖，非累积），进程重启即丢失——撤销仅在同一会话内有效。
// 如需跨设备/跨会话撤销，见 _backupScopeData 下方迁移预案（Pinia 内存态或新增 Supabase undo 表）。
const _undoSnapshotStore = new Map();

// 通用 sanitize：只保留 patch 中属于 patchableFields 的字段
export function _sanitizePatch(patch, patchableFields) {
    const clean = {};
    if (!patch) return clean;
    patchableFields.forEach(function(key) {
        if (Object.prototype.hasOwnProperty.call(patch, key) && patch[key] !== undefined) {
            clean[key] = patch[key];
        }
    });
    return clean;
}

// 通用 split：将 cleanPatch 按 watchlistFields / metricsFields 拆成两份
export function _splitPatch(cleanPatch, watchlistFields, metricsFields) {
    const watchlistPatch = {};
    const metricsPatch = {};
    Object.keys(cleanPatch).forEach(function(key) {
        if (watchlistFields.indexOf(key) >= 0) watchlistPatch[key] = cleanPatch[key];
        if (metricsFields.indexOf(key) >= 0) metricsPatch[key] = cleanPatch[key];
    });
    return { watchlistPatch: watchlistPatch, metricsPatch: metricsPatch };
}

// 通用 backup：按日期备份单日数据到内存（_undoSnapshotStore，非 localStorage）
export function _backupScopeData(opts) {
    // opts: { type, date, getDataFn, backupKeyPrefix, watchlistIndex?, label }
    try {
        const targetDate = opts.date || getCurrentDate();
        const scopeData = opts.getDataFn();
        const backupKey = opts.type === 'import'
            ? (opts.backupKeyPrefix + '_import_backup')
            : (opts.backupKeyPrefix + '_save_backup');
        const dayBackup = { date: targetDate, data: scopeData[targetDate] || null };
        // 早盘竞价有 watchlist 索引，热门股票没有
        if (opts.watchlistIndex) {
            const wset = opts.watchlistIndex[targetDate];
            dayBackup.watchlist = (wset && wset.size > 0) ? Array.from(wset) : null;
        }
        // §8 红线：撤销快照是有界安全功能、非业务真相源，禁止落 localStorage。
        // 改为写入模块级内存 Map（按 backupKey 覆盖，非累积），见文件顶部 _undoSnapshotStore。
        // 迁移预案（如需跨设备/跨会话撤销）：改存 Pinia 内存态或新增 Supabase undo 表（scope+date+snapshot），
        // 由本函数写入、_rollbackScopeData 读取；当前仅内存，进程重启后本会话撤销快照即失效。
        _undoSnapshotStore.set(backupKey, JSON.stringify(dayBackup));
        _undoSnapshotStore.set(backupKey + '_time', new Date().toISOString());
    } catch (e) {
        console.warn((opts.label || 'scope') + '备份失败:', e);
    }
    return true;
}

// 通用 patchField：单行 patch 转发到 batch 版本
export async function _patchScopeField(date, stock, patch, batchFn) {
    return batchFn(date, [Object.assign({ stock: stock }, patch)]);
}

// 通用 mergePatchLocal：把 patch merge 进缓存对应行，不存在则新建
export function _mergePatchLocal(date, stock, cleanPatch, cacheObj, initFn) {
    const nameTrim = (stock || '').trim();
    if (!nameTrim) return;
    if (!cacheObj[date]) initFn(date);
    const list = cacheObj[date];
    const idx = list.findIndex(function(r) { return r && r.stock === nameTrim; });
    if (idx >= 0) {
        Object.keys(cleanPatch).forEach(function(k) { list[idx][k] = cleanPatch[k]; });
    } else {
        const row = Object.assign({ stock: nameTrim }, cleanPatch);
        list.push(row);
    }
}

// 通用 rollback：从内存（_undoSnapshotStore）恢复备份数据
export function _rollbackScopeData(opts) {
    // opts: { type, getDataFn, setDataFn, backupKeyPrefix, watchlistIndex?, label, onSuccess, onComplete }
    const backupKey = opts.type === 'import'
        ? (opts.backupKeyPrefix + '_import_backup')
        : (opts.backupKeyPrefix + '_save_backup');
    const raw = _undoSnapshotStore.get(backupKey);
    if (!raw) {
        throw new Error('没有可撤回的' + (opts.label || '') + '数据');
    }
    let dayBackup;
    try { dayBackup = JSON.parse(raw); } catch (e) {
        throw new Error('撤回数据解析失败: ' + e.message);
    }
    const targetDate = dayBackup.date || getCurrentDate();
    const scopeData = opts.getDataFn();
    scopeData[targetDate] = dayBackup.data || [];
    if (opts.watchlistIndex && dayBackup.watchlist) {
        opts.watchlistIndex[targetDate] = new Set(dayBackup.watchlist);
    }
    if (opts.setDataFn) opts.setDataFn(scopeData);
    if (opts.onSuccess) opts.onSuccess(targetDate, scopeData[targetDate]);
    if (opts.onComplete) opts.onComplete();
    return true;
}
