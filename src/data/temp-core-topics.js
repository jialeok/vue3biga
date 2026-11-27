// temp-core-topics.js — 临时核心词表的唯一 Data 层入口（规则 〇·a）
//
// ══════════════════════════════════════════════════════════════════════════════════════
// 用户口径（2026-11-17）：
//   「新建核心词时勾选临时题材 ⇒ 只影响当天 + 未来两天，历史日与未来更多日期不受影响；
//     未来三天随时可以关停，关停当天及之后恢复主流题材」
//   用户拍板：共 3 个交易日；**只归类、不强制禁选**（是否选中仍由现有选股规则决定）。
//
// ⛔ 本模块与 core_topics 完全隔离：
//   core_topics 的 push 是「按 name 差集删除 + 全量 upsert」，临时词混进去会被覆盖/误删。
//   这张表只增删自己的行，⛔ 绝不调用 saveCoreTopics / pushCoreTopicsToCloud。
//
// §5 数据层：全量读一次（切日期只做内存筛选，§32 禁重复请求）；写入必须 await 返回结果（§10）。
// §10 读失败 ≠ 空数据：失败 throw，且 _loaded 仍落地（否则消费方门控永久挂起）。
// §8 不进 localStorage：云端唯一真相。
// ══════════════════════════════════════════════════════════════════════════════════════

import { ref } from 'vue';
import { getSupabase } from './supabase-client.js';
import { _dbgLog } from './debug-log.js';
import { fetchAllPages } from './paged-fetch.js';

/** 全量临时词（响应式：写入后所有注入点自动重算） */
const _rows = ref([]);
/** 「读过」（成功或失败都算）—— 与 isCoreTopicsCloudLoaded 同语义 */
const _loaded = ref(false);
/** 数据版本：注入点 void 一下即可建立响应式依赖 */
const _version = ref(0);

let _inflight = null;
let _cooldownUntil = 0;
const FAIL_COOLDOWN_MS = 30000;
let _channel = null;

const SELECT_FIELDS = 'id,name,synonyms,start_date,disabled_from,updated_at';

/** 同步读（不发请求，§5）。返回的是同一个响应式数组引用；无数据时是 []，⛔ 不伪造默认值。 */
export function getTempCoreTopics() {
  return Array.isArray(_rows.value) ? _rows.value : [];
}

export function isTempCoreTopicsLoaded() {
  return _loaded.value === true;
}

export function getTempCoreTopicsToken() {
  return String(_version.value);
}

/** 仅供测试 / 换账户：清空会话缓存（⛔ 不删云端数据） */
export function clearTempCoreTopicsCache() {
  _rows.value = [];
  _loaded.value = false;
  _inflight = null;
  _cooldownUntil = 0;
  _version.value += 1;
}

function _normalize(row) {
  if (!row || !row.name) return null;
  // ★ 2026-11-26 事故：本函数曾被调用两次（_readAll 里一次、_putRows 里再一次），
  //   而它只认数据库的 snake_case 字段 ⇒ 第二次拿到的是已归一化的对象（字段已是 startDate）
  //   ⇒ `!row.start_date` 直接 return null ⇒ 全部行被过滤掉 ⇒ 列表永远为空、还不报错。
  //   ⇒ 这里两种命名都认，保证幂等（归一化多次结果不变）。
  const startRaw = row.start_date !== undefined ? row.start_date : row.startDate;
  if (!startRaw) return null;
  let syns = row.synonyms;
  if (typeof syns === 'string') {
    try { syns = JSON.parse(syns); } catch (e) { syns = syns.split(','); }
  }
  const id = Number(row.id);
  const disabledRaw = row.disabled_from !== undefined ? row.disabled_from : row.disabledFrom;
  return {
    id: isFinite(id) && id > 0 ? id : null,
    name: String(row.name).trim(),
    synonyms: (Array.isArray(syns) ? syns : []).map(function(s) { return String(s == null ? '' : s).trim(); }).filter(Boolean),
    startDate: String(startRaw).slice(0, 10),
    disabledFrom: disabledRaw ? String(disabledRaw).slice(0, 10) : null,
    updatedAt: row.updated_at || row.updatedAt || ''
  };
}

