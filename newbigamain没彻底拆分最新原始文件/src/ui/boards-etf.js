// boards-etf.js — 从 boards-render.js 拆分（看板域: boards-etf.js）

        // 获取ETF数据
        export function getEtfData() {
            return JSON.parse(localStorage.getItem('stockEtfData') || '{}');
        }

        // 获取今日ETF数据

        // 获取今日ETF数据
        export function getTodayEtf() {
            const data = window.getEtfData();
            return data[window.currentDate] || [];
        }

        // 获取今日ETF评论

        // 获取今日ETF评论
        export function getTodayEtfComment() {
            const data = JSON.parse(localStorage.getItem('stockEtfComment') || '{}');
            return data[window.currentDate] || '';
        }

        // 打开ETF编辑

        // 打开ETF编辑
        export function openEtfEdit() {
            const etfList = window.getTodayEtf();
            const formContainer = document.getElementById('etfEditTableBody');

            let html = '';
            if (etfList.length === 0) {
                html = `
                    <div class="etf-edit-row" id="etf-row-0">
                        <input type="text" class="form-input etf-edit-shuliang-input" name="shuliang-0" value="" placeholder="总数量" style="width:60px !important;">
                        <input type="text" class="form-input etf-edit-die-input" name="die-0" value="" placeholder="跌" readonly style="width:50px !important;background:#f3f4f6;">
                        <input type="text" class="form-input etf-edit-zhang-input" name="zhang-0" value="" placeholder="涨" oninput="window.onEtfZhangInput(this)" style="width:50px !important;">
                        <input type="text" class="form-input etf-edit-jingtu-input" name="jingtu-0" placeholder="竞符合数">
                        <input type="text" class="form-input etf-edit-tushi-input" name="tushi-0" placeholder="图示">
                        <div class="etf-row-actions">
                            <button type="button" class="etf-remove-btn" onclick="window.removeEtfRow(0)">×</button>
                        </div>
                    </div>
                `;
            } else {
                etfList.forEach((item, index) => {
                    const shuliangVal = item.shuliang || '';
                    let dieVal = '';
                    let zhangVal = '';
                    if (item.dieZhangbi && item.dieZhangbi.includes(':')) {
                        const parts = item.dieZhangbi.split(':');
                        dieVal = parts[0] || '';
                        zhangVal = parts[1] || '';
                    }
                    html += `
                        <div class="etf-edit-row" id="etf-row-${index}">
                            <input type="text" class="form-input etf-edit-shuliang-input" name="shuliang-${index}" value="${shuliangVal}" placeholder="总数量" style="width:60px !important;">
                            <input type="text" class="form-input etf-edit-die-input" name="die-${index}" value="${dieVal}" placeholder="跌" readonly style="width:50px !important;background:#f3f4f6;">
                            <input type="text" class="form-input etf-edit-zhang-input" name="zhang-${index}" value="${zhangVal}" placeholder="涨" oninput="window.onEtfZhangInput(this)" style="width:50px !important;">
                            <input type="text" class="form-input etf-edit-jingtu-input" name="jingtu-${index}" value="${item.jingtu || ''}" placeholder="竞符合数">
                            <input type="text" class="form-input etf-edit-tushi-input" name="tushi-${index}" value="${item.tushi || ''}" placeholder="图示">
                            <div class="etf-row-actions">
                                <button type="button" class="etf-remove-btn" onclick="window.removeEtfRow(${index})">×</button>
                            </div>
                        </div>
                    `;
                });
            }

            formContainer.innerHTML = html;
            document.getElementById('etfModal').classList.add('active');
        }

        // 关闭ETF编辑

        // 关闭ETF编辑
        export function closeEtfModal() {
            document.getElementById('etfModal').classList.remove('active');
        }

        // 打开ETF评论编辑

        // 打开ETF评论编辑
        export function openEtfCommentEdit() {
            const comment = window.getTodayEtfComment();
            document.getElementById('etfCommentInput').value = comment;
            document.getElementById('etfCommentModal').classList.add('active');
        }

        // 关闭ETF评论编辑

        // 关闭ETF评论编辑
        export function closeEtfCommentModal() {
            document.getElementById('etfCommentModal').classList.remove('active');
        }

        // 添加ETF行

        // 添加ETF行
        export function addEtfRow() {
            const formContainer = document.getElementById('etfEditTableBody');
            const rows = formContainer.querySelectorAll('.etf-edit-row');
            const rowCount = rows.length;

            const newRow = document.createElement('div');
            newRow.className = 'etf-edit-row';
            newRow.id = `etf-row-${rowCount}`;
            newRow.innerHTML = `
                <input type="text" class="form-input etf-edit-shuliang-input" name="shuliang-${rowCount}" value="" placeholder="总数量" style="width:60px !important;">
                <input type="text" class="form-input etf-edit-die-input" name="die-${rowCount}" value="" placeholder="跌" readonly style="width:50px !important;background:#f3f4f6;">
                <input type="text" class="form-input etf-edit-zhang-input" name="zhang-${rowCount}" value="" placeholder="涨" oninput="window.onEtfZhangInput(this)" style="width:50px !important;">
                <input type="text" class="form-input etf-edit-jingtu-input" name="jingtu-${rowCount}" placeholder="竞符合数">
                <input type="text" class="form-input etf-edit-tushi-input" name="tushi-${rowCount}" placeholder="图示">
                <div class="etf-row-actions">
                    <button type="button" class="etf-remove-btn" onclick="window.removeEtfRow(${rowCount})">×</button>
                </div>
            `;

            formContainer.appendChild(newRow);
        }

        // 移除ETF行

        // 移除ETF行
        export function removeEtfRow(index) {
            const row = document.getElementById(`etf-row-${index}`);
            if (row) {
                row.remove();
                window.renumberEtfRows();
            }
        }

        // 重新编号ETF行

        // 重新编号ETF行
        export function renumberEtfRows() {
            const formContainer = document.getElementById('etfEditTableBody');
            const rows = formContainer.querySelectorAll('.etf-edit-row');
            rows.forEach((row, i) => {
                row.id = `etf-row-${i}`;
                
                const dieZhangbiInput = row.querySelector('input[name^="dieZhangbi-"]');
                const jingtuInput = row.querySelector('input[name^="jingtu-"]');
                const shuliangInput = row.querySelector('input[name^="shuliang-"]');
                const tushiInput = row.querySelector('input[name^="tushi-"]');
                const removeBtn = row.querySelector('.etf-remove-btn');
                
                if (dieZhangbiInput) dieZhangbiInput.name = `dieZhangbi-${i}`;
                if (jingtuInput) jingtuInput.name = `jingtu-${i}`;
                if (shuliangInput) shuliangInput.name = `shuliang-${i}`;
                if (tushiInput) tushiInput.name = `tushi-${i}`;
                if (removeBtn) removeBtn.onclick = function() { window.removeEtfRow(i); };
            });
        }

        // 清除ETF数据

        // 清除ETF数据
        export function clearEtf() {
            if (!confirm('确定要清除所有ETF数据吗？此操作不可恢复。')) {
                return;
            }
            localStorage.removeItem('stockEtfData');
            const formContainer = document.getElementById('etfEditTableBody');
            formContainer.innerHTML = `
                <div class="etf-edit-row" id="etf-row-0">
                    <input type="text" class="form-input etf-edit-shuliang-input" name="shuliang-0" value="" placeholder="总数量" style="width:60px !important;">
                    <input type="text" class="form-input etf-edit-die-input" name="die-0" value="" placeholder="跌" readonly style="width:50px !important;background:#f3f4f6;">
                    <input type="text" class="form-input etf-edit-zhang-input" name="zhang-0" value="" placeholder="涨" oninput="window.onEtfZhangInput(this)" style="width:50px !important;">
                    <input type="text" class="form-input etf-edit-jingtu-input" name="jingtu-0" placeholder="竞符合数">
                    <input type="text" class="form-input etf-edit-tushi-input" name="tushi-0" placeholder="图示">
                    <div class="etf-row-actions">
                        <button type="button" class="etf-remove-btn" onclick="window.removeEtfRow(0)">×</button>
                    </div>
                </div>
            `;
            window.renderEtf();
            window.showToast('✅ 数据已清除！');
        }

        // 保存ETF数据

        // 保存ETF数据
        export function saveEtf() {
            const formContainer = document.getElementById('etfEditTableBody');
            const rows = formContainer.querySelectorAll('.etf-edit-row');
            const etfList = [];

            rows.forEach((row, index) => {
                const shuliangInput = row.querySelector(`[name="shuliang-${index}"]`);
                const dieInput = row.querySelector(`[name="die-${index}"]`);
                const zhangInput = row.querySelector(`[name="zhang-${index}"]`);
                const jingtuInput = row.querySelector(`[name="jingtu-${index}"]`);
                const tushiInput = row.querySelector(`[name="tushi-${index}"]`);

                const shuliang = shuliangInput ? shuliangInput.value.trim() : '';
                const die = dieInput ? dieInput.value.trim() : '';
                const zhang = zhangInput ? zhangInput.value.trim() : '';
                const jingtu = jingtuInput ? jingtuInput.value.trim() : '';
                const tushi = tushiInput ? tushiInput.value.trim() : '';

                // 组合跌涨比
                let dieZhangbi = '';
                if (die || zhang) {
                    dieZhangbi = die + ':' + zhang;
                }

                if (shuliang || dieZhangbi || jingtu || tushi) {
                    etfList.push({
                        shuliang,
                        dieZhangbi,
                        jingtu,
                        tushi
                    });
                }
            });

            const etfData = window.getEtfData();
            etfData[window.currentDate] = etfList;
            localStorage.setItem('stockEtfData', JSON.stringify(etfData));

            window.renderEtf();
            window.renderWeekendStats();
            window.closeEtfModal();
        }

        // 保存ETF评论

        // 保存ETF评论
        export function saveEtfComment() {
            const commentInput = document.getElementById('etfCommentInput');
            if (!commentInput) return;
            
            const comment = commentInput.value.trim();
            const allComments = JSON.parse(localStorage.getItem('stockEtfComment') || '{}');
            allComments[window.currentDate] = comment;
            localStorage.setItem('stockEtfComment', JSON.stringify(allComments));
            
            window.renderEtf();
            window.closeEtfCommentModal();
            window.showToast('✅ 评论已保存！');
        }

        // 渲染ETF看板

        // 渲染ETF看板
        export function renderEtf() {
            const etfList = window.getTodayEtf();
            const etfComment = window.getTodayEtfComment();
            const tableBody = document.getElementById('etfTableBody');
            const placeholder = document.getElementById('etfCommentPlaceholder');
            const commentText = document.getElementById('etfCommentText');
            
            if (etfList.length === 0) {
                tableBody.innerHTML = '<div class="etf-empty">暂无数据，点击添加...</div>';
            } else {
                let html = '';
                etfList.forEach((item) => {
                    const tushiValue = item.tushi || '';
                    const isUrl = tushiValue.startsWith('http://') || tushiValue.startsWith('https://');
                    let tushiHtml;
                    if (isUrl) {
                        if (tushiValue.includes('shimo.im')) {
                            const docMatch = tushiValue.match(/shimo\.im\/(docs|sheets)\/([a-zA-Z0-9]+)/);
                            let deepLink = '';
                            if (docMatch && docMatch[1] && docMatch[2]) {
                                deepLink = `shimo://${docMatch[1]}/${docMatch[2]}`;
                            }
                            tushiHtml = `<a href="${tushiValue}" target="_blank" style="color:#3b82f6;text-decoration:none;" onclick="event.stopPropagation()">📄查看石墨</a>`;
                        } else {
                            tushiHtml = `<a href="${tushiValue}" target="_blank" style="color:#3b82f6;text-decoration:none;" onclick="event.stopPropagation()">打开链接</a>`;
                        }
                    } else {
                        tushiHtml = tushiValue;
                    }
                    html += `
                        <div class="etf-row">
                            <div class="etf-item etf-item-shuliang">${item.shuliang || ''}</div>
                            <div class="etf-item etf-item-dieZhangbi">${item.dieZhangbi || ''}</div>
                            <div class="etf-item etf-item-jingtu">${item.jingtu || ''}</div>
                            <div class="etf-item etf-item-tushi">${tushiHtml}</div>
                        </div>
                    `;
                });
                tableBody.innerHTML = html;
            }
            
            if (etfComment) {
                if (placeholder) placeholder.style.display = 'none';
                if (commentText) {
                    commentText.style.display = 'block';
                    commentText.textContent = etfComment;
                }
            } else {
                if (placeholder) placeholder.style.display = 'block';
                if (commentText) commentText.style.display = 'none';
            }
        }

        // 获取今日最近多板数据

        // 获取今日最近多板评论
        export function getTodayDuibanComment() {
            const data = JSON.parse(localStorage.getItem('duibanComment') || '{}');
            return data[window.currentDate] || '';
        }

        // 自动计算总数（根据跌涨比）- 用于最近多板

        // 自动计算总数（根据跌涨比）- 用于最近多板
        export function autoCalculateShuliang(dieZhangbiInput, shuliangInput) {
            const value = dieZhangbiInput.value.trim();
            if (value.includes(':')) {
                const parts = value.split(':');
                if (parts.length === 2) {
                    const num1 = parseInt(parts[0]) || 0;
                    const num2 = parseInt(parts[1]) || 0;
                    shuliangInput.value = num1 + num2;
                }
            }
        }

        // ETF专用：自动计算跌涨比（失去焦点时计算）
        let etfDefaultTotal = 48;
        

        export function autoCalculateEtfDieZhangbi(input, shuliangInput) {
            let value = input.value.trim();
            const total = parseInt(shuliangInput.value) || etfDefaultTotal;
            
            if (value.includes(':')) {
                const parts = value.split(':');
                const left = parts[0] || '';
                const right = parts[1] || '';
                
                // 只有一边有值时，计算另一边
                if (left !== '' && right === '') {
                    const die = parseInt(left) || 0;
                    const zhang = total - die;
                    input.value = die + ':' + zhang;
                } else if (left === '' && right !== '') {
                    const zhang = parseInt(right) || 0;
                    const die = total - zhang;
                    input.value = die + ':' + zhang;
                } else if (left !== '' && right !== '') {
                    // 两边都有值时，更新总数
                    const die = parseInt(left) || 0;
                    const zhang = parseInt(right) || 0;
                    shuliangInput.value = die + zhang;
                }
            }
        }
        

        export function onEtfTotalChange(shuliangInput, dieZhangbiInput) {
            const total = parseInt(shuliangInput.value) || 48;
            etfDefaultTotal = total;
            dieZhangbiInput.placeholder = total + ' (跌:涨)';
        }

        // 处理涨值输入

        // 处理涨值输入
        export function onEtfZhangInput(zhangInput) {
            const row = zhangInput.closest('.etf-edit-row');
            if (!row) return;

            const shuliangInput = row.querySelector('.etf-edit-shuliang-input');
            const dieInput = row.querySelector('.etf-edit-die-input');

            const zhangValue = parseInt(zhangInput.value) || 0;
            const zhangStr = zhangInput.value.trim();

            // 如果输入了涨值，自动设置默认总数量48
            if (zhangStr !== '' && !shuliangInput.value) {
                shuliangInput.value = '48';
            }

            const total = parseInt(shuliangInput.value) || 48;

            // 计算跌值
            if (zhangStr !== '') {
                const dieValue = total - zhangValue;
                dieInput.value = dieValue >= 0 ? dieValue : 0;
            } else {
                dieInput.value = '';
            }

            // 同步到竞价变化看板
            window.syncEtfZhangToBidding(zhangStr);
        }

        // 同步涨值到竞价变化看板

        // 同步涨值到竞价变化看板
        export function syncEtfZhangToBidding(zhangValue) {
            // 更新竞价变化看板的板块ETF收盘值
            const biddingModal = document.getElementById('biddingModal');
            if (biddingModal && biddingModal.classList.contains('active')) {
                const closeInputs = document.querySelectorAll('[data-sector-etf="true"]');
                closeInputs.forEach(closeInput => {
                    closeInput.value = zhangValue;
                });
            }

            // 同时更新已保存的竞价变化数据
            const biddingData = window.getBiddingData();
            const todayBidding = biddingData[window.currentDate];
            if (todayBidding && todayBidding.length > 0) {
                todayBidding.forEach(row => {
                    if ((row.name || '').includes('板块ETF')) {
                        row.close = zhangValue;
                    }
                });
                biddingData[window.currentDate] = todayBidding;
                window.saveData();
                window.renderBidding();
            }
        }

        // 最近多板专用：自动计算跌涨比（失去焦点时计算）
        window.duibanDefaultTotal = 56;
        

