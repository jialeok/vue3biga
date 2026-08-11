// boards-duiban.js — 从 boards-render.js 拆分（看板域: boards-duiban.js）

        // 获取今日最近多板数据
        export function getTodayDuiban() {
            const data = JSON.parse(localStorage.getItem('duibanData') || '{}');
            return data[window.currentDate] || [];
        }

        // 保存今日最近多板数据

        // 保存今日最近多板数据
        export function saveTodayDuiban(duibanList) {
            const data = JSON.parse(localStorage.getItem('duibanData') || '{}');
            data[window.currentDate] = duibanList;
            localStorage.setItem('duibanData', JSON.stringify(data));
        }

        // 根据早盘竞价看板当天所有股票的涨跌幅（note字段），自动统计"最近多板"的总数量和跌涨比。
        // 总数 = 早盘竞价列表的股票总数（不管有没有涨跌幅数据，停牌的也算在内）。
        // 涨数（红数）= note中含"涨停"或百分比>0的股票数量。
        // 跌数 = 总数 - 涨数（即：平盘、停牌、跌停、百分比<=0 的都算跌）。

        // 根据早盘竞价看板当天所有股票的涨跌幅（note字段），自动统计"最近多板"的总数量和跌涨比。
        // 总数 = 早盘竞价列表的股票总数（不管有没有涨跌幅数据，停牌的也算在内）。
        // 涨数（红数）= note中含"涨停"或百分比>0的股票数量。
        // 跌数 = 总数 - 涨数（即：平盘、停牌、跌停、百分比<=0 的都算跌）。
        export function recalcDuibanFromAuction() {
            const auctionList = window.getTodayAuction();
            const total = auctionList.length;
            if (total === 0) return; // 没有股票时不做统计更新（避免把已有的手动数据清空）

            let riseCount = 0;

            auctionList.forEach(item => {
                const note = item.note || '';
                if (note.includes('涨停')) {
                    riseCount++;
                    return;
                }
                if (note.includes('跌停')) return;
                const percentMatch = note.match(/-?\d+\.?\d*%/);
                if (percentMatch) {
                    const value = parseFloat(percentMatch[0]);
                    if (value > 0) riseCount++;
                }
            });

            const fallCount = total - riseCount;

            const duibanData = JSON.parse(localStorage.getItem('duibanData') || '{}');
            const existingList = duibanData[window.currentDate] || [];
            const firstRow = existingList[0] || {};

            const updatedFirstRow = {
                ...firstRow,
                shuliang: String(total),
                dieZhangbi: `${fallCount}:${riseCount}`
            };

            const newList = [updatedFirstRow, ...existingList.slice(1)];
            duibanData[window.currentDate] = newList;
            localStorage.setItem('duibanData', JSON.stringify(duibanData));

            window.renderDuiban();
            window.renderWeekendStats();
        }

        // 获取今日最近多板评论

        export function autoCalculateDuibanDieZhangbi(input, shuliangInput) {
            let value = input.value.trim();
            const total = parseInt(shuliangInput.value) || window.duibanDefaultTotal;
            
            if (value.includes(':')) {
                const parts = value.split(':');
                const left = parts[0] || '';
                const right = parts[1] || '';
                
                if (left !== '' && right === '') {
                    const die = parseInt(left) || 0;
                    const zhang = total - die;
                    input.value = die + ':' + zhang;
                } else if (left === '' && right !== '') {
                    const zhang = parseInt(right) || 0;
                    const die = total - zhang;
                    input.value = die + ':' + zhang;
                } else if (left !== '' && right !== '') {
                    const die = parseInt(left) || 0;
                    const zhang = parseInt(right) || 0;
                    shuliangInput.value = die + zhang;
                }
            }
        }
        

        export function onDuibanTotalChange(shuliangInput, dieZhangbiInput) {
            const total = parseInt(shuliangInput.value) || 56;
            window.duibanDefaultTotal = total;
            dieZhangbiInput.placeholder = total + ' (跌:涨)';
        }

        // 打开最近多板评论编辑
        // 记录当前打开编辑弹窗时，旧数据里除第一行外的其余行（用于保存时原样保留，不丢数据）
        let _duibanExtraRows = [];


        export function openDuibanEdit() {
            // 打开弹窗前先按当前早盘竞价数据重新计算一次，确保数值始终最新（不依赖之前是否做过导入操作）
            window.recalcDuibanFromAuction();

            const duibanList = window.getTodayDuiban();
            const formContainer = document.getElementById('duibanEditTableBody');

            const firstRow = duibanList[0] || {};
            _duibanExtraRows = duibanList.slice(1); // 旧数据若有多行，多余的行原样保留，不在编辑框里展示

            const shuliangVal = firstRow.shuliang || '';
            const dieZhangbiVal = firstRow.dieZhangbi || '';
            const jingtuVal = firstRow.jingtu || '';
            const tushiVal = firstRow.tushi || '';

            // 兼容旧的"跌:涨"单字符串格式，拆成两个独立数字
            let dieVal = '';
            let zhangVal = '';
            if (dieZhangbiVal.includes(':')) {
                const parts = dieZhangbiVal.split(':');
                dieVal = (parts[0] || '').trim();
                zhangVal = (parts[1] || '').trim();
            }

            const html = `
                <div class="duiban-edit-row" id="duiban-row-0">
                    <input type="text" class="form-input duiban-edit-shuliang-input" name="shuliang-0" value="${shuliangVal}" placeholder="总数量" oninput="window.onDuibanShuliangInput(this)">
                    <div style="display:flex;align-items:center;gap:4px;width:90px !important;">
                        <input type="text" class="form-input duiban-edit-die-input" name="die-0" value="${dieVal}" placeholder="跌" style="width:38px !important;text-align:center;padding-left:4px;padding-right:4px;" oninput="window.onDuibanDieZhangInput(this, 'die')">
                        <span style="color:#94a3b8;">:</span>
                        <input type="text" class="form-input duiban-edit-zhang-input" name="zhang-0" value="${zhangVal}" placeholder="涨" style="width:38px !important;text-align:center;padding-left:4px;padding-right:4px;" oninput="window.onDuibanDieZhangInput(this, 'zhang')">
                    </div>
                    <input type="text" class="form-input duiban-edit-jingtu-input" name="jingtu-0" value="${jingtuVal}" placeholder="竞符合数">
                    <input type="text" class="form-input duiban-edit-tushi-input" name="tushi-0" value="${tushiVal}" placeholder="图示/石墨链接">
                </div>
            `;

            formContainer.innerHTML = html;
            document.getElementById('duibanModal').classList.add('active');
        }

        // 总数量输入时：如果跌/涨其中一个已填，自动算出另一个

        // 总数量输入时：如果跌/涨其中一个已填，自动算出另一个
        export function onDuibanShuliangInput(shuliangInput) {
            const row = shuliangInput.closest('.duiban-edit-row');
            const dieInput = row.querySelector('[name="die-0"]');
            const zhangInput = row.querySelector('[name="zhang-0"]');
            const total = parseInt(shuliangInput.value) || 0;
            if (!total) return;
            const dieVal = dieInput.value.trim();
            const zhangVal = zhangInput.value.trim();
            if (dieVal !== '' && zhangVal === '') {
                zhangInput.value = Math.max(0, total - (parseInt(dieVal) || 0));
            } else if (zhangVal !== '' && dieVal === '') {
                dieInput.value = Math.max(0, total - (parseInt(zhangVal) || 0));
            }
        }

        // 跌/涨其中一个输入时：如果总数量已填，自动算出另一个

        // 跌/涨其中一个输入时：如果总数量已填，自动算出另一个
        export function onDuibanDieZhangInput(input, type) {
            const row = input.closest('.duiban-edit-row');
            const shuliangInput = row.querySelector('[name="shuliang-0"]');
            const dieInput = row.querySelector('[name="die-0"]');
            const zhangInput = row.querySelector('[name="zhang-0"]');
            const total = parseInt(shuliangInput.value) || 0;
            if (!total) return;
            const value = parseInt(input.value) || 0;
            if (type === 'die') {
                zhangInput.value = Math.max(0, total - value);
            } else {
                dieInput.value = Math.max(0, total - value);
            }
        }

        // 关闭最近多板编辑

        // 关闭最近多板编辑
        export function closeDuibanModal() {
            document.getElementById('duibanModal').classList.remove('active');
        }

        // 保存最近多板数据（单行布局：只读取第一行输入，旧数据里多余的行原样拼接保留，不丢数据）

        // 保存最近多板数据（单行布局：只读取第一行输入，旧数据里多余的行原样拼接保留，不丢数据）
        export function saveDuiban() {
            const row = document.getElementById('duiban-row-0');
            const dieInput = row ? row.querySelector('[name="die-0"]') : null;
            const zhangInput = row ? row.querySelector('[name="zhang-0"]') : null;
            const jingtuInput = row ? row.querySelector('[name="jingtu-0"]') : null;
            const shuliangInput = row ? row.querySelector('[name="shuliang-0"]') : null;
            const tushiInput = row ? row.querySelector('[name="tushi-0"]') : null;

            const dieVal = dieInput ? dieInput.value.trim() : '';
            const zhangVal = zhangInput ? zhangInput.value.trim() : '';
            const dieZhangbi = (dieVal || zhangVal) ? `${dieVal}:${zhangVal}` : '';
            const jingtu = jingtuInput ? jingtuInput.value.trim() : '';
            const shuliang = shuliangInput ? shuliangInput.value.trim() : '';
            const tushi = tushiInput ? tushiInput.value.trim() : '';

            const duibanList = [];
            if (dieZhangbi || jingtu || shuliang || tushi) {
                duibanList.push({ dieZhangbi, jingtu, shuliang, tushi });
            }
            // 旧数据里第一行之后的其余行，原样拼接保留
            duibanList.push(..._duibanExtraRows);
            
            window.saveTodayDuiban(duibanList);
            window.renderDuiban();
            window.renderWeekendStats();
            window.closeDuibanModal();
        }

        // 清除最近多板数据

        // 清除最近多板数据
        export function clearDuiban() {
            if (confirm('确定要清除所有最近多板数据吗？')) {
                _duibanExtraRows = [];
                window.saveTodayDuiban([]);
                window.renderDuiban();
                window.renderWeekendStats();
                window.closeDuibanModal();
            }
        }

        // 渲染最近多板看板

        // 渲染最近多板看板
        export function renderDuiban() {
            const duibanList = window.getTodayDuiban();
            const duibanComment = window.getTodayDuibanComment();
            const tableBody = document.getElementById('duibanTableBody');
            const placeholder = document.getElementById('duibanCommentPlaceholder');
            const commentText = document.getElementById('duibanCommentText');
            
            if (duibanList.length === 0) {
                tableBody.innerHTML = '<div class="duiban-empty">暂无数据，点击添加...</div>';
            } else {
                let html = '';
                duibanList.forEach((item) => {
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
                        <div class="duiban-row">
                            <div class="duiban-item duiban-item-shuliang">${item.shuliang || ''}</div>
                            <div class="duiban-item duiban-item-dieZhangbi">${item.dieZhangbi || ''}</div>
                            <div class="duiban-item duiban-item-jingtu">${item.jingtu || ''}</div>
                            <div class="duiban-item duiban-item-tushi">${tushiHtml}</div>
                        </div>
                    `;
                });
                tableBody.innerHTML = html;
            }
            
            if (duibanComment) {
                if (placeholder) placeholder.style.display = 'none';
                if (commentText) {
                    commentText.style.display = 'block';
                    commentText.textContent = duibanComment;
                }
            } else {
                if (placeholder) placeholder.style.display = 'block';
                if (commentText) commentText.style.display = 'none';
            }
        }

        // 判断是否为非交易日（周末或用户标记的休假）