function _putRows(rows) {
  _rows.value = (rows || []).map(_normalize).filter(Boolean);
  _loaded.value = true;
  _version.value += 1;
}

async function _readAll() {
  const sb = getSupabase();
  if (!sb) throw new Error('Supabase 未就绪，无法读取临时核心词');
  const raw = await fetchAllPages(function() {
    return sb.from('core_topic_temp').select(SELECT_FIELDS).order('id', { ascending: true });
  }, { pageSize: 1000, concurrency: 2 });
  return (raw || []).map(_normalize).filter(Boolean);
}

/**
 * 【异步读】确保临时词表已加载（会话缓存 + 单飞 + 失败冷却）。
 * 空表是【合法状态】：表示该用户没有任何临时题材 ⇒ return []，调用方照旧用主流题材。
 */
export async function ensureTempCoreTopics() {
  if (_loaded.value && Date.now() >= _cooldownUntil) return _rows.value;
  if (_inflight) return _inflight;
  if (Date.now() < _cooldownUntil) {
    throw new Error('临时核心词读取冷却中（core_topic_temp 表可能尚未创建）');
  }
  return _startRead();
}

/**
 * 真正发起一次网络读（单飞）。
 * ★ 2026-11-26 用户报障「临时题材明明保存了，弹窗里永远空、也不报错」的根因就在这里：
 *   旧 refreshTempCoreTopics 只是把 _cooldownUntil 清 0，却**没清 _loaded**，
 *   而 ensure 的第一行是 `_loaded && now >= _cooldownUntil ⇒ 直接返回 _rows` ——
 *   于是「启动那次读失败 ⇒ _loaded=true 且 rows=[]」之后，refresh 也永远不会再发请求，
 *   界面永远是空列表，而且因为没抛错，连红字提示都没有。
 *   ⇒ 强制重读必须走本函数（无条件发请求），⛔ 不能再绕回 ensure 的早退分支。
 */
function _startRead() {
  if (_inflight) return _inflight;
  const p = _readAll().then(function(rows) {
    _putRows(rows);
    _dbgLog('[TEMP-CORE] 从云端加载 ' + rows.length + ' 条临时核心词');
    return _rows.value;
  }).catch(function(e) {
    // §10：失败也算「读过」，但保留上次成功的数据（⛔ 不把读失败伪装成「没有临时词」）
    _loaded.value = true;
    _cooldownUntil = Date.now() + FAIL_COOLDOWN_MS;
    _dbgLog('[AUCTION-ERR] 临时核心词读取失败: ' + (e && e.message || e));
    throw e;
  }).finally(function() {
    if (_inflight === p) _inflight = null;
  });
  _inflight = p;
  return p;
}

/** 强制重读（Realtime 回调 / 写入后对账 / 弹窗打开）：⛔ 绕过「冷却」与「已加载」两道早退 */
export async function refreshTempCoreTopics() {
  _cooldownUntil = 0;
  return _startRead();
}

function _mergeRow(row) {
  const norm = _normalize(row);
  if (!norm) return;
  const next = _rows.value.slice();
  const i = next.findIndex(function(r) { return r.id === norm.id; });
  if (i >= 0) next[i] = norm;
  else next.push(norm);
  _rows.value = next;
  _version.value += 1;
}

/**
 * 新增 / 编辑一条临时核心词。
 * @param {{id?:number, name:string, synonyms:string[], startDate:string}} input
 * @returns {Promise<object>} 归一化后的行（UI 可直接用它刷新列表）
 */
