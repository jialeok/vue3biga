import { _emit } from '../stores/eventBus.js';
import { state } from '../logic/app-state.js';
        // ===== jiwang_data 表操作（记忘看板/昨日复盘独立表）=====
        // 字段说明：diezhang/qingxu/jujiao/whoIncrease/kxianPrefix/kxian/guancha/
        // guochengJieguo/shouguJieguo/jielun/chushou 为核心文本字段，stats 是弹性
        // jsonb（行情阶段/仓位/勾选项等，字段还在持续增加，不逐个拆列）。

import { getSupabase, _moduleKey, getJiwangData } from './supabase-client.js';
import { _dbgLog } from './debug-log.js';
import { useUiStore } from '../stores/uiStore.js';
import { reactive } from 'vue';
// 复用 duiban 域已有的 recent_multi_data Realtime 订阅（不另建 channel，避免重复订阅）。
// 此处仅挂载一个只读聚合缓存供 stats-calc 的 computeRecordStats 使用（§15 单一数据源）。
import { subscribeRecentMulti } from './duiban-sync.js';

        // 从 jiwang_data 表全量读取，返回 {date: {...}}
        export async function pullJiwangFromTable() {
            const sb = getSupabase();
            const result = {};
            // 记录每个 date 已经放进 result 的那一行的 updated_at，方便碰到重复日期时
            // 判断该保留哪一条——如果 jiwang_data.date 缺唯一约束，同一天可能有多行，
            // Postgres 在没有 .order() 时行返回顺序未定义，直接"后来者覆盖前者"会
            // 出现"这次是新数据、下次刷新又变旧数据"的不确定表现。
            const resultUpdatedAt = {};
            let duplicateDates = null;
            let offset = 0;
            const pageSize = 1000;
            while (true) {
                const { data, error } = await sb.from('jiwang_data')
                    .select('"date",diezhang,qingxu,jujiao,"whoIncrease","kxianPrefix",kxian,guancha,"guochengJieguo","shouguJieguo",jielun,chushou,stats,updated_at')
                    .range(offset, offset + pageSize - 1);
                if (error) throw error;
                if (!data || data.length === 0) break;
                data.forEach(function(row) {
                    if (!row || !row.date) return;
                    if (result.hasOwnProperty(row.date)) {
                        if (!duplicateDates) duplicateDates = [];
                        duplicateDates.push(row.date);
                        const existingTime = new Date(resultUpdatedAt[row.date] || 0);
                        const rowTime = new Date(row.updated_at || 0);
                        if (rowTime <= existingTime) return; // 已有的那条更新，跳过这条更旧的重复行
                    }
                    resultUpdatedAt[row.date] = row.updated_at;
                    result[row.date] = {
                        diezhang: row.diezhang || '',
                        qingxu: row.qingxu || '',
                        jujiao: row.jujiao || '',
                        whoIncrease: row.whoIncrease || '',
                        kxianPrefix: row.kxianPrefix || '',
                        kxian: row.kxian || '',
                        guancha: row.guancha || '',
                        guochengJieguo: row.guochengJieguo || '',
                        shouguJieguo: row.shouguJieguo || '',
                        jielun: row.jielun || '',
                        chushou: row.chushou || '',
                        stats: row.stats || {}
                    };
                });
                if (data.length < pageSize) break;
                offset += pageSize;
            }
            if (duplicateDates) {
                console.warn('pullJiwangFromTable: 发现重复日期行: ' + duplicateDates.join(', ') + '（建议在 Supabase 给 jiwang_data.date 加唯一约束）');
                _dbgLog && _dbgLog('pullJiwangFromTable: 发现重复日期行: ' + duplicateDates.join(', '));
            }
            state._jiwangTableAvailable = true;
            return result;
        }

        // 拉取单日 jiwang 数据并合并到内存缓存（Realtime 收到变更时用）
        export async function pullJiwangForDate(date) {
            if (!date) return;
            // 防御性检查：如果这天还有本地编辑没真正推送成功（排队中/防抖定时器还没触发），
            // 不要用云端数据覆盖——调用方大多已经各自检查过一次，这里再兜底一层，
            // 避免以后新增调用点时忘记加这个判断，导致重新引入"覆盖未推送编辑"的问题。
            const pending = (state._jiwangDirtyDates && state._jiwangDirtyDates.has(date)) ||
                (state._jiwangPushTimers && state._jiwangPushTimers[date]) ||
                (state._justPushedJiwang && date === useUiStore().currentDate);
            if (pending) {
                _dbgLog && _dbgLog('pullJiwangForDate: ' + date + ' 有本地待推送编辑，跳过覆盖');
                return;
            }
            const sb = getSupabase();
            // 注意：这里故意不用 .maybeSingle()。如果 jiwang_data 表在 date 列上
            // 缺少唯一约束，同一天可能存在重复行——.maybeSingle() 在命中多行时会
            // 直接抛错，而调用方大多只是 console.warn 静默吞掉，表现为"切换日期/
            // 切回前台后记忘看板一片空白，且没有任何报错提示"。改用普通 .select()
            // 取回该日期的所有行，即使有重复也不报错；再按 updated_at 挑最新的一条，
            // 保证结果确定、可预期（而不是像全量拉取那样依赖未定义的行返回顺序）。
            const { data: rows, error } = await sb.from('jiwang_data')
                .select('diezhang,qingxu,jujiao,"whoIncrease","kxianPrefix",kxian,guancha,"guochengJieguo","shouguJieguo",jielun,chushou,stats,updated_at')
                .eq('"date"', date);
            if (error) throw error;
            const jiwangData = getJiwangData();
            if (!rows || rows.length === 0) {
                delete jiwangData[date];
                state._jiwangTableAvailable = true;
                return;
            }
            if (rows.length > 1) {
                console.warn('pullJiwangForDate: ' + date + ' 在云端存在 ' + rows.length + ' 条重复行，已按 updated_at 取最新一条（建议在 Supabase 给 jiwang_data.date 加唯一约束）');
                _dbgLog && _dbgLog('pullJiwangForDate: ' + date + ' 发现 ' + rows.length + ' 条重复行');
            }
            const data = rows.reduce(function(latest, r) {
                if (!latest) return r;
                return (new Date(r.updated_at || 0) > new Date(latest.updated_at || 0)) ? r : latest;
            }, null);
            jiwangData[date] = {
                diezhang: data.diezhang || '',
                qingxu: data.qingxu || '',
                jujiao: data.jujiao || '',
                whoIncrease: data.whoIncrease || '',
                kxianPrefix: data.kxianPrefix || '',
                kxian: data.kxian || '',
                guancha: data.guancha || '',
                guochengJieguo: data.guochengJieguo || '',
                shouguJieguo: data.shouguJieguo || '',
                jielun: data.jielun || '',
                chushou: data.chushou || '',
                stats: data.stats || {}
            };
            state._jiwangTableAvailable = true;
        }

        // 当日 jiwang 数据 UPSERT 到 jiwang_data 表（防抖调用，2秒无新改动后推送）
        export async function pushJiwangToCloud(date) {
            if (!date) return;
            const jiwangData = getJiwangData();
            const item = jiwangData[date];
            if (!item) {
                _dbgLog('pushJiwangToCloud: ' + date + ' 本地无数据，跳过（可能已被清空）');
                return; // 本地这天没有数据（可能已被清空），交给 window.deleteJiwangFromCloud 处理
            }
            state._justPushedJiwang = true;
            setTimeout(function() { state._justPushedJiwang = false; }, 5000);
            const sb = getSupabase();
            const row = {
                date: date,
                diezhang: item.diezhang || '',
                qingxu: item.qingxu || '',
                jujiao: item.jujiao || '',
                whoIncrease: item.whoIncrease || '',
                kxianPrefix: item.kxianPrefix || '',
                kxian: item.kxian || '',
                guancha: item.guancha || '',
                guochengJieguo: item.guochengJieguo || '',
                shouguJieguo: item.shouguJieguo || '',
                jielun: item.jielun || '',
                chushou: item.chushou || '',
                stats: item.stats || {},
                updated_at: new Date().toISOString()
            };
            _dbgLog('pushJiwangToCloud: 开始 upsert ' + date);
            // 用 .select() 拿回实际写入/更新的行，用来验证这次 upsert 是否真的生效——
            // 如果 date 列缺少唯一约束，onConflict:'date' 不会报错，但也不会真正更新
            // 已有行，而是插入一条新行，写入"看起来成功"但可能出现重复行/顺序问题；
            // 如果命中 RLS 规则被过滤，upsert 同样不报错但什么也没真正持久化。
            // 两种情况都会让用户看到"同步成功"提示，之后却读到旧值/空值。
            const { data: upserted, error } = await sb.from('jiwang_data').upsert(row, { onConflict: 'date' }).select('"date"');
            if (error) {
                _dbgLog('pushJiwangToCloud: ' + date + ' upsert 失败: ' + (error.message || JSON.stringify(error)));
                throw error;
            }
            if (!upserted || upserted.length === 0) {
                const msg = 'upsert 未返回任何行，写入可能未真正生效（检查 jiwang_data.date 是否有唯一约束、以及 RLS 策略）';
                _dbgLog('pushJiwangToCloud: ' + date + ' ' + msg);
                throw new Error(msg);
            }
            if (upserted.length > 1) {
                _dbgLog('pushJiwangToCloud: ' + date + ' upsert 返回了 ' + upserted.length + ' 行，说明 date 列缺少唯一约束，onConflict 未生效，产生了重复行——请在 Supabase 给 jiwang_data.date 加唯一约束');
            }
            _dbgLog('pushJiwangToCloud: ' + date + ' upsert 成功');
            state._jiwangTableAvailable = true;
        }

        // 防抖推送 jiwang 到云端（2秒无新改动后才真正推送，避免连续操作时频繁请求）
        // 按日期独立计时，避免同一批 saveData() 里同时标脏多个日期（如回填下一天K线时）
        // 互相 clearTimeout 导致只有最后一个日期被推送。
        // 仅用于"非用户主动点保存"的联动场景（比如自动回填K线）；用户明确点击的保存
        // 按钮/选择框，一律走下面的 pushJiwangNow()——立即推送，不等 2 秒防抖，
        // 否则"保存后马上刷新/切页"会导致请求根本没来得及发出去，且没有任何报错。
        export function scheduleJiwangPush(date) {
            if (!date) return;
            _dbgLog('scheduleJiwangPush: 排队 ' + date + '（2秒防抖）');
            clearTimeout(state._jiwangPushTimers[date]);
            state._jiwangPushTimers[date] = setTimeout(function() {
                delete state._jiwangPushTimers[date];
                pushJiwangToCloud(date).catch(function(e) {
                    console.warn('window.pushJiwangToCloud 失败:', e);
                    const detail = (e && (e.message || e.details || e.hint || e.code)) || String(e);
                    _dbgLog('scheduleJiwangPush: ' + date + ' 推送失败: ' + detail);
                    _emit('ui:toast', { type: 'warning', msg: '⚠️ 记忘看板云端同步失败，本次修改未保存！原因: ' + detail, duration: 10000 });
                });
            }, 2000);
        }

        // 立即推送 jiwang 到云端（不等 2 秒防抖），用于所有用户明确触发的"保存"动作
        // （编辑弹窗保存、圆圈统计保存、评论保存、行情/仓位选择、三个勾选框等——这些都是
        // "一次操作即完成"，没有额外的确认步骤，如果还走 2 秒防抖，用户保存完立刻刷新页面
        // 或切换日期，请求可能根本没发出去，且 catch 不会触发、不会有任何报错提示。
        // successMsg 为空则不弹成功提示（用于像勾选框这种高频操作，避免 toast 刷屏）。
        export function pushJiwangNow(date, successMsg) {
            if (!date) return Promise.resolve();
            clearTimeout(state._jiwangPushTimers[date]);
            delete state._jiwangPushTimers[date];
            _dbgLog('pushJiwangNow: 立即推送 ' + date);
            return pushJiwangToCloud(date).then(function() {
                if (successMsg) _emit('ui:toast', { type: 'success', msg: successMsg });
            }).catch(function(e) {
                console.warn('window.pushJiwangNow 失败:', e);
                const detail = (e && (e.message || e.details || e.hint || e.code)) || String(e);
                _dbgLog('pushJiwangNow: ' + date + ' 推送失败: ' + detail);
                _emit('ui:toast', { type: 'warning', msg: '⚠️ 记忘看板云端同步失败，本次修改未保存！原因: ' + detail, duration: 10000 });
            });
        }

        // 删除某天的 jiwang 云端行（例如清空复盘数据时）
        export async function deleteJiwangFromCloud(date) {
            if (!date) return;
            state._justPushedJiwang = true;
            setTimeout(function() { state._justPushedJiwang = false; }, 5000);
            const sb = getSupabase();
            const { error } = await sb.from('jiwang_data').delete().eq('date', date);
            if (error) throw error;
        }

        // 一次性迁移：将本地旧快照（stockApp_v42_jiwang）灌入 jiwang_data 表
        export async function migrateJiwangToTable() {
            if (localStorage.getItem('_jiwang_table_migrated') === '1') { // 合规：一次性迁移标记（§8 允许）
                state._jiwangTableAvailable = true;
                return;
            }
            let jiwangData = {};
            try {
                const raw = localStorage.getItem(_moduleKey('jiwang'));
                if (raw) jiwangData = JSON.parse(raw) || {};
            } catch (e) { jiwangData = {}; }
            const dates = Object.keys(jiwangData).filter(function(d) {
                return jiwangData[d] && typeof jiwangData[d] === 'object';
            });
            if (dates.length === 0) {
                try {
                    const sb = getSupabase();
                    const { error } = await sb.from('jiwang_data').select('"date"').limit(1);
                    if (!error) {
                        state._jiwangTableAvailable = true;
                        localStorage.setItem('_jiwang_table_migrated', '1'); // 合规：一键迁移标记（§8 允许）
                        console.log('[迁移] 本地无 jiwang 数据，jiwang_data 表已就绪');
                    }
                } catch(e) { console.warn('[迁移] jiwang_data 表不可用:', e.message); }
                return;
            }
            const sb = getSupabase();
            const now = new Date().toISOString();
            const rows = dates.map(function(date) {
                var item = jiwangData[date] || {};
                return {
                    date: date,
                    diezhang: item.diezhang || '',
                    qingxu: item.qingxu || '',
                    jujiao: item.jujiao || '',
                    whoIncrease: item.whoIncrease || '',
                    kxianPrefix: item.kxianPrefix || '',
                    kxian: item.kxian || '',
                    guancha: item.guancha || '',
                    guochengJieguo: item.guochengJieguo || '',
                    shouguJieguo: item.shouguJieguo || '',
                    jielun: item.jielun || '',
                    chushou: item.chushou || '',
                    stats: item.stats || {},
                    updated_at: now
                };
            });
            try {
                const { error } = await sb.from('jiwang_data')
                    .upsert(rows, { onConflict: 'date', ignoreDuplicates: true });
                if (error) {
                    console.warn('[迁移] jiwang_data 失败:', error.message);
                    return;
                }
                state._jiwangTableAvailable = true;
                localStorage.setItem('_jiwang_table_migrated', '1');
                // 迁移确认成功后清除本地旧快照，云端表从此是唯一数据源
                try { localStorage.removeItem(_moduleKey('jiwang')); } catch (e) {}
                console.log('[迁移] jiwang_data 迁移完成:', rows.length, '行');
            } catch(e) {
                console.warn('[迁移] jiwang_data 异常:', e.message);
            }
        }

        // 启动 jiwang_data 表的 Realtime 订阅（其它设备保存时自动刷新）
        export function startJiwangRealtime() {
            stopJiwangRealtime();
            try {
                const sb = getSupabase();
                state._jiwangRealtimeChannel = sb
                    .channel('jiwang_data_changes')
                    .on('postgres_changes', {
                        event: '*', schema: 'public', table: 'jiwang_data'
                    }, function(payload) {
                        if (state._justPushedJiwang) { _dbgLog('JiwangRealtime: 收到变化但是自己刚推送的，忽略'); return; } // 自己刚推的，忽略
                        const row = payload.new || payload.old;
                        if (!row || !row.date) return;
                        const changedDate = row.date;
                        _dbgLog('JiwangRealtime: 收到 ' + changedDate + ' 变化（他端推送），拉取该日数据');
                        pullJiwangForDate(changedDate).then(function() {
                            if (changedDate === useUiStore().currentDate) {
                                _emit('data:realtime-update', { boards: 'jiwang' });
                                _emit('data:realtime-update', { boards: 'marketStage' });
                            }
                        }).catch(function(e) { console.warn('Jiwang Realtime 拉取失败:', e); _dbgLog('JiwangRealtime: 拉取失败: ' + (e && e.message)); });
                    })
                    .subscribe();
                console.log('Jiwang Realtime 订阅已启动');
            } catch (e) { console.error('Jiwang Realtime 订阅失败:', e); }
        }

        export function stopJiwangRealtime() {
            if (state._jiwangRealtimeChannel) {
                try { getSupabase().removeChannel(state._jiwangRealtimeChannel); } catch(e) {}
                state._jiwangRealtimeChannel = null;
            }
        }

        // ===== 最近多板（recent_multi_data）统计聚合缓存 =====
        // 供 stats-calc.computeRecordStats 聚合「最近多板表现」使用。该表的真相源在 duiban 域
        // （useBoardData.saveRecentMulti / duiban-sync），这里只维护一份「只读聚合缓存」，
        // 不持有任何写入逻辑。复用 duiban-sync.subscribeRecentMulti 的订阅（不重复建 channel）。
        // 缓存为 reactive：computeRecordStats 在 computed 内读取会被 Vue 自动追踪（§17 响应性），
        // Realtime 变更或首次 hydrate 完成后看板自动重算（fail-soft：任何失败仅 warn，不抛）。
        const _recentMultiMemCache = reactive({});
        let _recentMultiStatsSynced = false;

        export function getRecentMultiData() {
            _ensureRecentMultiStatsSync();
            return _recentMultiMemCache;
        }

        async function hydrateRecentMultiData() {
            try {
                const sb = getSupabase();
                if (!sb) return;
                const { data, error } = await sb.from('recent_multi_data').select('*');
                if (error) { console.error('[jiwang-data] hydrateRecentMultiData 失败:', error.message); return; }
                (data || []).forEach(function(r) { if (r && r.date) _recentMultiMemCache[r.date] = r; });
            } catch (e) { console.error('[jiwang-data] hydrateRecentMultiData 异常:', e && e.message); }
        }

        function _ensureRecentMultiStatsSync() {
            if (_recentMultiStatsSynced) return;
            _recentMultiStatsSynced = true;
            // 首次访问即拉全量；失败不影响渲染，computed 会因后续 realtime / 重试刷新。
            hydrateRecentMultiData().catch(function(e) { console.warn('[jiwang-data] hydrateRecentMultiData 失败:', e); });
            // 订阅 recent_multi_data 变更，保持聚合缓存最新（§31 Realtime 自愈由 duiban-sync 负责）。
            try {
                subscribeRecentMulti(function(payload) {
                    if (!payload) return;
                    if (payload.eventType === 'DELETE' || !payload.new || !payload.new.date) {
                        const d = payload.old && payload.old.date;
                        if (d) delete _recentMultiMemCache[d];
                    } else {
                        _recentMultiMemCache[payload.new.date] = payload.new;
                    }
                });
            } catch (e) { console.warn('[jiwang-data] 订阅 recent_multi_data 失败:', e); }
        }

