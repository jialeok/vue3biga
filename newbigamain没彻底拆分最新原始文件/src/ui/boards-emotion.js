// boards-emotion.js — 从 boards-render.js 拆分（看板域: boards-emotion.js）

        export function formatEmotionNumber(v, decimals) {
            if (v === null || v === undefined || isNaN(v)) return '-';
            if (decimals === undefined) return String(Math.round(Number(v)));
            return Number(v).toFixed(decimals);
        }


        export function yuanToYi(v) {
            if (v === null || v === undefined || isNaN(v)) return null;
            return Number((Number(v) / 1e8).toFixed(2));
        }


        export async function loadEmotionData(date) {
            date = date || window.currentDate;
            if (window._emotionDataCache && window._emotionDataCache.date === date) return window._emotionDataCache.data;

            // 优先读云端 emotion_data 表
            try {
                const sb = window.getSupabase();
                const { data, error } = await sb.from('emotion_data')
                    .select('date, metrics, five_days, updated_at')
                    .eq('date', date)
                    .limit(1);
                if (error) throw error;
                if (data && data.length > 0) {
                    window._emotionDataCache = { date: date, data: data[0] };
                    return data[0];
                }
            } catch (e) {
                console.warn('读取 emotion_data 失败:', e.message);
            }

            window._emotionDataCache = { date: date, data: null };
            return null;
        }


        export function toggleEmotionExpand(event) {
            if (event) event.stopPropagation();
            const boardEl = document.getElementById('emotionBoard');
            const contentEl = document.getElementById('emotionContent');
            const toggleBtn = document.getElementById('emotionToggleBtn');
            if (!contentEl || !toggleBtn) return;
            const isHidden = contentEl.style.display === 'none';
            contentEl.style.display = isHidden ? 'block' : 'none';
            toggleBtn.textContent = isHidden ? '▲' : '▼';
            if (isHidden) window.renderEmotionBoard();
        }


        export function toggleEmotionRow(key) {
            const panel = document.getElementById('emotionTrendPanel-' + key);
            if (!panel) return;
            const isOpen = panel.classList.contains('show');
            if (isOpen) {
                panel.classList.remove('show');
                window._emotionExpandedRows.delete(key);
            } else {
                panel.classList.add('show');
                window._emotionExpandedRows.add(key);
            }
        }


        export function renderEmotionTrend(fiveDays, field, title, isPercent) {
            if (!Array.isArray(fiveDays) || fiveDays.length === 0) return '<div style="font-size:11px;color:#94a3b8;padding:6px;">暂无趋势数据</div>';
            const points = fiveDays.map(function (d) {
                let v = d[field];
                if ((field === 'amount' || field === 'amountDiff') && v !== null && v !== undefined) v = window.yuanToYi(v);
                return { date: d._date || '', value: (v === null || v === undefined || isNaN(v)) ? null : Number(v) };
            });
            return window.renderMiniTrendSvg(points, '#f59e0b', { percent: !!isPercent });
        }

        // 情绪看板：仅刷新「预测量能」字段

        // 情绪看板：仅刷新「预测量能」字段
        export async function refreshEmotionPredictVol(event) {
            if (event) event.stopPropagation();
            if (!window.currentDate) return;
            const btn = document.getElementById('emotionRefreshBtn');
            if (btn) btn.classList.add('refreshing');
            try {
                const url = window.EMOTION_WORKER_BASE.replace(/\/$/, '') + '/window.refresh-emotion';
                const resp = await fetch(url, { method: 'POST' });
                const result = await resp.json();
                if (!result.ok) {
                    throw new Error(result.error || '刷新失败');
                }
                // 更新缓存中的 predictVol
                if (window._emotionDataCache && window._emotionDataCache.date === window.currentDate && window._emotionDataCache.data) {
                    window._emotionDataCache.data.metrics = window._emotionDataCache.data.metrics || {};
                    window._emotionDataCache.data.metrics.predictVol = result.predictVol;
                    window._emotionDataCache.data.metrics.predictVolFallback = false; // 手动刷新到的是今日真实预测
                    window._emotionDataCache.data.updated_at = new Date().toISOString();
                }
                // 仅重渲染顶部量能行，不改动其它行
                window.renderEmotionVolumeLine(window._emotionDataCache ? window._emotionDataCache.data : null);
            } catch (e) {
                console.error('[EMOTION-REFRESH] 刷新预测量能失败:', e.message);
                alert('刷新预测量能失败：' + e.message);
            } finally {
                if (btn) btn.classList.remove('refreshing');
            }
        }


        export function renderEmotionVolumeLine(data) {
            const volumeLineEl = document.getElementById('emotionVolumeLine');
            if (!volumeLineEl) return;
            const metrics = (data && data.metrics) || {};
            const predictVol = metrics.predictVol;
            const predictFallback = metrics.predictVolFallback === true;
            const yesterdayAmount = metrics.amount;
            const predictYi = predictVol !== null && predictVol !== undefined ? window.yuanToYi(predictVol) : null;
            const yestYi = yesterdayAmount !== null && yesterdayAmount !== undefined ? window.yuanToYi(yesterdayAmount) : null;
            const volParts = [];
            const refreshBtn = '<span class="emotion-window.refresh-btn" id="emotionRefreshBtn" onclick="window.refreshEmotionPredictVol(event)" title="刷新预测量能"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M23 4v6h-6M1 20v-6h6M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 0 1 3.51 15"/></svg></span>';
            // 「预测」段始终渲染：有值显示数字（回落昨日时标注「(昨)」），无值显示「待更新」——避免整段消失只剩昨日
            if (predictYi !== null) {
                const predLabel = predictFallback ? '预测(昨)' : '预测';
                volParts.push('<span>' + predLabel + ' <span class="emv-val">' + predictYi + '亿</span>' + refreshBtn + '</span>');
            } else {
                volParts.push('<span>预测 <span class="emv-val" style="color:#9ca3af;">待更新</span>' + refreshBtn + '</span>');
            }
            if (yestYi !== null) volParts.push('<span>昨日 <span class="emv-val">' + yestYi + '亿</span></span>');
            volumeLineEl.innerHTML = volParts.length > 0
                ? volParts.join('<span style="color:#d1d5db;">/</span>')
                : '<span>量能数据未抓取</span>';
        }


        export async function renderEmotionBoard() {
            const data = await window.loadEmotionData(window.currentDate);
            const summaryEl = document.getElementById('emotionSummary');
            const volumeLineEl = document.getElementById('emotionVolumeLine');
            const listEl = document.getElementById('emotionList');
            const toggleBtn = document.getElementById('emotionToggleBtn');
            if (!summaryEl || !listEl) return;

            const metrics = (data && data.metrics) || {};
            const fiveDays = (data && data.five_days) || [];
            console.log('[EMOTION-DEBUG] data:', data ? 'loaded' : 'null', 'five_days count:', fiveDays.length, 'rows:', fiveDays.map(function (d) { return { date: d._date, limitUp: d.limitUp, limitDown: d.limitDown, onceLimit: d.onceLimit, highestLb: d.highestLb, zhaban: d.zhaban }; }));

            // 标题摘要：涨停/跌停/最高连板
            const up = metrics.limitUp, down = metrics.limitDown, lb = metrics.highestLb;
            const summaryParts = [];
            if (up !== null && !isNaN(up)) summaryParts.push('涨停 ' + Math.round(up));
            if (down !== null && !isNaN(down)) summaryParts.push('跌停 ' + Math.round(down));
            if (lb !== null && !isNaN(lb)) summaryParts.push('最高 ' + Math.round(lb) + '板');
            summaryEl.textContent = summaryParts.length > 0 ? summaryParts.join(' / ') : '暂无数据';

            // 量能行：当天预测量能 / 昨日成交额（三市总成交额），含刷新按钮
            window.renderEmotionVolumeLine(data);

            // 列表行
            let html = '';
            window.EMOTION_ROW_CONFIG.forEach(function (cfg) {
                const key = cfg.key;
                let val = metrics[key];
                if (key === 'amountDiff') val = metrics.amountDiff;
                const isMissing = val === null || val === undefined || isNaN(val);
                const numVal = isMissing ? null : Number(val);
                let valueClass = '';
                if (!isMissing && cfg.key === 'amountDiff') {
                    valueClass = numVal > 0 ? 'up' : (numVal < 0 ? 'down' : '');
                }
                let extraHtml = '';
                if (cfg.extraKey && metrics[cfg.extraKey] !== null && metrics[cfg.extraKey] !== undefined && !isNaN(metrics[cfg.extraKey])) {
                    extraHtml = '<span style="color:#6b7280;font-weight:500;font-size:12px;margin-left:4px;">/ ' + Number(metrics[cfg.extraKey]).toFixed(1) + '%</span>';
                }

                html += '<div class="emotion-row">';
                html += '<div class="emotion-row-header" onclick="window.toggleEmotionRow(\'' + key + '\')">';
                html += '<div class="emotion-row-title">' + cfg.title + '</div>';
                html += '<div class="emotion-row-value ' + valueClass + '">' +
                    '<span>' + window.formatEmotionNumber(val, cfg.key === 'amountDiff' ? 2 : 0) + '</span>' +
                    (isMissing ? '' : '<span class="unit">' + cfg.unit + '</span>') +
                    extraHtml +
                    '</div>';
                html += '</div>';
                html += '<div class="emotion-trend-panel" id="emotionTrendPanel-' + key + '">';
                if (cfg.hasTrend) {
                    html += '<div class="emotion-trend-title">' + cfg.title + ' 近5日</div>';
                    html += window.renderEmotionTrend(fiveDays, cfg.field, cfg.title, false);
                }
                html += '</div>';
                html += '</div>';
            });
            listEl.innerHTML = html;

            // 恢复展开状态
            window._emotionExpandedRows.forEach(function (key) {
                const panel = document.getElementById('emotionTrendPanel-' + key);
                if (panel) panel.classList.add('show');
            });

            if (toggleBtn) {
                const contentEl = document.getElementById('emotionContent');
                toggleBtn.textContent = (contentEl && contentEl.style.display === 'none') ? '▼' : '▲';
            }
        }


        export async function startEmotionRealtime() {
            if (window._emotionRealtimeChannel) return;
            try {
                const sb = window.getSupabase();
                window._emotionRealtimeChannel = sb
                    .channel('emotion_data_changes')
                    .on('postgres_changes', { event: '*', schema: 'public', table: 'emotion_data' }, function (payload) {
                        const changedDate = payload.new && payload.new.date;
                        if (changedDate === window.currentDate) {
                            window._emotionDataCache = null;
                            window.renderEmotionBoard();
                        }
                    })
                    .subscribe(function (status) {
                        window._emotionTableAvailable = (status === 'SUBSCRIBED');
                    });
            } catch (e) {
                console.warn('emotion_data Realtime 订阅失败:', e.message);
            }
        }

        // 竞价变化看板诊断：可在控制台执行 runBiddingDiagnostics() 查看当前状态