export async function upsertTempCoreTopic(input) {
  const sb = getSupabase();
  if (!sb) throw new Error('Supabase 未就绪，无法保存临时核心词');
  const name = String(input && input.name || '').trim();
  const startDate = String(input && input.startDate || '').slice(0, 10);
  if (!name || !/^\d{4}-\d{2}-\d{2}$/.test(startDate)) throw new Error('临时核心词名称 / 设置日不合法');
  const id = Number(input && input.id);
  const payload = {
    name: name,
    synonyms: JSON.stringify((Array.isArray(input.synonyms) ? input.synonyms : []).map(function(s) { return String(s == null ? '' : s).trim(); }).filter(Boolean)),
    start_date: startDate,
    updated_at: new Date().toISOString()
  };
  if (isFinite(id) && id > 0) {
    payload.id = id;
  } else {
    // [TEMP-CORE-DEDUP 2026-11-26] 同名临时题材 ⛔ 不再 insert 第二条。
    //   实测「羊字辈」被点了两次 ⇒ 库里 id 4 / 5 两行一模一样 ⇒
    //   生效期同一题材算两遍、列表也出现两条，用户看到的是「怎么有两个」。
    //   没传 id 时：同名行已存在 ⇒ 更新它（设置日 / 同义词），不存在才新增。
    try { await ensureTempCoreTopics(); } catch (e) { /* 读失败就按新增走，§10 不猜已有数据 */ }
    const exist = _rows.value.find(function(r) { return r.name === name; });
    if (exist && exist.id) payload.id = exist.id;
  }
  const { data, error } = await sb.from('core_topic_temp').upsert([payload], { onConflict: 'id' }).select(SELECT_FIELDS);
  if (error) throw error;
  const row = data && data[0];
  if (row) _mergeRow(row);
  else await refreshTempCoreTopics();
  return _normalize(row) || payload;
}

/**
 * 关停 / 恢复：disabledFrom = 关停日（含）⇒ 传日期；恢复 ⇒ 传 null。
 * ⛔ 只改本表的 disabled_from 一个字段，绝不碰 core_topics。
 */
export async function setTempCoreTopicDisabled(id, disabledFrom) {
  const sb = getSupabase();
  if (!sb) throw new Error('Supabase 未就绪，无法关停临时核心词');
  const nid = Number(id);
  if (!isFinite(nid) || nid <= 0) throw new Error('临时核心词 id 不合法');
  const date = disabledFrom ? String(disabledFrom).slice(0, 10) : null;
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('关停日不合法');
  const { data, error } = await sb.from('core_topic_temp')
    .update({ disabled_from: date, updated_at: new Date().toISOString() })
    .eq('id', nid)
    .select(SELECT_FIELDS);
  if (error) throw error;
  const row = data && data[0];
  if (row) _mergeRow(row);
  else await refreshTempCoreTopics();
  return _normalize(row);
}

/** 彻底删除一条临时核心词（关停之外的新增操作；⛔ 不碰 core_topics） */
export async function deleteTempCoreTopic(id) {
  const sb = getSupabase();
  if (!sb) throw new Error('Supabase 未就绪，无法删除临时核心词');
  const nid = Number(id);
  if (!isFinite(nid) || nid <= 0) throw new Error('临时核心词 id 不合法');
  const { error } = await sb.from('core_topic_temp').delete().eq('id', nid);
  if (error) throw error;
  _rows.value = _rows.value.filter(function(r) { return r.id !== nid; });
  _version.value += 1;
}

/** §31：start 先 stop 幂等，stop 配对 removeChannel */
export function startTempCoreTopicsRealtime() {
  stopTempCoreTopicsRealtime();
  try {
    const sb = getSupabase();
    if (!sb) return;
    _channel = sb.channel('core_topic_temp_changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'core_topic_temp' }, function() {
        refreshTempCoreTopics().catch(function(e) {
          _dbgLog('[AUCTION-ERR] core_topic_temp Realtime 回调失败 ' + (e && e.message || e));
        });
      })
      .subscribe();
  } catch (e) {
    _dbgLog('[AUCTION-ERR] core_topic_temp Realtime 订阅失败 ' + (e && e.message || e));
  }
}

export function stopTempCoreTopicsRealtime() {
  if (_channel) {
    try { getSupabase().removeChannel(_channel); } catch (e) { /* 已断开 */ }
    _channel = null;
  }
}
