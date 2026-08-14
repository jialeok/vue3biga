/**
 * emotion-workflow.js — 情绪看板 Logic 层（业务规则 / 工作流 / 协调 / Realtime 协调）
 *
 * §3.1 / §4：把「加载→失败处理→缓存」协调、盈亏/涨跌等业务规则、Realtime 订阅
 * 生命周期从 EmotionBoard.vue 下沉到本模块。UI 只调用本模块导出的 *Safe 函数与
 * 业务规则函数，不再直连 Supabase、不再内联业务计算。
 *
 * §10 / §11：读取失败 ≠ 空数据。loadEmotionSafe 在失败时返回 { ok:false, error }，
 * 绝不把失败写进缓存伪装成 null（E-02）。只有「成功但查无此日」才返回 { ok:true, data:null }。
 *
 * §31：Realtime 在模块级统一管理（单一 channel），由组件 onMounted 订阅、
 * onUnmounted 退订，避免重复订阅。
 */
import { getSupabase } from '../../data/supabase-client.js';
import {
  loadEmotion,
  loadLatestEmotion,
  saveEmotion,
  upsertEmotion,
  deleteEmotion,
} from '../../data/emotion-data.js';
import {
  getEmotionDataCache,
  setEmotionDataCache,
} from '../../data/emotion-config.js';

// ============================================================
// 加载 → 失败处理 → 缓存 协调（E-01 / E-02）
// ============================================================

/**
 * 安全加载某日情绪数据。
 * @param {string} date 查询日期
 * @param {object} [opts]
 * @param {boolean} [opts.allowFallback=false] 仅当查询日期即「今天」时允许回退到最近可用
 * @param {boolean} [opts.force=false] 跳过缓存强制重新拉取（Realtime 变更刷新用）
 * @returns {Promise<{ok:boolean, data?:object|null, error?:Error, fallback?:boolean, fromCache?:boolean}>}
 */
export async function loadEmotionSafe(date, opts = {}) {
  const { allowFallback = false, force = false } = opts;

  // 缓存命中（成功过的记录，含「合法空」）直接返回；失败不会被缓存，故不在此出现。
  if (!force) {
    const cache = getEmotionDataCache();
    if (cache && cache.date === date) {
      return { ok: true, data: cache.data, fromCache: true };
    }
  }

  try {
    const rows = await loadEmotion(date);
    if (rows && rows.length > 0) {
      setEmotionDataCache({ date, data: rows[0] });
      return { ok: true, data: rows[0] };
    }
    // [FALLBACK] 仅「今天」回退到最近一个有数据的日期；历史/未来日期不回退（避免陈旧数据误导）。
    if (allowFallback) {
      const latest = await loadLatestEmotion();
      if (latest && latest.length > 0) {
        const fb = latest[0];
        setEmotionDataCache({ date, data: fb });
        return { ok: true, data: fb, fallback: true };
      }
    }
    // 成功但查无此日：合法空（非失败）。写入空结果以便同日期复用，但不报错。
    setEmotionDataCache({ date, data: null });
    return { ok: true, data: null };
  } catch (e) {
    // §10/§11：读取失败 — 不落缓存、不伪装成 null，把错误向上抛给 UI。
    return { ok: false, error: e };
  }
}

// ============================================================
// 写入 / 删除 协调（E-01 / §10）
// ============================================================

/**
 * 批量保存（upsert）情绪数据。失败返回 { ok:false }，绝不静默。
 */
export async function saveEmotionSafe(rows) {
  try {
    await saveEmotion(rows);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e };
  }
}

/**
 * 单日保存（upsert）情绪数据。
 */
export async function upsertEmotionSafe(date, payload) {
  try {
    await upsertEmotion(date, payload);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e };
  }
}

/**
 * 删除某日情绪数据。
 */
export async function deleteEmotionSafe(date) {
  try {
    await deleteEmotion(date);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e };
  }
}

