// app-core-ui.js — 从 app-core.js 抽离的纯 UI 函数（DOM 操作、弹窗、表单渲染）
// 依赖：app-core.js 中的逻辑函数和数据层函数（全局作用域）

        // ============================================================
        // 同步状态 UI（顶部导航条右侧角标）
        // ============================================================
        export function updateCloudSyncUI(state) {
            window._syncState = state;
            const el = document.getElementById('cloudSyncIndicator');
            if (!el) return;
            const map = {
                synced:  { icon: '☁️', color: '#10b981', title: '已同步到云端' },
                syncing: { icon: '🔄', color: '#f59e0b', title: '同步中...' },
                offline: { icon: '⚠️', color: '#ef4444', title: '同步失败（离线）' }
            };
            const s = map[state] || map.synced;
            el.textContent = s.icon;
            el.style.color = s.color;
            el.title = s.title;
        }

        // 更新日期显示
        export function updateDateDisplay() {
            document.getElementById('currentDateDisplay').textContent = window.currentDate;
            document.getElementById('weekdayDisplay').textContent = window.getWeekday(window.currentDate);
            
            const statusEl = document.getElementById('marketStatus');
            if (window.isMarketClosed(window.currentDate)) {
                statusEl.textContent = '休';
                statusEl.className = 'market-status market-closed';
            } else {
                statusEl.textContent = '市';
                statusEl.className = 'market-status market-open';
            }
        }

        // 打开评论编辑
        export function openCommentEdit() {
            const stats = window.getStats();
            document.getElementById('commentInput').value = stats.comment || '';
            document.getElementById('commentModal').classList.add('active');
        }

        // 关闭评论编辑
        export function closeCommentModal() {
            document.getElementById('commentModal').classList.remove('active');
        }

        // 渲染评论
        export function renderComment() {
            const stats = window.getStats();
            const contentEl = document.getElementById('commentContent');
            
            if (contentEl) {
                if (stats.comment && stats.comment.trim() !== '') {
                    contentEl.innerHTML = `<div style="white-space: pre-wrap;">${stats.comment}</div>`;
                } else {
                    contentEl.innerHTML = '<div class="comment-placeholder">暂无评论，点击添加...</div>';
                }
            }
        }

        // 打开追踪记录编辑
        export function openTrackEdit(stockId) {
            window.currentTrackEditId = stockId;
            
            // 查找股票数据 - 使用当前日期的数据
            let stockData = null;
            const data = window.getTodayData();
            
            // 首先尝试使用ID查找（ID是数字）
            stockData = data.find(s => String(s.id) === String(stockId));
            
            // 如果ID查找失败，尝试使用名称查找
            if (!stockData) {
                stockData = data.find(s => s.name === stockId);
            }
            
            if (!stockData) {
                window.showToast('❌ 未找到股票数据');
                return;
            }
            
            // 更新标题
            document.getElementById('trackEditTitle').textContent = `编辑追踪记录 - ${stockData.name}`;
            
            // 填充表格
            const tbody = document.getElementById('trackEditTableBody');
            if (!tbody) {
                return;
            }
            tbody.innerHTML = '';
            
            const trackData = stockData.track || [];
            
            if (trackData.length === 0) {
                // 添加一行空记录
                window.addTrackEditRow();
            } else {
                // 按时间正序填充（最早的在上）
                trackData.forEach(item => {
                    window.addTrackEditRow(item.date || '', item.content || '');
                });
            }
            
            const modal = document.getElementById('trackEditModal');
            modal.classList.add('active');
        }

        // 添加追踪编辑行
        export function addTrackEditRow(date = '', content = '') {
            const container = document.getElementById('trackEditTableBody');
            
            const row = document.createElement('div');
            row.className = 'track-edit-row';
            row.innerHTML = `
                <div class="track-edit-date">
                    <input type="text" class="track-date-input" value="${date}" placeholder="点击右侧自动填充" readonly style="background:#f8fafc;cursor:default">
                </div>
                <div class="track-edit-window.content">
                    <textarea class="track-window.content-input" placeholder="追踪内容...">${window.content}</textarea>
                </div>
                <div class="track-edit-delete">
                    <button type="button" class="remove-track-btn" onclick="window.removeTrackEditRow(this)">×</button>
                </div>
            `;
            container.appendChild(row);
            
            const contentInput = row.querySelector('.track-window.content-input');
            const dateInput = row.querySelector('.track-date-input');
            
            contentInput.addEventListener('input', function() {
                const content = this.value.trim();
                if (content !== '' && dateInput.value.trim() === '') {
                    const now = new Date();
                    const dateStr = window.currentDate + ' ' + String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
                    dateInput.value = dateStr;
                } else if (content === '') {
                    dateInput.value = '';
                }
            });
        }

        // 移除追踪编辑行
        export function removeTrackEditRow(button) {
            const row = button.closest('.track-edit-row');
            const tbody = document.getElementById('trackEditTableBody');
            if (row && tbody.children.length > 1) {
                row.remove();
            } else {
                // 如果只有一行，清空内容
                row.querySelector('.track-date-input').value = '';
                row.querySelector('.track-window.content-input').value = '';
            }
        }

        // 关闭追踪记录编辑
        export function closeTrackEditModal() {
            document.getElementById('trackEditModal').classList.remove('active');
            window.currentTrackEditId = null;
        }

        // 打开早盘竞价编辑
        export function openAuctionEdit() {
            const modal = document.getElementById('auctionModal');
            const formContainer = document.getElementById('auctionFormContainer');

            // [PERF-FIX 2026-07-26] 先立即显示模态框框架，避免用户点击后无反馈。
            // 表单内容用 requestAnimationFrame 异步填充，防止行数多（60+）时阻塞 UI。
            formContainer.innerHTML = '<div style="padding:20px;text-align:center;color:#6b7280;font-size:13px">加载中...</div>';
            modal.classList.add('active');

            // 每次打开弹窗时，"历史数据补录"开关重置为默认关闭状态，日期清空（下次开启时自动填当前日历日期）
            const historyFillToggle = document.getElementById('auctionHistoryFillToggle');
            const historyFillBody = document.getElementById('auctionHistoryFillBody');
            const historyFillDate = document.getElementById('auctionHistoryFillDate');
            if (historyFillToggle) historyFillToggle.checked = false;
            if (historyFillBody) historyFillBody.style.display = 'none';
            if (historyFillDate) historyFillDate.value = '';

            requestAnimationFrame(function() {
                const auctionList = window.getTodayGroupList(window.currentGroup);
                let html = '';
                if (auctionList.length === 0) {
                    html = `
                        <div class="auction-form-row" id="auction-row-0">
                            <div class="rank-form-number">1</div>
                            <input type="text" class="form-input auction-form-stock-input" name="auction-stock-0" placeholder="股票名称">
                            <input type="text" class="form-input auction-form-volume-input" name="auction-volume-0" placeholder="竞价量">
                            <input type="text" class="form-input auction-form-yest-input" name="auction-yest-0" placeholder="昨日成交量">
                            <button type="button" class="remove-rank-btn" onclick="window.removeAuctionRow(0)">×</button>
                        </div>
                    `;
                } else {
                    // 行数过多时分批构建 HTML，避免大字符串操作单次耗时过长
                    const chunkSize = 30;
                    const parts = [];
                    for (let i = 0; i < auctionList.length; i += chunkSize) {
                        let chunkHtml = '';
                        const end = Math.min(i + chunkSize, auctionList.length);
                        for (let j = i; j < end; j++) {
                            const item = auctionList[j];
                            chunkHtml += `
                                <div class="auction-form-row" id="auction-row-${j}">
                                    <div class="rank-form-number">${j + 1}</div>
                                    <input type="text" class="form-input auction-form-stock-input" name="auction-stock-${j}" value="${item.stock || ''}" placeholder="股票名称">
                                    <input type="text" class="form-input auction-form-volume-input" name="auction-volume-${j}" value="${item.volume || ''}" placeholder="竞价量">
                                    <input type="text" class="form-input auction-form-yest-input" name="auction-yest-${j}" value="${item.yestVolume || ''}" placeholder="昨日成交量">
                                    <button type="button" class="remove-rank-btn" onclick="window.removeAuctionRow(${j})">×</button>
                                </div>
                            `;
                        }
                        parts.push(chunkHtml);
                    }
                    html = parts.join('');
                }

                formContainer.innerHTML = html;
            });
        }

        // 关闭早盘竞价编辑
        export function closeAuctionModal() {
            document.getElementById('auctionModal').classList.remove('active');
        }

        // 打开热门股票编辑弹窗（独立 DOM #hotEditModal）
        export function openHotEdit() {
            window.openHotEditModal();
        }

        export function openHotEditModal() {
            const modal = document.getElementById('hotEditModal');
            const formContainer = document.getElementById('hotFormContainer');
            if (!formContainer || !modal) return;

            // [PERF-FIX 2026-07-26] 先立即显示模态框框架，再异步渲染表单，避免行数多时点击无反馈。
            formContainer.innerHTML = '<div style="padding:20px;text-align:center;color:#6b7280;font-size:13px">加载中...</div>';
            modal.classList.add('active');

            // 重置历史补录开关
            const hfToggle = document.getElementById('hotHistoryFillToggle');
            const hfBody = document.getElementById('hotHistoryFillBody');
            const hfDate = document.getElementById('hotHistoryFillDate');
            if (hfToggle) hfToggle.checked = false;
            if (hfBody) hfBody.style.display = 'none';
            if (hfDate) hfDate.value = '';

            requestAnimationFrame(function() {
                const hotList = window.getHotAuctionData()[window.currentDate] || [];
                let html = '';
                if (hotList.length === 0) {
                    html = `
                        <div class="auction-form-row" id="hot-row-0">
                            <div class="rank-form-number">1</div>
                            <input type="text" class="form-input auction-form-stock-input" name="hot-stock-0" placeholder="股票名称">
                            <input type="text" class="form-input auction-form-volume-input" name="hot-volume-0" placeholder="竞价量">
                            <input type="text" class="form-input auction-form-yest-input" name="hot-yest-0" placeholder="昨日成交量">
                            <button type="button" class="remove-rank-btn" onclick="window.removeHotRow(0)">×</button>
                        </div>
                    `;
                } else {
                    // 行数过多时分批构建 HTML，避免大字符串操作单次耗时过长
                    const chunkSize = 30;
                    const parts = [];
                    for (let i = 0; i < hotList.length; i += chunkSize) {
                        let chunkHtml = '';
                        const end = Math.min(i + chunkSize, hotList.length);
                        for (let j = i; j < end; j++) {
                            const item = hotList[j];
                            chunkHtml += `
                                <div class="auction-form-row" id="hot-row-${j}">
                                    <div class="rank-form-number">${j + 1}</div>
                                    <input type="text" class="form-input auction-form-stock-input" name="hot-stock-${j}" value="${item.stock || ''}" placeholder="股票名称">
                                    <input type="text" class="form-input auction-form-volume-input" name="hot-volume-${j}" value="${item.volume || ''}" placeholder="竞价量">
                                    <input type="text" class="form-input auction-form-yest-input" name="hot-yest-${j}" value="${item.yestVolume || ''}" placeholder="昨日成交量">
                                    <button type="button" class="remove-rank-btn" onclick="window.removeHotRow(${j})">×</button>
                                </div>
                            `;
                        }
                        parts.push(chunkHtml);
                    }
                    html = parts.join('');
                }
                formContainer.innerHTML = html;
            });
        }

        export function closeHotEditModal() {
            const modal = document.getElementById('hotEditModal');
            if (modal) modal.classList.remove('active');
        }

        // 渲染热门股票表单
        export function renderHotForm() {
            const hotList = window.getHotAuctionData()[window.currentDate] || [];
            const formContainer = document.getElementById('hotFormContainer');
            if (!formContainer) return;
            if (hotList.length === 0) {
                formContainer.innerHTML = `
                    <div class="auction-form-row" id="hot-row-0">
                        <div class="rank-form-number">1</div>
                        <input type="text" class="form-input auction-form-stock-input" name="hot-stock-0" placeholder="股票名称">
                        <input type="text" class="form-input auction-form-volume-input" name="hot-volume-0" placeholder="竞价量">
                        <input type="text" class="form-input auction-form-yest-input" name="hot-yest-0" placeholder="昨日成交量">
                        <button type="button" class="remove-rank-btn" onclick="window.removeHotRow(0)">×</button>
                    </div>
                `;
                return;
            }
            let html = '';
            hotList.forEach((item, index) => {
                html += `
                    <div class="auction-form-row" id="hot-row-${index}">
                        <div class="rank-form-number">${index + 1}</div>
                        <input type="text" class="form-input auction-form-stock-input" name="hot-stock-${index}" value="${item.stock || ''}" placeholder="股票名称">
                        <input type="text" class="form-input auction-form-volume-input" name="hot-volume-${index}" value="${item.volume || ''}" placeholder="竞价量">
                        <input type="text" class="form-input auction-form-yest-input" name="hot-yest-${index}" value="${item.yestVolume || ''}" placeholder="昨日成交量">
                        <button type="button" class="remove-rank-btn" onclick="window.removeHotRow(${index})">×</button>
                    </div>
                `;
            });
            formContainer.innerHTML = html;
        }

        // 删除热门股票行
        export function removeHotRow(index) {
            const row = document.getElementById(`hot-row-${index}`);
            const container = document.getElementById('hotFormContainer');
            if (row && container.children.length > 1) {
                row.remove();
                window.reindexHotRows();
            } else if (row) {
                row.querySelector('.auction-form-stock-input').value = '';
                row.querySelector('.auction-form-volume-input').value = '';
                row.querySelector('.auction-form-yest-input').value = '';
            }
        }

        export function reindexHotRows() {
            const container = document.getElementById('hotFormContainer');
            if (!container) return;
            const rows = container.querySelectorAll('.auction-form-row');
            rows.forEach((row, idx) => {
                row.id = `hot-row-${idx}`;
                row.querySelector('.rank-form-number').textContent = idx + 1;
                row.querySelector('.auction-form-stock-input').name = `hot-stock-${idx}`;
                row.querySelector('.auction-form-volume-input').name = `hot-volume-${idx}`;
                row.querySelector('.auction-form-yest-input').name = `hot-yest-${idx}`;
                row.querySelector('.remove-rank-btn').onclick = () => window.removeHotRow(idx);
            });
        }

        // 添加热门股票行
        export function addHotRow() {
            const formContainer = document.getElementById('hotFormContainer');
            if (!formContainer) return;
            const rowCount = formContainer.querySelectorAll('.auction-form-row').length;
            const newRow = document.createElement('div');
            newRow.className = 'auction-form-row';
            newRow.id = `hot-row-${rowCount}`;
            newRow.innerHTML = `
                <div class="rank-form-number">${rowCount + 1}</div>
                <input type="text" class="form-input auction-form-stock-input" name="hot-stock-${rowCount}" placeholder="股票名称">
                <input type="text" class="form-input auction-form-volume-input" name="hot-volume-${rowCount}" placeholder="竞价量">
                <input type="text" class="form-input auction-form-yest-input" name="hot-yest-${rowCount}" placeholder="昨日成交量">
                <button type="button" class="remove-rank-btn" onclick="window.removeHotRow(${rowCount})">×</button>
            `;
            formContainer.appendChild(newRow);
        }

        // 历史数据补录开关
        export function onHotHistoryFillToggleChange() {
            const checked = document.getElementById('hotHistoryFillToggle').checked;
            const body = document.getElementById('hotHistoryFillBody');
            if (body) body.style.display = checked ? 'block' : 'none';
            if (checked) {
                const dateInput = document.getElementById('hotHistoryFillDate');
                if (dateInput && !dateInput.value) dateInput.value = window.currentDate;
            }
        }

        // 清除题材（热门股票独立版本）
        export function clearAllHotConcepts() {
            const targetDate = window.auctionStore ? window.auctionStore.currentDate : window.currentDate;
            const hotData = window.getHotAuctionData();
            const existingList = (hotData[targetDate] || []).slice();
            if (existingList.length === 0) { alert('当前没有数据可清除！'); return; }
            let clearCount = 0;
            const patches = [];
            existingList.forEach((item, idx) => {
                if ((item.note && item.note.includes('(')) || item.topics) {
                    const newItem = { ...item };
                    let newNote = newItem.note || '';
                    newNote = newNote.replace(/\(([^)]+)\)/g, '');
                    newItem.note = newNote;
                    newItem.topics = '';
                    var parsed = window.parseNoteToFields(newNote);
                    newItem.changePct = parsed.changePct;
                    existingList[idx] = newItem;
                    // 字段级 PATCH：本次改动的是 note/topics/change_pct 三个字段
                    patches.push({ stock: newItem.stock, note: newItem.note, topics: '', change_pct: newItem.changePct });
                    clearCount++;
                }
            });
            if (clearCount > 0) {
                window.getHotAuctionData()[targetDate] = existingList;
                window.invalidateTopicCache();
                window.syncHotStocksListForDate(targetDate).catch(function(err) { window._dbgLog('[AUCTION-ERR] window.clearAllHotConcepts window.syncHotStocksListForDate ' + (err && err.message || err)); });
                window.patchHotFieldBatch(targetDate, patches).catch(function(err) { window._dbgLog('[AUCTION-ERR] window.clearAllHotConcepts window.patchHotFieldBatch ' + (err && err.message || err)); });
                window.renderHotForm();
                window.renderAuction('hot');
                alert('✅ 已清除 ' + clearCount + ' 条题材数据');
            } else {
                alert('没有找到需要清除的题材数据');
            }
        }

        // 清除文字（热门股票独立版本）
        export function clearAllHotText() {
            const targetDate = window.auctionStore ? window.auctionStore.currentDate : window.currentDate;
            const hotData = window.getHotAuctionData();
            const existingList = (hotData[targetDate] || []).slice();
            if (existingList.length === 0) { alert('当前没有数据可清除！'); return; }
            let clearCount = 0;
            const patches = [];
            existingList.forEach((item, idx) => {
                if (item.note) {
                    const percentMatches = item.note.match(/-?\d+\.?\d*%/g) || [];
                    const bracketMatches = item.note.match(/\([^)]+\)/g) || [];
                    const ztDtMatches = item.note.match(/涨停|跌停/g) || [];
                    const uniqueZtDt = [...new Set(ztDtMatches)];
                    const newNote = percentMatches.join('') + uniqueZtDt.join('') + bracketMatches.join('');
                    if (newNote !== item.note) {
                        const newItem = { ...item, note: newNote };
                        var parsed = window.parseNoteToFields(newNote);
                        newItem.changePct = parsed.changePct;
                        newItem.topics = parsed.topics;
                        existingList[idx] = newItem;
                        // 字段级 PATCH：note 变了，changePct/topics 由 note 重解析而来，一并上报
                        patches.push({ stock: newItem.stock, note: newItem.note, change_pct: newItem.changePct, topics: newItem.topics });
                        clearCount++;
                    }
                }
            });
            if (clearCount > 0) {
                window.getHotAuctionData()[targetDate] = existingList;
                window.invalidateTopicCache();
                window.syncHotStocksListForDate(targetDate).catch(function(err) { window._dbgLog('[AUCTION-ERR] window.clearAllHotText window.syncHotStocksListForDate ' + (err && err.message || err)); });
                window.patchHotFieldBatch(targetDate, patches).catch(function(err) { window._dbgLog('[AUCTION-ERR] window.clearAllHotText window.patchHotFieldBatch ' + (err && err.message || err)); });
                window.renderHotForm();
                window.renderAuction('hot');
                alert('✅ 已清除 ' + clearCount + ' 条文字数据');
            } else {
                alert('没有找到需要清除的文字数据');
            }
        }

        // 清除注释（热门股票独立版本）
        export function clearAllHotNotes() {
            const targetDate = window.auctionStore ? window.auctionStore.currentDate : window.currentDate;
            const hotData = window.getHotAuctionData();
            const existingList = (hotData[targetDate] || []).slice();
            if (existingList.length === 0) { alert('当前没有数据可清除！'); return; }
            let clearCount = 0;
            const patches = [];
            existingList.forEach((item, idx) => {
                if (item.note) {
                    existingList[idx] = { ...item, note: '' };
                    // 字段级 PATCH：只清空 note 一个字段
                    patches.push({ stock: item.stock, note: '' });
                    clearCount++;
                }
            });
            if (clearCount > 0) {
                window.getHotAuctionData()[targetDate] = existingList;
                window.invalidateTopicCache();
                window.syncHotStocksListForDate(targetDate).catch(function(err) { window._dbgLog('[AUCTION-ERR] window.clearAllHotNotes window.syncHotStocksListForDate ' + (err && err.message || err)); });
                window.patchHotFieldBatch(targetDate, patches).catch(function(err) { window._dbgLog('[AUCTION-ERR] window.clearAllHotNotes window.patchHotFieldBatch ' + (err && err.message || err)); });
                window.renderHotForm();
                window.renderAuction('hot');
                alert('✅ 已清除 ' + clearCount + ' 条注释数据');
            } else {
                alert('没有找到需要清除的注释数据');
            }
        }

        // 清空所有行（热门股票独立版本）
        export function clearAllHotRows() {
            const targetDate = window.auctionStore ? window.auctionStore.currentDate : window.currentDate;
            const hotData = window.getHotAuctionData();
            const existingList = hotData[targetDate] || [];
            if (existingList.length === 0) { alert('当前没有数据！'); return; }
            if (!confirm(`确定要清空当前 ${existingList.length} 条热门股票数据？此操作不可撤回。`)) return;
            window.getHotAuctionData()[targetDate] = [];
            window.invalidateTopicCache();
            window.syncHotStocksListForDate(targetDate).catch(function(err) { window._dbgLog('[AUCTION-ERR] window.clearAllHotRows window.syncHotStocksListForDate ' + (err && err.message || err)); });
            window.deleteHotTrendsForDateFromCloud(targetDate).catch(function(err) { window._dbgLog('[AUCTION-ERR] window.clearAllHotRows window.deleteHotTrendsForDateFromCloud ' + (err && err.message || err)); });
            window.renderHotForm();
            window.renderAuction('hot');
            alert('✅ 已清空所有热门股票行');
        }

        // AI识图（热门股票独立版本）：打开后写入 hotPasteInput，调用 importHotFromPaste
        export function openHotAiVisionModal() {
            window._aiVisionTarget = 'hot';
            window._aiVisionImages = [];
            document.getElementById('aiVisionThumbs').innerHTML = '';
            document.getElementById('aiVisionResult').value = '';
            document.getElementById('aiVisionStatus').textContent = '';
            document.getElementById('aiVisionModal').style.display = 'block';
        }

        // 股票代码映射 toggle（热门股票独立版本，stockCodeMap 数据本身共享）
        export function onStockCodeMapToggleChangeHot() {
            const on = document.getElementById('stockCodeMapToggle_hot').checked;
            document.getElementById('stockCodeMapBody_hot').style.display = on ? 'block' : 'none';
            if (on) {
                const map = window._scMapCache || {};
                const cnt = Object.keys(map).length;
                window.setStockCodeMapStatusHot(cnt > 0 ? `当前映射已有 ${cnt} 只` : '当前映射为空', false);
            }
        }

        export function setStockCodeMapStatusHot(msg, isErr) {
            const el = document.getElementById('stockCodeMapStatus_hot');
            if (!el) return;
            el.textContent = msg;
            el.style.color = isErr ? '#dc2626' : '#059669';
        }

        // 清空映射（热门股票独立版本：清空内存缓存显示，云端 stockcodemap 是唯一真相源不主动清空）
        export function clearStockCodeMapHot() {
            if (!confirm('确定清空股票代码映射？清空后抓取程序将读不到代码。')) return;
            window.showToast('股票代码映射为云端唯一真相源，如需删除请到云端 stockcodemap 表操作');
            const ta = document.getElementById('stockCodeMapInput_hot');
            if (ta) ta.value = '';
            window.setStockCodeMapStatusHot('已清空输入框（云端映射未删除）', false);
        }

        // ============ 股票代码映射（stockCodeMap）============
        // 独立于竞价数据，只存「名称→代码」，供抓取程序读取，前台不渲染代码
        export function onStockCodeMapToggleChange() {
            const on = document.getElementById('stockCodeMapToggle').checked;
            document.getElementById('stockCodeMapBody').style.display = on ? 'block' : 'none';
            if (on) {
                const map = window._scMapCache || {};
                const cnt = Object.keys(map).length;
                window.setStockCodeMapStatus(cnt > 0 ? `当前映射已有 ${cnt} 只` : '当前映射为空', false);
            }
        }

        export function setStockCodeMapStatus(msg, isErr) {
            const el = document.getElementById('stockCodeMapStatus');
            if (!el) return;
            el.textContent = msg;
            el.style.color = isErr ? '#dc2626' : '#059669';
        }

        export function clearStockCodeMap() {
            if (!confirm('确定清空股票代码映射？清空后抓取程序将读不到代码。')) return;
            window.showToast('股票代码映射为云端唯一真相源，如需删除请到云端 stockcodemap 表操作');
            window.setStockCodeMapStatus('已清空输入框（云端映射未删除）', false);
        }

        // 删除早盘竞价行
        export function removeAuctionRow(index) {
            const row = document.getElementById(`auction-row-${index}`);
            const container = document.getElementById('auctionFormContainer');
            if (row && container.children.length > 1) {
                row.remove();
                window.reindexAuctionRows();
            } else if (row) {
                row.querySelector('.auction-form-stock-input').value = '';
                row.querySelector('.auction-form-volume-input').value = '';
                row.querySelector('.auction-form-yest-input').value = '';
            }
        }

        // 重新索引早盘竞价行
        export function reindexAuctionRows() {
            const container = document.getElementById('auctionFormContainer');
            const rows = container.querySelectorAll('.auction-form-row');
            rows.forEach((row, idx) => {
                row.id = `auction-row-${idx}`;
                row.querySelector('.rank-form-number').textContent = idx + 1;
                row.querySelector('.auction-form-stock-input').name = `auction-stock-${idx}`;
                row.querySelector('.auction-form-volume-input').name = `auction-volume-${idx}`;
                row.querySelector('.auction-form-yest-input').name = `auction-yest-${idx}`;
                row.querySelector('.remove-rank-btn').onclick = () => window.removeAuctionRow(idx);
            });
        }

        // 添加早盘竞价行
        export function addAuctionRow() {
            const formContainer = document.getElementById('auctionFormContainer');
            const rowCount = formContainer.querySelectorAll('.auction-form-row').length;
            const newRow = document.createElement('div');
            newRow.className = 'auction-form-row';
            newRow.id = `auction-row-${rowCount}`;
            
            newRow.innerHTML = `
                <div class="rank-form-number">${rowCount + 1}</div>
                <input type="text" class="form-input auction-form-stock-input" name="auction-stock-${rowCount}" placeholder="股票名称">
                <input type="text" class="form-input auction-form-volume-input" name="auction-volume-${rowCount}" placeholder="竞价量">
                <input type="text" class="form-input auction-form-yest-input" name="auction-yest-${rowCount}" placeholder="昨日成交量">
                <button type="button" class="remove-rank-btn" onclick="window.removeAuctionRow(${rowCount})">×</button>
            `;
            
            formContainer.appendChild(newRow);
        }

        // "历史数据补录"开关变化时的处理：控制专用输入区域的显示/隐藏，并默认把日期选择器设为当前日历日期
        export function onAuctionHistoryFillToggleChange() {
            const checked = document.getElementById('auctionHistoryFillToggle').checked;
            const body = document.getElementById('auctionHistoryFillBody');
            if (body) {
                body.style.display = checked ? 'block' : 'none';
            }
            if (checked) {
                const dateInput = document.getElementById('auctionHistoryFillDate');
                if (dateInput && !dateInput.value) {
                    dateInput.value = window.currentDate;
                }
            }
        }

        // 统一渲染接口状态文本
        export function setApiStatus(elId, msg, isOk) {
            const el = document.getElementById(elId);
            if (!el) return;
            el.textContent = msg;
            el.style.color = isOk ? '#059669' : '#dc2626';
        }

        // 展示热门股票诊断报告的弹窗（热门股票 tab 独立 DOM，不与早盘竞价共用）
        export function showHotDiagReport(text) {
            const overlay = document.createElement('div');
            overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.75);z-index:99999;display:flex;align-items:center;justify-content:center;padding:20px;';
            overlay.onclick = function(e) { if (e.target === overlay) overlay.remove(); };
            overlay.innerHTML = `
                <div style="background:#111827;color:#bbf7d0;border-radius:12px;max-width:100%;width:100%;max-height:80vh;display:flex;flex-direction:column;font-family:monospace;">
                    <div style="display:flex;justify-content:space-between;align-items:center;padding:12px 16px;border-bottom:1px solid #374151;">
                        <span style="color:#fff;font-weight:600;">热门股票 · 接口诊断报告</span>
                        <div>
                            <button id="_hotDiagCopyBtn" style="margin-right:8px;background:#059669;color:#fff;border:none;border-radius:6px;padding:6px 10px;font-size:12px;">复制</button>
                            <button id="_hotDiagCloseBtn" style="background:#374151;color:#fff;border:none;border-radius:6px;padding:6px 10px;font-size:12px;">关闭</button>
                        </div>
                    </div>
                    <pre style="margin:0;padding:12px 16px;overflow:auto;white-space:pre-wrap;word-break:break-all;font-size:11px;line-height:1.5;">${text.replace(/</g, '&lt;')}</pre>
                </div>
            `;
            document.body.appendChild(overlay);
            document.getElementById('_hotDiagCloseBtn').onclick = function() { overlay.remove(); };
            document.getElementById('_hotDiagCopyBtn').onclick = function() {
                navigator.clipboard && navigator.clipboard.writeText(text).then(function() {
                    window.showToast('✅ 已复制诊断报告');
                }).catch(function() {
                    window.showToast('❌ 复制失败，请长按选中手动复制');
                });
            };
        }

        // 显示猫抓操作模式选择弹窗（补全 / 覆盖）
        // onChoose: callback(overwrite: boolean)  overwrite=false=补全, true=覆盖
        export function showNumcatChoiceModal(title, onChoose) {
            const modal = document.createElement('div');
            modal.className = 'modal active';
            modal.style.zIndex = '3000';
            modal.innerHTML = `
                <div class="modal-window.content" style="padding-bottom: 20px; max-width: 360px;">
                    <div style="font-size: 15px; font-weight: 600; color: #831843; margin-bottom: 6px; text-align: center;">${title}</div>
                    <div style="font-size: 12px; color: #6b7280; margin-bottom: 16px; text-align: center;">请选择操作模式</div>
                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 8px;">
                        <button type="button" data-choice="fill" style="padding: 12px 8px; font-size: 13px; background: linear-gradient(135deg, #ec4899, #db2777); color: #fff; border: none; border-radius: 6px; cursor: pointer; min-height: 44px; font-weight: 500;">补全<br><span style="font-size: 10px; opacity: 0.9;">只填缺失</span></button>
                        <button type="button" data-choice="overwrite" style="padding: 12px 8px; font-size: 13px; background: linear-gradient(135deg, #be185d, #9d174d); color: #fff; border: none; border-radius: 6px; cursor: pointer; min-height: 44px; font-weight: 500;">覆盖<br><span style="font-size: 10px; opacity: 0.9;">全部更新</span></button>
                    </div>
                    <button type="button" data-choice="window.cancel" style="width: 100%; padding: 10px; font-size: 12px; background: #f3f4f6; color: #6b7280; border: none; border-radius: 6px; cursor: pointer; min-height: 40px; margin-top: 4px;">取消</button>
                </div>
            `;
            document.body.appendChild(modal);

            const close = function() { modal.remove(); };
            modal.querySelector('[data-choice="fill"]').onclick = function() { close(); onChoose(false); };
            modal.querySelector('[data-choice="overwrite"]').onclick = function() { close(); onChoose(true); };
            modal.querySelector('[data-choice="window.cancel"]').onclick = close;
            modal.addEventListener('click', function(e) { if (e.target === modal) close(); });
        }

        // 展示早盘竞价诊断报告的弹窗（早盘竞价 tab 独立 DOM，不与热门股票共用）
        export function showAuctionDiagReport(text) {
            const overlay = document.createElement('div');
            overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.75);z-index:99999;display:flex;align-items:center;justify-content:center;padding:20px;';
            overlay.onclick = function(e) { if (e.target === overlay) overlay.remove(); };
            overlay.innerHTML = `
                <div style="background:#111827;color:#bbf7d0;border-radius:12px;max-width:100%;width:100%;max-height:80vh;display:flex;flex-direction:column;font-family:monospace;">
                    <div style="display:flex;justify-content:space-between;align-items:center;padding:12px 16px;border-bottom:1px solid #374151;">
                        <span style="color:#fff;font-weight:600;">早盘竞价 · 接口诊断报告</span>
                        <div>
                            <button id="_auctionDiagCopyBtn" style="margin-right:8px;background:#059669;color:#fff;border:none;border-radius:6px;padding:6px 10px;font-size:12px;">复制</button>
                            <button id="_auctionDiagCloseBtn" style="background:#374151;color:#fff;border:none;border-radius:6px;padding:6px 10px;font-size:12px;">关闭</button>
                        </div>
                    </div>
                    <pre style="margin:0;padding:12px 16px;overflow:auto;white-space:pre-wrap;word-break:break-all;font-size:11px;line-height:1.5;">${text.replace(/</g, '&lt;')}</pre>
                </div>
            `;
            document.body.appendChild(overlay);
            document.getElementById('_auctionDiagCloseBtn').onclick = function() { overlay.remove(); };
            document.getElementById('_auctionDiagCopyBtn').onclick = function() {
                navigator.clipboard && navigator.clipboard.writeText(text).then(function() {
                    window.showToast('✅ 已复制诊断报告');
                }).catch(function() {
                    window.showToast('❌ 复制失败，请长按选中手动复制');
                });
            };
        }

        export function clearAllAuctionConcepts() {
            const targetDate = window.auctionStore ? window.auctionStore.currentDate : window.currentDate;
            const auctionData = window.getAuctionData();
            const existingList = auctionData[targetDate] || [];

            if (existingList.length === 0) {
                alert('当前没有数据可清除！');
                return;
            }

            let clearCount = 0;

            existingList.forEach(item => {
                if ((item.note && item.note.includes('(')) || item.topics) {
                    let newNote = item.note || '';
                    newNote = newNote.replace(/\(([^)]+)\)/g, '');
                    item.note = newNote;
                    item.topics = '';
                    // 重新解析 note 确保 changePct 一致
                    var parsed = window.parseNoteToFields(newNote);
                    item.changePct = parsed.changePct;
                    clearCount++;
                }
            });

            window._dbgLog('[AUCTION-WRITE] window.clearAllAuctionConcepts targetDate=' + targetDate + ' beforeRows=' + existingList.length + ' cleared=' + clearCount);

            if (clearCount > 0) {
                window.setAuctionDateData(targetDate, existingList, 'window.clearAllAuctionConcepts');
                const patches = existingList.filter(function(item) { return item.stock; }).map(function(item) { return { stock: item.stock.trim(), note: item.note || '', topics: '', change_pct: item.changePct || '' }; });
                window.patchAuctionFieldBatch(targetDate, patches);
                window.markAuctionDirty(targetDate);
                window.scheduleCloudPush();
                window.saveData();
                window.invalidateTopicCache();

                // 同步更新股票列表中的题材（清除后）
                window.syncStockTopicsFromAuction();
                window.renderList();

                window.renderAuctionForm();
                window.renderAuction();
                alert('✅ 已清除 ' + clearCount + ' 条题材数据');
            } else {
                alert('没有找到需要清除的题材数据');
            }
        }

        export function clearAllAuctionText() {
            const targetDate = window.auctionStore ? window.auctionStore.currentDate : window.currentDate;
            const auctionData = window.getAuctionData();
            const existingList = auctionData[targetDate] || [];

            if (existingList.length === 0) {
                alert('当前没有数据可清除！');
                return;
            }

            let clearCount = 0;

            existingList.forEach(item => {
                if (item.note) {
                    const percentMatches = item.note.match(/-?\d+\.?\d*%/g) || [];
                    const bracketMatches = item.note.match(/\([^)]+\)/g) || [];
                    const ztDtMatches = item.note.match(/涨停|跌停/g) || [];
                    const uniqueZtDt = [...new Set(ztDtMatches)];
                    const newNote = percentMatches.join('') + uniqueZtDt.join('') + bracketMatches.join('');
                    if (newNote !== item.note) {
                        item.note = newNote;
                        // 同步 changePct 和 topics 字段
                        var parsed = window.parseNoteToFields(newNote);
                        item.changePct = parsed.changePct;
                        item.topics = parsed.topics;
                        clearCount++;
                    }
                }
            });

            window._dbgLog('[AUCTION-WRITE] window.clearAllAuctionText targetDate=' + targetDate + ' beforeRows=' + existingList.length + ' cleared=' + clearCount);

            if (clearCount > 0) {
                window.setAuctionDateData(targetDate, existingList, 'window.clearAllAuctionText');
                const patches = existingList.filter(function(item) { return item.stock; }).map(function(item) { return { stock: item.stock.trim(), note: item.note || '', change_pct: item.changePct || '', topics: item.topics || '' }; });
                window.patchAuctionFieldBatch(targetDate, patches);
                window.markAuctionDirty(targetDate);
                window.scheduleCloudPush();
                window.saveData();
                window.invalidateTopicCache();

                // 同步更新股票列表中的题材（清除后）
                window.syncStockTopicsFromAuction();
                window.renderList();

                window.renderAuctionForm();
                window.renderAuction();
                alert('✅ 已清除 ' + clearCount + ' 条文字数据');
            } else {
                alert('没有找到需要清除的文字数据');
            }
        }

        export function clearAllAuctionNotes() {
            const targetDate = window.auctionStore ? window.auctionStore.currentDate : window.currentDate;
            const auctionData = window.getAuctionData();
            const existingList = auctionData[targetDate] || [];

            if (existingList.length === 0) {
                alert('当前没有数据可清除！');
                return;
            }

            let clearCount = 0;

            existingList.forEach(item => {
                if (item.note) {
                    item.note = '';
                    clearCount++;
                }
            });

            window._dbgLog('[AUCTION-WRITE] window.clearAllAuctionNotes targetDate=' + targetDate + ' beforeRows=' + existingList.length + ' cleared=' + clearCount);

            if (clearCount > 0) {
                window.setAuctionDateData(targetDate, existingList, 'window.clearAllAuctionNotes');
                const patches = existingList.filter(function(item) { return item.stock; }).map(function(item) { return { stock: item.stock.trim(), note: '' }; });
                window.patchAuctionFieldBatch(targetDate, patches);
                window.markAuctionDirty(targetDate);
                window.scheduleCloudPush();
                window.saveData();
                window.invalidateTopicCache();

                // 同步更新股票列表中的题材（清除后）
                window.syncStockTopicsFromAuction();
                window.renderList();

                window.renderAuctionForm();
                window.renderAuction();
                alert('✅ 已清除 ' + clearCount + ' 条注释数据');
            } else {
                alert('没有找到需要清除的注释数据');
            }
        }

        export async function clearAllAuctionRows() {
            const targetDate = window.auctionStore ? window.auctionStore.currentDate : window.currentDate;
            const auctionData = window.getAuctionData();
            const existingList = auctionData[targetDate] || [];
            window._dbgLog('[AUCTION-WRITE] window.clearAllAuctionRows targetDate=' + targetDate + ' beforeRows=' + existingList.length + ' afterRows=0 markDirty=true');

            if (existingList.length === 0) {
                alert('当前没有数据！');
                return;
            }

            if (!confirm(`确定要清空当前 ${existingList.length} 条竞价数据？此操作不可撤回。`)) {
                return;
            }

            // [GHOST-DATA-FIX] 必须先删云端，再清本地。否则本地清空后 scheduleCloudPush
            // 里的 syncAuctionListForDate 会因为“拟移除比例>60%”被安全护栏拦住，
            // 云端一行没删；刷新后 Realtime/拉取把云端的 37 条原样复活。
            try {
                await window.deleteAuctionFromCloud(targetDate);
                window._dbgLog('[AUCTION-WRITE] window.clearAllAuctionRows 已删除云端 ' + targetDate + ' 全部行');
            } catch (e) {
                window._dbgLog('[AUCTION-ERR] window.clearAllAuctionRows 删除云端失败 ' + targetDate + ' ' + (e && e.message || e));
                alert('❌ 云端删除失败，本地未清空，请检查网络后重试');
                return;
            }

            // 清空当天全部数据（通过 guard API，仅清当前日期，避免误清其它日期）
            window.clearAuctionDateData(targetDate, 'window.clearAllAuctionRows');
            window.markAuctionDirty(targetDate);
            window.scheduleCloudPush();
            window.saveData();
            window.invalidateTopicCache();
            window.syncStockTopicsFromAuction();
            window.renderList();
            window.renderAuctionForm();
            window.renderAuction();
            alert('✅ 已清空所有竞价行（含云端）');
        }

        // ============================================================
        // 从 app-core.js 提取的 DOM helper（供混合函数调用）
        // ============================================================

        // switchGroup 的 UI 部分：Tab 样式、标题、页面可见性、页码圆点、滚动
        export function _switchGroupUI(g) {
            const tabAuction = document.getElementById('tabAuction');
            const tabHot = document.getElementById('tabHot');
            if (tabAuction) tabAuction.classList.toggle('active', g === 'auction');
            if (tabHot) tabHot.classList.toggle('active', g === 'hot');

            const titleEl = document.getElementById('auctionBoardTitle');
            if (titleEl) titleEl.textContent = g === 'hot' ? '热门股票' : '早盘竞价';

            const auctionPages = ['auctionPage1', 'auctionPage2', 'auctionPage3', 'auctionPage4'];
            const hotPages = ['hotPage1', 'hotPage2', 'hotPage3', 'hotPage4'];
            const showPages = g === 'hot' ? hotPages : auctionPages;
            const hidePages = g === 'hot' ? auctionPages : hotPages;

            hidePages.forEach(id => {
                const el = document.getElementById(id);
                if (el) el.classList.remove('active');
            });
            showPages.forEach((id, idx) => {
                const el = document.getElementById(id);
                if (el) {
                    if (idx === 0) el.classList.add('active');
                    else el.classList.remove('active');
                }
            });

            const dots = document.querySelectorAll('.page-dot');
            dots.forEach((dot, idx) => {
                dot.classList.toggle('active', idx === 0);
            });

            setTimeout(function() {
                const header = document.getElementById('auctionHeader') || document.getElementById('groupTabBar');
                if (header) {
                    const dateNav = document.querySelector('.date-nav');
                    const dateNavH = dateNav ? dateNav.offsetHeight : 0;
                    const rect = header.getBoundingClientRect();
                    window.scrollTo({ top: rect.top + window.scrollY - dateNavH - 4 });
                }
            }, 60);
        }

        // 读取评论输入框值
        export function _getCommentInputValue() {
            return document.getElementById('commentInput').value.trim();
        }

        // 读取追踪记录编辑表单数据
        export function _readTrackEditFormData() {
            const tbody = document.getElementById('trackEditTableBody');
            const rows = tbody.querySelectorAll('.track-edit-row');
            const trackData = [];
            rows.forEach(row => {
                const dateInput = row.querySelector('.track-date-input');
                const contentInput = row.querySelector('.track-window.content-input');
                const date = dateInput ? dateInput.value.trim() : '';
                const content = contentInput ? contentInput.value.trim() : '';
                if (date || content) trackData.push({ date, content });
            });
            return trackData;
        }

        // 恢复股票卡片展开状态
        export function _restoreStockCardExpand(stockId) {
            if (!stockId) return;
            setTimeout(() => {
                const stockCard = document.getElementById('stock-card-' + stockId);
                if (stockCard) stockCard.classList.add('single-expanded');
            }, 50);
        }

        // 读取热门股票表单行数据
        export function _readHotFormRows() {
            const container = document.getElementById('hotFormContainer');
            if (!container) return [];
            const rows = container.querySelectorAll('.auction-form-row');
            const result = [];
            rows.forEach(row => {
                const stockInput = row.querySelector('.auction-form-stock-input');
                const volumeInput = row.querySelector('.auction-form-volume-input');
                const yestInput = row.querySelector('.auction-form-yest-input');
                result.push({
                    stock: stockInput ? stockInput.value.trim() : '',
                    volume: volumeInput ? volumeInput.value.trim() : '',
                    yestVolume: yestInput ? yestInput.value.trim() : ''
                });
            });
            return result;
        }

        // 读取竞价表单行数据
        export function _readAuctionFormRows() {
            const container = document.getElementById('auctionFormContainer');
            if (!container) return [];
            const rows = container.querySelectorAll('.auction-form-row');
            const result = [];
            rows.forEach(row => {
                const stockInput = row.querySelector('.auction-form-stock-input');
                const volumeInput = row.querySelector('.auction-form-volume-input');
                const yestInput = row.querySelector('.auction-form-yest-input');
                result.push({
                    stock: stockInput ? stockInput.value.trim() : '',
                    volume: volumeInput ? volumeInput.value.trim() : '',
                    yestVolume: yestInput ? yestInput.value.trim() : ''
                });
            });
            return result;
        }

        // 读取粘贴文本框值
        export function _getPasteTextareaValue(id) {
            const el = document.getElementById(id);
            return el ? el.value.trim() : '';
        }

        // 读取历史补录开关和日期
        export function _readHistoryFillToggle(prefix) {
            const toggle = document.getElementById(prefix + 'HistoryFillToggle');
            const date = document.getElementById(prefix + 'HistoryFillDate');
            return {
                enabled: toggle ? toggle.checked : false,
                date: date ? date.value : ''
            };
        }

        // 更新 API 诊断结果到 UI
        export function _showDiagResultInUI(elementId, html) {
            const el = document.getElementById(elementId);
            if (el) el.innerHTML = html;
        }

        // 读取股票代码映射文本框
        export function _readStockCodeMapTextarea(prefix) {
            const id = prefix === 'hot' ? 'hotStockCodeMapTextarea' : 'stockCodeMapTextarea';
            return window._getPasteTextareaValue(id);
        }
