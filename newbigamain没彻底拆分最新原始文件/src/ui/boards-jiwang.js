// boards-jiwang.js — 从 boards-render.js 拆分（看板域: boards-jiwang.js）

        // 金额简写函数（超过100万显示为w形式）
        export function formatAmount(value) {
            if (value === undefined || value === '' || isNaN(parseFloat(value))) {
                return '-';
            }
            
            const num = parseFloat(value);
            if (Math.abs(num) >= 1000000) {
                // 超过100万，简写成w形式，四舍五入
                const wValue = Math.round(num / 10000);
                return wValue + 'w';
            } else {
                // 小于100万，显示完整数字
                return num.toLocaleString('zh-CN');
            }
        }

        // 渲染记忘看板

        // 渲染记忘看板
        export function renderJiwang() {
            const data = window.getTodayJiwang() || {};
            document.getElementById('jw-diezhang').textContent = data.diezhang || '-';
            document.getElementById('jw-qingxu').textContent = data.qingxu || '-';
            
            // 渲染今日聚焦（处理谁增做谁的子选项）
            const jujiaoEl = document.getElementById('jw-jujiao');
            if (data.jujiao === '谁增做谁' && data.whoIncrease) {
                let subStyle = '';
                if (data.whoIncrease === '龙头增' || data.whoIncrease === '板块增' || data.whoIncrease === '谁都增') {
                    subStyle = 'font-size:13px;color:#dc2626';
                } else if (data.whoIncrease === '谁都减') {
                    subStyle = 'font-size:13px;color:#059669';
                }
                jujiaoEl.innerHTML = `<span style="font-size:13px;color:#1f2937">谁增做谁</span> <span style="${subStyle}">${data.whoIncrease}</span>`;
            } else {
                jujiaoEl.textContent = data.jujiao || '-';
                jujiaoEl.className = 'jiwang-value';
            }
            
            // 显示前缀+K线（如果有前缀）
            let kxianDisplay = data.kxian || '-';
            if (data.kxianPrefix && data.kxian) {
                kxianDisplay = data.kxianPrefix + '+' + data.kxian;
            }
            document.getElementById('jw-kxian').textContent = kxianDisplay;
            document.getElementById('jw-guancha').textContent = data.guancha || '-';
            document.getElementById('jw-guochengjieguo').textContent = data.guochengJieguo || '-';
            document.getElementById('jw-shougujieguo').textContent = data.shouguJieguo || '-';
            
            // 更新出手情况样式：对了显示红色，错了显示灰色（保持原字体大小13px）
            const chushouEl = document.getElementById('jw-chushou');
            chushouEl.textContent = data.chushou || '-';
            if (data.chushou === '出手对了' || data.chushou === '空仓对了') {
                chushouEl.className = 'jiwang-value red-highlight-small';
            } else if (data.chushou === '出手错了' || data.chushou === '空仓错了') {
                chushouEl.className = 'jiwang-value gray-highlight-small';
            } else {
                chushouEl.className = 'jiwang-value';
            }
            
            // 更新得出结论的样式
            const jielunEl = document.getElementById('jw-jielun');
            jielunEl.textContent = data.jielun || '-';
            if (data.jielun === '出手') {
                jielunEl.className = 'jiwang-value red-highlight';
            } else if (data.jielun === '空仓') {
                jielunEl.className = 'jiwang-value gray-highlight';
            } else {
                jielunEl.className = 'jiwang-value';
            }
            
            // 更新印章
            const stamp = document.getElementById('jiwangStamp');
            const stampQuestion = document.getElementById('stampQuestion');
            if (data.jielun === '出手') {
                stamp.className = 'jiwang-stamp red';
                stamp.style.border = '3px solid rgba(248, 113, 113, 0.5)';
                stamp.style.background = 'rgba(248, 113, 113, 0.15)';
                stamp.style.color = 'rgba(248, 113, 113, 0.6)';
                stampQuestion.innerHTML = '<div class="stamp-text">得出结论</div><div class="stamp-result">出手</div>';
            } else if (data.jielun === '空仓') {
                stamp.className = 'jiwang-stamp gray';
                stamp.style.border = '3px solid rgba(156, 163, 175, 0.5)';
                stamp.style.background = 'rgba(156, 163, 175, 0.15)';
                stamp.style.color = 'rgba(156, 163, 175, 0.6)';
                stampQuestion.innerHTML = '<div class="stamp-text">得出结论</div><div class="stamp-result">空仓</div>';
            } else {
                // 未填写时显示淡黄色大问号
                stamp.className = 'jiwang-stamp yellow';
                stamp.style.border = '3px solid rgba(253, 224, 71, 0.25)';
                stamp.style.background = 'rgba(253, 224, 71, 0.08)';
                stamp.style.color = 'rgba(253, 224, 71, 0.35)';
                stampQuestion.textContent = '?';
            }
            
            window.renderCircleStats();
        }

        // 渲染模式看板

        // 获取 N 个交易日前的日期（递归调用 getPreviousTradingDay）
        export function getNthPreviousTradingDay(dateStr, n) {
            let result = dateStr;
            for (let i = 0; i < n; i++) {
                result = window.getPreviousTradingDay(result);
                if (!result) return null;
            }
            return result;
        }

        // 根据收盘数值映射K线类型

        // 根据收盘数值映射K线类型
        export function getKxianTypeByClose(closeValue) {
            if (!closeValue) return '';

            // 后台数值不带%，直接解析
            const value = parseFloat(closeValue);

            if (isNaN(value)) return '';

            // 映射规则（value是数值，如3.6，输出时加上%）
            if (value >= 3.6) {
                return `大阳${value}%`;
            } else if (value >= 2.6) {
                return `中阳${value}%`;
            } else if (value >= 1.0) {
                return `小阳${value}%`;
            } else if (value > -1.0) {
                return `十字星${value}%`;
            } else if (value >= -2.5) {
                return `小阴${value}%`;
            } else if (value >= -3.5) {
                return `中阴${value}%`;
            } else {
                return `大阴${value}%`;
            }
        }

        // 获取上一交易日的最近多板收盘数值

        // 获取上一交易日的最近多板收盘数值
        export function getPrevDayMultiBoardClose() {
            const prevDate = window.getPreviousTradingDay(window.currentDate);
            if (!prevDate) return null;

            const biddingData = window.getBiddingData();
            const prevDayData = biddingData[prevDate];

            if (!prevDayData || !Array.isArray(prevDayData)) return null;

            // 找到"最近多板%"这一行
            const multiBoardRow = prevDayData.find(row => row.name === '最近多板%');
            if (!multiBoardRow) return null;

            return multiBoardRow.close || null;
        }

        // 打开记忘编辑

        // 打开记忘编辑
        export function openJiwangEdit() {
            const data = window.getTodayJiwang() || {};
            const diezhangValue = data.diezhang || '';
            
            // 判断是否是预设选项
            const presetOptions = ['1:2', '1:3', '1:4', '2:1', '1:1', '2:3', '3:1', '3:2', '4:1'];
            if (presetOptions.includes(diezhangValue)) {
                document.getElementById('jwEditDiezhang').value = diezhangValue;
                document.getElementById('jwEditDiezhangOther').style.display = 'none';
            } else if (diezhangValue) {
                document.getElementById('jwEditDiezhang').value = '其它';
                document.getElementById('jwEditDiezhangOther').style.display = 'block';
                document.getElementById('jwEditDiezhangOther').value = diezhangValue;
            } else {
                document.getElementById('jwEditDiezhang').value = '';
                document.getElementById('jwEditDiezhangOther').style.display = 'none';
            }
            
            document.getElementById('jwEditQingxu').value = data.qingxu || '';
            document.getElementById('jwEditJujiao').value = data.jujiao || '最近多板';

            // 填充昨多板K线前缀
            document.getElementById('jwEditKxianPrefix').value = data.kxianPrefix || '';

            // 自动填写昨多板K线（如果为空）
            let kxianValue = data.kxian || '';
            let autoGeneratedKxian = false;
            if (!kxianValue) {
                const prevClose = window.getPrevDayMultiBoardClose();
                if (prevClose) {
                    kxianValue = window.getKxianTypeByClose(prevClose);
                    autoGeneratedKxian = true;
                }
            }
            document.getElementById('jwEditKxian').value = kxianValue;

            // 如果自动生成了K线数据，自动保存
            if (autoGeneratedKxian && kxianValue) {
                const jiwangData = window.getJiwangData();
                if (!jiwangData[window.currentDate]) {
                    jiwangData[window.currentDate] = {};
                }
                jiwangData[window.currentDate].kxian = kxianValue;
                window.markJiwangDirty(window.currentDate);
                window.saveData();
                window.pushJiwangNow(window.currentDate);
                window.renderJiwang();
            }
            
            // 初始化谁增做谁子选择
            const whoIncreaseSelect = document.getElementById('jwEditWhoIncrease');
            if (data.jujiao === '谁增做谁' && data.whoIncrease) {
                whoIncreaseSelect.value = data.whoIncrease;
                whoIncreaseSelect.style.display = 'block';
            } else {
                whoIncreaseSelect.value = '';
                whoIncreaseSelect.style.display = 'none';
            }
            
            // 根据今日聚焦和子选项更新观察选项
            const jujiaoValue = data.jujiao || '最近多板';
            const whoIncreaseValue = data.whoIncrease || '';
            if (jujiaoValue === '最近多板') {
                window.updateGuanchaOptions('duoban');
            } else if (jujiaoValue === '板块ETF') {
                window.updateGuanchaOptions('etf');
            } else if (jujiaoValue === '谁增做谁') {
                if (whoIncreaseValue === '龙头增') {
                    window.updateGuanchaOptions('duoban');
                } else if (whoIncreaseValue === '板块增') {
                    window.updateGuanchaOptions('etf');
                } else {
                    window.updateGuanchaOptions('all');
                }
            } else {
                window.updateGuanchaOptions('all');
            }
            
            document.getElementById('jwEditGuancha').value = data.guancha || '';
            window.onGuanchaChange(); // 根据观察字段值初始化过程结果选项
            document.getElementById('jwEditGuochengJieguo').value = data.guochengJieguo || '';
            
            // 解析昨收盘结果（格式：跌:涨）
            const shouguJieguo = data.shouguJieguo || '';
            if (shouguJieguo.includes(':')) {
                const parts = shouguJieguo.split(':');
                document.getElementById('jwEditShouguJieguoDie').value = parts[0] || '';
                document.getElementById('jwEditShouguJieguoZhang').value = parts[1] || '';
            } else {
                document.getElementById('jwEditShouguJieguoDie').value = '';
                document.getElementById('jwEditShouguJieguoZhang').value = '';
            }
            
            document.getElementById('jwEditJielun').value = data.jielun || '';
            window.onJielunChange(); // 根据得出结论值初始化出手情况选项
            document.getElementById('jwEditChushou').value = data.chushou || '';
            
            // 同步板块ETF复选框状态
            const stats = window.getStats();
            const editSectorEtfCheck = document.getElementById('editSectorEtfCheck');
            if (editSectorEtfCheck) {
                const isSectorEtf = stats.sectorEtf || false;
                editSectorEtfCheck.textContent = isSectorEtf ? '✓' : '×';
                editSectorEtfCheck.className = `checkbox-option ${isSectorEtf ? 'checked' : 'unchecked'}`;
            }
            
            document.getElementById('jiwangModal').classList.add('active');
        }

        // 昨日跌涨选择变化

        // 昨日跌涨选择变化
        export function onDiezhangChange() {
            const select = document.getElementById('jwEditDiezhang');
            const otherInput = document.getElementById('jwEditDiezhangOther');
            
            if (select.value === '其它') {
                otherInput.style.display = 'block';
                otherInput.focus();
            } else {
                otherInput.style.display = 'none';
                otherInput.value = '';
            }
        }
        
        // 今日聚焦选择变化

        // 今日聚焦选择变化
        export function onJujiaoChange() {
            const select = document.getElementById('jwEditJujiao');
            const whoIncreaseSelect = document.getElementById('jwEditWhoIncrease');
            const guanchaSelect = document.getElementById('jwEditGuancha');
            
            if (select.value === '谁增做谁') {
                whoIncreaseSelect.style.display = 'block';
                whoIncreaseSelect.focus();
                // 重置观察选项为全部
                window.updateGuanchaOptions('all');
            } else if (select.value === '最近多板') {
                whoIncreaseSelect.style.display = 'none';
                whoIncreaseSelect.value = '';
                // 观察选项只显示最近多板过程、最近多板结果
                window.updateGuanchaOptions('duoban');
            } else if (select.value === '板块ETF') {
                whoIncreaseSelect.style.display = 'none';
                whoIncreaseSelect.value = '';
                // 观察选项只显示板块ETF过程
                window.updateGuanchaOptions('etf');
            }
        }
        
        // 谁增做谁子选择变化

        // 谁增做谁子选择变化
        export function onWhoIncreaseChange() {
            const whoIncreaseSelect = document.getElementById('jwEditWhoIncrease');
            const guanchaSelect = document.getElementById('jwEditGuancha');
            const value = whoIncreaseSelect.value;
            
            if (value === '龙头增') {
                // 观察选项只显示最近多板过程、最近多板结果
                window.updateGuanchaOptions('duoban');
            } else if (value === '板块增') {
                // 观察选项只显示板块ETF过程
                window.updateGuanchaOptions('etf');
            } else if (value === '谁都增' || value === '谁都减') {
                // 自动设置观察为"两个过程"，但用户还可以修改
                window.updateGuanchaOptions('all');
                guanchaSelect.value = '两个过程';
            } else {
                // 默认显示全部选项
                window.updateGuanchaOptions('all');
            }
            // 更新过程结果选项
            window.onGuanchaChange();
        }
        
        // 更新观察选项

        // 更新观察选项
        export function updateGuanchaOptions(type) {
            const guanchaSelect = document.getElementById('jwEditGuancha');
            const currentValue = guanchaSelect.value;
            
            // 清空现有选项
            guanchaSelect.innerHTML = '<option value="">请选择</option>';
            
            if (type === 'duoban') {
                // 只显示最近多板过程、最近多板结果
                guanchaSelect.innerHTML += '<option value="最近多板过程">最近多板过程</option>';
                guanchaSelect.innerHTML += '<option value="最近多板结果">最近多板结果</option>';
            } else if (type === 'etf') {
                // 只显示板块ETF过程
                guanchaSelect.innerHTML += '<option value="板块ETF过程">板块ETF过程</option>';
            } else {
                // 显示全部选项
                guanchaSelect.innerHTML += '<option value="最近多板过程">最近多板过程</option>';
                guanchaSelect.innerHTML += '<option value="最近多板结果">最近多板结果</option>';
                guanchaSelect.innerHTML += '<option value="板块ETF过程">板块ETF过程</option>';
                guanchaSelect.innerHTML += '<option value="两个过程">两个过程</option>';
            }
            
            // 如果之前的值还在新选项中，保持选中
            if (currentValue && Array.from(guanchaSelect.options).some(opt => opt.value === currentValue)) {
                guanchaSelect.value = currentValue;
            }
        }

        // 关闭记忘编辑

        // 关闭记忘编辑
        export function closeJiwangModal() {
            document.getElementById('jiwangModal').classList.remove('active');
        }

        // 保存记忘数据

        // 保存记忘数据
        export function saveJiwang(e) {
            e.preventDefault();
            const select = document.getElementById('jwEditDiezhang');
            const otherInput = document.getElementById('jwEditDiezhangOther');
            const diezhangValue = select.value === '其它' ? otherInput.value : select.value;
            
            const jujiaoSelect = document.getElementById('jwEditJujiao');
            const whoIncreaseSelect = document.getElementById('jwEditWhoIncrease');
            const whoIncreaseValue = jujiaoSelect.value === '谁增做谁' ? whoIncreaseSelect.value : '';
            
            // 在保存前同步板块ETF状态到stats
            const stats = window.getStats();
            const editSectorEtfCheck = document.getElementById('editSectorEtfCheck');
            if (editSectorEtfCheck) {
                stats.sectorEtf = editSectorEtfCheck.classList.contains('checked');
            }
            
            const data = {
                diezhang: diezhangValue,
                qingxu: document.getElementById('jwEditQingxu').value,
                jujiao: jujiaoSelect.value,
                whoIncrease: whoIncreaseValue,
                kxianPrefix: document.getElementById('jwEditKxianPrefix').value,
                kxian: document.getElementById('jwEditKxian').value,
                guancha: document.getElementById('jwEditGuancha').value,
                guochengJieguo: document.getElementById('jwEditGuochengJieguo').value,
                shouguJieguo: (document.getElementById('jwEditShouguJieguoDie').value || '') + ':' + (document.getElementById('jwEditShouguJieguoZhang').value || ''),
                jielun: document.getElementById('jwEditJielun').value,
                chushou: document.getElementById('jwEditChushou').value,
                stats: stats
            };
            window.getJiwangData()[window.currentDate] = data;
            window.markJiwangDirty(window.currentDate);
            window._dbgLog('saveJiwang: 保存 ' + window.currentDate + ' 到内存, data=' + JSON.stringify(data).slice(0, 300));
            window.saveData();
            window.pushJiwangNow(window.currentDate, '✅ 记忘看板已保存并同步到云端');
            window.renderJiwang();
            window.closeJiwangModal();
            
            window.autoCalculateRecentMultiScore();
            window.autoCalculateConsecutiveDays();
            window.renderConsecutiveUp();
        }

        // 渲染昨日最大成交额看板

