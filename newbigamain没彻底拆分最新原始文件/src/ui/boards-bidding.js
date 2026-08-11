// boards-bidding.js — 从 boards-render.js 拆分（看板域: boards-bidding.js）

        export function getTodayBidding() {
            const biddingData = window.getBiddingData();
            const existingData = biddingData[window.currentDate];
            
            if (existingData !== undefined && Array.isArray(existingData)) {
                // 检查是否有任何有效数据（任何一行有任何非空字段）
                const hasValidData = existingData.some(row => {
                    return (row.name && row.name.toString().trim() !== '') ||
                           (row.time915 && row.time915.toString().trim() !== '') ||
                           (row.time920 && row.time920.toString().trim() !== '') ||
                           (row.time930 && row.time930.toString().trim() !== '') ||
                           (row.change && row.change.toString().trim() !== '') ||
                           (row.close && row.close.toString().trim() !== '');
                });
                if (hasValidData) {
                    return existingData;
                }
            }
            
            return null;
        }

        // 获取默认竞价变化模板

        // 获取默认竞价变化模板
        export function getDefaultBiddingTemplate() {
            const stored = localStorage.getItem('biddingDefaultTemplate_v41');
            if (stored) {
                try {
                    const template = JSON.parse(stored);
                    if (template && Array.isArray(template) && template.length > 0) {
                        return template;
                    }
                } catch (e) {
                }
            }
            // 默认模板
            return [
                { name: '最近多板%' },
                { name: '板块ETF(48)' },
                { name: '昨日资金前十' },
                { name: '大盘ETF' },
                { name: '大盘（%）' },
                { name: '封单家数' },
                { name: '账号溢价' }
            ];
        }

        // 保存默认竞价变化模板

        // 保存默认竞价变化模板
        export function saveDefaultBiddingTemplate(template) {
            localStorage.setItem('biddingDefaultTemplate_v41', JSON.stringify(template));
        }

        // 获取默认竞价变化数据（基于模板）

        // 获取默认竞价变化数据（基于模板）
        export function getDefaultBiddingData() {
            const template = window.getDefaultBiddingTemplate();
            return template.map(item => ({
                name: item.name || '',
                time915: '',
                time920: '',
                time930: '',
                change: '',
                close: ''
            }));
        }

        // 封单家数行名已统一为 '封单家数'，旧数据中的 '9点25分封单家数' 需要迁移。
        // 返回是否发生过迁移。

        // 封单家数行名已统一为 '封单家数'，旧数据中的 '9点25分封单家数' 需要迁移。
        // 返回是否发生过迁移。
        export function migrateSealRowName(rows) {
            if (!Array.isArray(rows)) return false;
            const OLD_NAME = '9点25分封单家数';
            const NEW_NAME = '封单家数';
            const oldIdx = rows.findIndex(function(r) { return ((r && r.name) || '').trim() === OLD_NAME; });
            if (oldIdx < 0) return false;
            const newIdx = rows.findIndex(function(r) { return ((r && r.name) || '').trim() === NEW_NAME; });
            const oldRow = rows[oldIdx];
            if (newIdx >= 0) {
                // 新旧名同时存在：把旧行的非空字段合并到新行
                const newRow = rows[newIdx];
                ['time915', 'time920', 'time930', 'change', 'close'].forEach(function(field) {
                    if ((oldRow[field] || '').toString().trim() !== '' && (newRow[field] || '').toString().trim() === '') {
                        newRow[field] = oldRow[field];
                    }
                });
                rows.splice(oldIdx, 1);
                // 迁移后清理：封单家数的收盘列不应有值
                window.sanitizeBiddingRow(newRow);
            } else {
                // 只有旧名：直接改名
                oldRow.name = NEW_NAME;
                // 改名后清理：封单家数的收盘列不应有值
                window.sanitizeBiddingRow(oldRow);
            }
            return true;
        }

        // 确保某日期包含所有默认模板行（如 账号溢价），避免手动/抓取后特殊行丢失

        // 确保某日期包含所有默认模板行（如 账号溢价），避免手动/抓取后特殊行丢失
        export function ensureBiddingTemplateRows(date) {
            if (!date) return;
            const bidding = window.getBiddingData() || {};
            const existing = bidding[date];
            const originalHadData = existing && Array.isArray(existing) && existing.length > 0;
            if (!existing || !Array.isArray(existing)) {
                bidding[date] = window.getDefaultBiddingData();
                window._dbgLog('[BIDDING-TEMPLATE] ' + date + ' 无数据，已初始化默认模板行');
                return;
            }

            // 迁移旧行名：'9点25分封单家数' -> '封单家数'
            const migrated = window.migrateSealRowName(existing);
            if (migrated) {
                window._dbgLog('[BIDDING-TEMPLATE] ' + date + ' 已迁移旧行名 9点25分封单家数 -> 封单家数');
            }

            // 安全网：清理现有行中可能残留的 封单家数 close 列脏数据
            existing.forEach(function(r) { window.sanitizeBiddingRow(r); });

            // 同步修正 localStorage 中的默认模板（防止下次打开编辑表单时旧名又冒出来）
            const template = window.getDefaultBiddingTemplate();
            const tplDirty = window.migrateSealRowName(template);
            if (tplDirty) {
                window.saveDefaultBiddingTemplate(template);
                window._dbgLog('[BIDDING-TEMPLATE] 默认模板已迁移旧行名 9点25分封单家数 -> 封单家数');
            }

            const existingNames = new Set(existing.map(r => ((r && r.name) || '').trim()));
            let added = 0;
            template.forEach(function(t) {
                const name = ((t && t.name) || '').trim();
                if (name && !existingNames.has(name)) {
                    existing.push({
                        name: name,
                        time915: '',
                        time920: '',
                        time930: '',
                        change: '',
                        close: ''
                    });
                    added++;
                }
            });
            if (added > 0 || migrated || tplDirty) {
                window._dbgLog('[BIDDING-TEMPLATE] ' + date + ' 补回 ' + added + ' 个缺失模板行');
                // 该日期已有云端数据但缺失模板行时，把补回的行同步到云端，
                // 防止下次云端拉取又把它们“覆盖掉”。
                if (originalHadData) {
                    window.pushBiddingToCloud(date).catch(function(e) {
                        window._dbgLog('[BIDDING-TEMPLATE] 推送补回模板行失败: ' + (e && e.message || e));
                    });
                }
            }
        }

        // 获取统计数据
        // 注意：这里不再无条件 markJiwangDirty(window.currentDate)！
        // 原因（真实事故复盘）：renderMarketStage()/renderCircleStats() 等纯展示函数
        // 也会调用 getStats() 来读取数据渲染界面，之前每次调用都会把 window.currentDate 标脏。
        // 刷新页面时，_appInit() 里的 renderMarketStage() 会在 pullFromCloud() 从云端
        // 拉回真实数据之前就先执行一次（此时 _jiwangMemCache 是刚重置的空对象），
        // getStats() 因此会为 window.currentDate 创建一个空占位对象并标脏；紧接着
        // autoCalculateConsecutiveDays()/autoTagShunshiNishi() 等初始化函数调用的
        // saveData() 看到这个"脏"标记，会用这个空占位对象去 scheduleJiwangPush()。
        // 如果这个 2 秒防抖推送恰好在 pullFromCloud() 拉回真实数据之前触发，
        // 就会把云端的真实数据覆盖成空白——表现为"保存后一刷新，数据就没了"。
        // 现在改为只在真正修改 stats 字段的地方显式调用 markJiwangDirty()
        // （见 updateMarketStage/updatePosition/toggleCheckbox/saveCircleStats 等），
        // 单纯读取渲染不再有副作用。

        // 获取统计数据
        // 注意：这里不再无条件 markJiwangDirty(window.currentDate)！
        // 原因（真实事故复盘）：renderMarketStage()/renderCircleStats() 等纯展示函数
        // 也会调用 getStats() 来读取数据渲染界面，之前每次调用都会把 window.currentDate 标脏。
        // 刷新页面时，_appInit() 里的 renderMarketStage() 会在 pullFromCloud() 从云端
        // 拉回真实数据之前就先执行一次（此时 _jiwangMemCache 是刚重置的空对象），
        // getStats() 因此会为 window.currentDate 创建一个空占位对象并标脏；紧接着
        // autoCalculateConsecutiveDays()/autoTagShunshiNishi() 等初始化函数调用的
        // saveData() 看到这个"脏"标记，会用这个空占位对象去 scheduleJiwangPush()。
        // 如果这个 2 秒防抖推送恰好在 pullFromCloud() 拉回真实数据之前触发，
        // 就会把云端的真实数据覆盖成空白——表现为"保存后一刷新，数据就没了"。
        // 现在改为只在真正修改 stats 字段的地方显式调用 markJiwangDirty()
        // （见 updateMarketStage/updatePosition/toggleCheckbox/saveCircleStats 等），
        // 单纯读取渲染不再有副作用。
        export function getStats() {
            const jiwangData = window.getJiwangData();
            if (!jiwangData[window.currentDate]) {
                jiwangData[window.currentDate] = {};
            }
            if (!jiwangData[window.currentDate].stats) {
                jiwangData[window.currentDate].stats = {};
            }
            return jiwangData[window.currentDate].stats;
        }

        // 更新行情阶段

        // 更新行情阶段
        export function updateMarketStage(value) {
            const stats = window.getStats();
            stats.marketStage = value;
            window.markJiwangDirty(window.currentDate);
            window.saveData();
            window.pushJiwangNow(window.currentDate);
            
            // 更新选择框样式：空仓行情和主跌行情时变绿色
            const selectElement = document.getElementById('marketStageSelect');
            if (selectElement) {
                if (value === '' || value === '主跌行情') {
                    // 空仓行情（空值）或主跌行情时变绿色
                    selectElement.style.color = '#059669';
                    selectElement.style.borderColor = '#059669';
                    selectElement.style.background = 'rgba(16, 185, 129, 0.05)';
                } else {
                    // 其他行情恢复默认
                    selectElement.style.color = '';
                    selectElement.style.borderColor = '';
                    selectElement.style.background = '';
                }
            }
        }

        // 更新仓位选择

        // 更新仓位选择
        export function updatePosition(value) {
            const stats = window.getStats();
            stats.position = value;
            window.markJiwangDirty(window.currentDate);
            window.saveData();
            window.pushJiwangNow(window.currentDate);
            
            // 更新选择框样式
            const selectElement = document.getElementById('positionSelect');
            if (selectElement) {
                if (!value || value === '') {
                    // 请选择时变灰色
                    selectElement.style.color = '#9ca3af';
                    selectElement.style.borderColor = '#9ca3af';
                    selectElement.style.background = 'rgba(156, 163, 175, 0.1)';
                } else if (value === '空仓') {
                    // 空仓时变绿色
                    selectElement.style.color = '#059669';
                    selectElement.style.borderColor = '#059669';
                    selectElement.style.background = 'rgba(16, 185, 129, 0.05)';
                } else {
                    // 其他仓位恢复默认红色
                    selectElement.style.color = '';
                    selectElement.style.borderColor = '';
                    selectElement.style.background = '';
                }
            }
        }

        // 切换复选框状态

        // 切换复选框状态
        export function toggleCheckbox(type, event) {
            if (event) {
                event.stopPropagation();
            }
            
            const stats = window.getStats();
            
            if (type === 'recentMulti') {
                stats.recentMulti = !stats.recentMulti;
                const element = document.getElementById('recentMultiCheck');
                const label = document.getElementById('recentMultiLabel');
                element.textContent = stats.recentMulti ? '✓' : '×';
                element.className = `checkbox-option ${stats.recentMulti ? 'checked' : 'unchecked'}`;
                if (label) {
                    label.className = `checkbox-label ${stats.recentMulti ? 'checked' : 'unchecked'}`;
                }
            } else if (type === 'topicDirection') {
                stats.topicDirection = !stats.topicDirection;
                const element = document.getElementById('topicDirectionCheck');
                const label = document.getElementById('topicDirectionLabel');
                element.textContent = stats.topicDirection ? '✓' : '×';
                element.className = `checkbox-option ${stats.topicDirection ? 'checked' : 'unchecked'}`;
                if (label) {
                    label.className = `checkbox-label ${stats.topicDirection ? 'checked' : 'unchecked'}`;
                }
            } else if (type === 'sectorEtf') {
                stats.sectorEtf = !stats.sectorEtf;
                const element = document.getElementById('sectorEtfCheck');
                const label = document.getElementById('sectorEtfLabel');
                element.textContent = stats.sectorEtf ? '✓' : '×';
                element.className = `checkbox-option ${stats.sectorEtf ? 'checked' : 'unchecked'}`;
                if (label) {
                    label.className = `checkbox-label ${stats.sectorEtf ? 'checked' : 'unchecked'}`;
                }
            }
            
            window.markJiwangDirty(window.currentDate);
            window.saveData();
            window.pushJiwangNow(window.currentDate);
        }

        // 在编辑模态框中切换复选框

        // 在编辑模态框中切换复选框
        export function toggleEditCheckbox(type, event) {
            if (event) {
                event.stopPropagation();
            }
            
            const stats = window.getStats();
            
            // 使用更宽松的比较方式
            if (type.trim() === 'recentMulti') {
                stats.recentMulti = !stats.recentMulti;
                const element = document.getElementById('editRecentMultiCheck');
                element.textContent = stats.recentMulti ? '✓' : '×';
                element.className = `checkbox-option ${stats.recentMulti ? 'checked' : 'unchecked'}`;
            } else if (type.trim().toLowerCase() === 'topicdirection') {
                stats.topicDirection = !stats.topicDirection;
                const element = document.getElementById('editTopicDirectionCheck');
                if (element) {
                    element.textContent = stats.topicDirection ? '✓' : '×';
                    element.className = `checkbox-option ${stats.topicDirection ? 'checked' : 'unchecked'}`;
                }
            } else if (type.trim().toLowerCase() === 'sectoretf') {
                stats.sectorEtf = !stats.sectorEtf;
                const element = document.getElementById('editSectorEtfCheck');
                if (element) {
                    element.textContent = stats.sectorEtf ? '✓' : '×';
                    element.className = `checkbox-option ${stats.sectorEtf ? 'checked' : 'unchecked'}`;
                }
            }
            
            window.markJiwangDirty(window.currentDate);
            window.saveData();
            window.renderMarketStage();
        }

        // 渲染行情阶段区域

        // 渲染行情阶段区域
        export function renderMarketStage() {
            const stats = window.getStats();
            
            // 确保新字段存在
            if (stats.marketStage === undefined) stats.marketStage = '';
            if (stats.recentMulti === undefined) stats.recentMulti = false;
            if (stats.topicDirection === undefined) stats.topicDirection = false;
            if (stats.sectorEtf === undefined) stats.sectorEtf = false;
            if (stats.balance === undefined) stats.balance = '';
            if (stats.position === undefined) stats.position = '';
            
            // 行情阶段选择框
            const marketStageSelect = document.getElementById('marketStageSelect');
            if (marketStageSelect) {
                marketStageSelect.value = stats.marketStage || '';
                
                // 空仓行情或主跌行情时变绿色
                if (stats.marketStage === '' || stats.marketStage === '主跌行情') {
                    marketStageSelect.style.color = '#059669';
                    marketStageSelect.style.borderColor = '#059669';
                    marketStageSelect.style.background = 'rgba(16, 185, 129, 0.05)';
                } else {
                    marketStageSelect.style.color = '';
                    marketStageSelect.style.borderColor = '';
                    marketStageSelect.style.background = '';
                }
            }
            
            // 仓位选择框
            const positionSelect = document.getElementById('positionSelect');
            if (positionSelect) {
                const positionValue = stats.position || '';
                positionSelect.value = positionValue;
                
                // 根据仓位设置颜色
                if (!stats.position || stats.position === '') {
                    // 请选择时变灰色
                    positionSelect.style.color = '#9ca3af';
                    positionSelect.style.borderColor = '#9ca3af';
                    positionSelect.style.background = 'rgba(156, 163, 175, 0.1)';
                } else if (stats.position === '空仓') {
                    // 空仓时变绿色
                    positionSelect.style.color = '#059669';
                    positionSelect.style.borderColor = '#059669';
                    positionSelect.style.background = 'rgba(16, 185, 129, 0.05)';
                } else {
                    // 其他仓位恢复默认红色
                    positionSelect.style.color = '';
                    positionSelect.style.borderColor = '';
                    positionSelect.style.background = '';
                }
            }
            
            // 最近多板复选框
            const recentMultiCheck = document.getElementById('recentMultiCheck');
            const recentMultiLabel = document.getElementById('recentMultiLabel');
            if (recentMultiCheck) {
                recentMultiCheck.textContent = stats.recentMulti ? '✓' : '×';
                recentMultiCheck.className = `checkbox-option ${stats.recentMulti ? 'checked' : 'unchecked'}`;
            }
            if (recentMultiLabel) {
                recentMultiLabel.className = `checkbox-label ${stats.recentMulti ? 'checked' : 'unchecked'}`;
            }
            
            // 题材方向复选框
            const topicDirectionCheck = document.getElementById('topicDirectionCheck');
            const topicDirectionLabel = document.getElementById('topicDirectionLabel');
            if (topicDirectionCheck) {
                topicDirectionCheck.textContent = stats.topicDirection ? '✓' : '×';
                topicDirectionCheck.className = `checkbox-option ${stats.topicDirection ? 'checked' : 'unchecked'}`;
            }
            if (topicDirectionLabel) {
                topicDirectionLabel.className = `checkbox-label ${stats.topicDirection ? 'checked' : 'unchecked'}`;
            }
            
            // 板块ETF复选框
            const sectorEtfCheck = document.getElementById('sectorEtfCheck');
            const sectorEtfLabel = document.getElementById('sectorEtfLabel');
            if (sectorEtfCheck) {
                sectorEtfCheck.textContent = stats.sectorEtf ? '✓' : '×';
                sectorEtfCheck.className = `checkbox-option ${stats.sectorEtf ? 'checked' : 'unchecked'}`;
            }
            if (sectorEtfLabel) {
                sectorEtfLabel.className = `checkbox-label ${stats.sectorEtf ? 'checked' : 'unchecked'}`;
            }
            
            // 账户余额
            const balanceCard = document.getElementById('balanceCard');
            const balanceValue = document.getElementById('balanceValue');
            
            if (balanceCard && balanceValue) {
                if (stats.balance !== undefined && stats.balance !== '' && !isNaN(parseFloat(stats.balance))) {
                    // 使用金额简写函数
                    balanceValue.textContent = window.formatAmount(stats.balance);
                    
                    // 根据账户涨幅的颜色设置账户余额的颜色
                    const gainCard = document.getElementById('gainCard');
                    if (gainCard) {
                        if (gainCard.classList.contains('positive')) {
                            balanceCard.className = 'circle-card positive';
                        } else if (gainCard.classList.contains('negative')) {
                            balanceCard.className = 'circle-card negative';
                        } else {
                            balanceCard.className = 'circle-card';
                        }
                    } else {
                        balanceCard.className = 'circle-card';
                    }
                } else {
                    balanceValue.textContent = '-';
                    balanceCard.className = 'circle-card';
                }
            }
        }

        // 金额简写函数（超过100万显示为w形式）

        // 切换模式看板展开/收起
        export function togglePatternExpand(event) {
            event.stopPropagation(); // 阻止冒泡，避免触发编辑
            const boardEl = document.getElementById('patternBoard');
            const toggleBtn = document.getElementById('patternToggleBtn');
            
            if (boardEl.classList.contains('minimized')) {
                // 从完全折叠状态展开
                boardEl.classList.remove('minimized');
                toggleBtn.textContent = '▲';
            } else {
                // 从完全展开状态折叠成标题栏
                boardEl.classList.add('minimized');
                toggleBtn.textContent = '▼';
            }
        }

        // 渲染竞价变化看板

        // 渲染竞价变化看板
        export function renderBidding() {
            // 先补全模板行，再渲染，确保 账号溢价 等特殊行不会因历史数据缺失而消失
            window.ensureBiddingTemplateRows(window.currentDate);

            let biddingData = window.getTodayBidding();
            const contentEl = document.getElementById('biddingContent');
            const placeholderEl = document.getElementById('biddingPlaceholder');
            const toggleBtn = document.getElementById('biddingToggleBtn');

            // [NULL-GUARD] 容器不存在（被 Vue 组件接管或 DOM 结构异常）时绝不写 innerHTML，
            // 否则会抛 "Cannot set properties of null"，并连带让调用方（renderList / 初始链路）
            // 误以为整条渲染失败了。容器缺失时记录日志直接返回，交由对应的 Vue 刷新路径处理。
            if (!contentEl) {
                if (window._dbgLog) window._dbgLog('[BIDDING-RENDER] #biddingContent 不存在，跳过原生渲染（可能已交给 Vue 路径）');
                return;
            }

            if (!biddingData || biddingData.length === 0) {
                window._dbgLog('[BIDDING-RENDER] ' + window.currentDate + ' 无有效数据，回退到默认模板');
                biddingData = window.getDefaultBiddingData();
            }

            // 按默认模板顺序重排：云端行按写入/更新时间返回，顺序不稳定（Worker 写的行
            // updated_at 最新会沉底）。模板里的行按模板索引排，不在模板里的额外行排最后，
            // 保证前台永远是固定顺序，与"设置默认模板"里的顺序一致。
            const _tpl = window.getDefaultBiddingTemplate();
            const _tplOrder = {};
            _tpl.forEach(function(t, i) { _tplOrder[((t && t.name) || '').trim()] = i; });
            biddingData = biddingData.slice().sort(function(a, b) {
                const ai = _tplOrder[((a && a.name) || '').trim()];
                const bi = _tplOrder[((b && b.name) || '').trim()];
                return (ai === undefined ? 999 : ai) - (bi === undefined ? 999 : bi);
            });

            if (placeholderEl) placeholderEl.style.display = 'none';
            
            let html = '<table class="bidding-table">';
            
            html += '<thead><tr>';
            html += '<th>要盯项目</th>';
            html += '<th>9:15</th>';
            html += '<th>9:20</th>';
            html += '<th>9:25</th>'; // 注意：字段名 time930 对应的是9:25竞价数据，字段名保持不变只改显示
            html += '<th>增减</th>';
            html += '<th>收盘</th>';
            html += '</tr></thead>';
            
            html += '<tbody>';
            biddingData.forEach((row, index) => {
                const isAccountPremium = (row.name || '') === '账号溢价';
                const isDuibanRow = (row.name || '').trim() === '最近多板%';

                // "最近多板%"行：是否存在可展示的修改历史
                // 条件：modifiedAt存在（即保存过两次及以上），且初始值和当前值均非空
                const duibanHasHistory = isDuibanRow &&
                    row.time930_initial !== undefined &&
                    row.time930_initial !== '' &&
                    row.time930 !== '' && row.time930 !== undefined && row.time930 !== null &&
                    row.time930_modifiedAt !== undefined && row.time930_modifiedAt !== null;

                let rowClass = isAccountPremium ? 'account-premium-row' : '';
                let rowExtraAttr = '';
                // 有修改历史才绑定点击弹窗
                if (isDuibanRow && duibanHasHistory) {
                    rowClass += ' duiban-row-clickable';
                    rowExtraAttr = ` data-duiban-initial="${row.time930_initial}" data-duiban-final="${row.time930}" data-duiban-initial-modified="${row.time930_initial_modifiedAt || ''}" data-duiban-modified="${row.time930_modifiedAt || ''}" onclick="window.onDuibanRowClick(this, event)"`;
                }

                html += `<tr class="${rowClass.trim()}"${rowExtraAttr}>`;
                
                let nameDisplay = row.name || '';
                html += `<td>${nameDisplay}</td>`;
                
                // 根据项目名决定格式
                let rowFormat = 'red'; // 默认格式：数字加"红"（上涨家数类行：板块ETF(48)、昨日资金前十）
                if (nameDisplay.includes('%')) {
                    rowFormat = 'percent'; // 带%的项目：数字加%
                } else if (nameDisplay === '账号溢价') {
                    rowFormat = 'yuan'; // 账号溢价：数字加"元"
                } else if (nameDisplay === '封单家数' || nameDisplay === '9点25分封单家数') {
                    rowFormat = 'jia'; // 封单家数：数字加"家"
                } else if (nameDisplay === '大盘ETF') {
                    rowFormat = 'percent'; // 大盘ETF是4只宽基的平均涨幅，带%显示（2026-07 修复：原先etf格式不带%）
                }
                // 板块ETF(48) 走默认 red 格式：存的是上涨家数，显示"38红"（2026-07 修复：原先etf格式只显示"38"）
                
                // 格式化函数
                const formatValue = (val) => {
                    if (!val) return '';
                    const isNumber = /^-?\d+(\.\d+)?$/.test(val.trim());
                    if (!isNumber) return val;
                    
                    if (rowFormat === 'percent') {
                        return val + '%';
                    } else if (rowFormat === 'yuan') {
                        return val + '元';
                    } else if (rowFormat === 'jia') {
                        return val + '家';
                    } else if (rowFormat === 'etf') {
                        return val; // Fix Bug3: ETF类直接显示数值，不加任何后缀
                    } else {
                        return val + '红';
                    }
                };
                
                html += `<td>${formatValue(row.time915)}</td>`;
                html += `<td>${formatValue(row.time920)}</td>`;

                // "最近多板%"这一行的9:25格子：满足条件时变色提示（红=变强，绿=变弱）
                if (isDuibanRow) {
                    const time920Num = parseFloat(row.time920);
                    const time930Num = parseFloat(row.time930);
                    const baseValid = row.time920 && !isNaN(time920Num);
                    let duibanCellStyle = '';
                    // 有修改历史才变色（第一次保存不变色）
                    if (duibanHasHistory && baseValid && !isNaN(time930Num) && time930Num !== time920Num) {
                        if (time930Num > time920Num) {
                            duibanCellStyle = 'background:rgba(239,68,68,0.15);color:#dc2626;border-radius:4px;';
                        } else if (time930Num < time920Num) {
                            duibanCellStyle = 'background:rgba(16,185,129,0.15);color:#059669;border-radius:4px;';
                        }
                    }
                    html += `<td style="${duibanCellStyle}">${formatValue(row.time930)}</td>`;
                } else {
                    html += `<td>${formatValue(row.time930)}</td>`;
                }
                
                // 增减列：根据值应用样式
                let changeDisplay = row.change || '';
                let changeStyle = '';
                if (changeDisplay === '增') {
                    changeStyle = 'color:#ef4444;font-weight:bold;font-size:11px';
                } else if (changeDisplay === '减') {
                    changeStyle = 'color:#059669;font-size:12px';
                } else if (changeDisplay === '平') {
                    changeStyle = 'color:#1f2937;font-weight:600';
                }
                html += `<td style="${changeStyle}">${changeDisplay}</td>`;
                
                html += `<td>${formatValue(row.close)}</td>`;
                html += '</tr>';
            });
            html += '</tbody>';
            html += '</table>';
            
            contentEl.innerHTML = html;
            
            // 显示展开/收起按钮，保持当前状态
            toggleBtn.style.display = 'flex';
            const boardEl = document.getElementById('biddingBoard');
            if (boardEl && !boardEl.classList.contains('minimized')) {
                toggleBtn.textContent = '▲';
            } else if (boardEl) {
                toggleBtn.textContent = '▼';
            }

            // 每次重新渲染（包括切换日期）时，关闭可能残留的历史提示框
            window.closeDuibanHistoryPopup();
        }

        // ═══════════════════════════════════════════════════════════
        // 情绪看板（emotion_data 表）
        // ═══════════════════════════════════════════════════════════

        window._emotionDataCache = null; // { date: { metrics, five_days, updated_at } }
        window._emotionRealtimeChannel = null;
        window._emotionTableAvailable = false;
        window._emotionExpandedRows = new Set(); // 已展开趋势图的行 key

        // 情绪看板预测量能刷新：指向 Cloudflare Worker 域名
        window.EMOTION_WORKER_BASE = 'https://bidding-board-worker.834696737hgl.workers.dev';

        window.EMOTION_ROW_CONFIG = [
            { key: 'amountDiff', title: '昨日成交额环比差值', unit: '亿', hasTrend: true, field: 'amountDiff' },
            { key: 'onceLimit', title: '昨日一字板家数', unit: '家', hasTrend: true, field: 'onceLimit' },
            { key: 'highestLb', title: '昨日最高连板天数', unit: '天', hasTrend: true, field: 'highestLb' },
            { key: 'limitUp', title: '昨日涨停家数', unit: '家', hasTrend: true, field: 'limitUp' },
            { key: 'limitDown', title: '昨日跌停家数', unit: '家', hasTrend: true, field: 'limitDown' },
            { key: 'zhaban', title: '昨日炸板家数', unit: '家', hasTrend: true, field: 'zhaban', extraKey: 'zhabanRate', extraUnit: '%' }
        ];


        // 竞价变化看板诊断：可在控制台执行 runBiddingDiagnostics() 查看当前状态
        export async function runBiddingDiagnostics() {
            const lines = [];
            const push = function(s) { lines.push(s); console.log(s); };
            push('===== 竞价变化看板诊断 =====');
            push('当前日期: ' + window.currentDate);
            const localRows = (window.getBiddingData()[window.currentDate] || []);
            push('本地内存行数: ' + localRows.length);
            localRows.forEach(function(r) {
                push('  ' + (r.name || '(无名)') + ' | 915=' + (r.time915 || '-') +
                     ' 920=' + (r.time920 || '-') + ' 930=' + (r.time930 || '-') +
                     ' change=' + (r.change || '-') + ' close=' + (r.close || '-'));
            });
            push('默认模板: ' + window.getDefaultBiddingTemplate().map(function(t) { return t.name; }).join('、'));
            push('推送中日期: ' + (window._biddingPushInFlight ? Array.from(window._biddingPushInFlight).join(',') : '无'));
            push('脏日期（未同步）: ' + (window._biddingDirtyDates ? Array.from(window._biddingDirtyDates).join(',') : '无'));
            try {
                const sb = window.getSupabase();
                const { data, error } = await sb.from('bidding_data')
                    .select('name,time915,time920,time930,"change",close')
                    .eq('date', window.currentDate);
                if (error) throw error;
                push('云端当前日期行数: ' + ((data || []).length));
                (data || []).forEach(function(r) {
                    const hasValue = (r.time915 || r.time920 || r.time930 || r.change || r.close);
                    push('  ' + (r.name || '(无名)') + (hasValue ? ' [有值]' : ' [空]'));
                });
            } catch (e) {
                push('读取云端失败: ' + (e && e.message || e));
            }
            push('===== 诊断结束 =====');
            return lines.join('\n');
        }

        // "最近多板%"历史提示弹窗：记录当前绑定的关闭监听器引用，避免重复绑定导致无法移除（手机端堆叠bug的根因）
        let duibanPopupClickCloseHandler = null;
        let duibanPopupScrollCloseHandler = null;

        // 点击"最近多板%"这一行 → 弹出9:25修改历史（首次值+时间 / 最终值+时间，分两行显示，时间格式为 分:秒，不带文字标签）

        // 点击"最近多板%"这一行 → 弹出9:25修改历史（首次值+时间 / 最终值+时间，分两行显示，时间格式为 分:秒，不带文字标签）
        export function onDuibanRowClick(rowEl, event) {
            event.stopPropagation();

            // 再次点击同一行时，视为"再点一次=收起"，直接关闭弹窗，不重新打开
            const existingPopup = document.getElementById('duibanHistoryPopup');
            if (existingPopup) {
                window.closeDuibanHistoryPopup();
                return;
            }

            // 兜底：清掉可能残留的旧弹窗和旧监听器，防止叠加显示
            window.closeDuibanHistoryPopup();

            const initial = rowEl.getAttribute('data-duiban-initial');
            const final = rowEl.getAttribute('data-duiban-final');
            const initialModifiedAt = rowEl.getAttribute('data-duiban-initial-modified');
            const finalModifiedAt = rowEl.getAttribute('data-duiban-modified');

            // 时间格式：分:秒
            // 兼容本地旧数据（毫秒时间戳）和 Worker 写入的 ISO 字符串
            const formatMMSS = (ts) => {
                if (!ts) return '';
                let d;
                if (/^\d+$/.test(String(ts))) {
                    d = new Date(parseInt(ts));
                } else {
                    d = new Date(ts);
                }
                if (isNaN(d.getTime())) return '';
                const pad = n => String(n).padStart(2, '0');
                return `${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
            };

            const initialTimeStr = formatMMSS(initialModifiedAt);
            const finalTimeStr = formatMMSS(finalModifiedAt);

            // 两行：首次值+时间 / 最终值+时间
            const row1 = `${initialTimeStr ? initialTimeStr + '　' : ''}${initial}%`;
            const row2 = `${finalTimeStr ? finalTimeStr + '　' : ''}${final}%`;

            const popup = document.createElement('div');
            popup.className = 'duiban-history-popup';
            popup.id = 'duibanHistoryPopup';
            popup.innerHTML = `<div class="dh-row">${row1}</div><div class="dh-row">${row2}</div>`;

            document.body.appendChild(popup);

            // 定位在9:25格子（第4个td）正下方居中
            const tds = rowEl.querySelectorAll('td');
            const anchorEl = tds.length >= 4 ? tds[3] : rowEl;
            const rect = anchorEl.getBoundingClientRect();
            let top = rect.bottom + 6;
            // 先挂载到body才能量到实际宽度，用visibility:hidden避免闪烁
            popup.style.visibility = 'hidden';
            // 粗估：单行约 "28:35  -0.6%" = 约13字符 * ~8px = 104px，加padding
            // 定位后再修正，先用格子中心临时对齐
            let left = rect.left + rect.width / 2;
            popup.style.top = top + 'px';
            popup.style.left = left + 'px';
            // 等浏览器渲染出实际宽度后居中修正
            requestAnimationFrame(() => {
                const pw = popup.offsetWidth;
                let finalLeft = rect.left + rect.width / 2 - pw / 2;
                if (finalLeft + pw > window.innerWidth - 10) finalLeft = window.innerWidth - pw - 10;
                if (finalLeft < 10) finalLeft = 10;
                popup.style.left = finalLeft + 'px';
                popup.style.visibility = '';
            });

            // 延迟绑定，避免本次点击事件冒泡立刻触发关闭
            setTimeout(() => {
                duibanPopupClickCloseHandler = function() { window.closeDuibanHistoryPopup(); };
                document.addEventListener('click', duibanPopupClickCloseHandler, { once: true });

                // 下拉/滚动时也自动关闭；capture:true 保证内部滚动容器的滚动也能被捕获到
                duibanPopupScrollCloseHandler = function() { window.closeDuibanHistoryPopup(); };
                document.addEventListener('scroll', duibanPopupScrollCloseHandler, { once: true, capture: true });
            }, 0);
        }

        // 关闭"最近多板%"9:25修改历史提示框（点击其它地方/滚动/双击进入编辑/切换日期时调用）

        // 关闭"最近多板%"9:25修改历史提示框（点击其它地方/滚动/双击进入编辑/切换日期时调用）
        export function closeDuibanHistoryPopup() {
            // 用class统一清理所有同类弹窗，防止历史遗留的重复弹窗删不干净
            document.querySelectorAll('.duiban-history-popup').forEach(p => p.remove());

            if (duibanPopupClickCloseHandler) {
                document.removeEventListener('click', duibanPopupClickCloseHandler);
                duibanPopupClickCloseHandler = null;
            }
            if (duibanPopupScrollCloseHandler) {
                document.removeEventListener('scroll', duibanPopupScrollCloseHandler, true);
                duibanPopupScrollCloseHandler = null;
            }
        }

        // 切换竞价变化看板展开/收起

        // 切换竞价变化看板展开/收起
        export function toggleBiddingExpand(event) {
            event.stopPropagation();
            const boardEl = document.getElementById('biddingBoard');
            const toggleBtn = document.getElementById('biddingToggleBtn');
            
            if (boardEl.classList.contains('minimized')) {
                boardEl.classList.remove('minimized');
                toggleBtn.textContent = '▲';
            } else {
                boardEl.classList.add('minimized');
                toggleBtn.textContent = '▼';
            }
        }

        // 打开竞价变化编辑
        // ══════════════════════════════════════════════════════════════
        // 竞价变化看板 · 同花顺抓取填入表单（手动补录的自动化）
        // 与 Cloudflare Worker 自动抓取互为备份：Worker 到点自动写库；
        // 这个按钮在编辑模态框里，抓当前时段的快照【填入表单输入框】，
        // 用户检查无误后自己点"保存竞价变化"——保存链路完全复用现有逻辑。
        // ══════════════════════════════════════════════════════════════
        // 板块ETF 48 只清单（与 Worker 里 CONFIG.SECTOR_ETFS 保持一致，改清单两边都要改）
        const BIDDING_SECTOR_ETFS = [
            { code: '560780', name: '半导体设备ETF' }, { code: '159995', name: '芯片ETF华夏' },
            { code: '512480', name: '半导体ETF国' }, { code: '159732', name: '消费电子ETF' },
            { code: '515880', name: '通信ETF国泰' }, { code: '560800', name: '数字经济ETF' },
            { code: '159819', name: '人工智能ETF' }, { code: '159206', name: '卫星ETF永赢' },
            { code: '515750', name: '科技50ETF' }, { code: '159608', name: '稀有金属ETF' },
            { code: '159998', name: '计算机ETF天弘' }, { code: '561160', name: '电池ETF富国' },
            { code: '159857', name: '光伏ETF天弘' }, { code: '516780', name: '稀土ETF华泰' },
            { code: '562500', name: '机器人ETF华夏' }, { code: '515400', name: '大数据ETF富国' },
            { code: '560860', name: '工业有色ETF' }, { code: '516510', name: '云计算ETF易' },
            { code: '516390', name: '新能源车ETF' }, { code: '563010', name: '电信ETF易方达' },
            { code: '159875', name: '新能源ETF嘉实' }, { code: '516100', name: '金融科技ETF' },
            { code: '886078', name: '商业航天' }, { code: '512660', name: '军工ETF国泰' },
            { code: '560280', name: '工程机械ETF' }, { code: '515230', name: '软件ETF国泰' },
            { code: '159996', name: '家电ETF国泰' }, { code: '885939', name: '海峡两岸' },
            { code: '159227', name: '航空航天ETF' }, { code: '518880', name: '黄金ETF华安' },
            { code: '1A0001', name: '上证指数' }, { code: '159869', name: '游戏ETF华夏' },
            { code: '515150', name: '一带一路ETF' }, { code: '516620', name: '影视ETF国泰' },
            { code: '515120', name: '创新药ETF广发' }, { code: '516910', name: '物流ETF富国' },
            { code: '159842', name: '券商ETF银华' }, { code: '159666', name: '交通运输ETF' },
            { code: '512200', name: '房地产ETF南方' }, { code: '159766', name: '旅游ETF富国' },
            { code: '562600', name: '医疗器械ETF' }, { code: '159611', name: '电力ETF广发' },
            { code: '167301', name: '保险主题LOF' }, { code: '159825', name: '农业ETF富国' },
            { code: '159309', name: '油气ETF汇添富' }, { code: '512690', name: '酒ETF鹏华' },
            { code: '515220', name: '煤炭ETF国泰' }, { code: '159887', name: '银行ETF富国' }
        ];
        const BIDDING_BIG_ETFS = ['510500', '512100', '510300', '510050']; // 大盘ETF行：4只宽基
        // 48只里的非股票代码 → 指数快照接口（上证指数 1A0001 对应标准代码 000001.SH）
        const BIDDING_INDEX_CODES = { '886078': '886078.TI', '885939': '885939.TI', '1A0001': '000001.SH' };

        // ETF/特殊代码 → 快照接口代码（注意：不能复用 tickerToThscode，它会把 1 开头深市ETF误判成 .SH）

        // ETF/特殊代码 → 快照接口代码（注意：不能复用 tickerToThscode，它会把 1 开头深市ETF误判成 .SH）
        export function biddingEtfToSnapshotCode(code) {
            if (BIDDING_INDEX_CODES[code]) return { thscode: BIDDING_INDEX_CODES[code], type: 'index' };
            if (code.charAt(0) === '5') return { thscode: code + '.SH', type: 'stock' };
            return { thscode: code + '.SZ', type: 'stock' };
        }

        // 当前北京时间该填哪一列（与 Worker 的 autoPoint 同一套时段划分）

        // 当前北京时间该填哪一列（与 Worker 的 autoPoint 同一套时段划分）
        export function biddingCurrentPoint() {
            const now = new Date(Date.now() + 8 * 3600 * 1000);
            const mins = now.getUTCHours() * 60 + now.getUTCMinutes();
            if (mins >= 9 * 60 + 10 && mins < 9 * 60 + 17) return { col: 'time915', label: '9:15' };
            if (mins >= 9 * 60 + 17 && mins < 9 * 60 + 22) return { col: 'time920', label: '9:20' };
            if (mins >= 9 * 60 + 22 && mins < 9 * 60 + 40) return { col: 'time930', label: '9:25' };
            if (mins >= 15 * 60) return { col: 'close', label: '收盘' };
            return null;
        }

        // 腾讯行情快照（JSONP 方式）：fuyao A股快照不覆盖 ETF 基金代码，腾讯接口覆盖场内 ETF 且免费。
        // 浏览器直接 fetch qt.gtimg.cn 会被 CORS 拦，但它返回的是 v_xxx="..." 变量赋值，
        // 用 <script> 注入后读全局变量即可（财经网站通行的经典用法）。
        // 入参 thscodes 形如 ['510500.SH','159995.SZ']，返回 { '510500.SH': pct(number) }

        // 腾讯行情快照（JSONP 方式）：fuyao A股快照不覆盖 ETF 基金代码，腾讯接口覆盖场内 ETF 且免费。
        // 浏览器直接 fetch qt.gtimg.cn 会被 CORS 拦，但它返回的是 v_xxx="..." 变量赋值，
        // 用 <script> 注入后读全局变量即可（财经网站通行的经典用法）。
        // 入参 thscodes 形如 ['510500.SH','159995.SZ']，返回 { '510500.SH': pct(number) }
        export function biddingGetTencentPcts(thscodes) {
            return new Promise(function (resolve, reject) {
                const tqCodes = thscodes.map(function (c) {
                    const num = c.split('.')[0];
                    return (c.slice(-2) === 'SZ' ? 'sz' : 'sh') + num;
                });
                const s = document.createElement('script');
                s.src = 'https://qt.gtimg.cn/q=' + tqCodes.join(',');
                s.charset = 'gbk';
                const timer = setTimeout(function () { window.cleanup(); reject(new Error('腾讯行情请求超时')); }, 10000);

                function cleanup() { clearTimeout(timer); s.remove(); }
                window.cleanup = cleanup;
                s.onload = function () {
                    const result = {};
                    tqCodes.forEach(function (code) {
                        const raw = window['v_' + code];
                        if (!raw) return;
                        const pct = parseFloat(String(raw).split('~')[32]); // 字段32 = 涨跌幅百分比
                        if (!isNaN(pct)) {
                            result[code.slice(2) + (code.slice(0, 2) === 'sz' ? '.SZ' : '.SH')] = pct;
                        }
                    });
                    window.cleanup();
                    resolve(result);
                };
                s.onerror = function () { window.cleanup(); reject(new Error('腾讯行情加载失败')); };
                document.head.appendChild(s);
            });
        }


        export async function fetchBiddingSnapshotToForm(btn) {
            const statusEl = document.getElementById('biddingFetchStatus');
            const say = function (msg, ok) {
                if (statusEl) { statusEl.textContent = msg; statusEl.style.color = ok === false ? '#dc2626' : (ok === true ? '#059669' : '#6b7280'); }
            };
            const point = window.biddingCurrentPoint();
            if (!point) {
                say('当前不在抓取时段（09:10-09:40 或 15:00 后），请直接手动填写', false);
                return;
            }
            window.setBtnLoading(btn, true);
            try {
                say('正在拉取快照（股票走同花顺 / ETF走腾讯行情）...');
                // ── 1. 最近多板%：883410 成分股涨幅算术平均（fuyao）──
                const ladderData = await window.fuyaoApiGet('/api/a-share-index/constituents/ths-stock-list', { thscode: '883410.TI' });
                const ladderCodes = ((ladderData && ladderData.item) || []).map(function (it) { return it.thscode; }).filter(Boolean);
                // ── 2. 板块ETF 48只：45只ETF走腾讯行情 + 3只指数走fuyao ──
                const etfCodes = [], indexCodes = [];
                BIDDING_SECTOR_ETFS.forEach(function (e) {
                    const c = window.biddingEtfToSnapshotCode(e.code);
                    if (c.type === 'index') indexCodes.push(c.thscode); else etfCodes.push(c.thscode);
                });
                // ── 3. 昨日资金前十：883901 成分股（fuyao）──
                const top10Data = await window.fuyaoApiGet('/api/a-share-index/constituents/ths-stock-list', { thscode: '883901.TI' });
                const top10Codes = ((top10Data && top10Data.item) || []).map(function (it) { return it.thscode; }).filter(Boolean);
                // ── 4. 大盘ETF 4只（腾讯行情）+ 大盘% 上证指数（fuyao指数快照）──
                const bigEtfCodes = BIDDING_BIG_ETFS.map(function (c) { return c + '.SH'; });

                // fuyao A股快照：只拉 883410 + 883901 成分股（ETF代码 fuyao 不覆盖，走腾讯）
                const allStockCodes = Array.from(new Set([].concat(ladderCodes, top10Codes)));
                const stockPcts = {};
                for (let i = 0; i < allStockCodes.length; i += 40) {
                    const chunk = allStockCodes.slice(i, i + 40);
                    const snap = await window.fuyaoApiGet('/api/a-share/prices/snapshot', { thscodes: chunk.join(',') });
                    ((snap && snap.item) || []).forEach(function (it) {
                        if (it && it.thscode && it.price_change_ratio_pct !== null && it.price_change_ratio_pct !== undefined) {
                            let ratio = Number(it.price_change_ratio_pct);
                            // [BUG-FIX 2026-07-26] 同花顺 snapshot 的 price_change_ratio_pct 在某些场景下只返回绝对值（如 2.62），
                            // 需要结合 price_change/current_price/prev_close 判断真实方向，避免负涨幅被显示为正数。
                            const priceChange = it.price_change !== undefined && it.price_change !== null ? Number(it.price_change) : null;
                            const curr = it.current_price !== undefined && it.current_price !== null ? Number(it.current_price) : null;
                            const prev = it.prev_close !== undefined && it.prev_close !== null ? Number(it.prev_close) : null;
                            const isActuallyDown = (priceChange !== null && priceChange < 0) || (curr !== null && prev !== null && curr < prev);
                            if (isActuallyDown && ratio > 0) {
                                ratio = -ratio;
                                window._dbgLog('[BIDDING-SNAP-SIGN] ' + it.thscode + ' 接口返回涨幅=' + it.price_change_ratio_pct + ' 但 price_change=' + priceChange + ' current=' + curr + ' prev=' + prev + '，已修正为负值');
                            }
                            stockPcts[it.thscode] = ratio;
                            // 调试：最近多板成分股打印完整字段，便于核对符号问题
                            if (_DBG_VERBOSE && ladderCodes.indexOf(it.thscode) >= 0) {
                                window._dbgLog('[BIDDING-SNAP-RAW] ' + it.thscode + ' price_change_ratio_pct=' + it.price_change_ratio_pct +
                                    ' price_change=' + it.price_change + ' current_price=' + it.current_price + ' prev_close=' + it.prev_close +
                                    ' finalRatio=' + ratio);
                            }
                        }
                    });
                }

                // 腾讯行情：45只板块ETF + 4只大盘ETF（一次批量，JSONP 无跨域问题）
                const etfPcts = await window.biddingGetTencentPcts(Array.from(new Set([].concat(etfCodes, bigEtfCodes))));
                // fuyao 指数快照（3只板块指数 + 上证指数）
                const indexPcts = {};
                const allIndexCodes = Array.from(new Set(indexCodes.concat(['000001.SH'])));
                if (allIndexCodes.length > 0) {
                    const idxSnap = await window.fuyaoApiGet('/api/a-share-index/prices/snapshot', { thscodes: allIndexCodes.join(',') });
                    ((idxSnap && idxSnap.item) || []).forEach(function (it) {
                        if (it && it.thscode && it.price_change_ratio_pct !== null && it.price_change_ratio_pct !== undefined) {
                            let ratio = Number(it.price_change_ratio_pct);
                            // [BUG-FIX 2026-07-26] 指数快照同样做符号修正
                            const priceChange = it.price_change !== undefined && it.price_change !== null ? Number(it.price_change) : null;
                            const curr = it.current_price !== undefined && it.current_price !== null ? Number(it.current_price) : null;
                            const prev = it.prev_close !== undefined && it.prev_close !== null ? Number(it.prev_close) : null;
                            const isActuallyDown = (priceChange !== null && priceChange < 0) || (curr !== null && prev !== null && curr < prev);
                            if (isActuallyDown && ratio > 0) {
                                ratio = -ratio;
                                window._dbgLog('[BIDDING-IDX-SIGN] ' + it.thscode + ' 接口返回涨幅=' + it.price_change_ratio_pct + ' 已修正为负值');
                            }
                            indexPcts[it.thscode] = ratio;
                        }
                    });
                }

                // ── 计算5行的值（纯数字字符串，不带%/红，与 Worker 写入格式一致）──
                const values = {}; // 行名匹配key → value
                const ladderVals = ladderCodes.map(function (c) { return stockPcts[c]; }).filter(function (v) { return typeof v === 'number' && !isNaN(v); });
                if (ladderVals.length > 0) {
                    values['最近多板%'] = (ladderVals.reduce(function (a, b) { return a + b; }, 0) / ladderVals.length).toFixed(2);
                }
                let sectorRed = 0;
                BIDDING_SECTOR_ETFS.forEach(function (e) {
                    const c = window.biddingEtfToSnapshotCode(e.code);
                    const v = c.type === 'index' ? indexPcts[c.thscode] : etfPcts[c.thscode];
                    if (typeof v === 'number' && !isNaN(v) && v > 0) sectorRed++;
                });
                values['板块ETF'] = String(sectorRed); // 按行名前缀匹配（板块ETF(48)）
                if (top10Codes.length > 0) {
                    let top10Red = 0;
                    top10Codes.forEach(function (c) { const v = stockPcts[c]; if (typeof v === 'number' && !isNaN(v) && v > 0) top10Red++; });
                    values['昨日资金前十'] = String(top10Red);
                }
                const bigVals = bigEtfCodes.map(function (c) { return etfPcts[c]; }).filter(function (v) { return typeof v === 'number' && !isNaN(v); });
                if (bigVals.length > 0) {
                    values['大盘ETF'] = (bigVals.reduce(function (a, b) { return a + b; }, 0) / bigVals.length).toFixed(2);
                }
                if (typeof indexPcts['000001.SH'] === 'number') {
                    values['大盘（%）'] = indexPcts['000001.SH'].toFixed(2);
                }

                // ── 按行名匹配填入表单对应列（账号溢价等不在 values 里的行不动）──
                const formContainer = document.getElementById('biddingFormContainer');
                const nameInputs = formContainer.querySelectorAll('[name^="name-"]');
                let filledRows = 0;
                let sectorEtfFilledValue = null;
                nameInputs.forEach(function (nameInput) {
                    const idx = nameInput.name.split('-')[1];
                    const rowName = (nameInput.value || '').trim();
                    let value;
                    if (values[rowName] !== undefined) value = values[rowName];
                    else if (rowName.indexOf('板块ETF') === 0 && values['板块ETF'] !== undefined) value = values['板块ETF'];
                    if (value === undefined) return;
                    const target = formContainer.querySelector('[name="' + point.col + '-' + idx + '"]');
                    if (target) {
                        target.value = value;
                        filledRows++;
                        if (rowName.indexOf('板块ETF') === 0) {
                            sectorEtfFilledValue = value;
                        }
                    }
                });
                window.updateAllChangeValues(); // 9:25 填完后自动算增减列

                // 如果本次填了板块ETF(48)，立即同步到早盘板块ETF表现看板（无需等点保存）
                if (sectorEtfFilledValue !== null) {
                    window.syncSectorEtfZhangNum(sectorEtfFilledValue);
                    window._dbgLog('[BIDDING-SNAP] 抓取后即时同步板块ETF涨数: ' + sectorEtfFilledValue);
                }

                say('✅ 已填入 ' + point.label + ' 列共 ' + filledRows + ' 行，请检查后点"保存竞价变化"', true);
            } catch (err) {
                console.error('window.fetchBiddingSnapshotToForm 失败:', err);
                let msg = err && err.message ? err.message : '抓取失败';
                if (msg.indexOf('Failed to fetch') >= 0) msg = '代理请求失败，请检查网络';
                say('❌ ' + msg, false);
            } finally {
                window.setBtnLoading(btn, false);
            }
        }


        export function openBiddingEdit() {
            // 进入编辑前先关闭可能还开着的"最近多板%"历史提示弹窗
            window.closeDuibanHistoryPopup();

            const boardEl = document.getElementById('biddingBoard');
            
            if (boardEl.classList.contains('minimized')) {
                return;
            }

            // 先补全模板行，再打开编辑，确保 账号溢价 等特殊行始终可编辑
            window.ensureBiddingTemplateRows(window.currentDate);
            
            let biddingData = window.getTodayBidding();
            if (!biddingData || biddingData.length === 0) {
                biddingData = window.getDefaultBiddingData();
            }

            // 按默认模板顺序重排（与 renderBidding() 保持一致）：否则编辑框会按
            // 云端/本地原始行顺序渲染表单，保存时又是按表单DOM顺序写回，导致该
            // 日期从此固化成错误顺序——即便 renderBidding() 本身有排序，也会被
            // 下一次编辑保存后的数据覆盖掉。
            const _tplEdit = window.getDefaultBiddingTemplate();
            const _tplOrderEdit = {};
            _tplEdit.forEach(function(t, i) { _tplOrderEdit[((t && t.name) || '').trim()] = i; });
            biddingData = biddingData.slice().sort(function(a, b) {
                const ai = _tplOrderEdit[((a && a.name) || '').trim()];
                const bi = _tplOrderEdit[((b && b.name) || '').trim()];
                return (ai === undefined ? 999 : ai) - (bi === undefined ? 999 : bi);
            });
            
            const formContainer = document.getElementById('biddingFormContainer');
            
            let html = '<div style="display:flex;flex-direction:column;gap:6px">';
            
            // 表头
            html += '<div style="display:flex;gap:6px;height:36px;align-items:center">';
            html += '<div style="flex:2.8;min-width:110px;height:100%;display:flex;align-items:center;justify-content:center;font-size:13px;color:#6b7280;font-weight:600;background:#f8fafc;border-radius:4px">要盯项目</div>';
            html += '<div style="flex:1.2;min-width:55px;height:100%;display:flex;align-items:center;justify-content:center;font-size:12px;color:#6b7280;font-weight:600;background:#f8fafc;border-radius:4px">9:15</div>';
            html += '<div style="flex:1.2;min-width:55px;height:100%;display:flex;align-items:center;justify-content:center;font-size:12px;color:#6b7280;font-weight:600;background:#f8fafc;border-radius:4px">9:20</div>';
            html += '<div style="flex:1.4;min-width:60px;height:100%;display:flex;align-items:center;justify-content:center;font-size:12px;color:#6b7280;font-weight:600;background:#f8fafc;border-radius:4px">9:25</div>'; // 注意：字段名 time930 对应的是9:25竞价数据，字段名保持不变只改显示
            html += '<div style="flex:1;min-width:45px;height:100%;display:flex;align-items:center;justify-content:center;font-size:12px;color:#6b7280;font-weight:600;background:#f8fafc;border-radius:4px">增减</div>';
            html += '<div style="flex:1.2;min-width:55px;height:100%;display:flex;align-items:center;justify-content:center;font-size:12px;color:#6b7280;font-weight:600;background:#f8fafc;border-radius:4px">收盘</div>';
            html += '</div>';
            
            // 每一行（行高44px满足iOS最小触控目标，onclick=this.focus()确保iOS滚动容器内可靠聚焦）
            // tabindex按顺序编号，让讯飞/搜狗等第三方输入法的"下个"按Tab顺序跳格
            biddingData.forEach((row, index) => {
                const tb = index * 5 + 1; // tabindex base：名称=tb, 915=tb+1, 920=tb+2, 930=tb+3, 收盘=tb+4
                html += '<div style="display:flex;gap:6px;min-height:44px;align-items:center;padding:2px 0">';
                
                // 第一列：要盯项目（带删除按钮）
                html += `<div style="flex:2.8;min-width:110px;display:flex;align-items:center;gap:4px">`;
                html += `<button type="button" onclick="window.removeBiddingRow(${index})" tabindex="-1" style="font-size:10px;padding:4px 6px;border:1px solid #ef4444;color:#ef4444;background:#fef2f2;border-radius:4px;cursor:pointer;white-space:nowrap;flex-shrink:0;height:30px">删</button>`;
                html += `<input type="text" class="form-input" name="name-${index}" value="${row.name || ''}" placeholder="项目" autocomplete="off" inputmode="text" enterkeyhint="next" tabindex="${tb}" style="flex:1;font-size:11px;padding:0 2px;min-width:0;border-radius:4px;height:34px;touch-action:manipulation;pointer-events:auto;-webkit-user-select:text;user-select:text;" oninput="window.onBiddingInputChange(this)" onclick="this.focus()">`;
                html += `</div>`;
                
                // 第二列：9:15
                html += `<div style="flex:1.2;min-width:55px"><input type="text" class="form-input" name="time915-${index}" value="${row.time915 || ''}" placeholder="-" autocomplete="off" inputmode="decimal" enterkeyhint="next" tabindex="${tb+1}" style="width:100%;font-size:13px;padding:0 2px;box-sizing:border-box;border-radius:4px;height:36px;text-align:center;touch-action:manipulation;pointer-events:auto;-webkit-user-select:text;user-select:text;" oninput="window.onBiddingInputChange(this)" onclick="this.focus()"></div>`;
                
                // 第三列：9:20
                html += `<div style="flex:1.2;min-width:55px"><input type="text" class="form-input" name="time920-${index}" value="${row.time920 || ''}" placeholder="-" autocomplete="off" inputmode="decimal" enterkeyhint="next" tabindex="${tb+2}" style="width:100%;font-size:13px;padding:0 2px;box-sizing:border-box;border-radius:4px;height:36px;text-align:center;touch-action:manipulation;pointer-events:auto;-webkit-user-select:text;user-select:text;" oninput="window.onBiddingInputChange(this)" onclick="this.focus()"></div>`;
                
                // 第四列：9:30
                html += `<div style="flex:1.4;min-width:60px"><input type="text" class="form-input" name="time930-${index}" value="${row.time930 || ''}" placeholder="-" autocomplete="off" inputmode="decimal" enterkeyhint="next" tabindex="${tb+3}" style="width:100%;font-size:13px;padding:0 2px;box-sizing:border-box;border-radius:4px;height:36px;text-align:center;touch-action:manipulation;pointer-events:auto;-webkit-user-select:text;user-select:text;" oninput="window.onBiddingInputChange(this)" onclick="this.focus()"></div>`;
                
                // 第五列：增减
                let changeValue = row.change || '';
                let changeStyle = '';
                if (row.time930 && row.time920) {
                    const time930Num = parseFloat(row.time930);
                    const time920Num = parseFloat(row.time920);
                    if (!isNaN(time930Num) && !isNaN(time920Num)) {
                        if (time930Num > time920Num) {
                            changeValue = '增';
                            changeStyle = 'color:#ef4444;font-weight:600';
                        } else if (time930Num < time920Num) {
                            changeValue = '减';
                            changeStyle = 'color:#059669;font-weight:600';
                        } else {
                            changeValue = '平';
                            changeStyle = 'color:#1f2937;font-weight:600';
                        }
                    }
                }
                html += `<div style="flex:1;min-width:45px"><input type="text" class="form-input" name="change-${index}" id="change-${index}" value="${changeValue}" placeholder="-" autocomplete="off" style="width:100%;font-size:13px;padding:0 2px;box-sizing:border-box;border-radius:4px;height:32px;text-align:center;background:#f8fafc;${changeStyle}" readonly tabindex="-1"></div>`;
                
                // 第六列：收盘
                const isSectorEtf = (row.name || '').includes('板块ETF');
                const sectorEtfAttr = isSectorEtf ? ' data-sector-etf="true"' : '';
                html += `<div style="flex:1.2;min-width:55px"><input type="text" class="form-input" name="close-${index}" value="${row.close || ''}" placeholder="-" autocomplete="off" inputmode="decimal" enterkeyhint="next" tabindex="${tb+4}" style="width:100%;font-size:13px;padding:0 2px;box-sizing:border-box;border-radius:4px;height:36px;text-align:center;touch-action:manipulation;pointer-events:auto;-webkit-user-select:text;user-select:text;" oninput="window.onBiddingInputChange(this)" onclick="this.focus()"${sectorEtfAttr}></div>`;
                
                html += '</div>';
            });
            
            html += '</div>';
            
            formContainer.innerHTML = html;
            document.getElementById('biddingModal').classList.add('active');
            
            // 延迟计算，确保DOM已经渲染完成
            setTimeout(() => {
                window.updateAllChangeValues();
                // 强制给所有可编辑 input 绑定 touchstart→focus，
                // 解决移动端 WebView 某些行无法点击聚焦的问题
                const editableInputs = formContainer.querySelectorAll('input:not([readonly])');
                editableInputs.forEach(inp => {
                    inp.addEventListener('touchstart', function(e) {
                        e.stopPropagation();
                        setTimeout(() => this.focus(), 0);
                    }, { passive: true });
                });
            }, 50);
        }

        // 竞价变化输入框实时更新

        // 竞价变化输入框实时更新
        export function onBiddingInputChange(input) {
            if (input) input.dataset.touched = 'true';
            window.updateAllChangeValues();

            // 检查是否是板块ETF的收盘值输入框
            if (input && input.hasAttribute('data-sector-etf')) {
                window.syncBiddingCloseToEtf(input);
            }

            // 同步账号溢价的收盘值到今日盈亏
            const formContainer = document.getElementById('biddingFormContainer');
            const nameInputs = formContainer.querySelectorAll('[name^="name-"]');

            for (let i = 0; i < nameInputs.length; i++) {
                const nameInput = nameInputs[i];
                if (nameInput.value === '账号溢价') {
                    const closeInput = formContainer.querySelector(`[name="close-${i}"]`);
                    const stats = window.getStats();
                    if (closeInput && closeInput.value.trim() !== '') {
                        const closeValue = closeInput.value.trim();
                        const profitNum = parseFloat(closeValue);
                        if (!isNaN(profitNum)) {
                            stats.profit = profitNum;
                            window.markJiwangDirty(window.currentDate);
                            window.saveData();
                            window.renderCircleStats();
                        }
                    } else {
                        // 清空账号溢价时，同步清空圆形统计的今日盈亏
                        stats.profit = '';
                        window.markJiwangDirty(window.currentDate);
                        window.saveData();
                        window.renderCircleStats();
                    }
                }
            }

            // 实时更新连涨连跌天数柱状图
            window.autoCalculateConsecutiveDays();
        }

        // 同步竞价变化收盘值到早盘板块ETF涨值
        // 根据板块ETF上涨数量同步到早盘板块ETF表现看板

        // 同步竞价变化收盘值到早盘板块ETF涨值
        // 根据板块ETF上涨数量同步到早盘板块ETF表现看板
        export function syncSectorEtfZhangNum(zhangNum) {
            zhangNum = parseInt(zhangNum) || 0;

            // 同时更新已保存的ETF数据（先更新数据）
            const etfData = window.getEtfData();
            let todayEtf = etfData[window.currentDate];

            // 如果没有数据，创建新数据
            if (!todayEtf || todayEtf.length === 0) {
                todayEtf = [{
                    shuliang: '48',
                    dieZhangbi: '',
                    jingtu: '',
                    tushi: ''
                }];
            }

            const firstEtf = todayEtf[0];
            if (!firstEtf.shuliang) {
                firstEtf.shuliang = '48';
            }
            const total = parseInt(firstEtf.shuliang) || 48;
            const dieValue = total - zhangNum;
            firstEtf.dieZhangbi = dieValue + ':' + zhangNum;
            etfData[window.currentDate] = todayEtf;
            localStorage.setItem('stockEtfData', JSON.stringify(etfData));

            window._dbgLog('[SECTOR-ETF] 同步到ETF看板: 总 ' + total + ', 涨 ' + zhangNum + ', 跌:涨 = ' + firstEtf.dieZhangbi);

            // 重新渲染ETF看板（这会更新显示）
            window.renderEtf();

            // 如果早盘板块ETF编辑模态框打开，更新输入框
            const etfModal = document.getElementById('etfModal');
            if (etfModal && etfModal.classList.contains('active')) {
                // 重新打开编辑框以显示最新数据
                window.openEtfEdit();
            }
        }


        export function syncBiddingCloseToEtf(input) {
            const value = input.value.trim();
            const zhangNum = parseInt(value) || 0;
            window.syncSectorEtfZhangNum(zhangNum);
        }



        // 更新所有增减值

        // 更新所有增减值
        export function updateAllChangeValues() {
            const formContainer = document.getElementById('biddingFormContainer');
            const nameInputs = formContainer.querySelectorAll('[name^="name-"]');
            const count = nameInputs.length;
            
            for (let i = 0; i < count; i++) {
                const time920Input = formContainer.querySelector(`[name="time920-${i}"]`);
                const time930Input = formContainer.querySelector(`[name="time930-${i}"]`);
                const changeInput = document.getElementById(`change-${i}`);
                
                if (time920Input && time930Input && changeInput) {
                    const time920Val = parseFloat(time920Input.value);
                    const time930Val = parseFloat(time930Input.value);
                    
                    // 检查是否为空或无效数字
                    const time920Empty = !time920Input.value.trim();
                    const time930Empty = !time930Input.value.trim();
                    const time920Invalid = isNaN(time920Val);
                    const time930Invalid = isNaN(time930Val);
                    
                    // 如果任何一个为空或无效，清空增减列
                    if (time920Empty || time930Empty || time920Invalid || time930Invalid) {
                        changeInput.value = '';
                        changeInput.style.color = '';
                        continue;
                    }
                    
                    // 两个都是有效数字，计算增减
                    let changeValue = '';
                    
                    if (time930Val > time920Val) {
                        changeValue = '增';
                        changeInput.style.color = '#ef4444';
                    } else if (time930Val < time920Val) {
                        changeValue = '减';
                        changeInput.style.color = '#059669';
                    } else {
                        changeValue = '平';
                        changeInput.style.color = '#1f2937';
                    }
                    
                    changeInput.value = changeValue;
                }
            }
        }

        // 关闭竞价变化编辑

        // 关闭竞价变化编辑
        export function closeBiddingModal() {
            document.getElementById('biddingModal').classList.remove('active');
        }

        // 清除竞价变化数据（保留第一列，清除其他列）

        // 清除竞价变化数据（保留第一列，清除其他列）
        export function clearBiddingData() {
            if (!confirm('确定要清除所有数据吗？\n\n将保留第一列（要盯项目）的内容，\n清除其他所有列的数据。')) {
                return;
            }
            
            // 先把表单当前内容写入存储，确保名称列的最新编辑不会丢失
            window._saveBiddingFormToStorage();

            let biddingData = window.getTodayBidding();
            if (!biddingData || biddingData.length === 0) {
                window.showToast('没有数据需要清除');
                return;
            }
            
            // 检查是否是模板数据（没有保存过的日期）
            const bidding = window.getBiddingData();
            const isNewDate = !bidding[window.currentDate] || bidding[window.currentDate].length === 0;
            
            // 如果是新日期，创建副本以避免修改模板
            if (isNewDate) {
                biddingData = biddingData.map(row => ({...row}));
            }
            
            // 保留第一列（name），清除其他列
            biddingData.forEach(row => {
                row.time915 = '';
                row.time920 = '';
                row.time930 = '';
                row.change = '';
                row.close = '';
                // 同步清除"最近多板%"行的9:25修改历史锁定字段，
                // 否则下次重新填入保存后，旧的初始值会干扰变色和弹窗逻辑
                delete row.time930_initial;
                delete row.time930_initial_modifiedAt;
                delete row.time930_modifiedAt;
            });
            
            window.getBiddingData()[window.currentDate] = biddingData;
            window.saveData();

            // [FIX] 清空操作必须真正删除云端对应日期的行：pushBiddingToCloud 对“全空”表单有
            // “跳过推送、避免覆盖云端已有数据”的安全网（第 9492 行 return），只 blank 列而不删云端，
            // 会导致刷新 / Realtime 把旧数据“复活”。这里显式删云端行才是干净清除。
            // bidding 行名来自固定模板，删掉云端行不影响下次重新生成；本地仍保留空行供用户重新填写。
            window.deleteBiddingFromCloud(window.currentDate).catch(function(e) {
                window._dbgLog('[BIDDING-CLEAR] window.deleteBiddingFromCloud 失败: ' + (e && e.message));
                try { window.showWarningToast('⚠️ 云端清除失败，旧数据可能仍在：' + (e && e.message), 8000); } catch (err) {}
            });

            // 同步清除圆形统计的今日盈亏
            const stats = window.getStats();
            stats.profit = '';
            window.markJiwangDirty(window.currentDate);
            window.saveData();
            window.renderCircleStats();
            
            window.openBiddingEdit();
            window.showToast('已清除数据');
            
            // 实时更新连涨连跌天数柱状图
            window.autoCalculateConsecutiveDays();
        }

        // 添加竞价变化行

        // 添加竞价变化行
        export function addBiddingRow() {
            // 先把表单当前内容写入存储，防止用户填了一半的数据被丢弃
            window._saveBiddingFormToStorage();

            let biddingData = window.getTodayBidding();
            
            // 检查是否是模板数据（没有保存过的日期）
            const bidding = window.getBiddingData();
            const isNewDate = !bidding[window.currentDate] || bidding[window.currentDate].length === 0;
            
            // 如果是新日期，创建副本以避免修改模板
            if (isNewDate) {
                biddingData = biddingData.map(row => ({...row}));
            }
            
            biddingData.push({
                name: '',
                time915: '',
                time920: '',
                time930: '',
                change: '',
                close: ''
            });
            window.getBiddingData()[window.currentDate] = biddingData;
            window.saveData();
            window.openBiddingEdit();
        }

        // 移除竞价变化行

        // 移除竞价变化行
        export function removeBiddingRow(index) {
            // 先把表单当前内容写入存储，防止用户填了一半的数据被丢弃
            window._saveBiddingFormToStorage();

            let biddingData = window.getTodayBidding();
            
            // 检查是否是模板数据（没有保存过的日期）
            const bidding = window.getBiddingData();
            const isNewDate = !bidding[window.currentDate] || bidding[window.currentDate].length === 0;
            
            // 如果是新日期，创建副本以避免修改模板
            if (isNewDate) {
                biddingData = biddingData.map(row => ({...row}));
            }
            
            if (index >= 0 && index < biddingData.length) {
                biddingData.splice(index, 1);
                window.getBiddingData()[window.currentDate] = biddingData;
                window.saveData();
                window.openBiddingEdit();
            }
        }

        // 内部辅助：将表单当前输入静默写入存储（不触发渲染/toast/关闭弹窗）
        // 供 addBiddingRow / removeBiddingRow / clearBiddingData 在操作前调用，
        // 防止用户填了一半的内容因表单重建而丢失。
        // 内部辅助：将表单当前输入静默写入存储（不触发渲染/toast/关闭弹窗）
        // 供 addBiddingRow / removeBiddingRow / clearBiddingData 在操作前调用，
        // 防止用户填了一半的内容因表单重建而丢失。

        // 内部辅助：将表单当前输入静默写入存储（不触发渲染/toast/关闭弹窗）
        // 供 addBiddingRow / removeBiddingRow / clearBiddingData 在操作前调用，
        // 防止用户填了一半的内容因表单重建而丢失。
        // 内部辅助：将表单当前输入静默写入存储（不触发渲染/toast/关闭弹窗）
        // 供 addBiddingRow / removeBiddingRow / clearBiddingData 在操作前调用，
        // 防止用户填了一半的内容因表单重建而丢失。
        export function _saveBiddingFormToStorage() {
            const formContainer = document.getElementById('biddingFormContainer');
            if (!formContainer) return;
            const nameInputs = formContainer.querySelectorAll('[name^="name-"]');
            if (nameInputs.length === 0) return;

            const rawRows = [];
            const count = nameInputs.length;
            for (let i = 0; i < count; i++) {
                const nameInput   = formContainer.querySelector(`[name="name-${i}"]`);
                const time915Input = formContainer.querySelector(`[name="time915-${i}"]`);
                const time920Input = formContainer.querySelector(`[name="time920-${i}"]`);
                const time930Input = formContainer.querySelector(`[name="time930-${i}"]`);
                const changeInput  = formContainer.querySelector(`[name="change-${i}"]`);
                const closeInput   = formContainer.querySelector(`[name="close-${i}"]`);
                rawRows.push({
                    name:    nameInput    ? nameInput.value.trim()    : '',
                    time915: time915Input ? time915Input.value.trim() : '',
                    time920: time920Input ? time920Input.value.trim() : '',
                    time930: time930Input ? time930Input.value.trim() : '',
                    change:  changeInput  ? changeInput.value.trim()  : '',
                    close:   closeInput   ? closeInput.value.trim()   : '',
                    touched: {
                        time915: time915Input && time915Input.dataset.touched === 'true',
                        time920: time920Input && time920Input.dataset.touched === 'true',
                        time930: time930Input && time930Input.dataset.touched === 'true',
                        change:  changeInput  && changeInput.dataset.touched  === 'true',
                        close:   closeInput   && closeInput.dataset.touched   === 'true'
                    }
                });
            }

            // 与旧数据逐字段合并，逻辑同 saveBidding：本次为空的字段保留旧值，避免误清空
            const oldBiddingDataForMerge = window.getTodayBidding() || [];
            const FIELDS_TO_MERGE = ['time915', 'time920', 'time930', 'change', 'close'];
            const biddingData = rawRows.map(function(newRow, i) {
                let oldRow = null;
                if (newRow.name) {
                    oldRow = oldBiddingDataForMerge.find(r => r && r.name === newRow.name);
                }
                if (!oldRow) {
                    oldRow = oldBiddingDataForMerge[i] || null;
                }
                if (!oldRow) {
                    const { touched, ...rest } = newRow;
                    return rest;
                }
                const merged = { ...newRow };
                FIELDS_TO_MERGE.forEach(function(field) {
                    if (merged.touched && merged.touched[field]) return;
                    if (merged[field] === '' && oldRow[field] !== undefined && oldRow[field] !== '') {
                        merged[field] = oldRow[field];
                    }
                });
                delete merged.touched;
                return merged;
            });

            window.getBiddingData()[window.currentDate] = biddingData;
            // [BUG-FIX] 表单临时保存（增删行/清除前）也标记为脏，避免启动合并时把云端旧值覆盖回来。
            window._biddingDirtyDates.add(window.currentDate);
            window.saveData();
        }

        // 保存竞价变化数据

        // 保存竞价变化数据
        export async function saveBidding() {
            // [BUG-FIX] 立即标记当前日期有未同步编辑，防止保存过程中被 Realtime/启动拉取覆盖。
            window._biddingDirtyDates.add(window.currentDate);
            const formContainer = document.getElementById('biddingFormContainer');
            const saveBtn = document.querySelector('#biddingModal .submit-btn');
            const rawRows = [];

            // 获取所有name输入框
            const nameInputs = formContainer.querySelectorAll('[name^="name-"]');
            const count = nameInputs.length;

            for (let i = 0; i < count; i++) {
                const nameInput = formContainer.querySelector(`[name="name-${i}"]`);
                const time915Input = formContainer.querySelector(`[name="time915-${i}"]`);
                const time920Input = formContainer.querySelector(`[name="time920-${i}"]`);
                const time930Input = formContainer.querySelector(`[name="time930-${i}"]`);
                const changeInput = formContainer.querySelector(`[name="change-${i}"]`);
                const closeInput = formContainer.querySelector(`[name="close-${i}"]`);

                const name = nameInput ? nameInput.value.trim() : '';
                const time915 = time915Input ? time915Input.value.trim() : '';
                const time920 = time920Input ? time920Input.value.trim() : '';
                const time930 = time930Input ? time930Input.value.trim() : '';
                const change = changeInput ? changeInput.value.trim() : '';
                const close = closeInput ? closeInput.value.trim() : '';

                // 记录用户是否编辑过该字段；编辑过的字段（即使清空）应被保留，不应被旧值合并覆盖
                const touched = {
                    time915: time915Input && time915Input.dataset.touched === 'true',
                    time920: time920Input && time920Input.dataset.touched === 'true',
                    time930: time930Input && time930Input.dataset.touched === 'true',
                    change: changeInput && changeInput.dataset.touched === 'true',
                    close: closeInput && closeInput.dataset.touched === 'true',
                };

                // 保留所有行（包括名称为空的行），否则历史数据会被当前模板覆盖
                rawRows.push({
                    name,
                    time915,
                    time920,
                    time930,
                    change,
                    close,
                    touched
                });
            }

            // 合并式保存：本次表单中某字段为空，不代表用户想清空它，很可能只是这个时段
            // （比如9:20保存时，9:25/收盘列本来就还没到时间填）尚未填写。
            // 因此与旧数据逐字段合并——只有本次提交了非空值才覆盖旧值，本次为空则保留旧值。
            // 例外：用户本次显式编辑过并清空的字段（input dataset.touched='true'）不再被旧值回填。
            // 行的匹配优先按 name（同名视为同一行），找不到旧行或 name 为空时按 index 兜底对齐。
            const oldBiddingDataForMerge = window.getTodayBidding() || [];
            const FIELDS_TO_MERGE = ['time915', 'time920', 'time930', 'change', 'close'];
            const biddingData = rawRows.map(function(newRow, i) {
                let oldRow = null;
                if (newRow.name) {
                    oldRow = oldBiddingDataForMerge.find(r => r && r.name === newRow.name);
                }
                if (!oldRow) {
                    oldRow = oldBiddingDataForMerge[i] || null;
                }
                if (!oldRow) {
                    const { touched, ...rest } = newRow;
                    return rest;
                }
                const merged = { ...newRow };
                FIELDS_TO_MERGE.forEach(function(field) {
                    // 用户编辑过该字段：即使清空也要生效，不再用旧值回填
                    if (merged.touched && merged.touched[field]) return;
                    if (merged[field] === '' && oldRow[field] !== undefined && oldRow[field] !== '') {
                        merged[field] = oldRow[field];
                    }
                });
                delete merged.touched;
                return merged;
            });

            // "最近多板%"这一行的9:25（time930）修改历史锁定逻辑
            // 只针对这一行，记录第一次保存的值（锁定不变）和最后一次保存的时间
            (function lockDuibanTime930History() {
                const oldBiddingData = window.getTodayBidding(); // 保存前的旧数据，用于取回已锁定的初始值
                const newRow = biddingData.find(r => r.name && r.name.trim() === '最近多板%');
                if (!newRow) return;
                const oldRow = oldBiddingData ? oldBiddingData.find(r => r.name && r.name.trim() === '最近多板%') : null;

                if (oldRow && oldRow.time930_initial !== undefined && oldRow.time930_initial !== '') {
                    // 已经锁定过有效初始值：保持不变（包括首次锁定时间），只更新最后修改时间
                    newRow.time930_initial = oldRow.time930_initial;
                    newRow.time930_initial_modifiedAt = oldRow.time930_initial_modifiedAt;
                    newRow.time930_modifiedAt = Date.now();
                } else if (newRow.time930 && newRow.time930.trim() !== '') {
                    // 本次 time930 有实际值（且旧初始值不存在或为空）：锁定初始值，不算"已修改"
                    newRow.time930_initial = newRow.time930;
                    newRow.time930_initial_modifiedAt = Date.now();
                    newRow.time930_modifiedAt = undefined;
                } else {
                    // 本次 time930 也是空的，不锁定，清除历史字段
                    newRow.time930_initial = undefined;
                    newRow.time930_initial_modifiedAt = undefined;
                    newRow.time930_modifiedAt = undefined;
                }
            })();

            window.getBiddingData()[window.currentDate] = biddingData;
            window.saveData();

            // 本地可见的后续操作（不依赖云端推送）
            // Fix Bug5: iOS上点"保存"时oninput可能来不及触发syncBiddingCloseToEtf
            // 在saveBidding中主动同步板块ETF数据到早盘ETF看板。
            // 兼容抓取时段：早盘填在 time930，收盘后填在 close，优先取 close，其次 time930。
            const sectorEtfRow = biddingData.find(row => row.name && row.name.startsWith('板块ETF'));
            if (sectorEtfRow) {
                const rawValue = (sectorEtfRow.close && sectorEtfRow.close.trim() !== '')
                    ? sectorEtfRow.close.trim()
                    : (sectorEtfRow.time930 && sectorEtfRow.time930.trim() !== '')
                        ? sectorEtfRow.time930.trim()
                        : '';
                if (rawValue !== '') {
                    window.syncSectorEtfZhangNum(rawValue);
                    window._dbgLog('[BIDDING-SAVE] 保存时同步板块ETF涨数: ' + rawValue);
                }
            }

            // 同步账号溢价的收盘值到今日盈亏
            const accountPremiumRow = biddingData.find(row => row.name === '账号溢价');
            if (accountPremiumRow && accountPremiumRow.close && accountPremiumRow.close.trim() !== '') {
                const closeValue = accountPremiumRow.close.trim();
                const profitNum = parseFloat(closeValue);
                if (!isNaN(profitNum)) {
                    const stats = window.getStats();
                    stats.profit = profitNum;
                    window.markJiwangDirty(window.currentDate);
                    window.saveData();
                    window.renderCircleStats();
                }
            }

            // 保持展开状态（用户展开编辑后，保存后保持展开）
            const boardEl = document.getElementById('biddingBoard');
            const toggleBtn = document.getElementById('biddingToggleBtn');
            boardEl.classList.remove('minimized');
            toggleBtn.textContent = '▲';

            window.renderBidding();

            // 重新计算评分（因为竞价变化数据影响评分）
            window.autoCalculateRecentMultiScore();

            window.autoCalculateConsecutiveDays();
            window.renderConsecutiveUp();

            // 同步更新记忘看板的昨多板K线（如果保存的是上一交易日的数据）
            window.syncJiwangKxianFromBidding();

            // [BUG-FIX] 等待云端同步完成后再关闭模态框，避免用户在推送完成前刷新页面导致数据丢失。
            // 之前 pushBiddingToCloud 是 fire-and-forget，手机上保存后立即切屏/刷新容易丢数据。
            if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = '保存中...'; }
            let cloudErr = null;
            try {
                await window.pushBiddingToCloud(window.currentDate);
                // 同步删除"云端有但表单没有"的行（用户在表单里点"删"掉的行，比如改名残留的幽灵行）
                await window.syncBiddingDeletionsToCloud(window.currentDate);
                window._dbgLog('[BIDDING-SAVE] 云端同步完成 ' + window.currentDate);
            } catch (e) {
                cloudErr = e;
                console.warn('window.saveBidding 云端同步失败:', e);
            } finally {
                if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = '保存竞价变化'; }
                window.closeBiddingModal();
                if (cloudErr) {
                    const detail = (cloudErr && (cloudErr.message || cloudErr.details || cloudErr.hint || cloudErr.code)) || String(cloudErr);
                    window.showWarningToast('⚠️ 云端同步失败，本次修改未保存！原因: ' + detail, 10000);
                } else {
                    window.showToast('✅ 竞价变化保存成功（已同步云端）！');
                }
            }

            // 自动打标顺势/逆势标签
            window.autoTagShunshiNishi();
        }
        
        // 根据竞价变化自动打标顺势/逆势标签

        // 根据竞价变化自动打标顺势/逆势标签
        export function autoTagShunshiNishi(skipRender = false) {
            const biddingData = window.getTodayBidding();
            if (!biddingData || !Array.isArray(biddingData) || biddingData.length === 0) {
                return;
            }
            
            // 获取最近多板%行
            const duibanRow = biddingData.find(row => row.name && row.name.trim() === '最近多板%');
            // Fix Bug4: 原为includes('最近多板%')，与syncJiwangKxianFromBidding的精确匹配不一致，统一改为精确匹配+trim
            if (!duibanRow) return;
            
            const time930 = parseFloat(duibanRow.time930);
            const close = parseFloat(duibanRow.close);
            
            // 判断行情方向：time930 < close = 顺势，time930 > close = 逆势
            if (isNaN(time930) || isNaN(close)) return;
            
            const isShunshi = time930 < close; // 顺势行情
            
            // 获取今日股票列表
            const stocks = window.getStocksData()[window.currentDate] || [];
            let hasUpdate = false;
            
            stocks.forEach(stock => {
                const closeValue = parseFloat(stock.close);
                if (isNaN(closeValue)) return;
                
                // 清除旧的顺逆标签（全部清除，重新计算）
                // 顺逆互斥：清除时两个都清
                if (stock.nishi || stock.shunshi) {
                    stock.nishi = false;
                    stock.shunshi = false;
                    stock.autoNishi = false;
                    stock.autoShunshi = false;
                }
                
                // 重新计算标签（手动自动都要覆盖）
                // 顺逆互斥：只打一个标签
                if (closeValue >= 2) {
                    // 涨幅>=2%的股票
                    if (isShunshi) {
                        // 顺势行情：>=2%打顺势
                        stock.shunshi = true;
                        stock.autoShunshi = true;
                        hasUpdate = true;
                    } else {
                        // 逆势行情：>=2%打逆势
                        stock.nishi = true;
                        stock.autoNishi = true;
                        hasUpdate = true;
                    }
                } else {
                    // 涨幅<2%的股票
                    if (isShunshi) {
                        // 顺势行情：<2%打逆势
                        stock.nishi = true;
                        stock.autoNishi = true;
                        hasUpdate = true;
                    } else {
                        // 逆势行情：<2%打顺势
                        stock.shunshi = true;
                        stock.autoShunshi = true;
                        hasUpdate = true;
                    }
                }
            });
            
            if (hasUpdate && !skipRender) {
                window.saveData();
                window.renderList();
            }
            return hasUpdate;
        }

        // 同步更新记忘看板的昨多板K线

        // 同步更新记忘看板的昨多板K线
        export function syncJiwangKxianFromBidding() {
            // 获取下一交易日（当前保存的数据是上一交易日的，所以要更新下一交易日的记忘看板）
            const nextDate = window.getNextTradingDay(window.currentDate);
            if (!nextDate) return;

            // 获取当前保存的竞价变化数据
            const biddingData = window.getBiddingData();
            const currentBidding = biddingData[window.currentDate];

            if (!currentBidding || !Array.isArray(currentBidding)) return;

            // 找到"最近多板%"这一行
            const multiBoardRow = currentBidding.find(row => row.name === '最近多板%');
            if (!multiBoardRow || !multiBoardRow.close) return;

            // 生成K线类型
            const kxianValue = window.getKxianTypeByClose(multiBoardRow.close);
            if (!kxianValue) return;

            // 更新下一交易日的记忘看板K线数据
            const jiwangData = window.getJiwangData();
            if (!jiwangData[nextDate]) {
                jiwangData[nextDate] = {};
            }

            // 更新K线值
            jiwangData[nextDate].kxian = kxianValue;
            window.markJiwangDirty(nextDate);
            window.saveData();
            window.pushJiwangNow(nextDate);

            // 如果下一交易日就是当前显示的日期，重新渲染
            if (nextDate === window.currentDate) {
                window.renderJiwang();
            }
        }

        // 打开默认模板设置