// ============================================================
// DOM helper 函数 — 供 logic/ 层调用，避免 logic/ 直接操作 DOM
// ============================================================
export function _domGet(id) { return document.getElementById(id); }
export function _domValue(id) { const el = document.getElementById(id); return el ? el.value : ''; }
export function _domSetValue(id, val) { const el = document.getElementById(id); if (el) el.value = val; }
export function _domText(id) { const el = document.getElementById(id); return el ? el.textContent : ''; }
export function _domSetText(id, text) { const el = document.getElementById(id); if (el) el.textContent = text; }
        export function _domSetHtml(id, html) { const el = document.getElementById(id); if (el) el.innerHTML = html; }
export function _domSetColor(id, color) { const el = document.getElementById(id); if (el) el.style.color = color; }
export function _domSetDisplay(id, display) { const el = document.getElementById(id); if (el) el.style.display = display; }
export function _domQuery(sel) { return document.querySelector(sel); }
export function _domQueryAll(sel) { return document.querySelectorAll(sel); }
export function _domCreate(tag) { return document.createElement(tag); }
export function _domAppend(parentId, child) { const el = document.getElementById(parentId); if (el) el.appendChild(child); }
export function _domAddEventListener(id, event, handler) { const el = document.getElementById(id); if (el) el.addEventListener(event, handler); }
export function _domReadyState() { return document.readyState; }
export function _domAddEventListenerDoc(event, handler) { document.addEventListener(event, handler); }
export function _domQueryChecked(sel) { const el =(sel); return el ? el.value : null; }
