// scope-helpers.js — 早盘竞价(auction)与热门股票(hot)共用的参数化通用函数
// 消除两份几乎一样的逻辑，统一为接受 scope/字段集 的通用版本

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

// 通用 backup：按日期备份单日数据到 localStorage
export function _backupScopeData(opts) {
    // opts: { type, date, getDataFn, backupKeyPrefix, watchlistIndex?, label }
    try {
        const targetDate = opts.date || window.currentDate;
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
        localStorage.setItem(backupKey, JSON.stringify(dayBackup));
        localStorage.setItem(backupKey + '_time', new Date().toISOString());
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

// 通用 rollback：从 localStorage 恢复备份数据
export function _rollbackScopeData(opts) {
    // opts: { type, getDataFn, setDataFn, backupKeyPrefix, watchlistIndex?, label, onSuccess, onComplete }
    const backupKey = opts.type === 'import'
        ? (opts.backupKeyPrefix + '_import_backup')
        : (opts.backupKeyPrefix + '_save_backup');
    const raw = localStorage.getItem(backupKey);
    if (!raw) {
        throw new Error('没有可撤回的' + (opts.label || '') + '数据');
    }
    let dayBackup;
    try { dayBackup = JSON.parse(raw); } catch (e) {
        throw new Error('撤回数据解析失败: ' + e.message);
    }
    const targetDate = dayBackup.date || window.currentDate;
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
