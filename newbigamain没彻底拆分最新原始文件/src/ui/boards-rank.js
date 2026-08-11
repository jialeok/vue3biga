// boards-rank.js — 从 boards-render.js 拆分（看板域: boards-rank.js）

        // 渲染昨日最大成交额看板
        export function renderRank() {
            const rankList = window.getTodayRank();
            const rankContent = document.getElementById('rankContent');

            // [NULL-GUARD] 排名看板已被 Vue 组件接管（rank-vue.js 将 #rankContent 替换为
            // #rank-vue-root 并覆盖本函数）。若容器不存在，说明走 Vue 路径，委托 Vue 刷新即可，
            // 绝不再对 null 写 innerHTML（否则会抛出 “Cannot set properties of null”）。
            if (!rankContent) {
                if (typeof window.vueRankBoardRefresh === 'function') {
                    try { window.vueRankBoardRefresh(); } catch (e) { /* 忽略 Vue 刷新异常 */ }
                }
                return;
            }

            if (rankList.length === 0) {
                rankContent.innerHTML = `
                    <div class="rank-header-row">
                        <div class="rank-header-item rank-header-number">排名</div>
                        <div class="rank-header-item rank-header-stock">股票名称</div>
                        <div class="rank-header-item rank-header-jitu">竞图</div>
                        <div class="rank-header-item rank-header-diezhang">涨幅</div>
                        <div class="rank-header-item rank-header-concept">题材概念</div>
                        <div class="rank-header-item rank-header-turnover">成交额</div>
                    </div>
                    <div style="text-align:center;padding:20px;color:#9ca3af;font-size:13px">暂无排名数据</div>
                `;
                return;
            }
            
            let html = `
                <div class="rank-header-row">
                    <div class="rank-header-item rank-header-number">排名</div>
                    <div class="rank-header-item rank-header-stock">股票名称</div>
                    <div class="rank-header-item rank-header-jitu">竞图</div>
                    <div class="rank-header-item rank-header-diezhang">涨幅</div>
                    <div class="rank-header-item rank-header-concept">题材概念</div>
                    <div class="rank-header-item rank-header-turnover">成交额</div>
                </div>
            `;
            
            let displayIndex = 0;
            rankList.forEach((item, index) => {
                if (item.type === 'empty') {
                    html += `<div class="rank-item" style="height:16px;background:transparent;"></div>`;
                    return;
                }
                
                if (item.type === 'separator') {
                    html += `
                        <div class="rank-item" style="background:#fffbeb;">
                            <div class="rank-number"></div>
                            <div class="rank-stock-name" style="color:#dc2626;font-weight:600;">今日排行</div>
                            <div class="rank-jitu"></div>
                            <div class="rank-diezhang"></div>
                            <div class="rank-concept" style="color:#dc2626;font-weight:600;">${item.time || ''}</div>
                            <div class="rank-turnover"></div>
                        </div>
                    `;
                    displayIndex = 0;
                    return;
                }
                
                displayIndex++;
                const rankNumber = displayIndex;
                const isChecked = item.jitu === '✓';
                const conceptClass = isChecked ? 'red-text' : '';
                
                let percentClass = 'empty';
                let percentDisplay = '-';
                if (item.percent) {
                    const percentValue = parseFloat(item.percent) || 0;
                    percentClass = percentValue >= 0 ? 'rise' : 'fall';
                    percentDisplay = item.percent + '%';
                }
                
                let turnoverDisplay = item.turnover || '-';
                if (turnoverDisplay !== '-' && !isNaN(parseFloat(turnoverDisplay))) {
                    turnoverDisplay = turnoverDisplay.replace('亿', '');
                    turnoverDisplay = turnoverDisplay + '亿';
                }
                
                html += `
                    <div class="rank-item">
                        <div class="rank-number">${rankNumber}</div>
                        <div class="rank-stock-name">${item.stock || '-'}</div>
                        <div class="rank-jitu ${isChecked ? 'checked' : 'unchecked'}">${item.jitu || '×'}</div>
                        <div class="rank-diezhang ${percentClass}">${percentDisplay}</div>
                        <div class="rank-concept ${conceptClass}">${item.concept || '-'}</div>
                        <div class="rank-turnover">${turnoverDisplay}</div>
                    </div>
                `;
            });
            
            rankContent.innerHTML = html;
        }

        // 打开昨日最大成交额编辑

        // 打开昨日最大成交额编辑
        export function openRankEdit() {
            const rankList = window.getTodayRank();
            const formContainer = document.getElementById('rankFormContainer');
            
            let html = '';
            if (rankList.length === 0) {
                html = `
                    <div class="rank-form-row" id="rank-row-0">
                        <div class="rank-form-number">1</div>
                        <input type="text" class="form-input rank-form-stock-input" name="stock-0" placeholder="名称">
                        <select class="form-input rank-form-jitu-input" name="jitu-0">
                            <option value="×">×</option>
                            <option value="✓">✓</option>
                        </select>
                        <input type="text" class="form-input rank-form-percent-input" name="percent-0" placeholder="涨幅如：+4.5">
                        <input type="text" class="form-input rank-form-concept-input" name="concept-0" placeholder="题材">
                        <input type="text" class="form-input rank-form-turnover-input" name="turnover-0" placeholder="额">
                        <button type="button" class="remove-rank-btn" onclick="window.removeRankRow(0)">×</button>
                    </div>
                `;
            } else {
                let displayIndex = 0;
                let afterSeparator = false;
                rankList.forEach((item, index) => {
                    if (item.type === 'empty') {
                        html += `
                            <div class="rank-form-row rank-empty-row" id="rank-row-${index}" style="height:20px;background:transparent;">
                                <div class="rank-form-number"></div>
                                <input type="text" class="form-input rank-form-stock-input" name="stock-${index}" style="visibility:hidden;">
                                <select class="form-input rank-form-jitu-input" name="jitu-${index}" style="visibility:hidden;">
                                    <option value="×">×</option>
                                    <option value="✓">✓</option>
                                </select>
                                <input type="text" class="form-input rank-form-percent-input" name="percent-${index}" style="visibility:hidden;">
                                <input type="text" class="form-input rank-form-concept-input" name="concept-${index}" style="visibility:hidden;">
                                <input type="text" class="form-input rank-form-turnover-input" name="turnover-${index}" style="visibility:hidden;">
                                <button type="button" class="remove-rank-btn" onclick="window.removeRankRow(${index})">×</button>
                            </div>
                        `;
                        return;
                    }
                    
                    if (item.type === 'separator') {
                        html += `
                            <div class="rank-form-row rank-separator-row" id="rank-row-${index}">
                                <div class="rank-form-number"></div>
                                <input type="text" class="form-input rank-form-stock-input" name="stock-${index}" value="今日排行" placeholder="名称" style="color:#dc2626;font-weight:600;text-align:center;" readonly>
                                <select class="form-input rank-form-jitu-input" name="jitu-${index}" style="visibility:hidden;">
                                    <option value="×">×</option>
                                    <option value="✓">✓</option>
                                </select>
                                <input type="text" class="form-input rank-form-percent-input" name="percent-${index}" value="" placeholder="涨幅如：+4.5" style="visibility:hidden;">
                                <input type="text" class="form-input rank-form-concept-input" name="concept-${index}" value="${item.time || ''}" placeholder="题材" style="color:#dc2626;font-weight:600;text-align:center;" readonly>
                                <input type="text" class="form-input rank-form-turnover-input" name="turnover-${index}" value="" placeholder="额" style="visibility:hidden;">
                                <button type="button" class="remove-rank-btn" onclick="window.removeRankRow(${index})">×</button>
                            </div>
                        `;
                        afterSeparator = true;
                        displayIndex = 0;
                        return;
                    }

                    displayIndex++;
                    let turnoverValue = item.turnover || '';
                    if (turnoverValue && turnoverValue.includes('亿')) {
                        turnoverValue = turnoverValue.replace('亿', '');
                    }
                    
                    html += `
                        <div class="rank-form-row" id="rank-row-${index}">
                            <div class="rank-form-number">${displayIndex}</div>
                            <input type="text" class="form-input rank-form-stock-input" name="stock-${index}" value="${item.stock || ''}" placeholder="名称">
                            <select class="form-input rank-form-jitu-input" name="jitu-${index}">
                                <option value="×" ${item.jitu === '×' ? 'selected' : ''}>×</option>
                                <option value="✓" ${item.jitu === '✓' ? 'selected' : ''}>✓</option>
                            </select>
                            <input type="text" class="form-input rank-form-percent-input" name="percent-${index}" value="${item.percent || ''}" placeholder="涨幅如：+4.5">
                            <input type="text" class="form-input rank-form-concept-input" name="concept-${index}" value="${item.concept || ''}" placeholder="题材">
                            <input type="text" class="form-input rank-form-turnover-input" name="turnover-${index}" value="${turnoverValue}" placeholder="额">
                            <button type="button" class="remove-rank-btn" onclick="window.removeRankRow(${index})">×</button>
                        </div>
                    `;
                });
            }
            
            formContainer.innerHTML = html;
            document.getElementById('rankModal').classList.add('active');
        }

        // 获取ETF数据

        // 保存本月总结心得
        export function saveMonthlySummary() {
            const monthRange = window.getMonthTradingDays(window.currentDate);
            const summaryKey = `monthly_summary_${monthRange.firstDay}_${monthRange.lastDay}`;
            const summary = document.getElementById('monthlySummaryText').value.trim();
            
            localStorage.setItem(summaryKey, summary);
            window.closeMonthlySummaryModal();
            window.renderMonthlySummary();
        }

        // HTML转义函数

        // HTML转义函数
        export function escapeHtml(text) {
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }

        // 打开最近多板评论编辑

        // 打开最近多板评论编辑
        export function openDuibanCommentEdit() {
            const comment = window.getTodayDuibanComment();
            document.getElementById('duibanCommentInput').value = comment;
            document.getElementById('duibanCommentModal').classList.add('active');
        }

        // 关闭最近多板评论编辑

        // 关闭最近多板评论编辑
        export function closeDuibanCommentModal() {
            document.getElementById('duibanCommentModal').classList.remove('active');
        }

        // 保存最近多板评论

        // 保存最近多板评论
        export function saveDuibanComment() {
            const commentInput = document.getElementById('duibanCommentInput');
            if (!commentInput) return;
            
            const comment = commentInput.value.trim();
            const allComments = JSON.parse(localStorage.getItem('duibanComment') || '{}');
            allComments[window.currentDate] = comment;
            localStorage.setItem('duibanComment', JSON.stringify(allComments));
            
            window.renderDuiban();
            window.closeDuibanCommentModal();
        }

        // 移除昨日最大成交额行

        // 移除昨日最大成交额行
        export function removeRankRow(index) {
            // 先更新数据存储，移除对应索引的数据
            const rankData = window.getRankData();
            let rankList = rankData[window.currentDate] || [];
            
            // 过滤掉 type 为 separator 和 empty 的行，只保留真正的股票数据
            const stockItems = rankList.filter(item => item && item.stock);
            
            if (index >= 0 && index < stockItems.length) {
                stockItems.splice(index, 1);
                // 重新构建列表，保留 separator 和 empty，但移除对应的股票
                const newRankList = [];
                let stockIdx = 0;
                rankList.forEach(item => {
                    if (item && (item.type === 'separator' || item.type === 'empty')) {
                        newRankList.push(item);
                    } else if (item && item.stock) {
                        if (stockIdx < stockItems.length) {
                            newRankList.push(stockItems[stockIdx]);
                            stockIdx++;
                        }
                    }
                });
                rankData[window.currentDate] = newRankList;
                window.saveData();
            }
            
            const row = document.getElementById(`rank-row-${index}`);
            if (row) {
                row.remove();
                // 重新编号所有行
                const formContainer = document.getElementById('rankFormContainer');
                const rows = formContainer.querySelectorAll('.rank-form-row');
                rows.forEach((row, i) => {
                    row.id = `rank-row-${i}`;
                    row.querySelector('.rank-form-number').textContent = i + 1;
                    
                    // 更新输入框的name属性和删除按钮
                    const inputs = row.querySelectorAll('input, select');
                    const fieldNames = ['stock', 'jitu', 'percent', 'concept', 'turnover'];
                    inputs.forEach((input, inputIdx) => {
                        if (inputIdx < fieldNames.length) {
                            input.name = `${fieldNames[inputIdx]}-${i}`;
                        }
                    });
                    
                    const removeBtn = row.querySelector('.remove-rank-btn');
                    if (removeBtn) {
                        removeBtn.setAttribute('onclick', `window.removeRankRow(${i})`);
                    }
                });
            }
        }

        // 添加昨日最大成交额行

        // 添加昨日最大成交额行
        export function addRankRow() {
            const formContainer = document.getElementById('rankFormContainer');
            const rowCount = formContainer.querySelectorAll('.rank-form-row').length;
            const newRow = document.createElement('div');
            newRow.className = 'rank-form-row';
            newRow.id = `rank-row-${rowCount}`;
            
            newRow.innerHTML = `
                <div class="rank-form-number">${rowCount + 1}</div>
                <input type="text" class="form-input rank-form-stock-input" name="stock-${rowCount}" placeholder="名称">
                <select class="form-input rank-form-jitu-input" name="jitu-${rowCount}">
                    <option value="×">×</option>
                    <option value="✓">✓</option>
                </select>
                <input type="text" class="form-input rank-form-percent-input" name="percent-${rowCount}" placeholder="涨幅如：+4.5">
                <input type="text" class="form-input rank-form-concept-input" name="concept-${rowCount}" placeholder="题材">
                <input type="text" class="form-input rank-form-turnover-input" name="turnover-${rowCount}" placeholder="额">
                <button type="button" class="remove-rank-btn" onclick="window.removeRankRow(${rowCount})">×</button>
            `;
            
            formContainer.appendChild(newRow);
        }

        // 保存昨日最大成交额数据

        // 保存昨日最大成交额数据
        export function saveRank(e) {
            e.preventDefault();
            const formContainer = document.getElementById('rankFormContainer');
            const rows = formContainer.querySelectorAll('.rank-form-row');
            const rankList = [];
            
            rows.forEach((row, index) => {
                if (row.classList.contains('rank-empty-row')) {
                    rankList.push({ type: 'empty' });
                    return;
                }
                
                if (row.classList.contains('rank-separator-row')) {
                    const conceptInput = row.querySelector(`[name="concept-${index}"]`);
                    rankList.push({
                        type: 'separator',
                        time: conceptInput ? conceptInput.value.trim() : ''
                    });
                    return;
                }
                
                const stockInput = row.querySelector(`[name="stock-${index}"]`);
                const jituSelect = row.querySelector(`[name="jitu-${index}"]`);
                const percentInput = row.querySelector(`[name="percent-${index}"]`);
                const conceptInput = row.querySelector(`[name="concept-${index}"]`);
                const turnoverInput = row.querySelector(`[name="turnover-${index}"]`);
                
                const stock = stockInput ? stockInput.value.trim() : '';
                const jitu = jituSelect ? jituSelect.value : '×';
                const percent = percentInput ? percentInput.value.trim() : '';
                const concept = conceptInput ? conceptInput.value.trim() : '';
                let turnover = turnoverInput ? turnoverInput.value.trim() : '';
                
                if (turnover && turnover.includes('亿')) {
                    turnover = turnover.replace('亿', '');
                }
                
                if (stock) {
                    rankList.push({
                        stock,
                        jitu,
                        percent,
                        concept,
                        turnover
                    });
                }
            });
            
            window.getRankData()[window.currentDate] = rankList;
            window.saveData();
            window.renderRank();
            window.closeRankModal();
        }

        // 关闭排名编辑

        // 关闭排名编辑
        export function closeRankModal() {
            document.getElementById('rankModal').classList.remove('active');
        }

        // 从粘贴导入排名数据

        // 从粘贴导入排名数据
        export function importRankFromPaste() {
            const pasteText = document.getElementById('rankPasteInput').value.trim();
            if (!pasteText) {
                document.getElementById('rankImportStatus').textContent = '请先粘贴数据！';
                document.getElementById('rankImportStatus').style.color = '#dc2626';
                return;
            }

            const lines = pasteText.split('\n');
            const newRankList = [];

            lines.forEach((line, index) => {
                if (!line.trim()) return;
                
                // 跳过标题行 - 严格检查
                const trimmedLine = line.trim();
                if (index === 0 && (trimmedLine.includes('股票名称') || trimmedLine.includes('涨幅') || trimmedLine.includes('概念'))) {
                    return;
                }

                // 先用 Tab 分割
                let cells = line.split('\t');
                
                // 检查是否真正是 Tab 分隔：如果第一个单元格包含空格且很长，说明实际是空格分隔
                const firstCellHasSpaces = cells[0] && cells[0].trim().includes(' ');
                const firstCellIsLong = cells[0] && cells[0].trim().length > 8;
                
                if (firstCellHasSpaces && firstCellIsLong) {
                    cells = trimmedLine.split(/\s+/);
                } else if (cells.length < 2) {
                    // 如果只有1个单元格，说明是空格分隔
                    cells = trimmedLine.split(/\s+/);
                }
                
                // 过滤空单元格 - 使用更严格的检查
                cells = cells.filter(c => {
                    const trimmed = c.trim();
                    return trimmed !== '';
                });
                
                // 支持3列或4列格式
                if (cells.length < 2) {
                    return;
                }

                const stock = cells[0].trim();
                let percentRaw = '';
                let concept = '';
                let turnoverRaw = '';

                if (cells.length >= 4) {
                    // 4列格式：股票名称 + 涨幅 + 概念 + 成交额
                    percentRaw = cells[1].trim();
                    concept = cells[2].trim();
                    turnoverRaw = cells[3].trim();
                } else if (cells.length === 3) {
                    // 3列格式：股票名称 + 涨幅 + 概念 或 股票名称 + 概念 + 成交额
                    const secondCell = cells[1].trim();
                    const thirdCell = cells[2].trim();
                    // 判断第二列是涨幅还是概念
                    if (secondCell.includes('%') || secondCell.includes('+') || secondCell.includes('-') || secondCell.startsWith('+') || secondCell.startsWith('-')) {
                        // 股票名称 + 涨幅 + 概念
                        percentRaw = secondCell;
                        concept = thirdCell;
                    } else if (thirdCell.includes('亿') || thirdCell.includes('万') || (!isNaN(parseFloat(thirdCell)) && thirdCell.match(/\d/))) {
                        // 股票名称 + 概念 + 成交额
                        concept = secondCell;
                        turnoverRaw = thirdCell;
                    } else {
                        // 默认当作 概念 + 成交额
                        concept = secondCell;
                        turnoverRaw = thirdCell;
                    }
                } else {
                    // 2列格式：股票名称 + 板块/概念/涨幅/成交额
                    const secondCell = cells[1].trim();
                    // 判断第二列是什么类型
                    // 1. 涨幅：以 %、+、- 开头或结尾
                    // 2. 成交额：包含"亿"或"万"或全是数字
                    // 3. 板块/概念：其他
                    if (secondCell.includes('%') || secondCell.includes('+') || secondCell.includes('-') || secondCell.startsWith('+') || secondCell.startsWith('-')) {
                        percentRaw = secondCell;
                    } else if (secondCell.includes('亿') || secondCell.includes('万') || (!isNaN(parseFloat(secondCell)) && secondCell.match(/\d/))) {
                        turnoverRaw = secondCell;
                    } else {
                        concept = secondCell;
                    }
                }

                if (!stock) return;

                let percent = percentRaw;
                if (percent && percent.includes('%')) {
                    percent = percent.replace('%', '').trim();
                }

                let turnover = turnoverRaw;
                if (turnover && turnover.includes('亿')) {
                    turnover = turnover.replace('亿', '').trim();
                }

                newRankList.push({
                    stock,
                    jitu: '×',
                    percent,
                    concept,
                    turnover
                });
            });

            if (newRankList.length === 0) {
                document.getElementById('rankImportStatus').textContent = '未能解析到有效数据！';
                document.getElementById('rankImportStatus').style.color = '#dc2626';
                return;
            }

            // 追加到现有数据 - 同名合并，不同名追加到分隔线后
            const existingRankList = window.getTodayRank();
            
            // 检查是否真的有股票数据（不只是检查数组长度）
            const hasStockData = existingRankList.some(item => item && item.stock);
            
            let finalRankList = [];

            if (hasStockData) {
                // 分离现有数据：分隔线前的数据、分隔线、分隔线后的数据
                let beforeSeparator = [];
                let separatorIndex = -1;
                let afterSeparator = [];
                
                existingRankList.forEach((item, index) => {
                    if (item.type === 'separator') {
                        separatorIndex = index;
                    } else if (separatorIndex === -1) {
                        beforeSeparator.push(item);
                    } else {
                        afterSeparator.push(item);
                    }
                });
                
                // 检查新数据是否都是补充（都存在于现有数据中）
                const allExistingItems = [...beforeSeparator, ...afterSeparator];
                const allAreSupplements = newRankList.every(newItem => {
                    return allExistingItems.some(item => item && item.stock === newItem.stock);
                });
                
                // 遍历新数据，同名合并，不同名追加
                let hasNewStock = false;
                newRankList.forEach(newItem => {
                    // 先在分隔线前的数据中查找
                    let existingIndex = beforeSeparator.findIndex(item => item && item.stock === newItem.stock);
                    if (existingIndex === -1) {
                        // 再在分隔线后的数据中查找
                        existingIndex = afterSeparator.findIndex(item => item && item.stock === newItem.stock);
                        if (existingIndex !== -1) {
                            // 找到，更新数据
                            const existingItem = afterSeparator[existingIndex];
                            if (!existingItem.percent && newItem.percent) existingItem.percent = newItem.percent;
                            if (!existingItem.concept && newItem.concept) existingItem.concept = newItem.concept;
                            if (!existingItem.turnover && newItem.turnover) existingItem.turnover = newItem.turnover;
                        }
                    } else {
                        // 找到，更新数据
                        const existingItem = beforeSeparator[existingIndex];
                        if (!existingItem.percent && newItem.percent) existingItem.percent = newItem.percent;
                        if (!existingItem.concept && newItem.concept) existingItem.concept = newItem.concept;
                        if (!existingItem.turnover && newItem.turnover) existingItem.turnover = newItem.turnover;
                    }
                    
                    if (existingIndex === -1) {
                        // 不同名，追加到分隔线后
                        afterSeparator.push(newItem);
                        hasNewStock = true;
                    }
                });
                
                // 检查是否有完整数据（四列都有值）
                const hasCompleteData = afterSeparator.some(item => {
                    return item && item.stock && item.percent && item.concept && item.turnover;
                });
                
                // 移除所有空行
                beforeSeparator = beforeSeparator.filter(item => item && item.stock);
                afterSeparator = afterSeparator.filter(item => item && item.stock);
                
                // 重新组装：分隔线前的数据 + 分隔线（如果有完整数据） + 分隔线后的数据
                finalRankList = [...beforeSeparator];
                
                if (hasCompleteData && afterSeparator.length > 0) {
                    finalRankList.push({ type: 'empty' });
                    const now = new Date();
                    const timeStr = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
                    finalRankList.push({
                        type: 'separator',
                        time: timeStr
                    });
                }
                
                finalRankList = [...finalRankList, ...afterSeparator];
            } else {
                finalRankList = newRankList;
            }

            window.getRankData()[window.currentDate] = finalRankList;
            window.saveData();

            window.renderRankForm();

            document.getElementById('rankPasteInput').value = '';
            document.getElementById('rankImportStatus').textContent = `✅ 成功导入 ${newRankList.length} 条数据`;
            document.getElementById('rankImportStatus').style.color = '#059669';
        }

        // 渲染排名表单（供导入后刷新使用）

        // 渲染排名表单（供导入后刷新使用）
        export function renderRankForm() {
            const rankList = window.getTodayRank();
            const formContainer = document.getElementById('rankFormContainer');

            if (rankList.length === 0) {
                formContainer.innerHTML = `
                    <div class="rank-form-row" id="rank-row-0">
                        <div class="rank-form-number">1</div>
                        <input type="text" class="form-input rank-form-stock-input" name="stock-0" placeholder="名称">
                        <select class="form-input rank-form-jitu-input" name="jitu-0">
                            <option value="×">×</option>
                            <option value="✓">✓</option>
                        </select>
                        <input type="text" class="form-input rank-form-percent-input" name="percent-0" placeholder="涨幅如：+4.5">
                        <input type="text" class="form-input rank-form-concept-input" name="concept-0" placeholder="题材">
                        <input type="text" class="form-input rank-form-turnover-input" name="turnover-0" placeholder="额">
                        <button type="button" class="remove-rank-btn" onclick="window.removeRankRow(0)">×</button>
                    </div>
                `;
                return;
            }

            let html = '';
            let displayIndex = 0;
            let afterSeparator = false;
            rankList.forEach((item, index) => {
                if (item.type === 'empty') {
                    html += `
                        <div class="rank-form-row rank-empty-row" id="rank-row-${index}" style="height:20px;background:transparent;">
                            <div class="rank-form-number"></div>
                            <input type="text" class="form-input rank-form-stock-input" name="stock-${index}" style="visibility:hidden;">
                            <select class="form-input rank-form-jitu-input" name="jitu-${index}" style="visibility:hidden;">
                                <option value="×">×</option>
                                <option value="✓">✓</option>
                            </select>
                            <input type="text" class="form-input rank-form-percent-input" name="percent-${index}" style="visibility:hidden;">
                            <input type="text" class="form-input rank-form-concept-input" name="concept-${index}" style="visibility:hidden;">
                            <input type="text" class="form-input rank-form-turnover-input" name="turnover-${index}" style="visibility:hidden;">
                            <button type="button" class="remove-rank-btn" onclick="window.removeRankRow(${index})">×</button>
                        </div>
                    `;
                    return;
                }
                
                if (item.type === 'separator') {
                    html += `
                        <div class="rank-form-row rank-separator-row" id="rank-row-${index}">
                            <div class="rank-form-number"></div>
                            <input type="text" class="form-input rank-form-stock-input" name="stock-${index}" value="今日排行" placeholder="名称" style="color:#dc2626;font-weight:600;text-align:center;" readonly>
                            <select class="form-input rank-form-jitu-input" name="jitu-${index}" style="visibility:hidden;">
                                <option value="×">×</option>
                                <option value="✓">✓</option>
                            </select>
                            <input type="text" class="form-input rank-form-percent-input" name="percent-${index}" value="" placeholder="涨幅如：+4.5" style="visibility:hidden;">
                            <input type="text" class="form-input rank-form-concept-input" name="concept-${index}" value="${item.time || ''}" placeholder="题材" style="color:#dc2626;font-weight:600;text-align:center;" readonly>
                            <input type="text" class="form-input rank-form-turnover-input" name="turnover-${index}" value="" placeholder="额" style="visibility:hidden;">
                            <button type="button" class="remove-rank-btn" onclick="window.removeRankRow(${index})">×</button>
                        </div>
                    `;
                    afterSeparator = true;
                    displayIndex = 0;
                    return;
                }

                displayIndex++;
                let turnoverValue = item.turnover || '';
                if (turnoverValue && turnoverValue.includes('亿')) {
                    turnoverValue = turnoverValue.replace('亿', '');
                }

                html += `
                    <div class="rank-form-row" id="rank-row-${index}">
                        <div class="rank-form-number">${displayIndex}</div>
                        <input type="text" class="form-input rank-form-stock-input" name="stock-${index}" value="${item.stock || ''}" placeholder="名称">
                        <select class="form-input rank-form-jitu-input" name="jitu-${index}">
                            <option value="×" ${item.jitu === '×' ? 'selected' : ''}>×</option>
                            <option value="✓" ${item.jitu === '✓' ? 'selected' : ''}>✓</option>
                        </select>
                        <input type="text" class="form-input rank-form-percent-input" name="percent-${index}" value="${item.percent || ''}" placeholder="涨幅如：+4.5">
                        <input type="text" class="form-input rank-form-concept-input" name="concept-${index}" value="${item.concept || ''}" placeholder="题材">
                        <input type="text" class="form-input rank-form-turnover-input" name="turnover-${index}" value="${turnoverValue}" placeholder="额">
                        <button type="button" class="remove-rank-btn" onclick="window.removeRankRow(${index})">×</button>
                    </div>
                `;
            });

            formContainer.innerHTML = html;
        }

        // 判断第一列是否需要特殊样式