// ============================================================
// 业务规则（E-03，原内联于 .vue 的盈亏/涨跌/换算等）
// 这些纯函数接受数据参数，模板侧用薄包装传入 metrics / fiveDays。
// ============================================================

/** 元 → 亿元（保留 2 位），非数字返回 null。 */
export function yuanToYi(v) {
  if (v === null || v === undefined || isNaN(v)) return null;
  return Number((Number(v) / 1e8).toFixed(2));
}

/** 格式化情绪数值：空值显示 '-'，可指定小数位。 */
export function formatEmotionNumber(v, decimals) {
  if (v === null || v === undefined || isNaN(v)) return '-';
  if (decimals === undefined) return String(Math.round(Number(v)));
  return Number(v).toFixed(decimals);
}

/** 某行指标是否缺失（null/undefined/NaN）。 */
export function emotionRowIsMissing(metrics, cfg) {
  const val = metrics ? metrics[cfg.key] : undefined;
  return val === null || val === undefined || isNaN(val);
}

/** 某行数值文本。amountDiff 固定 2 位小数，其余取整。 */
export function emotionRowValueText(metrics, cfg) {
  const val = metrics ? metrics[cfg.key] : undefined;
  return formatEmotionNumber(val, cfg.key === 'amountDiff' ? 2 : 0);
}

/**
 * 盈亏/涨跌分类：amountDiff 正→'up'、负→'down'、否则 ''。
 * 满足 E-03「盈亏规则下沉 Logic」。
 */
export function emotionRowValueClass(metrics, cfg) {
  if (emotionRowIsMissing(metrics, cfg)) return '';
  const val = metrics[cfg.key];
  const n = Number(val);
  if (cfg.key === 'amountDiff') {
    return n > 0 ? 'up' : (n < 0 ? 'down' : '');
  }
  return '';
}

/** 附加百分比值（如炸板率），非数字返回 null。 */
export function emotionRowExtraValue(metrics, cfg) {
  if (!cfg.extraKey) return null;
  const v = metrics ? metrics[cfg.extraKey] : undefined;
  if (v === null || v === undefined || isNaN(v)) return null;
  return Number(v);
}

/** 近 N 日趋势点（金额类自动转亿元）。 */
export function emotionTrendPoints(fiveDays, cfg) {
  if (!Array.isArray(fiveDays) || fiveDays.length === 0) return [];
  return fiveDays.map((d) => {
    let v = d[cfg.field];
    if ((cfg.field === 'amount' || cfg.field === 'amountDiff') && v !== null && v !== undefined) {
      v = yuanToYi(v);
    }
    return {
      date: d._date || '',
      value: (v === null || v === undefined || isNaN(v)) ? null : Number(v),
    };
  });
}

// ============================================================
// Realtime 协调（E-05，模块级单一 channel 统一管理）
// ============================================================

let _channel = null;

/**
 * 订阅 emotion_data 表变更。模块级单例，重复调用安全（已存在则直接复用）。
 * @param {(changedDate:string|undefined)=>void} cb 收到变更时回调，传入变更行 date。
 */
export function subscribeEmotion(cb) {
  const sb = getSupabase();
  if (!sb) return;
  if (_channel) return; // 已订阅，避免重复订阅（§31）
  _channel = sb
    .channel('emotion_data_changes')
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'emotion_data' },
      (payload) => {
        const changedDate = payload && payload.new && payload.new.date;
        if (typeof cb === 'function') cb(changedDate);
      }
    )
    .subscribe();
}

/** 退订 emotion_data 表变更（组件 onUnmounted 调用）。 */
export function unsubscribeEmotion() {
  const sb = getSupabase();
  if (_channel && sb) {
    try {
      sb.removeChannel(_channel);
    } catch (e) {
      // 退订失败不应阻断 UI，仅记录。
      console.warn('[emotion-workflow] Realtime 退订失败:', e && e.message);
    }
  }
  _channel = null;
}
