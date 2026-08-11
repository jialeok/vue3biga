// boards-stocks.js — 从 boards-render.js 拆分（看板域: boards-stocks.js）

        // 关闭热点选择编辑
        export function closeHotspotModal() {
            document.getElementById('hotspotModal').classList.remove('active');
        }

        // 保存热点选择

        // 保存热点选择
        export function saveHotspot() {
            const hotspot = document.getElementById('hotspotInput').value.trim();
            window.getHotspotData()[window.currentDate] = hotspot;
            window.saveData();
            window.renderHotspot();
            window.renderWeekendStats();
            window.closeHotspotModal();
        }

        // 设置筛选

        // 设置筛选
        export function setFilter(filter) {
            window.currentFilter = filter;
            
            // 更新卡片激活状态
            document.querySelectorAll('.compact-stat-card').forEach(card => {
                card.className = 'compact-stat-card';
                if (filter === 'all' && card.id === 'statAll') card.classList.add('active-filter-all');
                if (filter === '已买' && card.id === 'statBought') card.classList.add('active-filter-bought');
                if (filter === '已卖' && card.id === 'statSold') card.classList.add('active-filter-sold');
                if (filter === '持有' && card.id === 'statHold') card.classList.add('active-filter-hold');
                if (filter === '最近多板' && card.id === 'statRecentMulti') card.classList.add('active-filter-recentmulti');
                if (filter === '板块ETF' && card.id === 'statSectorEtf') card.classList.add('active-filter-sectoretf');
                if (filter === '题材方向' && card.id === 'statTopicDirection') card.classList.add('active-filter-topicdirection');
            });
            
            window.renderList();
        }

        // 选择次日预测

        // 选择次日预测
        export function selectNextDay(type) {
            document.getElementById('stockNextDay').value = type;
            document.getElementById('nextUpOption').className = type === 'up' ? 'nextday-option selected-up' : 'nextday-option';
            document.getElementById('nextDownOption').className = type === 'down' ? 'nextday-option selected-down' : 'nextday-option';
        }

        // 格式化日期：将20260131转换为2026年1月31日，或保持2026-02-13 10:54格式

        // 格式化日期：将20260131转换为2026年1月31日，或保持2026-02-13 10:54格式
        export function formatDate(dateStr) {
            if (!dateStr || dateStr.trim() === '') return '';
            
            // 如果包含时间（格式如：2026-02-13 10:54），直接返回
            if (dateStr.includes(' ')) {
                return dateStr;
            }
            
            // 移除所有非数字字符
            const cleanStr = dateStr.replace(/\D/g, '');
            
            if (cleanStr.length === 8) {
                const year = cleanStr.substring(0, 4);
                const month = parseInt(cleanStr.substring(4, 6));
                const day = parseInt(cleanStr.substring(6, 8));
                return `${year}年${month}月${day}日`;
            }
            
            return dateStr;
        }

        // 获取备注显示文本（带颜色前缀）

        // 获取备注显示文本（带颜色前缀）
        export function getRemarkDisplay(stock) {
            if (!stock || (!stock.remarkType && !stock.remark)) return '-';
            
            const typeMap = {
                'red_check': { text: '竞图符合✔', color: '#dc2626' },
                'orange_check': { text: '竞图勉强符合✔', color: '#f97316' },
                'green_x': { text: '竞图不符合×', color: '#16a34a' },
                'green_x_strong': { text: '竞图非常不符合×', color: '#16a34a' }
            };
            
            let result = '';
            
            // 如果有选择类型，添加带颜色的前缀
            if (stock.remarkType && typeMap[stock.remarkType]) {
                const typeInfo = typeMap[stock.remarkType];
                result += `<span style="color:${typeInfo.color}">${typeInfo.text}</span>`;
            }
            
            // 如果有备注内容，添加备注
            if (stock.remark) {
                if (result) result += ''; // 前缀和备注直接拼接
                result += stock.remark;
            }
            
            return result || '-';
        }

        // 渲染股票列表

        // 渲染股票列表
        export function renderList(skipOtherBoards = false, skipAuction = false) {
            let data = window.getTodayData();
            const stocksData = window.getStocksData();
            
            // 根据筛选条件过滤数据
            if (window.currentFilter === '已买') data = data.filter(s => s.bought);
            else if (window.currentFilter === '已卖') data = data.filter(s => s.sold);
            else if (window.currentFilter === '持有') data = data.filter(s => s.hold);
            else if (window.currentFilter === '最近多板') data = data.filter(s => s.recentMulti);
            else if (window.currentFilter === '板块ETF') data = data.filter(s => s.sectorEtf);
            else if (window.currentFilter === '题材方向') data = data.filter(s => s.topicDirection);
            
            // 排序：已买入 > 持有 > 已卖出 > 其他，然后按标签类型分组，最后按ID降序
            data.sort((a, b) => {
                // 计算优先级：已买入=3，持有=2，已卖出=1，其他=0
                const getPriority = (stock) => {
                    if (stock.bought) return 3;
                    if (stock.hold) return 2;
                    if (stock.sold) return 1;
                    return 0;
                };
                const aPriority = getPriority(a);
                const bPriority = getPriority(b);
                
                // 优先级高的在前
                if (aPriority !== bPriority) {
                    return bPriority - aPriority;
                }
                
                // 同优先级内，按标签类型分组排序
                // 计算标签类型优先级：同时有多个标签的按最高优先级算
                // 最近多板=3，板块ETF=2，题材方向=1，都没有=0
                const getTagPriority = (stock) => {
                    if (stock.recentMulti) return 3;
                    if (stock.sectorEtf) return 2;
                    if (stock.topicDirection) return 1;
                    return 0;
                };
                const aTagPriority = getTagPriority(a);
                const bTagPriority = getTagPriority(b);
                
                if (aTagPriority !== bTagPriority) {
                    return bTagPriority - aTagPriority;
                }
                
                // 同优先级同标签类型按ID降序
                return b.id - a.id;
            });
            
            // 更新统计数据（优化：只遍历一次）
            const todayData = getTodayData();
            let boughtCount = 0, soldCount = 0, holdCount = 0, recentMultiCount = 0, sectorEtfCount = 0, topicDirectionCount = 0;
            todayData.forEach(s => {
                if (s.bought) boughtCount++;
                if (s.sold) soldCount++;
                if (s.hold) holdCount++;
                if (s.recentMulti) recentMultiCount++;
                if (s.sectorEtf) sectorEtfCount++;
                if (s.topicDirection) topicDirectionCount++;
            });
            document.getElementById('todayCount').textContent = todayData.length;
            document.getElementById('boughtCount').textContent = boughtCount;
            document.getElementById('soldCount').textContent = soldCount;
            document.getElementById('holdCount').textContent = holdCount;
            document.getElementById('recentMultiCount').textContent = recentMultiCount;
            document.getElementById('sectorEtfCount').textContent = sectorEtfCount;
            document.getElementById('topicDirectionCount').textContent = topicDirectionCount;
            
            // 更新股票列表数量显示
            const stockListCount = document.getElementById('stockListCount');
            if (stockListCount) {
                stockListCount.textContent = '(' + todayData.length + ')';
            }
            
            // 更新日期显示
            window.updateDateDisplay();
            
            // 渲染模式看板、记忘看板、排名看板、多板看板和题材思路（仅在需要时渲染）
            // [RESILIENT-RENDER] 每个看板的渲染互相隔离：某一个看板渲染抛错（如 Vue 组件挂载
            // 失败、容器被误销毁）绝不能再中断整条 renderList 链路、导致后续看板（尤其"竞价变化
            // 看板"renderBidding）空白。逐个 try/catch，失败的看板仅记录日志，不影响其它看板。
            if (!skipOtherBoards) {
                const _safeRender = (label, fn) => {
                    try { fn(); }
                    catch (e) { if (window._dbgLog) window._dbgLog('[RENDER-LIST] ' + label + ' 渲染失败（已隔离）: ' + (e && e.message)); else console.warn('[RENDER-LIST] ' + label, e); }
                };
                // 竞价变化看板优先渲染，确保即使后面的看板（排名等）抛错也一定能显示
                _safeRender('renderBidding', () => window.renderBidding && window.renderBidding());
                _safeRender('renderPattern', () => window.renderPattern && window.renderPattern());
                _safeRender('renderJiwang', () => window.renderJiwang && window.renderJiwang());
                _safeRender('renderTagTitles', () => window.renderTagTitles && window.renderTagTitles());
                _safeRender('renderRank', () => window.renderRank && window.renderRank());
                if (!skipAuction) _safeRender('renderAuction', () => window.renderAuction && window.renderAuction());
                // 热门股票看板也必须重新渲染，否则切换日期后会残留上一个日期的数据
                // （所有日期切换函数都走 renderList，原先只渲染了 auction 分组）
                _safeRender('renderHotStocks', () => window.renderHotStocks && window.renderHotStocks());
                _safeRender('renderMulti', () => window.renderMulti && window.renderMulti());
                _safeRender('renderHotspot', () => window.renderHotspot && window.renderHotspot());
                _safeRender('renderEtf', () => window.renderEtf && window.renderEtf());
                _safeRender('renderDuiban', () => window.renderDuiban && window.renderDuiban());
                _safeRender('renderWeekendStats', () => window.renderWeekendStats && window.renderWeekendStats());
            }
            
            const listEl = document.getElementById('stockList'),
                  emptyEl = document.getElementById('emptyState');
            
            if (data.length === 0) {
                listEl.innerHTML = '';
                emptyEl.style.display = 'block';
                return;
            }
            
            emptyEl.style.display = 'none';
            
            listEl.innerHTML = data.map(stock => {
                const nextDayTag = stock.nextDay === 'up' ? '<span class="tag tag-next-up">次日涨</span>' : 
                                 stock.nextDay === 'down' ? '<span class="tag tag-next-down">次日跌</span>' : '';
                
                const dragonTag = stock.dragon ? '<span class="tag tag-dragon">龙</span>' : '';
                const holdTag = stock.hold ? '<span class="tag tag-hold">持</span>' : '';
                const watchTag = stock.watch ? '<span class="tag tag-watch">观</span>' : '';
                
                // 渲染追踪记录 - 最新的记录显示在顶部（反转显示）
                let trackDisplay = '';
                if (stock.track && Array.isArray(stock.track) && stock.track.length > 0) {
                    trackDisplay = `<div class="track-scroll-container"><div class="track-window.content-display">`;
                    
                    // 按时间倒序显示（最新的在上）
                    const reversedTrack = [...stock.track].reverse();
                    
                    reversedTrack.forEach(item => {
                        if (item.date || item.content) {
                            const formattedDate = window.formatDate(item.date);
                            trackDisplay += `
                                <div class="track-item">
                                    <span class="track-date">${formattedDate}</span>
                                    <span>${item.content || ''}</span>
                                </div>
                            `;
                        }
                    });
                    trackDisplay += '</div></div>';
                } else {
                    trackDisplay = `<div class="track-empty-hint">暂无追踪，点击添加...</div>`;
                }
                
                // 竞价开盘颜色
                let openColor = '#374151',
                    openDisplay = stock.open !== undefined && stock.open !== '' ? stock.open + '%' : '-';
                if (stock.open !== undefined && stock.open !== '' && !isNaN(parseFloat(stock.open))) {
                    if (parseFloat(stock.open) > 0) {
                        openColor = '#dc2626';
                        openDisplay = '+' + stock.open + '%';
                    } else if (parseFloat(stock.open) < 0) {
                        openColor = '#059669';
                    }
                }
                
                // 换手率颜色
                let turnoverColor = '#64748b',
                    turnoverDisplay = stock.turnover !== undefined && stock.turnover !== '' ? stock.turnover + '%' : '-';
                if (stock.turnover !== undefined && stock.turnover !== '' && !isNaN(parseFloat(stock.turnover))) {
                    turnoverColor = parseFloat(stock.turnover) <= 25 ? '#d97706' : '#dc2626';
                }
                
                // 开盘量比颜色
                const kbk = stock.kbiliangkai ? parseFloat(stock.kbiliangkai) : NaN;
                let kbkColor = '#64748b',
                    kbkDisplay = stock.kbiliangkai || '-';
                if (!isNaN(kbk)) {
                    kbkColor = kbk >= 3 ? '#dc2626' : '#059669';
                }
                
                // 调整幅度显示
                let adjustColor = '#374151',
                    adjustDisplay = '-',
                    adjustFontSize = '';
                if (stock.adjust !== undefined && stock.adjust !== '') {
                    // 检查是否是连板选项值
                    const lianbanOptions = ['二板成功', '二板失败', '三板成功', '三板失败', '四板成功', '四板失败', '五板成功', '五板失败'];
                    if (lianbanOptions.includes(stock.adjust)) {
                        // 连板选项，显示带颜色和对勾/叉号的文本
                        const isSuccess = stock.adjust.includes('成功');
                        const color = isSuccess ? '#dc2626' : '#16a34a';
                        const symbol = isSuccess ? '✔' : '✘';
                        adjustDisplay = `<span style="color:${color}">${stock.adjust}${symbol}</span>`;
                        adjustColor = 'inherit'; // 使用内联样式
                    } else {
                        // 其他情况，原样显示文本
                        adjustDisplay = stock.adjust;
                    }
                }
                
                // 收盘涨幅颜色和显示
                let closeColor = '#64748b',
                    closeDisplay = stock.close !== undefined && stock.close !== '' ? stock.close + '%' : '-';
                if (stock.close !== undefined && stock.close !== '' && !isNaN(parseFloat(stock.close))) {
                    closeColor = parseFloat(stock.close) > 0 ? '#dc2626' : '#059669';
                    if (parseFloat(stock.close) > 0) {
                        closeDisplay = '+' + stock.close + '%';
                    }
                }
                
                return `
                    <div class="stock-card ${stock.bought ? 'bought' : ''} ${stock.sold ? 'sold' : ''}" id="stock-card-${stock.id}">
                        <div class="stock-header">
                            <div class="stock-header-left" onclick="window.toggleStockActions(event, ${stock.id})">
                                <div class="stock-name">${stock.name}
                                    ${(() => {
                                        const pos1 = stock.bought ? '<span class="tag tag-bought">买</span>' : (stock.sold ? '<span class="tag tag-sold">卖</span>' : (holdTag ? holdTag : ''));
                                        const pos2 = stock.topicDirection ? '<span class="tag tag-topicdirection">题材</span>' : (stock.recentMulti ? '<span class="tag tag-recentmulti">多板</span>' : (stock.sectorEtf ? '<span class="tag tag-sectoretf">ETF</span>' : ''));
                                        const starTag = window.getStarTagsForStock(stock.name);
                                        const pos3 = starTag ? '<span class="tag ' + (['星爆', '星最多', '星增', '星平', '星现'].includes(starTag) ? 'tag-star-up' : 'tag-star-down') + '"><svg width="12" height="12" viewBox="0 0 24 24" fill="#fbbf24" style="vertical-align:middle;margin-bottom:1px"><polygon points="12,2 15.09,8.26 22,9.27 17,14.14 18.18,21.02 12,17.77 5.82,21.02 7,14.14 2,9.27 8.91,8.26"/></svg>' + starTag + '</span>' : '';
                                        const placeholder = '<span class="tag tag-placeholder"></span>';
                                        if (!pos1 && !pos2 && !pos3) {
                                            return '';
                                        }
                                        return '<div class="tags-row tags-row-first">' + (pos1 || placeholder) + (pos2 || placeholder) + (pos3 || placeholder) + '</div>';
                                    })()}
                                    <div class="tags-row">
                                        ${(() => {
                                            const pos2Tag = stock.topicDirection ? 'topicDirection' : (stock.recentMulti ? 'recentMulti' : (stock.sectorEtf ? 'sectorEtf' : null));
                                            return stock.recentMulti && pos2Tag !== 'recentMulti' ? '<span class="tag tag-recentmulti">多板</span>' : '';
                                        })()}
                                        ${(() => {
                                            const pos2Tag = stock.topicDirection ? 'topicDirection' : (stock.recentMulti ? 'recentMulti' : (stock.sectorEtf ? 'sectorEtf' : null));
                                            return stock.sectorEtf && pos2Tag !== 'sectorEtf' ? '<span class="tag tag-sectoretf">ETF</span>' : '';
                                        })()}
                                        ${(() => {
                                            const pos1Tag = stock.bought ? 'bought' : (stock.sold ? 'sold' : (holdTag ? 'hold' : null));
                                            return holdTag && pos1Tag !== 'hold' ? holdTag : '';
                                        })()}
                                        ${(() => {
                                            const pos1Tag = stock.bought ? 'bought' : (stock.sold ? 'sold' : (holdTag ? 'hold' : null));
                                            return stock.sold && pos1Tag !== 'sold' ? '<span class="tag tag-sold">卖</span>' : '';
                                        })()}
                                        ${stock.stage && stock.stage !== '其它' ? '<span class="tag ' + ((stock.stage === '连板' || stock.stage === '首板' || stock.stage === '二波' || stock.stage === '高位') ? 'tag-pink' : 'tag-default') + '">' + (stock.stage === '二波' ? '二' : stock.stage === '高位' ? '高' : stock.stage === '连板' ? '连' : stock.stage === '首板' ? '首' : stock.stage) + '</span>' : ''}
                                        ${watchTag}
                                        ${dragonTag}
                                        ${nextDayTag}
                                        ${stock.sellHigh ? '<span class="tag tag-sell-high">冲高</span>' : ''}
                                        ${stock.sell1120 ? '<span class="tag tag-sell-1120">11:20</span>' : ''}
                                        ${stock.sell1450 ? '<span class="tag tag-sell-1450">14:50</span>' : ''}
                                        ${stock.nishi ? '<span class="tag ' + (stock.close !== undefined && stock.close !== '' && !isNaN(parseFloat(stock.close)) && parseFloat(stock.close) > 0 ? 'tag-nishi-up' : 'tag-nishi-down') + '">逆</span>' : ''}
                                        ${stock.shunshi ? '<span class="tag ' + (stock.close !== undefined && stock.close !== '' && !isNaN(parseFloat(stock.close)) && parseFloat(stock.close) > 0 ? 'tag-shunshi-up' : 'tag-shunshi-down') + '">顺</span>' : ''}
                                    </div>
                                </div>
                            </div>
                            <div class="stock-header-right" onclick="window.toggleStockCardExpand(event, ${stock.id})">
                                <div class="close-rate-header ${stock.close !== undefined && stock.close !== '' && !isNaN(parseFloat(stock.close)) && parseFloat(stock.close) > 0 ? 'up' : 'down'}">
                                    ${(() => {
                                        const profitStatus = window.getStockProfitStatus(stock.name, stocksData);
                                        if (profitStatus === '赚') {
                                            return '<span class="bomb-badge" style="background:#dc2626;color:#fff">赚</span>';
                                        } else if (profitStatus === '亏') {
                                            return '<span class="bomb-badge" style="background:#6b7280;color:#fff">亏</span>';
                                        }
                                        return stock.bomb ? '<span class="bomb-badge">炸</span>' : '';
                                    })()}
                                    ${stock.close !== undefined && stock.close !== '' ? (parseFloat(stock.close) > 0 ? '+' : (parseFloat(stock.close) < 0 ? '-' : '')) + String(stock.close).replace(/^[+-]/, '') + '%' : '-%'}
                                </div>
                                <div class="expand-icon">▼</div>
                            </div>
                        </div>
                        <div class="stock-body" onclick="window.toggleStockActionsOnBody(event, ${stock.id})" ondblclick="window.editStock(${stock.id})">
                            <div class="info-item">
                                <div class="info-label">换手率</div>
                                <div class="turnover-highlight" style="color:${turnoverColor}">${turnoverDisplay}</div>
                            </div>
                            <div class="info-item">
                                <div class="info-label">竞价开盘</div>
                                <div class="info-value" style="color:${openColor}">${openDisplay}</div>
                            </div>
                            <div class="info-item">
                                <div class="info-label">调整幅度</div>
                                <div class="info-value" style="color:${adjustColor}; ${adjustFontSize}">${adjustDisplay}</div>
                            </div>
                            <div class="info-item">
                                <div class="info-label">竞符合数形态</div>
                                <div class="info-value" style="font-size:12px">${stock.pattern || '-'}</div>
                            </div>
                            <div class="info-item">
                                <div class="info-label">零轴位置</div>
                                <div class="axis-value">${stock.axis || '-'}</div>
                            </div>
                            <div class="info-item">
                                <div class="info-label">备注</div>
                                <div class="remark-value">${window.getRemarkDisplay(stock)}</div>
                            </div>
                            <div class="info-item">
                                <div class="info-label">开盘量比</div>
                                <div class="info-value" style="color:${kbkColor}">${kbkDisplay}</div>
                            </div>
                            <div class="info-item">
                                <div class="info-label">缩放量能</div>
                                <div class="sfliangneng-value">${stock.sfliangneng || '-'}</div>
                            </div>
                            <div class="info-item">
                                <div class="info-label">相关题材</div>
                                <div class="xgcaiti-value">${stock.xgcaiti ? stock.xgcaiti.replace(/[()]/g, '') : '-'}</div>
                            </div>
                        </div>
                        <div class="stock-actions" id="actions-${stock.id}">
                            <button class="action-btn btn-edit" onclick="window.editStock(${stock.id})">编辑</button>
                            <button class="action-btn btn-copy" onclick="window.copyToTomorrow(${stock.id})">复制到交易日</button>
                            <button class="action-btn btn-copy-date" onclick="window.copyToDate(${stock.id})">复制到日期</button>
                            <button class="action-btn btn-delete" onclick="window.deleteStock(${stock.id})">删除</button>
                        </div>
                        ${stock.isSold && stock.soldRecords && stock.soldRecords.length > 0 ? `
                        <div class="sold-records-display" style="padding:8px 15px;background:linear-gradient(90deg, rgba(220, 38, 38, 0.05), transparent);cursor:pointer;margin:8px 0;border-radius:8px;" onclick="event.stopPropagation();window.openSoldEdit(${stock.id})">
                            ${[...stock.soldRecords].reverse().map(record => {
                                const profit = parseFloat(record.profit) || 0;
                                const percent = parseFloat(record.percent) || 0;
                                const typeText = record.type === '部分卖' ? '部分卖' : 
                                                record.type === '全清仓' ? '全清仓' : '';
                                const profitText = profit >= 0 ? '赚' : '亏';
                                const percentDisplay = record.percent ? `${(parseFloat(record.percent) >= 0 ? '+' : '') + record.percent}%` : '';
                                return `<div style="font-size:12px;line-height:1.8;color:${profit >= 0 ? '#dc2626' : '#16a34a'};font-weight:500;">${record.date} ${typeText}${profitText}${(profit >= 0 ? '+' : '') + record.profit} ${percentDisplay}</div>`;
                            }).join('')}
                        </div>
                        ` : `
                        <div class="sold-records-empty" style="padding:6px 15px;background:linear-gradient(90deg, rgba(59, 130, 246, 0.03), transparent);cursor:pointer;margin:8px 0;border-radius:8px;" onclick="event.stopPropagation();window.openSoldEdit(${stock.id})">
                            <div style="font-size:12px;color:#94a3b8;">💰 点击添加</div>
                        </div>
                        `}
                        <div class="track-simple" onclick="window.openTrackEdit('${stock.id !== undefined ? stock.id : stock.name}')">
                            ${trackDisplay || '<div class="track-placeholder">追踪</div>'}
                        </div>
                    </div>
                `;
            }).join('');
            
            // 滚动条滚动到最右边
            document.querySelectorAll('.track-scroll-container').forEach(container => {
                setTimeout(() => {
                    container.scrollLeft = container.scrollWidth;
                }, 0);
            });
        }

        // 复制股票到交易日（简化版：只复制指定字段）

        // 复制股票到交易日（简化版：只复制指定字段）
        export function copyToTomorrow(id) {
            // 获取当前股票数据
            const stock = (window.getStocksData()[window.currentDate] || []).find(s => s.id === id);
            if (!stock) {
                window.showToast('❌ 未找到股票数据');
                return;
            }

            // 获取下一个交易日
            const nextTradingDay = window.getNextTradingDay(window.currentDate);

            // 处理标签：如果源股票有"已买入"标签，复制到交易日时变成"持有"；如果源股票有"已卖出"标签，复制到交易日时变成"观望"
            const sourceBought = stock.bought || false;
            const sourceSold = stock.sold || false;
            
            // 检查最新卖出记录的类型
            let shouldClearSoldRecords = false;
            if (stock.soldRecords && stock.soldRecords.length > 0) {
                const sortedRecords = [...stock.soldRecords].sort((a, b) => new Date(b.date) - new Date(a.date));
                const latestRecord = sortedRecords[0];
                if (latestRecord && latestRecord.type === '全清仓') {
                    shouldClearSoldRecords = true;
                }
            }
            
            const newStock = {
                id: Date.now(), // 生成新的唯一ID
                name: stock.name || '', // 股票名称
                stage: stock.stage || '二波', // 阶段
                xgcaiti: stock.xgcaiti || '', // 相关题材
                track: stock.track ? JSON.parse(JSON.stringify(stock.track)) : [], // 追踪记录（深拷贝）
                bought: false, // 已买入（复制时重置）
                sold: false, // 已卖出（复制时重置）
                hold: sourceBought || stock.hold || false, // 持有（如果源有已买入，则变成持有）
                // 继承链条防二次传递：这条 hold 是"复制到交易日"自动搬运产生的，不是用户在新日期
                // 重新确认的持有；打上标记后，deriveAuctionTagState 就不会把它当作再传一天的源头。
                // 只有源记录本身不是继承来的（sourceBought=当天真实买入 或 stock.hold 是用户在
                // 股票列表页手动勾选的）才会走到这里，此时的复制行为本身仍视为"未经新日期确认"。
                inheritedHold: (sourceBought || stock.hold || false) ? true : undefined,
                watch: sourceSold || stock.watch || false, // 观望（如果源有已卖出，则变成观望）
                dragon: stock.dragon || false, // 设置为龙头股
                recentMulti: stock.recentMulti || false, // 最近多板
                topicDirection: stock.topicDirection || false, // 题材方向
                sectorEtf: stock.sectorEtf || false, // 板块ETF
                isSold: stock.isSold || false, // 已卖
                soldRecords: shouldClearSoldRecords ? [] : (stock.soldRecords ? JSON.parse(JSON.stringify(stock.soldRecords)) : []), // 卖出记录（全清仓时清空，否则复制）
                // 以下字段为空字符串（不是0）
                adjust: '',
                open: '',
                close: '',
                turnover: '',
                kbiliangkai: '',
                sfliangneng: '',
                nextDay: '',
                bomb: false,
                pattern: '',
                axis: '',
                remark: '',
                remarkType: ''
            };
            
            // 确保交易日数据数组存在
            if (!window.getStocksData()[nextTradingDay]) {
                window.getStocksData()[nextTradingDay] = [];
            }

            // 检查交易日是否已有同名股票
            const existingStock = window.getStocksData()[nextTradingDay].find(s => s.name === newStock.name);
            if (existingStock) {
                if (!confirm(`${nextTradingDay}已存在"${newStock.name}"，是否覆盖？`)) {
                    return;
                }
                // 删除已存在的同名股票
                window.getStocksData()[nextTradingDay] = window.getStocksData()[nextTradingDay].filter(s => s.name !== newStock.name);
            }

            // 添加到交易日的数据
            window.getStocksData()[nextTradingDay].push(newStock);
            
            // 保存数据
            window.saveData();
            
            // 提示成功
            window.showToast(`✅ 已复制"${newStock.name}"到${nextTradingDay}`);
            
            // 如果当前查看的是交易日，则重新渲染
            if (window.currentDate === nextTradingDay) {
                window.renderList();
            }
        }

        // 复制股票到指定日期（一个月范围内）

        // 复制股票到指定日期（一个月范围内）
        export function copyToDate(id) {
            // 获取当前股票数据
            const stock = (window.getStocksData()[window.currentDate] || []).find(s => s.id === id);
            if (!stock) {
                window.showToast('❌ 未找到股票数据');
                return;
            }

            // 计算日期范围（当前日期到一个月后）
            const today = new Date(window.currentDate);
            const maxDate = new Date(today);
            maxDate.setDate(today.getDate() + 30);
            
            const todayStr = today.toISOString().split('T')[0];
            const maxDateStr = maxDate.toISOString().split('T')[0];

            // 弹出日期选择对话框
            const selectedDate = prompt('请选择复制日期（' + todayStr + ' 至 ' + maxDateStr + '）：', todayStr);
            
            // 用户取消选择
            if (!selectedDate) {
                return;
            }

            // 验证日期格式和范围
            const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
            if (!dateRegex.test(selectedDate)) {
                window.showToast('❌ 日期格式不正确，请使用 YYYY-MM-DD 格式');
                return;
            }

            const selectedDateObj = new Date(selectedDate);
            if (selectedDateObj < today || selectedDateObj > maxDate) {
                window.showToast('❌ 只能选择一个月范围内的日期');
                return;
            }

            // 检查是否是休市日
            if (window.isMarketClosed(selectedDate)) {
                window.showToast('❌ ' + selectedDate + '是休市日，无法复制');
                return;
            }

            // 处理标签：如果源股票有"已买入"标签，复制时变成"持有"；如果源股票有"已卖出"标签，复制时变成"观望"
            const sourceBought = stock.bought || false;
            const sourceSold = stock.sold || false;
            
            // 检查最新卖出记录的类型
            let shouldClearSoldRecords = false;
            if (stock.soldRecords && stock.soldRecords.length > 0) {
                const sortedRecords = [...stock.soldRecords].sort((a, b) => new Date(b.date) - new Date(a.date));
                const latestRecord = sortedRecords[0];
                if (latestRecord && latestRecord.type === '全清仓') {
                    shouldClearSoldRecords = true;
                }
            }
            
            // 复制指定字段，其他字段为空（与复制到明天功能一致）
            const newStock = {
                id: Date.now(), // 生成新的唯一ID
                name: stock.name || '', // 股票名称
                stage: stock.stage || '二波', // 阶段
                xgcaiti: stock.xgcaiti || '', // 相关题材
                track: stock.track ? JSON.parse(JSON.stringify(stock.track)) : [], // 追踪记录（深拷贝）
                soldRecords: shouldClearSoldRecords ? [] : (stock.soldRecords ? JSON.parse(JSON.stringify(stock.soldRecords)) : []), // 卖出记录（深拷贝，全清仓时清空）
                isSold: stock.isSold || false, // 是否已卖出
                bought: false, // 已买入（复制时重置）
                sold: false, // 已卖出（复制时重置）
                hold: sourceBought || stock.hold || false, // 持有（如果源有已买入，则变成持有）
                // 继承链条防二次传递：同 copyToTomorrow，复制产生的 hold 不作为下一天继承的源头
                inheritedHold: (sourceBought || stock.hold || false) ? true : undefined,
                watch: sourceSold || stock.watch || false, // 观望（如果源有已卖出，则变成观望）
                dragon: stock.dragon || false, // 设置为龙头股
                recentMulti: stock.recentMulti || false, // 最近多板
                topicDirection: stock.topicDirection || false, // 题材方向
                sectorEtf: stock.sectorEtf || false, // 板块ETF
                // 以下字段为空字符串（不是0）
                adjust: '',
                open: '',
                close: '',
                turnover: '',
                kbiliangkai: '',
                sfliangneng: '',
                nextDay: '',
                bomb: false,
                pattern: '',
                axis: '',
                remark: '',
                remarkType: ''
            };
            
            // 确保目标日期数据数组存在
            if (!window.getStocksData()[selectedDate]) {
                window.getStocksData()[selectedDate] = [];
            }

            // 检查目标日期是否已有同名股票
            const existingStock = window.getStocksData()[selectedDate].find(s => s.name === newStock.name);
            if (existingStock) {
                if (!confirm(selectedDate + '已存在"' + newStock.name + '"，是否覆盖？')) {
                    return;
                }
                // 删除已存在的同名股票
                window.getStocksData()[selectedDate] = window.getStocksData()[selectedDate].filter(s => s.name !== newStock.name);
            }

            // 添加到目标日期的数据
            window.getStocksData()[selectedDate].push(newStock);
            
            // 保存数据
            window.saveData();
            
            // 提示成功
            window.showToast('✅ 已复制"' + newStock.name + '"到' + selectedDate);
            
            // 如果当前查看的是目标日期，则重新渲染
            if (window.currentDate === selectedDate) {
                window.renderList();
            }
        }

        // 切换股票列表收起/展开

        // 切换股票列表收起/展开
        export function toggleStockListCollapse() {
            window.isStockListCollapsed = !window.isStockListCollapsed;
            const stockList = document.getElementById('stockList');
            const toggleText = document.getElementById('stockListToggleText');
            const toggleIcon = document.getElementById('stockListToggleIcon');
            
            if (window.isStockListCollapsed) {
                stockList.classList.add('collapsed');
                toggleText.textContent = '展开全部';
                toggleIcon.textContent = '📋';
                // 清除所有单张收起状态
                document.querySelectorAll('.stock-card.single-collapsed').forEach(el => {
                    el.classList.remove('single-collapsed');
                });
            } else {
                stockList.classList.remove('collapsed');
                toggleText.textContent = '收起全部';
                toggleIcon.textContent = '📑';
                // 清除所有单张展开状态
                document.querySelectorAll('.stock-card.single-expanded').forEach(el => {
                    el.classList.remove('single-expanded');
                });
            }
            
            // 保存用户偏好到本地存储
            localStorage.setItem('stockListCollapsed_v41', window.isStockListCollapsed);
        }

        // 初始化股票列表折叠状态

        // 初始化股票列表折叠状态
        export function initStockListCollapse() {
            const savedState = localStorage.getItem('stockListCollapsed_v41');
            const stockList = document.getElementById('stockList');
            const toggleText = document.getElementById('stockListToggleText');
            const toggleIcon = document.getElementById('stockListToggleIcon');
            
            // 默认收起状态，忽略之前保存的状态
            window.isStockListCollapsed = true;
            stockList.classList.add('collapsed');
            toggleText.textContent = '展开全部';
            toggleIcon.textContent = '📋';
        }

        // 切换股票卡片展开/收起（点击标题栏右侧）

        // 切换股票卡片展开/收起（点击标题栏右侧）
        export function toggleStockCardExpand(event, id) {
            event.stopPropagation();
            const stockCard = document.getElementById('stock-card-' + id);
            const actions = document.getElementById('actions-' + id);
            
            if (window.isStockListCollapsed) {
                // 收起状态下
                if (!stockCard.classList.contains('single-expanded')) {
                    // 股票未展开：展开股票，不显示编辑按钮
                    stockCard.classList.add('single-expanded');
                    actions.classList.remove('expanded');
                } else {
                    // 股票已展开：收起股票
                    stockCard.classList.remove('single-expanded');
                    actions.classList.remove('expanded');
                }
            } else {
                // 展开状态下
                stockCard.classList.toggle('single-collapsed');
                actions.classList.remove('expanded');
            }
        }

        // 点击内容区域显示编辑按钮（当卡片已展开时）

        // 点击内容区域显示编辑按钮（当卡片已展开时）
        export function toggleStockActionsOnBody(event, id) {
            event.stopPropagation();
            const stockCard = document.getElementById('stock-card-' + id);
            const actions = document.getElementById('actions-' + id);
            
            // 只有在卡片已展开时才显示/隐藏编辑按钮
            const isExpanded = window.isStockListCollapsed ? stockCard.classList.contains('single-expanded') : !stockCard.classList.contains('single-collapsed');
            
            if (isExpanded) {
                // 切换编辑按钮显示
                document.querySelectorAll('.stock-actions').forEach(el => {
                    if (el.id !== 'actions-' + id) el.classList.remove('expanded');
                });
                actions.classList.toggle('expanded');
            }
        }

        // 切换操作按钮展开/收起（点击标题栏左侧）

        // 切换操作按钮展开/收起（点击标题栏左侧）
        export function toggleStockActions(event, id) {
            event.stopPropagation();
            const actions = document.getElementById('actions-' + id);
            const stockCard = document.getElementById('stock-card-' + id);
            
            // 收起状态下：第一次点击展开股票（不显示编辑按钮），第二次点击收起股票
            if (window.isStockListCollapsed) {
                if (!stockCard.classList.contains('single-expanded')) {
                    // 股票未展开：展开股票，不显示编辑按钮
                    stockCard.classList.add('single-expanded');
                    actions.classList.remove('expanded');
                } else {
                    // 股票已展开：收起股票
                    stockCard.classList.remove('single-expanded');
                    actions.classList.remove('expanded');
                }
                return;
            }
            
            // 展开状态下
            stockCard.classList.toggle('single-collapsed');
            actions.classList.remove('expanded');
        }

        // 滑动切换日期
        let touchStartX = 0;
        let touchStartY = 0;
        const gestureArea = document.getElementById('gestureArea');
        
        gestureArea.addEventListener('touchstart', e => {
            touchStartX = e.changedTouches[0].screenX;
            touchStartY = e.changedTouches[0].screenY;
        }, { passive: true });
        
        gestureArea.addEventListener('touchend', e => {
            const endY = e.changedTouches[0].screenY;
            const diffX = touchStartX - e.changedTouches[0].screenX;
            const diffY = Math.abs(endY - touchStartY);
            
            // 如果有模态框打开，不触发翻页
            const activeModals = document.querySelectorAll('.modal.active');
            if (activeModals.length > 0) {
                return;
            }
            
            // 获取底部操作栏的位置
            const bottomBar = document.querySelector('.bottom-bar');
            const bottomBarTop = bottomBar ? bottomBar.getBoundingClientRect().top : window.innerHeight;
            
            // 如果触摸点在底部操作栏区域内，不触发翻页
            if (touchStartY >= bottomBarTop - 20) {
                return;
            }
            
            // 如果垂直滑动距离大于水平滑动距离，不触发翻页（可能是滚动页面）
            if (diffY > Math.abs(diffX)) {
                return;
            }
            
            if (Math.abs(diffX) > 50) {
                diffX > 0 ? window.changeDate(1) : window.changeDate(-1);
            }
        }, { passive: true });

        // 切换日期后，防御性地从云端补拉一次该日期的记忘看板数据。
        // 原因：_jiwangMemCache 只在"密码验证/整页刷新时的 pullFromCloud()"和
        // Realtime 订阅收到变化时更新，如果这条日期的数据是在本次会话开始前、
        // 从另一台设备写入的，而 Realtime 订阅当时恰好断线（手机切后台很常见），
        // 内存缓存里就完全没有这条数据——不是"丢失"，而是"从未拉取过"。
        // 跳过本地有未推送完成编辑的日期，避免用云端旧值覆盖刚编辑的内容。

        // 切换日期后，防御性地从云端补拉一次该日期的记忘看板数据。
        // 原因：_jiwangMemCache 只在"密码验证/整页刷新时的 pullFromCloud()"和
        // Realtime 订阅收到变化时更新，如果这条日期的数据是在本次会话开始前、
        // 从另一台设备写入的，而 Realtime 订阅当时恰好断线（手机切后台很常见），
        // 内存缓存里就完全没有这条数据——不是"丢失"，而是"从未拉取过"。
        // 跳过本地有未推送完成编辑的日期，避免用云端旧值覆盖刚编辑的内容。
        export function refreshJiwangForDateSwitch(date) {
            if (!date) return;
            const pending = (window._jiwangDirtyDates && window._jiwangDirtyDates.has(date)) ||
                (window._jiwangPushTimers && window._jiwangPushTimers[date]);
            if (pending) {
                window._dbgLog('refreshJiwangForDateSwitch: ' + date + ' 有本地待推送编辑，跳过拉取');
                return;
            }
            const _beforePull = JSON.stringify(window.getJiwangData()[date] || null).slice(0, 200);
            window._dbgLog('refreshJiwangForDateSwitch: 开始拉取 ' + date + ', 拉取前缓存=' + _beforePull);
            window.pullJiwangForDate(date).then(function() {
                const _afterPull = JSON.stringify(window.getJiwangData()[date] || null).slice(0, 200);
                window._dbgLog('refreshJiwangForDateSwitch: ' + date + ' 拉取完成, 拉取后缓存=' + _afterPull);
                if (date === window.currentDate) {
                    window.renderJiwang();
                    if (typeof window.renderMarketStage === 'function') window.renderMarketStage();
                }
            }).catch(function(e) {
                console.warn('切换日期补拉 jiwang 失败:', e.message);
                window._dbgLog('refreshJiwangForDateSwitch: ' + date + ' 拉取失败: ' + (e && e.message));
                window.showWarningToast('⚠️ 记忘看板拉取失败，当前显示的可能是过期数据。原因: ' + (e && e.message || e), 8000);
            });

            // 情绪看板同为纯云端表，切换日期时同步刷新
            window._emotionDataCache = null;
            window.loadEmotionData(date).then(function() {
                if (date === window.currentDate) window.renderEmotionBoard();
            }).catch(function(e) { console.warn('切换日期加载情绪看板失败:', e.message); });
        }

        // 改变日期
        // 记录"通过翻页/选择日期/回到今天等导航方式切换了 window.currentDate"，同步写入
        // lastEditedDate_v42。之前只有 saveData() 会写这个 key——如果用户切换日期后
        // 没有紧接着编辑保存就下拉刷新（页面整个重新加载），_appInit() 会用旧的
        // lastEditedDate_v42 把 window.currentDate 悄悄跳回切换前的日期，渲染的就是那天的
        // 记忘看板，而不是用户切换后正在看的那天——表现就是"明明才输入保存的数据，
        // 一刷新就不见了"，其实是刷新后根本没停留在同一天。

        // 改变日期
        // 记录"通过翻页/选择日期/回到今天等导航方式切换了 window.currentDate"，同步写入
        // lastEditedDate_v42。之前只有 saveData() 会写这个 key——如果用户切换日期后
        // 没有紧接着编辑保存就下拉刷新（页面整个重新加载），_appInit() 会用旧的
        // lastEditedDate_v42 把 window.currentDate 悄悄跳回切换前的日期，渲染的就是那天的
        // 记忘看板，而不是用户切换后正在看的那天——表现就是"明明才输入保存的数据，
        // 一刷新就不见了"，其实是刷新后根本没停留在同一天。
        export function _persistCurrentDateAsLastEdited(date) {
            if (!date || date < '2025-01-01') return;
            try { localStorage.setItem('lastEditedDate_' + window.DATA_VERSION, date); } catch (e) {}
            // 同步到 Vue store：computeAuctionViewData 等响应式 computed 依赖
            // auctionStore.currentDate，不同步会导致日期切换后 Vue 看板不刷新
            if (typeof window.auctionStore !== 'undefined' && window.auctionStore) window.auctionStore.currentDate = date;
        }


        export function changeDate(days) {
            // 隐藏月统计看板
            const monthlyBoard = document.getElementById('monthlyStatsBoard');
            if (monthlyBoard) {
                monthlyBoard.classList.remove('active');
            }

            const d = new Date(window.currentDate + 'T00:00:00');
            d.setDate(d.getDate() + days);

            const year = d.getFullYear();
            const month = String(d.getMonth() + 1).padStart(2, '0');
            const day = String(d.getDate()).padStart(2, '0');
            const newDate = `${year}-${month}-${day}`;

            if (newDate < '2025-01-01') {
                window.showHint('最早2025年');
                return;
            }

            window.setCurrentDate(newDate);
            window._persistCurrentDateAsLastEdited(newDate);

            window.setFilter('all');

            // [PERF-FIX 2026-07-26] 日期切换先把新日期显示出来，再用 rAF 渲染主要内容，
            // 并把非关键计算（最近多板分数、记忘看板）延后到 setTimeout，避免小三角按钮卡顿。
            requestAnimationFrame(function() {
                window.renderList();
                window.renderAuction();
                window.renderAuctionPage4();
            });
            setTimeout(function() {
                window.autoCalculateRecentMultiScore();
                window.refreshJiwangForDateSwitch(newDate);
            }, 0);
            window.showHint(days > 0 ? '明天' : '昨天');
        }

        // 处理日期选择（旧版日期选择器，保留兼容）

        // 处理日期选择（旧版日期选择器，保留兼容）
        export function handleDateSelect(date) {
            // 隐藏月统计看板
            const monthlyBoard = document.getElementById('monthlyStatsBoard');
            if (monthlyBoard) {
                monthlyBoard.classList.remove('active');
            }

            if (date < '2025-01-01') {
                alert('最早2025年');
                return;
            }

            window.setCurrentDate(date);
            window._persistCurrentDateAsLastEdited(date);

            window.setFilter('all');
            // [PERF-FIX 2026-07-26] 同 changeDate：关键渲染走 rAF，非关键计算延后。
            requestAnimationFrame(function() {
                window.renderList();
                window.renderAuction();
                window.renderAuctionPage4();
            });
            setTimeout(function() {
                window.autoCalculateRecentMultiScore();
                window.refreshJiwangForDateSwitch(date);
            }, 0);
        }

        // 回到今天

        // 回到今天
        export function goToday() {
            // 隐藏月统计看板
            const monthlyBoard = document.getElementById('monthlyStatsBoard');
            if (monthlyBoard) {
                monthlyBoard.classList.remove('active');
            }
            
            const now = new Date();
            const year = now.getFullYear();
            const month = String(now.getMonth() + 1).padStart(2, '0');
            const day = String(now.getDate()).padStart(2, '0');
            let today = `${year}-${month}-${day}`;
            if (today < '2025-01-01') today = '2025-01-01';
            
            window.setCurrentDate(today);
            window._persistCurrentDateAsLastEdited(today);

            window.setFilter('all');
            // [PERF-FIX 2026-07-26] 同 changeDate：关键渲染走 rAF，非关键计算延后。
            requestAnimationFrame(function() {
                window.renderList();
                window.renderAuction();
                window.renderAuctionPage4();
            });
            setTimeout(function() {
                window.autoCalculateRecentMultiScore();
                window.refreshJiwangForDateSwitch(today);
            }, 0);
            window.showHint('今天');
        }

        // 返回当前（返回到点击统计按钮前的日期）

        // 返回当前（返回到点击统计按钮前的日期）
        export function goBackToCurrent() {
            // 隐藏月统计看板
            const monthlyBoard = document.getElementById('monthlyStatsBoard');
            monthlyBoard.classList.remove('active');
            
            // 获取跳转前的日期
            let beforeDate = localStorage.getItem('statsNavBeforeDate');
            
            // 如果没有保存的日期，使用今天
            if (!beforeDate || beforeDate < '2025-01-01') {
                const now = new Date();
                const year = now.getFullYear();
                const month = String(now.getMonth() + 1).padStart(2, '0');
                const day = String(now.getDate()).padStart(2, '0');
                beforeDate = `${year}-${month}-${day}`;
            }
            
            if (beforeDate < '2025-01-01') beforeDate = '2025-01-01';
            
            window.setCurrentDate(beforeDate);
            window._persistCurrentDateAsLastEdited(beforeDate);

            window.setFilter('all');
            // [PERF-FIX 2026-07-26] 同 changeDate：关键渲染走 rAF，非关键计算延后。
            requestAnimationFrame(function() {
                window.renderList();
                window.renderAuction();
                window.renderAuctionPage4();
            });
            setTimeout(function() {
                window.autoCalculateRecentMultiScore();
                window.refreshJiwangForDateSwitch(beforeDate);
            }, 0);
            window.showHint('已返回');
        }

        // ========== 自定义日期选择器 ==========
        let pickerCurrentYear = new Date().getFullYear();
        let pickerCurrentMonth = new Date().getMonth();

        // 打开日期选择器

        // 打开日期选择器
        export function openDatePickerModal() {
            const date = new Date(window.currentDate);
            pickerCurrentYear = date.getFullYear();
            pickerCurrentMonth = date.getMonth();
            window.renderPickerCalendar();
            document.getElementById('datePickerModal').classList.add('active');
        }

        // 关闭日期选择器

        // 关闭日期选择器
        export function closeDatePickerModal() {
            document.getElementById('datePickerModal').classList.remove('active');
        }

        // 渲染日历

        // 渲染日历
        export function renderPickerCalendar() {
            const calendar = document.getElementById('datePickerCalendar');
            const holidays = window.getHolidays();
            
            // 更新月份标题
            document.getElementById('pickerMonthTitle').textContent = `${pickerCurrentYear}年${pickerCurrentMonth + 1}月`;
            
            // 更新假期按钮状态
            window.updatePickerHolidayBtn();
            
            let html = '';
            
            // 星期标题
            const weekDays = ['日', '一', '二', '三', '四', '五', '六'];
            weekDays.forEach(day => {
                html += `<div class="calendar-header">${day}</div>`;
            });
            
            // 获取当月第一天和最后一天
            const firstDay = new Date(pickerCurrentYear, pickerCurrentMonth, 1);
            const lastDay = new Date(pickerCurrentYear, pickerCurrentMonth + 1, 0);
            const startDayOfWeek = firstDay.getDay();
            const totalDays = lastDay.getDate();
            
            // 填充空白
            for (let i = 0; i < startDayOfWeek; i++) {
                html += `<div class="calendar-day empty"></div>`;
            }
            
            // 填充日期
            for (let day = 1; day <= totalDays; day++) {
                const dateStr = `${pickerCurrentYear}-${String(pickerCurrentMonth + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
                const date = new Date(dateStr + 'T00:00:00');
                const dayOfWeek = date.getDay();
                const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
                const isHoliday = holidays.includes(dateStr);
                const autoHoliday = !isHoliday && !isWeekend && window.isAutoHoliday(dateStr);
                const isSelected = dateStr === window.currentDate;

                let className = 'calendar-day';
                if (isSelected) {
                    className += ' selected';
                } else if (isHoliday || autoHoliday) {
                    className += ' holiday';
                } else if (isWeekend) {
                    className += ' weekend';
                } else {
                    className += ' normal-day';
                }

                const titleAttr = autoHoliday ? ' title="自动识别：非交易日"' : '';
                html += `<div class="${className}" onclick="window.selectPickerDate('${dateStr}')"${titleAttr}>${day}</div>`;
            }
            calendar.innerHTML = html;
        }

        // 选择日期（不关闭模态框，方便连续标记假期）

        // 选择日期（不关闭模态框，方便连续标记假期）
        export function selectPickerDate(dateStr) {
            if (dateStr < '2025-01-01') {
                window.showToast('日期不能早于2025-01-01');
                return;
            }
            window.setCurrentDate(dateStr);
            window._persistCurrentDateAsLastEdited(dateStr);
            window.allData = null;
            window.renderPickerCalendar();
            window.setFilter('all');
            // [PERF-FIX 2026-07-26] 同 changeDate：关键渲染走 rAF，非关键计算延后。
            requestAnimationFrame(function() {
                window.renderList();
                window.renderAuction();
                window.renderAuctionPage4();
            });
            setTimeout(function() {
                window.autoCalculateRecentMultiScore();
                window.refreshJiwangForDateSwitch(dateStr);
            }, 0);
        }

        // 上个月

        // 上个月
        export function prevPickerMonth() {
            pickerCurrentMonth--;
            if (pickerCurrentMonth < 0) {
                pickerCurrentMonth = 11;
                pickerCurrentYear--;
            }
            window.renderPickerCalendar();
        }

        // 下个月

        // 下个月
        export function nextPickerMonth() {
            pickerCurrentMonth++;
            if (pickerCurrentMonth > 11) {
                pickerCurrentMonth = 0;
                pickerCurrentYear++;
            }
            window.renderPickerCalendar();
        }

        // 今天

        // 今天
        export function pickerGoToday() {
            const now = new Date();
            pickerCurrentYear = now.getFullYear();
            pickerCurrentMonth = now.getMonth();
            const today = `${pickerCurrentYear}-${String(pickerCurrentMonth + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
            window.selectPickerDate(today);
        }

        // 标记假期（只能标记，不能取消）

        // 标记假期（只能标记，不能取消）
        export function togglePickerHoliday() {
            const holidays = window.getHolidays();
            
            if (holidays.includes(window.currentDate)) {
                window.showToast('已标记为假期，点击清除可取消');
                return;
            }
            
            holidays.push(window.currentDate);
            window.saveData();
            window.renderPickerCalendar();
            window.updateDateDisplay();
            window.showToast('已标记为假期');
        }

        // 更新假期按钮状态

        // 更新假期按钮状态
        export function updatePickerHolidayBtn() {
            const btn = document.getElementById('pickerHolidayBtn');
            const holidays = window.getHolidays();
            const isHoliday = holidays.includes(window.currentDate);
            
            if (isHoliday) {
                btn.style.background = 'linear-gradient(135deg, #ef4444, #dc2626)';
            } else {
                btn.style.background = 'linear-gradient(135deg, #f97316, #ea580c)';
            }
        }

        // 清除当前日期的假期标记和数据

        // 清除当前日期的假期标记和数据
        export function clearCurrentDateData() {
            const targetDate = window.auctionStore ? window.auctionStore.currentDate : window.currentDate;
            // 清除假期标记
            const holidays = window.getHolidays();
            const holidayIndex = holidays.indexOf(targetDate);
            if (holidayIndex > -1) {
                holidays.splice(holidayIndex, 1);
            }

            // 清除各类数据
            if (window.allData.stocks && window.allData.stocks[targetDate]) {
                delete window.allData.stocks[targetDate];
            }
            if (window.allData.jiwang && window.allData.jiwang[targetDate]) {
                delete window.allData.jiwang[targetDate];
            }
            if (window.allData.rank && window.allData.rank[targetDate]) {
                delete window.allData.rank[targetDate];
            }
            if (window.allData.multi && window.allData.multi[targetDate]) {
                delete window.allData.multi[targetDate];
            }
            if (window.allData.hotspot && window.allData.hotspot[targetDate]) {
                delete window.allData.hotspot[targetDate];
            }
            if (window.allData.pattern && window.allData.pattern[targetDate]) {
                delete window.allData.pattern[targetDate];
            }
            if (window.allData.bidding && window.allData.bidding[targetDate]) {
                delete window.allData.bidding[targetDate];
            }
            // bidding 已是纯云端表，仅清内存不够，需同步删除云端对应日期的行，
            // 否则下次刷新页面或 Realtime 同步会把数据从云端"复活"
            window.deleteBiddingFromCloud(targetDate).catch(function(e) {
                window._dbgLog('[AUCTION-ERR] window.deleteBiddingFromCloud ' + e.message);
            });
            // 阶段四 Bug 3 修复：auction 同步删除云端对应日期的行（与 bidding 对齐），
            // 原本只 delete allData.auction[window.currentDate]（即 _auctionMemCache[window.currentDate]），
            // 云端行还在，下次刷新/Realtime 会把数据"复活"
            window.deleteAuctionFromCloud(targetDate).catch(function(e) {
                window._dbgLog('[AUCTION-ERR] window.deleteAuctionFromCloud ' + e.message);
            });
            if (window._auctionMemCache[targetDate]) {
                window.deleteAuctionDateData(targetDate, 'window.clearCurrentDateData');
            }
            // 用户主动清空了本日数据（含 auction），标记为脏日期，
            // 允许下次推送时以本地（空）状态覆盖云端，而不是被"以云端为基准"保护挡住
            window.markAuctionDirty(targetDate);

            // 清除独立存储的 duibanData / stockEtfData 等当前日期数据
            ['duibanData', 'duibanComment', 'stockEtfData', 'stockEtfComment'].forEach(function(key) {
                try {
                    const raw = localStorage.getItem(key);
                    if (raw) {
                        const obj = JSON.parse(raw);
                        if (obj[targetDate] !== undefined) {
                            delete obj[targetDate];
                            localStorage.setItem(key, JSON.stringify(obj));
                        }
                    }
                } catch(e) {}
            });

            window.saveData();
            window.renderList();
            window.renderPickerCalendar();
            window.updateDateDisplay();
            window.showToast('已清除');
        }

        // 获取假期列表

        // 获取假期列表
        export function getHolidays() {
            if (!window.allData) window.loadAllData();
            if (!window.allData.holidays) window.allData.holidays = [];
            return window.allData.holidays;
        }

        // 同花顺 fuyao API key：优先读 localStorage，方便覆盖；否则用默认 key。
        // ⚠️ 默认 key 写在代码里有泄露风险，如被滥用可在 fuyao 后台轮换。
        const AICUBES_API_KEY_DEFAULT = 'sk-fuyao-8sA6812S-fonLtDnh0YzceQMA0PlB8ZX';


        export function getAicubesApiKey() {
            try {
                return localStorage.getItem('aicubes_api_key') || AICUBES_API_KEY_DEFAULT;
            } catch (e) {
                return AICUBES_API_KEY_DEFAULT;
            }
        }


        export function setAicubesApiKey(key) {
            try {
                localStorage.setItem('aicubes_api_key', key || '');
            } catch (e) {}
        }

        // 从 API 拿到的交易日集合（数组，yyyy-MM-dd 格式）

        // 从 API 拿到的交易日集合（数组，yyyy-MM-dd 格式）
        export function getTradingDays() {
            if (!window.allData) window.loadAllData();
            if (!window.allData.tradingDays) window.allData.tradingDays = [];
            return window.allData.tradingDays;
        }

        // 同步交易日历：从 fuyao 接口拉取近一年交易日，并自动把工作日非交易日识别为假期。

        // 同步交易日历：从 fuyao 接口拉取近一年交易日，并自动把工作日非交易日识别为假期。
        export async function syncTradingDaysFromAPI() {
            const apiKey = window.getAicubesApiKey();
            if (!apiKey) {
                window.showToast('请先设置 API Key：在控制台执行 window.setAicubesApiKey("你的key")');
                return { ok: false, error: 'missing_api_key' };
            }
            try {
                const resp = await fetch('https://fuyao.aicubes.cn/api/a-share/calendar/trading-days', {
                    method: 'GET',
                    headers: { 'X-api-key': apiKey }
                });
                const json = await resp.json();
                if (!json || json.code !== 0 || !Array.isArray(json.data && json.data.item)) {
                    window.showToast('同步交易日历失败：' + (json && json.message ? json.message : '未知错误'));
                    return { ok: false, error: json };
                }
                const dates = json.data.item.map(function(it) {
                    if (!it || !it.date) return '';
                    // 把 yyyyMMdd 转成 yyyy-MM-dd
                    const s = String(it.date);
                    return s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8);
                }).filter(Boolean);
                if (!window.allData) window.loadAllData();
                window.allData.tradingDays = dates;
                window.saveData();
                window.renderPickerCalendar();
                window.updateDateDisplay();
                window.showToast('✅ 已同步 ' + dates.length + ' 个交易日');
                return { ok: true, count: dates.length };
            } catch (e) {
                window.showToast('同步交易日历异常：' + (e && e.message ? e.message : '网络错误'));
                return { ok: false, error: e };
            }
        }

        // 判断 dateStr 是否落在 API 已覆盖的历史窗口内，且不是交易日（即自动假期）

        // 判断 dateStr 是否落在 API 已覆盖的历史窗口内，且不是交易日（即自动假期）
        export function isAutoHoliday(dateStr) {
            const tradingDays = window.getTradingDays();
            if (tradingDays.includes(dateStr)) return false;
            // 【修复】tradingDays 为空（交易日历未加载）时，不自动把工作日识别为假期。
            // 否则 isTradingDay 对所有工作日返回 false，getPreviousTradingDay 返回 null，
            // 趋势图只能画到当天一个点，历史4天全部断点。此时只靠周末判断更安全。
            if (tradingDays.length === 0) return false;
            const today = window._getLocalTodayStr ? window._getLocalTodayStr() : new Date().toISOString().slice(0, 10);
            const oneYearAgo = (function() {
                const d = new Date(today + 'T00:00:00');
                d.setFullYear(d.getFullYear() - 1);
                return d.toISOString().slice(0, 10);
            })();
            // 近一年窗口内、工作日、但不在 API 交易日列表里 -> 自动识别为假期
            return dateStr >= oneYearAgo && dateStr <= today;
        }

        // 判断是否为交易日

        // 判断是否为交易日
        export function isTradingDay(dateStr) {
            const date = new Date(dateStr + 'T00:00:00');
            const dayOfWeek = date.getDay();

            // 周六日肯定不是交易日
            if (dayOfWeek === 0 || dayOfWeek === 6) return false;

            // 手动标记的假期优先级最高
            const holidays = window.getHolidays();
            if (holidays.includes(dateStr)) return false;

            // 如果 API 交易日列表里明确包含，就是交易日
            const tradingDays = window.getTradingDays();
            if (tradingDays.includes(dateStr)) return true;

            // 在近一年 API 窗口内但不在交易日列表里的工作日 -> 自动识别为假期
            if (window.isAutoHoliday(dateStr)) return false;

            // 超出 API 窗口的未知未来日期，默认允许进入（不自动封禁）
            return true;
        }

        // 「最近交易日」= 自然日今天往前找（含今天），第一个满足 isTradingDay 的日期。
        // 今天是交易日 → 就是今天；今天是周末/节假日 → 往前找最近的那个交易日
        // （例如周六查询会返回周五）。用于"最近多板"这类只反映实时/最新一个交易日
        // 状态的接口：接口本身没有"查询任意历史日期"的能力，只有当页面停留的日期
        // 恰好等于这个"最近交易日"时，把接口返回值写入该日期才是正确的；写入任何
        // 更早的历史日期都是把"今天/最近一次的实时结果"张冠李戴地贴到了别的日子头上。

        // 「最近交易日」= 自然日今天往前找（含今天），第一个满足 isTradingDay 的日期。
        // 今天是交易日 → 就是今天；今天是周末/节假日 → 往前找最近的那个交易日
        // （例如周六查询会返回周五）。用于"最近多板"这类只反映实时/最新一个交易日
        // 状态的接口：接口本身没有"查询任意历史日期"的能力，只有当页面停留的日期
        // 恰好等于这个"最近交易日"时，把接口返回值写入该日期才是正确的；写入任何
        // 更早的历史日期都是把"今天/最近一次的实时结果"张冠李戴地贴到了别的日子头上。
        export function getMostRecentTradingDay() {
            const todayStr = window._getLocalTodayStr();
            if (window.isTradingDay(todayStr)) return todayStr;
            let d = new Date(todayStr + 'T00:00:00');
            for (let i = 0; i < 60; i++) {
                d.setDate(d.getDate() - 1);
                const year = d.getFullYear();
                const month = String(d.getMonth() + 1).padStart(2, '0');
                const day = String(d.getDate()).padStart(2, '0');
                const ds = `${year}-${month}-${day}`;
                if (window.isTradingDay(ds)) return ds;
            }
            return todayStr; // 兜底，理论不会走到
        }

        // 跳转到上一个交易日

        // 跳转到上一个交易日
        export function goToPrevTradingDay() {
            // 隐藏月统计看板
            const monthlyBoard = document.getElementById('monthlyStatsBoard');
            if (monthlyBoard) {
                monthlyBoard.classList.remove('active');
            }
            
            let date = new Date(window.currentDate + 'T00:00:00');
            let prevDate = new Date(date);
            
            // 往前找，直到找到交易日，最多查找60天防止死循环
            for (let i = 0; i < 60; i++) {
                prevDate.setDate(prevDate.getDate() - 1);
                
                const year = prevDate.getFullYear();
                const month = String(prevDate.getMonth() + 1).padStart(2, '0');
                const day = String(prevDate.getDate()).padStart(2, '0');
                const prevDateStr = `${year}-${month}-${day}`;
                
                // 检查是否早于2025年
                if (prevDateStr < '2025-01-01') {
                    window.showHint('最早2025年');
                    return;
                }
                
                // 找到交易日
                if (window.isTradingDay(prevDateStr)) {
                    window.setCurrentDate(prevDateStr);
                    window._persistCurrentDateAsLastEdited(prevDateStr);
                    window.allData = null;
                    window.showHint('上一交易日');
                    // 使用 requestAnimationFrame 延迟渲染，先显示提示
                    requestAnimationFrame(() => {
                        window.setFilter('all');
                        window.renderList();
                        window.autoCalculateRecentMultiScore();
                        window.renderAuctionPage4();
                    });
                    window.refreshJiwangForDateSwitch(prevDateStr);
                    return;
                }
            }
        }

        // 跳转到下一个交易日

        // 跳转到下一个交易日
        export function goToNextTradingDay() {
            // 隐藏月统计看板
            const monthlyBoard = document.getElementById('monthlyStatsBoard');
            if (monthlyBoard) {
                monthlyBoard.classList.remove('active');
            }
            
            let date = new Date(window.currentDate + 'T00:00:00');
            let nextDate = new Date(date);
            
            // 往后找，直到找到交易日，最多查找60天防止死循环
            for (let i = 0; i < 60; i++) {
                nextDate.setDate(nextDate.getDate() + 1);
                
                const year = nextDate.getFullYear();
                const month = String(nextDate.getMonth() + 1).padStart(2, '0');
                const day = String(nextDate.getDate()).padStart(2, '0');
                const nextDateStr = `${year}-${month}-${day}`;
                
                // 找到交易日
                if (window.isTradingDay(nextDateStr)) {
                    window.setCurrentDate(nextDateStr);
                    window._persistCurrentDateAsLastEdited(nextDateStr);
                    window.allData = null;
                    window.showHint('下一交易日');
                    // 使用 requestAnimationFrame 延迟渲染，先显示提示
                    requestAnimationFrame(() => {
                        window.setFilter('all');
                        window.renderList();
                        window.autoCalculateRecentMultiScore();
                        window.renderAuctionPage4();
                    });
                    window.refreshJiwangForDateSwitch(nextDateStr);
                    return;
                }
            }
            window.showHint('未找到交易日');
        }

        // 显示提示

        // 显示提示
        export function showHint(text) {
            const hint = document.getElementById('swipeHint');
            hint.textContent = text;
            hint.classList.add('show');
            setTimeout(() => hint.classList.remove('show'), 800);
        }

        // 打开添加模态框

        // 打开添加模态框
        export function openModal() {
            // 判断当前是否为周末统计模式 - 通过检查看板的激活状态
            const weekendBoard = document.getElementById('weekendStatsBoard');
            const monthlyBoard = document.getElementById('monthlyStatsBoard');
            
            if (weekendBoard.classList.contains('active')) {
                // 本周统计看板激活 - 打开本周总结心得
                window.openWeekendSummaryModal();
            } else if (monthlyBoard.classList.contains('active')) {
                // 本月统计看板激活 - 打开本月总结心得
                window.openMonthlySummaryModal();
            } else {
                // 交易日模式下，正常打开添加股票记录模态框
                window.editingId = null;
                window.topicAutoFilled = false;
                document.getElementById('modalTitle').textContent = '添加记录';
                document.getElementById('stockForm').reset();
                window.selectNextDay('');
                // 重置缩放量能自定义输入框显示状态
                const sfliangnengCustomInput = document.getElementById('stockSfliangnengCustom');
                if (sfliangnengCustomInput) sfliangnengCustomInput.style.display = 'none';
                // 重置调整幅度字段显示状态
                const adjustInput = document.getElementById('stockAdjust');
                const adjustSelect = document.getElementById('stockAdjustSelect');
                if (adjustInput) adjustInput.style.display = 'block';
                if (adjustSelect) adjustSelect.style.display = 'none';
                document.getElementById('stockModal').classList.add('active');
                
                // 清除重复警告
                const warningDiv = document.getElementById('duplicateWarning');
                if (warningDiv) {
                    warningDiv.style.display = 'none';
                }
                
                // 自动对焦到股票名称输入框
                setTimeout(() => {
                    document.getElementById('stockName').focus();
                }, 100);
                
                // 绑定竞价开盘输入联动事件
                window.bindStockOpenLinkage();
            }
        }

        // 关闭模态框

        // 关闭模态框
        export function closeModal() {
            document.getElementById('stockModal').classList.remove('active');
            window.editingId = null;
        }

        // 实时检查股票名称是否重复

        // 实时检查股票名称是否重复
        export function checkDuplicateStockName(name) {
            const warningDiv = document.getElementById('duplicateWarning');
            const suggestionsDiv = document.getElementById('stockNameSuggestions');
            const trimmedName = name.trim();
            
            // 显示股票名称建议
            if (trimmedName.length >= 1) {
                const allStockNames = window.getAllStockNames();
                const matches = allStockNames.filter(s => s.includes(trimmedName)).slice(0, 10);
                
                if (matches.length > 0) {
                    suggestionsDiv.innerHTML = matches.map(s => 
                        `<div onclick="window.selectStockSuggestion('${s}')">${s}</div>`
                    ).join('');
                    suggestionsDiv.style.display = 'block';
                } else {
                    suggestionsDiv.style.display = 'none';
                }
            } else {
                suggestionsDiv.style.display = 'none';
            }
            
            // 只在输入3个或4个汉字时检查重复
            if (trimmedName.length !== 3 && trimmedName.length !== 4) {
                warningDiv.style.display = 'none';
                return;
            }
            
            // 自动填充题材
            window.autoFillStockTopics(trimmedName);
            
            // 自动填充涨幅
            window.autoFillStockPercent(trimmedName);
            
            // 编辑模式下不检查（允许保持原名称）
            if (window.editingId) {
                const currentStock = window.getStocksData()[window.currentDate]?.find(s => s.id === window.editingId);
                if (currentStock && currentStock.name === trimmedName) {
                    warningDiv.style.display = 'none';
                    return;
                }
            }
            
            // 检查是否重复
            const existingStocks = window.getStocksData()[window.currentDate] || [];
            const duplicateStock = existingStocks.find(s => s.name === trimmedName);
            
            if (duplicateStock) {
                warningDiv.textContent = '股票名称 "' + trimmedName + '" 已存在，请勿重复添加！';
                warningDiv.style.display = 'block';
            } else {
                warningDiv.style.display = 'none';
            }
        }

        // 获取所有历史股票名称（去重）

        // 获取所有历史股票名称（去重）
        export function getAllStockNames() {
            const stocksData = window.getStocksData();
            const nameSet = new Set();
            
            Object.keys(stocksData).forEach(date => {
                const stocks = stocksData[date] || [];
                stocks.forEach(stock => {
                    if (stock.name) {
                        nameSet.add(stock.name.trim());
                    }
                });
            });
            
            return Array.from(nameSet).sort();
        }

        // 选择股票建议

        // 选择股票建议
        export function selectStockSuggestion(name) {
            document.getElementById('stockName').value = name;
            document.getElementById('stockNameSuggestions').style.display = 'none';
            
            // 触发填充逻辑
            window.checkDuplicateStockName(name);
        }

        // 点击其他地方隐藏建议
        document.addEventListener('click', function(e) {
            const suggestionsDiv = document.getElementById('stockNameSuggestions');
            const stockNameInput = document.getElementById('stockName');
            
            if (suggestionsDiv && stockNameInput) {
                if (!suggestionsDiv.contains(e.target) && e.target !== stockNameInput) {
                    suggestionsDiv.style.display = 'none';
                }
            }
        });

        // 自动填充股票题材

        // 自动填充股票题材
        export function autoFillStockTopics(stockName) {
            if (!stockName) return;
            
            // 如果已经自动填充过，不再填充
            if (window.topicAutoFilled) return;
            
            const xgcaitiInput = document.getElementById('stockXgcaiti');
            if (!xgcaitiInput) return;
            
            const allTopics = new Set();
            
            // 1. 先从该股票已有的记录中提取题材（股票卡片格式：无括号，支持+、逗号、顿号分隔）
            const stocksData = window.getStocksData();
            Object.keys(stocksData).forEach(date => {
                const dayStocks = stocksData[date] || [];
                const stockItem = dayStocks.find(s => s.name && s.name.trim() === stockName.trim());
                if (stockItem && stockItem.xgcaiti) {
                    // 支持 + 、,，、;； 分隔
                    const topics = stockItem.xgcaiti.split(/[+，,，、;；]/).map(t => t.trim()).filter(t => t);
                    topics.forEach(t => allTopics.add(t));
                }
            });
            
            // 2. 从当天竞价看板提取新题材（只用括号提取）
            const auctionList = window.getTodayAuction();
            const auctionStock = auctionList.find(s => s.stock && s.stock.trim() === stockName.trim());
            if (auctionStock && auctionStock.note) {
                const bracketMatches = auctionStock.note.match(/\([^)]+\)/g) || [];
                bracketMatches.forEach(match => {
                    const topics = match.replace(/[()]/g, '').split(/[+，,，、;；]/).map(t => t.trim()).filter(t => t);
                    topics.forEach(t => allTopics.add(t));
                });
            }
            
            // 如果找到题材，填充到输入框
            if (allTopics.size > 0) {
                xgcaitiInput.value = Array.from(allTopics).join('，');
                
                // 标记已自动填充
                window.topicAutoFilled = true;
            }
        }

        // 自动填充股票涨幅（从当天竞价看板的note字段提取）

        // 自动填充股票涨幅（从当天竞价看板的note字段提取）
        export function autoFillStockPercent(stockName) {
            if (!stockName) return;
            
            const percentInput = document.getElementById('stockClose');
            if (!percentInput) return;
            
            // 只在涨幅为空时填充
            if (percentInput.value && percentInput.value.trim() !== '') return;
            
            // 从当天竞价看板的note字段提取涨幅
            const auctionList = window.getTodayAuction();
            const auctionStock = auctionList.find(s => s.stock && s.stock.trim() === stockName.trim());
            
            if (auctionStock && auctionStock.note) {
                // 匹配括号前的涨幅数字，支持：-5.2%、5.2%、+5.2%
                const match = auctionStock.note.match(/^([+-]?\d+\.?\d*)%/);
                if (match) {
                    percentInput.value = match[1];
                }
            }
        }

        // 同步股票的收盘涨幅（当竞价看板note更新时）

        // 同步股票的收盘涨幅（当竞价看板note更新时）
        export function syncStockCloseFromAuction(stockName, note) {
            if (!stockName) return;
            let close = '';
            if (note) {
                const match = note.match(/^([+-]?\d+\.?\d*)%/);
                if (match) close = match[1];
            }
            const stocksData = window.getStocksData();
            if (!stocksData[window.currentDate]) return;
            const stock = stocksData[window.currentDate].find(s => s.name && s.name.trim() === stockName.trim());
            if (stock && close !== '') {
                stock.close = close;
                // 不在此处 saveData，由调用方统一保存，避免每条都写 localStorage
            }
        }

        // 同步更新股票列表中的题材（从早盘竞价看板）

        // 同步更新股票列表中的题材（从早盘竞价看板）
        export function syncStockTopicsFromAuction() {
            const auctionList = window.getTodayAuction();
            const stocksData = window.getStocksData();
            if (!stocksData[window.currentDate]) return;
            
            let hasUpdate = false;
            
            stocksData[window.currentDate].forEach(stock => {
                if (!stock.name) return;
                
                // 从早盘竞价看板查找同名股票
                const auctionItem = auctionList.find(item => 
                    item.stock && item.stock.trim() === stock.name.trim()
                );
                
                if (auctionItem) {
                    // 优先从 topics 字段读取，回退到 note 字段提取
                    let topics = [];
                    if (auctionItem.topics) {
                        topics = auctionItem.topics.split(/[+，,，、;；]/).map(t => t.trim()).filter(t => t);
                    }
                    if (topics.length === 0 && auctionItem.note) {
                        topics = window.extractTopics(auctionItem.note);
                    }
                    const newXgcaiti = topics.join('，');

                    // 如果有题材且与当前不同，则更新
                    if (newXgcaiti && newXgcaiti !== stock.xgcaiti) {
                        stock.xgcaiti = newXgcaiti;
                        hasUpdate = true;
                    }
                }
            });
            
            if (hasUpdate) {
                window.saveData();
            }
        }

        // 保存股票记录

        // 保存股票记录
        export function saveStock(e) {
            e.preventDefault();
            
            if (!window.getStocksData()[window.currentDate]) window.getStocksData()[window.currentDate] = [];
            
            const stockName = document.getElementById('stockName').value.trim();
            
            // 检查股票名称是否重复（仅添加新记录时检查）
            if (!window.editingId) {
                const existingStocks = window.getStocksData()[window.currentDate];
                const duplicateStock = existingStocks.find(s => s.name === stockName);
                if (duplicateStock) {
                    alert('股票名称 "' + stockName + '" 已存在，请勿重复添加！');
                    document.getElementById('stockName').focus();
                    return;
                }
            }
            
            let track = [];
            if (window.editingId) {
                const existingStock = window.getStocksData()[window.currentDate].find(s => s.id === window.editingId);
                if (existingStock && existingStock.track) {
                    track = JSON.parse(JSON.stringify(existingStock.track));
                }
            }
            
            let soldRecords = [];
            if (window.editingId) {
                const existingStock = window.getStocksData()[window.currentDate].find(s => s.id === window.editingId);
                if (existingStock && existingStock.soldRecords) {
                    soldRecords = JSON.parse(JSON.stringify(existingStock.soldRecords));
                }
            }
            
            const stock = {
                id: window.editingId || Date.now(),
                name: stockName,
                stage: document.getElementById('stockStage').value,
                adjust: window.getAdjustValue(),
                open: document.getElementById('stockOpen').value,
                close: document.getElementById('stockClose').value,
                turnover: document.getElementById('stockTurnover').value,
                kbiliangkai: document.getElementById('stockKbiliangkai').value,
                sfliangneng: window.getSfliangnengValue(),
                xgcaiti: document.getElementById('stockXgcaiti').value,
                nextDay: document.getElementById('stockNextDay').value,
                bomb: document.getElementById('stockBomb').checked,
                bought: document.getElementById('stockBought').checked,
                sold: document.getElementById('stockSold').checked,
                sellHigh: document.getElementById('stockSellHigh').checked,
                sell1120: document.getElementById('stockSell1120').checked,
                sell1450: document.getElementById('stockSell1450').checked,
                hold: document.getElementById('stockHold').checked,
                watch: document.getElementById('stockWatch').checked,
                dragon: document.getElementById('stockDragon').checked,
                pattern: document.getElementById('stockPattern').value,
                axis: document.getElementById('stockAxis').value,
                remark: document.getElementById('stockRemark').value,
                remarkType: document.getElementById('stockRemarkType').value,
                recentMulti: document.getElementById('stockRecentMulti').checked,
                topicDirection: document.getElementById('stockTopicDirection').checked,
                sectorEtf: document.getElementById('stockSectorEtf').checked,
                nishi: document.getElementById('stockNishi').checked,
                shunshi: document.getElementById('stockShunshi').checked,
                track: track,
                isSold: soldRecords.length > 0,
                soldRecords: soldRecords
            };
            
            if (window.editingId) {
                const stocks = window.getStocksData()[window.currentDate];
                const index = stocks.findIndex(s => s.id === window.editingId || s.id == window.editingId);
                if (index !== -1) {
                    stocks[index] = stock;
                } else {
                    stocks.push(stock);
                }
            } else {
                window.getStocksData()[window.currentDate].push(stock);
            }
            
            // 保存当前展开的股票ID（如果有的话）
            const expandedCard = document.querySelector('.stock-card.single-expanded');
            const expandedStockId = expandedCard ? expandedCard.id.replace('stock-card-', '') : null;
            
            window.saveData();
            window.closeModal(); // 先关闭模态框，让用户感觉更快
            
            // 使用 requestAnimationFrame 延迟渲染
            requestAnimationFrame(() => {
                window.autoTagShunshiNishi(true); // 实时更新顺势/逆势标签（跳过内部渲染）
                window.renderList(true); // 跳过其他看板渲染
                // renderAuction(); // 不需要重新渲染早盘竞价看板，颜色状态会在下次打开时更新
                
                // 恢复展开状态
                if (expandedStockId) {
                    setTimeout(() => {
                        const stockCard = document.getElementById('stock-card-' + expandedStockId);
                        if (stockCard) {
                            stockCard.classList.add('single-expanded');
                        }
                    }, 50);
                }
            });
        }

        // 编辑股票记录

        // 编辑股票记录
        export function editStock(id) {
            const stock = (window.getStocksData()[window.currentDate] || []).find(s => s.id === id);
            if (!stock) return;
            
            window.editingId = id;
            document.getElementById('modalTitle').textContent = '编辑记录';
            document.getElementById('stockName').value = stock.name;
            document.getElementById('stockStage').value = stock.stage;
            window.setAdjustValue(stock.adjust || '', stock.stage);
            document.getElementById('stockOpen').value = stock.open || '';
            document.getElementById('stockClose').value = stock.close || '';
            document.getElementById('stockTurnover').value = stock.turnover || '';
            document.getElementById('stockKbiliangkai').value = stock.kbiliangkai || '';
            window.setSfliangnengValue(stock.sfliangneng || '');
            document.getElementById('stockXgcaiti').value = stock.xgcaiti || '';
            window.selectNextDay(stock.nextDay || '');
            document.getElementById('stockBomb').checked = stock.bomb || false;
            document.getElementById('stockBought').checked = stock.bought || false;
            document.getElementById('stockSold').checked = stock.sold || false;
            document.getElementById('stockSellHigh').checked = stock.sellHigh || false;
            document.getElementById('stockSell1120').checked = stock.sell1120 || false;
            document.getElementById('stockSell1450').checked = stock.sell1450 || false;
            document.getElementById('stockHold').checked = stock.hold || false;
            document.getElementById('stockWatch').checked = stock.watch || false;
            document.getElementById('stockDragon').checked = stock.dragon || false;
            document.getElementById('stockPattern').value = stock.pattern || '';
            document.getElementById('stockAxis').value = stock.axis || '';
            document.getElementById('stockRemark').value = stock.remark || '';
            document.getElementById('stockRemarkType').value = stock.remarkType || '';
            document.getElementById('stockRecentMulti').checked = stock.recentMulti || false;
            document.getElementById('stockTopicDirection').checked = stock.topicDirection || false;
            document.getElementById('stockSectorEtf').checked = stock.sectorEtf || false;
            document.getElementById('stockNishi').checked = stock.nishi || false;
            document.getElementById('stockShunshi').checked = stock.shunshi || false;
            
            document.getElementById('stockModal').classList.add('active');
            
            // 清除重复警告
            const warningDiv = document.getElementById('duplicateWarning');
            if (warningDiv) {
                warningDiv.style.display = 'none';
            }
            
            // 自动聚焦到第一个为空的输入框
            setTimeout(() => {
                const focusFields = [
                    'stockName',
                    'stockXgcaiti',
                    'stockOpen',
                    'stockKbiliangkai',
                    'stockPattern',
                    'stockAxis',
                    'stockRemark',
                    'stockClose',
                    'stockTurnover',
                    'stockAdjust',
                    'stockSfliangnengSelect'
                ];
                for (const id of focusFields) {
                    const el = document.getElementById(id);
                    if (el && !el.value.trim()) {
                        el.focus();
                        return;
                    }
                }
            }, 100);
            
            // 绑定竞价开盘输入联动事件
            window.bindStockOpenLinkage();
        }

        // 绑定竞价开盘输入联动事件

        // 绑定竞价开盘输入联动事件
        export function bindStockOpenLinkage() {
            const openInput = document.getElementById('stockOpen');
            const axisInput = document.getElementById('stockAxis');
            const stageSelect = document.getElementById('stockStage');
            
            if (!openInput) return;
            
            // 移除之前绑定的事件（避免重复绑定）
            openInput.removeEventListener('input', window.handleStockOpenInput);
            
            // 绑定输入事件
            openInput.addEventListener('input', window.handleStockOpenInput);
        }
        
        // 处理得出结论选择变化

        // 处理得出结论选择变化
        export function onJielunChange() {
            const jielunSelect = document.getElementById('jwEditJielun');
            const chushouSelect = document.getElementById('jwEditChushou');
            
            if (!jielunSelect || !chushouSelect) return;
            
            const jielunValue = jielunSelect.value;
            const options = chushouSelect.querySelectorAll('option[data-type]');
            
            // 根据得出结论的值显示/隐藏出手情况选项
            options.forEach(option => {
                const type = option.getAttribute('data-type');
                if (jielunValue === '') {
                    // 得出结论为空，显示所有选项
                    option.style.display = 'block';
                } else if (jielunValue === '出手') {
                    // 选中"出手"，只显示"chushou"类型选项
                    option.style.display = type === 'chushou' ? 'block' : 'none';
                } else if (jielunValue === '空仓') {
                    // 选中"空仓"，只显示"kongcang"类型选项
                    option.style.display = type === 'kongcang' ? 'block' : 'none';
                }
            });
        }

        // 处理观察字段选择变化

        // 处理观察字段选择变化
        export function onGuanchaChange() {
            const guanchaSelect = document.getElementById('jwEditGuancha');
            const guochengSelect = document.getElementById('jwEditGuochengJieguo');
            
            if (!guanchaSelect || !guochengSelect) return;
            
            const guanchaValue = guanchaSelect.value;
            const options = guochengSelect.querySelectorAll('option[data-type]');
            
            // 根据观察字段的值显示/隐藏过程结果选项
            options.forEach(option => {
                const type = option.getAttribute('data-type');
                if (guanchaValue === '') {
                    // 观察字段为空，显示所有选项
                    option.style.display = 'block';
                } else if (guanchaValue === '最近多板结果') {
                    // 选中"最近多板结果"，只显示"结果"类型选项
                    option.style.display = type === 'result' ? 'block' : 'none';
                } else {
                    // 选中其他选项（包含"过程"），只显示"过程"类型选项
                    option.style.display = type === 'process' ? 'block' : 'none';
                }
            });
        }

        // 处理阶段选择变化

        // 处理阶段选择变化
        export function onStageChange() {
            const stageSelect = document.getElementById('stockStage');
            const adjustInput = document.getElementById('stockAdjust');
            const adjustSelect = document.getElementById('stockAdjustSelect');
            
            if (!stageSelect || !adjustInput || !adjustSelect) return;
            
            if (stageSelect.value === '连板') {
                // 选择连板时，显示选择框，隐藏输入框，清空输入框
                adjustInput.style.display = 'none';
                adjustSelect.style.display = 'block';
                adjustInput.value = '';
            } else {
                // 选择其他阶段时，显示输入框，隐藏选择框，清空选择框
                adjustInput.style.display = 'block';
                adjustSelect.style.display = 'none';
                adjustSelect.value = '';
            }
        }

        // 获取调整幅度的值

        // 获取调整幅度的值
        export function getAdjustValue() {
            const stageSelect = document.getElementById('stockStage');
            const adjustInput = document.getElementById('stockAdjust');
            const adjustSelect = document.getElementById('stockAdjustSelect');
            
            if (!stageSelect) return '';
            
            if (stageSelect.value === '连板') {
                return adjustSelect ? adjustSelect.value : '';
            } else {
                return adjustInput ? adjustInput.value : '';
            }
        }

        // 设置调整幅度的值

        // 设置调整幅度的值
        export function setAdjustValue(value, stage) {
            const adjustInput = document.getElementById('stockAdjust');
            const adjustSelect = document.getElementById('stockAdjustSelect');
            
            if (!adjustInput || !adjustSelect) return;
            
            const validOptions = ['', '二板成功', '二板失败', '三板成功', '三板失败', '四板成功', '四板失败', '五板成功', '五板失败'];
            
            if (stage === '连板') {
                // 阶段是连板，显示选择框
                adjustInput.style.display = 'none';
                adjustSelect.style.display = 'block';
                
                if (validOptions.includes(value)) {
                    // 值在选项中，直接选择
                    adjustSelect.value = value;
                    adjustInput.value = '';
                } else if (value) {
                    // 值不在选项中（历史数据），选择"其它"并填充输入框
                    adjustSelect.value = '';
                    adjustInput.style.display = 'block';
                    adjustSelect.style.display = 'none';
                    adjustInput.value = value;
                } else {
                    // 值为空
                    adjustSelect.value = '';
                    adjustInput.value = '';
                }
            } else {
                // 阶段不是连板，显示输入框
                adjustInput.style.display = 'block';
                adjustSelect.style.display = 'none';
                adjustInput.value = value;
                adjustSelect.value = '';
            }
        }

        // 处理缩放量能选择变化

        // 处理缩放量能选择变化
        export function onSfliangnengChange() {
            const select = document.getElementById('stockSfliangnengSelect');
            const customInput = document.getElementById('stockSfliangnengCustom');
            
            if (!select || !customInput) return;
            
            if (select.value === '其它') {
                customInput.style.display = 'block';
            } else {
                customInput.style.display = 'none';
                customInput.value = '';
            }
        }

        // 获取缩放量能的值

        // 获取缩放量能的值
        export function getSfliangnengValue() {
            const select = document.getElementById('stockSfliangnengSelect');
            const customInput = document.getElementById('stockSfliangnengCustom');
            
            if (!select) return '';
            
            if (select.value === '其它') {
                return customInput ? customInput.value.trim() : '';
            } else {
                return select.value;
            }
        }

        // 设置缩放量能的值

        // 设置缩放量能的值
        export function setSfliangnengValue(value) {
            const select = document.getElementById('stockSfliangnengSelect');
            const customInput = document.getElementById('stockSfliangnengCustom');
            
            if (!select) return;
            
            const validOptions = ['', '微放量', '温和放量', '放倍量', '放巨量', '平量', '缩量', '微缩量', '缩倍量', '其它'];
            
            if (validOptions.includes(value)) {
                // 值在选项中，直接选择
                select.value = value;
                if (customInput) {
                    customInput.style.display = 'none';
                    customInput.value = '';
                }
            } else if (value) {
                // 值不在选项中，选择"其它"并填充自定义输入框
                select.value = '其它';
                if (customInput) {
                    customInput.style.display = 'block';
                    customInput.value = value;
                }
            } else {
                // 值为空
                select.value = '';
                if (customInput) {
                    customInput.style.display = 'none';
                    customInput.value = '';
                }
            }
        }

        // 处理竞价开盘输入

        // 处理竞价开盘输入
        export function handleStockOpenInput() {
            const openInput = document.getElementById('stockOpen');
            const axisInput = document.getElementById('stockAxis');
            const stageSelect = document.getElementById('stockStage');
            
            if (!openInput || !axisInput || !stageSelect) return;
            
            const value = parseFloat(openInput.value);
            
            // 如果输入为空或不是数字，不处理
            if (isNaN(value) || openInput.value.trim() === '') {
                return;
            }
            
            // 正数：零轴位置=零轴上，阶段=二波
            if (value > 0) {
                axisInput.value = '零轴上';
                stageSelect.value = '二波';
            }
            // 0：零轴位置=刚好零轴，阶段=空
            else if (value === 0) {
                axisInput.value = '刚好零轴';
                stageSelect.value = '';
            }
            // 负数：零轴位置=零轴下，阶段=高位
            else if (value < 0) {
                axisInput.value = '零轴下';
                stageSelect.value = '高位';
            }
        }

        // 删除股票记录

        // 删除股票记录
        export function deleteStock(id) {
            if (!confirm('确定要删除这条记录吗？')) return;
            
            if (!window.getStocksData()[window.currentDate]) return;
            
            // 获取被删除的股票名称，用于清除早盘竞价看板中的固定状态
            const stockToDelete = window.getStocksData()[window.currentDate].find(s => s.id === id);
            const stockName = stockToDelete ? stockToDelete.name : null;
            
            window.getStocksData()[window.currentDate] = window.getStocksData()[window.currentDate].filter(s => s.id !== id);
            if (window.getStocksData()[window.currentDate].length === 0) delete window.getStocksData()[window.currentDate];
            
            // 清除早盘竞价看板中对应股票的固定状态
            if (stockName) {
                window.clearAuctionFixedState(stockName);
            }
            
            window.saveData();
            window.renderList();
        }

        // 切换卖出记录区域的显示
        // 打开卖出记录编辑模态框
        let editingSoldStockId = null;
        

        export function openSoldEdit(stockId) {
            editingSoldStockId = stockId;
            const stocks = window.getStocksData()[window.currentDate] || [];
            const stock = stocks.find(s => s.id === stockId || s.id == stockId);
            if (!stock) return;
            
            document.getElementById('soldEditTitle').textContent = '💰 ' + (stock.name || '股票') + ' - 卖出记录';
            document.getElementById('soldEditTableBody').innerHTML = '';
            
            // 加载记录，如果没有记录则添加一条空行
            if (stock.soldRecords && stock.soldRecords.length > 0) {
                stock.soldRecords.forEach(record => {
                    window.addSoldEditRow(record);
                });
            } else {
                window.addSoldEditRow(null);
            }
            
            document.getElementById('soldEditModal').classList.add('active');
        }

        // 关闭卖出记录编辑模态框

        // 关闭卖出记录编辑模态框
        export function closeSoldEditModal() {
            document.getElementById('soldEditModal').classList.remove('active');
            editingSoldStockId = null;
        }

        // 添加卖出记录编辑行

        // 添加卖出记录编辑行
        export function addSoldEditRow(record) {
            const container = document.getElementById('soldEditTableBody');
            const isToday = record ? record.date.startsWith(window.currentDate) : true;
            const now = new Date();
            const dateStr = record ? record.date : (window.currentDate + ' ' + String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0'));
            
            // 检查是否是第一条记录（新添加的行且容器中没有其他行）
            const isFirstRecord = !record && container.children.length === 0;
            
            const div = document.createElement('div');
            div.className = 'track-edit-row sold-edit-row';
            div.innerHTML = `
                <div class="track-edit-date">
                    <input type="text" class="track-date-input sold-date-input" value="${dateStr}" ${!isToday ? 'readonly' : ''}>
                </div>
                <div class="track-edit-window.content">
                    <input type="text" class="track-window.content-input sold-profit-input" placeholder="盈利 如：+1260" value="${record ? (record.profit || '') : ''}" ${!isToday ? 'readonly' : ''}>
                </div>
                <div class="track-edit-window.content">
                    <input type="text" class="track-window.content-input sold-percent-input" placeholder="涨幅 如：+4.5%" value="${record ? (record.percent || '') : ''}" ${!isToday ? 'readonly' : ''}>
                </div>
                <div class="track-edit-window.content">
                    <select class="track-window.content-input sold-type-input" ${!isToday ? 'disabled' : ''}>
                        ${isFirstRecord ? `
                        <option value="" ${record && !record.type ? 'selected' : ''}>请选择</option>
                        <option value="全清仓" ${record && record.type === '全清仓' ? 'selected' : ''}>全清仓</option>
                        <option value="部分卖" ${record && record.type === '部分卖' ? 'selected' : ''}>部分卖</option>
                        ` : `
                        <option value="全清仓" ${record && record.type === '全清仓' ? 'selected' : ''}>全清仓</option>
                        <option value="部分卖" ${record && record.type === '部分卖' ? 'selected' : ''}>部分卖</option>
                        <option value="" ${record && !record.type ? 'selected' : ''}>请选择</option>
                        `}
                    </select>
                </div>
                ${isToday ? `
                <div class="track-edit-delete">
                    <button type="button" class="remove-track-btn" onclick="this.parentElement.parentElement.remove()">×</button>
                </div>
                ` : ''}
            `;
            container.appendChild(div);
        }

        // 保存卖出记录编辑

        // 保存卖出记录编辑
        export function saveSoldEdit() {
            if (!editingSoldStockId) return;
            
            const rows = document.querySelectorAll('#soldEditTableBody .sold-edit-row');
            const records = [];
            
            rows.forEach(row => {
                const date = row.querySelector('.sold-date-input').value.trim();
                if (date) {
                    records.push({
                        id: Date.now().toString() + Math.random().toString(36).substr(2, 5),
                        date: date,
                        profit: row.querySelector('.sold-profit-input').value.trim(),
                        percent: row.querySelector('.sold-percent-input').value.trim(),
                        type: row.querySelector('.sold-type-input').value
                    });
                }
            });
            
            // 检查是否有全清仓记录
            const hasFullClearRecords = records.some(record => record.type === '全清仓');
            // 检查是否有有效的卖出记录（全清仓或部分卖）
            const hasValidSoldRecords = records.some(record => record.type === '全清仓' || record.type === '部分卖');
            
            // 更新股票数据
            const stocks = window.getStocksData()[window.currentDate];
            const stockIndex = stocks.findIndex(s => s.id === editingSoldStockId || s.id == editingSoldStockId);
            if (stockIndex !== -1) {
                // 检查是否是第一条卖出记录（之前没有卖出记录）
                const isFirstSoldRecord = !stocks[stockIndex].soldRecords || stocks[stockIndex].soldRecords.length === 0;
                
                stocks[stockIndex].soldRecords = records;
                stocks[stockIndex].isSold = records.length > 0;
                
                // 如果是第一条卖出记录，且股票没有"已买入"标签，则自动勾选"已买入"
                if (isFirstSoldRecord && !stocks[stockIndex].bought) {
                    stocks[stockIndex].bought = true;
                    // 用户手动确认买入 → 清除继承标记，使该记录可被 deriveAuctionTagState 当作
                    // 真实确认的源头继续向次日传递（而非被 inheritedHold 阻断）
                    stocks[stockIndex].inheritedHold = undefined;
                }
                
                // 如果不是第一条卖出记录，且有有效的卖出记录（全清仓或部分卖），则去掉"已买入"标签，只保留"已卖出"标签
                if (!isFirstSoldRecord && hasValidSoldRecords) {
                    stocks[stockIndex].bought = false;
                    stocks[stockIndex].sold = true;
                }
                
                // 如果有全清仓记录，且股票有"持有"或"已买入"标签，则自动变为"已卖出"
                if (hasFullClearRecords) {
                    if (stocks[stockIndex].hold || stocks[stockIndex].bought) {
                        stocks[stockIndex].hold = false;
                        stocks[stockIndex].bought = false;
                        stocks[stockIndex].sold = true;
                    }
                } else if (hasValidSoldRecords) {
                    // 如果有有效的卖出记录（部分卖）且未勾选已卖出，自动勾选
                    if (!stocks[stockIndex].sold) {
                        stocks[stockIndex].sold = true;
                    }
                }
                
                // 保存当前展开的股票ID
                const expandedCard = document.querySelector('.stock-card.single-expanded');
                const expandedStockId = expandedCard ? expandedCard.id.replace('stock-card-', '') : null;
                
                // 同步更新后续日期的同名股票的卖出记录
                const stockName = stocks[stockIndex].name;
                const allDates = Object.keys(window.getStocksData()).sort();
                const currentDateIndex = allDates.indexOf(window.currentDate);
                
                if (currentDateIndex !== -1) {
                    for (let i = currentDateIndex + 1; i < allDates.length; i++) {
                        const futureDate = allDates[i];
                        const futureStocks = window.getStocksData()[futureDate];
                        const futureStockIndex = futureStocks.findIndex(s => s.name === stockName);
                        
                        if (futureStockIndex !== -1) {
                            futureStocks[futureStockIndex].soldRecords = JSON.parse(JSON.stringify(records));
                            futureStocks[futureStockIndex].isSold = records.length > 0;
                            
                            if (hasFullClearRecords) {
                                futureStocks[futureStockIndex].hold = false;
                                futureStocks[futureStockIndex].bought = false;
                                futureStocks[futureStockIndex].sold = true;
                            } else if (hasValidSoldRecords) {
                                futureStocks[futureStockIndex].sold = true;
                            }
                        }
                    }
                }
                
            window.saveData();
            // 立即推送云端，避免防抖延迟内刷新导致数据恢复
            if (window.remainingBoards && window.remainingBoards.pushNow) window.remainingBoards.pushNow();
            window.renderList();
                
                // 恢复展开状态
                if (expandedStockId) {
                    setTimeout(() => {
                        const stockCard = document.getElementById('stock-card-' + expandedStockId);
                        if (stockCard) {
                            stockCard.classList.add('single-expanded');
                        }
                    }, 50);
                }
            }
            
            window.closeSoldEditModal();
            window.showToast('已保存');
        }

        // 显示Toast提示

        // 显示Toast提示
        export function showToast(message) {
            const toast = document.createElement('div');
            toast.className = 'toast';
            toast.textContent = message;
            document.body.appendChild(toast);
            
            setTimeout(() => {
                toast.style.opacity = '0';
                toast.style.transition = 'opacity 0.3s';
                setTimeout(() => toast.remove(), 300);
            }, 2000);
        }

        // 显示黄色警示Toast（屏幕正中间），与通用showToast独立，专用于"竞/昨零命中"等警示场景
        // durationMs 可选，默认 2000（保持原有场景不变）；需要用户看清/截图技术性错误信息时可传更长的值

        // 显示黄色警示Toast（屏幕正中间），与通用showToast独立，专用于"竞/昨零命中"等警示场景
        // durationMs 可选，默认 2000（保持原有场景不变）；需要用户看清/截图技术性错误信息时可传更长的值
        export function showWarningToast(message, durationMs) {
            const toast = document.createElement('div');
            toast.className = 'toast-warning';
            toast.textContent = message;
            document.body.appendChild(toast);

            setTimeout(() => {
                toast.style.opacity = '0';
                toast.style.transition = 'opacity 0.3s';
                setTimeout(() => toast.remove(), 300);
            }, durationMs || 2000);
        }

        // "竞/昨零命中"警示Toast的防抖标记：第一页renderAuction()和第二页renderAuctionPage2()
        // 可能在同一次操作中先后渲染，用短时间窗口去重，确保只弹一次
        let _lastJingYestEmptyToastTime = 0;

        export function maybeShowJingYestEmptyToast() {
            const now = Date.now();
            if (now - _lastJingYestEmptyToastTime < 300) return;
            _lastJingYestEmptyToastTime = now;
            window.showWarningToast('全部没有，谨慎出手');
        }

        // 导出数据

        // 导出数据
        export function exportData() {
            window.loadAllData();
            
            // 收集所有 weekly/weekend/monthly summary
            const summaries = {};
            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                if (key && (key.startsWith('weekly_summary_') || key.startsWith('weekend_summary_') || key.startsWith('monthly_summary_'))) {
                    summaries[key] = localStorage.getItem(key);
                }
            }
            
            // 收集所有 hasFumianTopic_日期
            const hasFumianTopics = {};
            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                if (key && key.startsWith('hasFumianTopic_')) {
                    hasFumianTopics[key] = localStorage.getItem(key);
                }
            }
            
            // 收集评分设置
            const scoreSettings = {};
            ['recentMulti', 'sectorEtf', 'topicDirection'].forEach(type => {
                const val = localStorage.getItem('scoreSettings_' + type);
                if (val) scoreSettings[type] = JSON.parse(val);
            });
            
            const exportObj = {
                stocks: window.getStocksData(),
                jiwang: window.getJiwangData(),
                rank: window.getRankData(),
                multi: window.getMultiData(),
                hotspot: window.getHotspotData(),
                pattern: window.getPatternData(),
                bidding: window.getBiddingData(),
                auction: window.getAuctionData(),
                auctionWatchlist: window._serializeAuctionWatchlistIndex(),
                tagTitles: window.getTagTitlesData(),
                duibanData: JSON.parse(localStorage.getItem('duibanData') || '{}'),
                duibanComment: JSON.parse(localStorage.getItem('duibanComment') || '{}'),
                stockEtfData: JSON.parse(localStorage.getItem('stockEtfData') || '{}'),
                stockEtfComment: JSON.parse(localStorage.getItem('stockEtfComment') || '{}'),
                coreTopics: JSON.parse(localStorage.getItem('coreTopics') || '[]'),
                biddingDefaultTemplate: JSON.parse(localStorage.getItem('biddingDefaultTemplate_v41') || '[]'),
                holidays: window.allData.holidays || [],
                tradingDays: window.allData.tradingDays || [],
                scoreSettings: scoreSettings,
                hasFumianTopics: hasFumianTopics,
                summaries: summaries,
                copiedStocksData: JSON.parse(localStorage.getItem('copiedStocksData') || '{}'),
                exportDate: window.currentDate,
                version: '4.2'
            };
            
            const dataStr = JSON.stringify(exportObj);
            window.showExportModal(dataStr);
        }

        // 内存中存储导出数据，避免塞入textarea导致卡顿
        let _exportDataStr = '';

        // 显示导出模态框

        // 显示导出模态框
        export function showExportModal(text) {
            _exportDataStr = text;
            // textarea 只显示提示，不渲染完整数据（数据量大时渲染很卡）
            const textarea = document.getElementById('exportTextArea');
            textarea.value = '数据已就绪（约 ' + (text.length / 1024).toFixed(0) + ' KB），点击下方按钮一键复制或导出文件。';
            document.getElementById('exportModal').classList.add('active');
        }

        // 关闭导出模态框

        // 关闭导出模态框
        export function closeExportModal() {
            document.getElementById('exportModal').classList.remove('active');
            document.getElementById('exportFileLink').style.display = 'none';
            _exportDataStr = '';
        }

        // 复制导出文本

        // 复制导出文本
        export function copyExportText() {
            if (!_exportDataStr) {
                window.showToast('❌ 数据未就绪，请重新打开导出');
                return;
            }
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(_exportDataStr).then(() => {
                    window.showToast('✅ 已复制到剪贴板！请粘贴到备忘录保存');
                    setTimeout(window.closeExportModal, 1000);
                }).catch(() => {
                    window._fallbackCopy();
                });
            } else {
                window._fallbackCopy();
            }
        }
        

        export function _fallbackCopy() {
            const textarea = document.getElementById('exportTextArea');
            const prev = textarea.value;
            textarea.value = _exportDataStr;
            textarea.select();
            textarea.setSelectionRange(0, _exportDataStr.length);
            try {
                document.execCommand('copy');
                window.showToast('✅ 已复制到剪贴板！请粘贴到备忘录保存');
                setTimeout(window.closeExportModal, 1000);
            } catch (err) {
                window.showToast('❌ 复制失败，请手动全选复制');
            }
            textarea.value = prev;
        }

        // 导出备份文件
        let lastExportUrl = null;
        

        export function exportToFile() {
            // 确保数据已加载
            window.loadAllData();
            
            // 收集所有 weekly/weekend/monthly summary
            const summaries = {};
            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                if (key && (key.startsWith('weekly_summary_') || key.startsWith('weekend_summary_') || key.startsWith('monthly_summary_'))) {
                    summaries[key] = localStorage.getItem(key);
                }
            }
            
            // 收集所有 hasFumianTopic_日期
            const hasFumianTopics = {};
            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                if (key && key.startsWith('hasFumianTopic_')) {
                    hasFumianTopics[key] = localStorage.getItem(key);
                }
            }
            
            // 收集评分设置
            const scoreSettings = {};
            ['recentMulti', 'sectorEtf', 'topicDirection'].forEach(type => {
                const val = localStorage.getItem('scoreSettings_' + type);
                if (val) scoreSettings[type] = JSON.parse(val);
            });
            
            const exportDataObj = {
                stocks: window.allData.stocks || {},
                jiwang: window.allData.jiwang || {},
                rank: window.allData.rank || {},
                multi: window.allData.multi || {},
                hotspot: window.allData.hotspot || {},
                pattern: window.allData.pattern || {},
                bidding: window.allData.bidding || {},
                auction: window.allData.auction || {},
                auctionWatchlist: window._serializeAuctionWatchlistIndex(),
                tagTitles: window.allData.tagTitles || {},
                duibanData: JSON.parse(localStorage.getItem('duibanData') || '{}'),
                duibanComment: JSON.parse(localStorage.getItem('duibanComment') || '{}'),
                stockEtfData: JSON.parse(localStorage.getItem('stockEtfData') || '{}'),
                stockEtfComment: JSON.parse(localStorage.getItem('stockEtfComment') || '{}'),
                coreTopics: JSON.parse(localStorage.getItem('coreTopics') || '[]'),
                biddingDefaultTemplate: JSON.parse(localStorage.getItem('biddingDefaultTemplate_v41') || '[]'),
                holidays: window.allData.holidays || [],
                tradingDays: window.allData.tradingDays || [],
                scoreSettings: scoreSettings,
                hasFumianTopics: hasFumianTopics,
                summaries: summaries,
                copiedStocksData: JSON.parse(localStorage.getItem('copiedStocksData') || '{}')
            };
            
            const jsonStr = JSON.stringify(exportDataObj);
            const blob = new Blob([jsonStr], { type: 'application/json' });
            
            if (lastExportUrl) {
                URL.revokeObjectURL(lastExportUrl);
            }
            
            const url = URL.createObjectURL(blob);
            lastExportUrl = url;
            
            const now = new Date();
            const dateStr = now.getFullYear() + 
                String(now.getMonth() + 1).padStart(2, '0') + 
                String(now.getDate()).padStart(2, '0') + '_' +
                String(now.getHours()).padStart(2, '0') + 
                String(now.getMinutes()).padStart(2, '0');
            const filename = '股票助手备份_' + dateStr + '.json';
            
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            
            // 显示下载链接
            const downloadLink = document.getElementById('downloadLink');
            const exportFileLink = document.getElementById('exportFileLink');
            downloadLink.href = url;
            downloadLink.textContent = '📂 已下载: ' + filename + ' (点击查看)';
            exportFileLink.style.display = 'block';
            
            window.showToast('✅ 备份文件已下载！');
        }

        // 显示导入模态框

        // 显示导入模态框
        export function showImportModal() {
            document.getElementById('importTextArea').value = '';
            document.getElementById('importTextModal').classList.add('active');
        }

        // 关闭导入模态框

        // 关闭导入模态框
        export function closeImportTextModal() {
            document.getElementById('importTextModal').classList.remove('active');
        }

        // 处理文件导入

        // 处理文件导入
        export function handleFileImport(event) {
            const file = event.target.files[0];
            if (!file) return;
            
            const reader = new FileReader();
            reader.onload = function(e) {
                let text = e.target.result;
                if (text.charCodeAt(0) === 0xFEFF) {
                    text = text.slice(1);
                }
                try {
                    const imported = JSON.parse(text);
                    if (confirm('导入将覆盖现有数据，是否继续？')) {
                        // 备份早盘竞价数据（用于撤回）
                        window.backupAuctionData('import');
                        
                        // bidding（竞价变化）已改为纯云端表 + 内存缓存，是独立于本次
                        // 导入的数据源。整体导入覆盖的是 stocks/jiwang/... 等其它模块，
                        // 不应该连带影响 bidding 云端数据——哪怕导入的备份文件里带有
                        // bidding 字段，也不再读取/覆盖，避免旧/损坏的备份把云端数据冲掉。
                        // allData.bidding 继续指向持久内存缓存 _biddingMemCache。
                        if (!window._biddingMemCache) window._biddingMemCache = {};
                        // jiwang 同理，已改为纯云端表 + 内存缓存。导入文件里的 jiwang 数据
                        // 合并进 _jiwangMemCache（而不是替换整个对象引用），并在下面把
                        // 涉及的日期标脏，交给 saveData()/scheduleJiwangPush() 推送到云端表。
                        if (!window._jiwangMemCache) window._jiwangMemCache = {};
                        if (imported.jiwang && typeof imported.jiwang === 'object') {
                            Object.assign(window._jiwangMemCache, imported.jiwang);
                        }
                        // 阶段四 Bug 3 修复：auction 不能用新对象替换，否则会切断 allData.auction 与 _auctionMemCache 的引用关系，
                        // 重新制造"两份状态不同步"。改为清空 _auctionMemCache 后把导入数据逐日期灌进去，保持引用不变。
                        window.clearAllAuctionDates('window.handleFileImport');
                        const importedAuctionData = imported.auction || {};
                        // 方案2：优先用备份文件携带的 auctionWatchlist 索引重建正式成员名单。
                        // 行对象不携带 in_watchlist 字段，索引是正式/影子身份的唯一权威来源。
                        // 旧备份无此字段时，回退到 _extractWatchlistNamesFromRows（兼容旧数据可能携带的 in_watchlist 字段）。
                        const importedWatchlistIdx = imported.auctionWatchlist || {};
                        Object.keys(importedAuctionData).forEach(function(d) {
                            const rows = importedAuctionData[d] || [];
                            const idxForDate = importedWatchlistIdx[d];
                            if (Array.isArray(idxForDate) && idxForDate.length > 0) {
                                window._setAuctionWatchlistForDate(d, idxForDate);
                            } else {
                                window._setAuctionWatchlistForDate(d, window._extractWatchlistNamesFromRows(rows));
                            }
                            window.setAuctionDateData(d, rows, 'window.handleFileImport');
                        });
                        // 阶段八：stocks / rank / multi / hotspot / pattern / tagTitles
                        // 导入数据写入独立内存缓存，避免 allData 与缓存断开引用
                        Object.assign(_stocksMemCache, imported.stocks || {});
                        Object.assign(_rankMemCache, imported.rank || {});
                        Object.assign(_multiMemCache, imported.multi || {});
                        Object.assign(_hotspotMemCache, imported.hotspot || {});
                        Object.assign(_patternMemCache, imported.pattern || {});
                        Object.assign(_tagTitlesMemCache, imported.tagTitles || {});

                        window.allData = {
                            stocks: _stocksMemCache,
                            jiwang: window._jiwangMemCache,
                            rank: _rankMemCache,
                            multi: _multiMemCache,
                            hotspot: _hotspotMemCache,
                            pattern: _patternMemCache,
                            bidding: window._biddingMemCache,
                            auction: window._auctionMemCache,
                            tagTitles: _tagTitlesMemCache
                        };

                        // 标记所有涉及日期为脏，确保推送到 Supabase
                        if (imported.stocks) Object.keys(imported.stocks).forEach(d => remainingBoards.markDirty('stocks', d));
                        if (imported.rank) Object.keys(imported.rank).forEach(d => remainingBoards.markDirty('rank', d));
                        if (imported.multi) Object.keys(imported.multi).forEach(d => remainingBoards.markDirty('multi', d));
                        if (imported.hotspot) Object.keys(imported.hotspot).forEach(d => remainingBoards.markDirty('hotspot', d));
                        if (imported.pattern) Object.keys(imported.pattern).forEach(d => remainingBoards.markDirty('pattern', d));
                        if (imported.tagTitles) Object.keys(imported.tagTitles).forEach(d => remainingBoards.markDirty('tagTitles', d));

                        // 这是一次"整体导入覆盖"，用户已经在上面的 confirm 中明确同意
                        // "导入将覆盖现有数据"。此时导入文件里的 auction 才是权威数据，
                        // 必须把涉及的每个日期都标记为脏，否则 pushToCloud() 里
                        // "以云端为基准"的保护逻辑会反过来用云端（可能是脏数据）
                        // 把刚导入的干净数据覆盖掉，导致"导入了但多余股票还在"。
                        Object.keys(window._auctionMemCache).forEach(function(d) { window.markAuctionDirty(d); });
                        // jiwang 同理：导入的日期都标脏，确保 saveData() 会把它们推送到 jiwang_data 表
                        if (imported.jiwang) {
                            Object.keys(imported.jiwang).forEach(function(d) { window.markJiwangDirty(d); });
                        }
                        
                        if (imported.duibanData) {
                            localStorage.setItem('duibanData', JSON.stringify(imported.duibanData));
                        }
                        if (imported.duibanComment) {
                            localStorage.setItem('duibanComment', JSON.stringify(imported.duibanComment));
                        }
                        if (imported.stockEtfData) {
                            localStorage.setItem('stockEtfData', JSON.stringify(imported.stockEtfData));
                        }
                        if (imported.stockEtfComment) {
                            localStorage.setItem('stockEtfComment', JSON.stringify(imported.stockEtfComment));
                        }
                        if (imported.coreTopics) {
                            localStorage.setItem('coreTopics', JSON.stringify(imported.coreTopics));
                        }
                        if (imported.biddingDefaultTemplate) {
                            localStorage.setItem('biddingDefaultTemplate_v41', JSON.stringify(imported.biddingDefaultTemplate));
                        }
                        if (imported.holidays) {
                            window.allData.holidays = imported.holidays;
                        }
                        if (imported.tradingDays) {
                            window.allData.tradingDays = imported.tradingDays;
                        }
                        if (imported.scoreSettings) {
                            ['recentMulti', 'sectorEtf', 'topicDirection'].forEach(type => {
                                if (imported.scoreSettings[type]) {
                                    localStorage.setItem('scoreSettings_' + type, JSON.stringify(imported.scoreSettings[type]));
                                }
                            });
                        }
                        if (imported.hasFumianTopics) {
                            Object.keys(imported.hasFumianTopics).forEach(key => {
                                localStorage.setItem(key, imported.hasFumianTopics[key]);
                            });
                        }
                        if (imported.summaries) {
                            Object.keys(imported.summaries).forEach(key => {
                                localStorage.setItem(key, imported.summaries[key]);
                            });
                        }
                        if (imported.copiedStocksData && Object.keys(imported.copiedStocksData).length > 0) {
                            localStorage.setItem('copiedStocksData', JSON.stringify(imported.copiedStocksData));
                        }
                        
                        // 修复tagTitles数据结构
                        if (window.allData.tagTitles) {
                            // 先找到最新的有效日期
                            const validDates = Object.keys(window.allData.tagTitles).filter(d => d && d.length === 10).sort();
                            const latestValidDate = validDates.length > 0 ? validDates[validDates.length - 1] : null;
                            
                            // 检查是否有空key的数据需要迁移
                            if (window.allData.tagTitles['']) {
                                const emptyKeyData = window.allData.tagTitles[''];
                                // 如果有有效日期，迁移到最新日期；否则迁移到当前日期
                                const targetDate = latestValidDate || window.currentDate;
                                
                                // 合并空key数据到目标日期（而不是覆盖）
                                if (!window.allData.tagTitles[targetDate]) {
                                    window.allData.tagTitles[targetDate] = emptyKeyData;
                                } else {
                                    // 合并标签数据
                                    ['recentMulti', 'sectorEtf', 'topicDirection'].forEach(type => {
                                        if (emptyKeyData[type]) {
                                            if (!window.allData.tagTitles[targetDate][type]) {
                                                window.allData.tagTitles[targetDate][type] = emptyKeyData[type];
                                            } else {
                                                // 合并tags数组（去重）
                                                const existingTags = window.allData.tagTitles[targetDate][type].tags || [];
                                                const newTags = emptyKeyData[type].tags || [];
                                                const mergedTags = [...new Set([...existingTags, ...newTags])];
                                                window.allData.tagTitles[targetDate][type].tags = mergedTags;
                                                
                                                // 合并active状态
                                                if (emptyKeyData[type].active) {
                                                    if (!window.allData.tagTitles[targetDate][type].active) {
                                                        window.allData.tagTitles[targetDate][type].active = {};
                                                    }
                                                    Object.assign(window.allData.tagTitles[targetDate][type].active, emptyKeyData[type].active);
                                                }
                                                
                                                // 保留score（如果空key有score且目标没有）
                                                if (emptyKeyData[type].score !== undefined && window.allData.tagTitles[targetDate][type].score === undefined) {
                                                    window.allData.tagTitles[targetDate][type].score = emptyKeyData[type].score;
                                                }
                                            }
                                        }
                                    });
                                    
                                    // 合并consecutiveUp
                                    if (emptyKeyData.consecutiveUp && !window.allData.tagTitles[targetDate].consecutiveUp) {
                                        window.allData.tagTitles[targetDate].consecutiveUp = emptyKeyData.consecutiveUp;
                                    }
                                }
                                delete window.allData.tagTitles[''];
                            }
                            
                            // 删除所有无效key
                            Object.keys(window.allData.tagTitles).forEach(key => {
                                if (!key || key.length !== 10) {
                                    delete window.allData.tagTitles[key];
                                }
                            });
                            
                            Object.keys(window.allData.tagTitles).forEach(date => {
                                const dateData = window.allData.tagTitles[date];
                                if (!dateData) return;
                                
                                ['recentMulti', 'sectorEtf', 'topicDirection'].forEach(type => {
                                    if (!dateData[type]) {
                                        dateData[type] = { tags: [], active: {}, score: 0 };
                                    }
                                    if (!dateData[type].tags) dateData[type].tags = [];
                                    if (!dateData[type].active) dateData[type].active = {};
                                    if (dateData[type].score === undefined) dateData[type].score = 0;
                                });
                                if (!dateData.consecutiveUp) {
                                    dateData.consecutiveUp = { duoban: 0, bankuai: 0, ticai: 0 };
                                }
                            });
                        }
                        
                        // 找到导入数据中最新的日期并跳转
                        const allDates = [
                            ...Object.keys(window.allData.stocks || {}),
                            ...Object.keys(window.allData.tagTitles || {})
                        ].filter(d => d && d.length === 10).sort();
                        
                        if (allDates.length > 0) {
                            const latestDate = allDates[allDates.length - 1];
                            if (latestDate >= '2025-01-01') {
                                window.setCurrentDate(latestDate);
                                localStorage.setItem('lastEditedDate_' + window.DATA_VERSION, window.currentDate);
                                const datePicker = document.getElementById('datePicker');
                                if (datePicker) datePicker.value = window.currentDate;
                            }
                        }
                        
                        // 标记刚推送，防止 Realtime 把刚导入的数据又覆盖掉
                        window._justPushed = true;
                        setTimeout(function() { window._justPushed = false; }, 8000);
                        window.saveData();
                        // 立即推送到云端（不等防抖）
                        clearTimeout(window._pushDebounceTimer);
                        window.pushToCloud();
                        // 强制清除缓存，确保下次读取最新数据
                        window.allData = null;
                        window.loadAllData();
                        window.renderList();
                        window.renderJiwang();
                        window.renderRank();
                        window.renderAuction();
                        window.renderMulti();
                        window.renderHotspot();
                        window.renderPattern();
                        window.renderBidding();
                        window.renderDuiban();
                        window.renderEtf();
                        window.closeImportTextModal();
                        window.showToast('✅ 文件导入成功！');
                    }
                } catch (err) {
                    console.error('导入错误:', err);
                    window.showToast('❌ 文件格式错误: ' + err.message);
                }
            };
            reader.readAsText(file);
            event.target.value = '';
        }

        // 【特殊修复功能】仅补全早盘竞价（auction）历史数据，不动其他任何模块
        // 用途：早盘竞价历史曾因"撤回"功能的bug被误清空，此功能用于从旧备份里
        // 把缺失的日期找回来，已存在的日期不受影响（不覆盖、不合并当天内容，直接跳过）

        // 【特殊修复功能】仅补全早盘竞价（auction）历史数据，不动其他任何模块
        // 用途：早盘竞价历史曾因"撤回"功能的bug被误清空，此功能用于从旧备份里
        // 把缺失的日期找回来，已存在的日期不受影响（不覆盖、不合并当天内容，直接跳过）
        export function handleAuctionOnlyImport(event) {
            const file = event.target.files[0];
            if (!file) return;

            const reader = new FileReader();
            reader.onload = function(e) {
                let text = e.target.result;
                if (text.charCodeAt(0) === 0xFEFF) {
                    text = text.slice(1);
                }
                try {
                    const imported = JSON.parse(text);
                    const importedAuction = imported.auction || {};
                    const importedWatchlistIdx = imported.auctionWatchlist || {};
                    const importedDates = Object.keys(importedAuction);

                    if (importedDates.length === 0) {
                        window.showToast('❌ 该文件中没有找到早盘竞价数据');
                        return;
                    }

                    window.loadAllData();
                    const currentAuction = window.allData.auction || {};

                    // 找出：旧备份里有、当前完全缺失（当天没有任何早盘竞价数据）的日期
                    const missingDates = importedDates.filter(date => {
                        const existing = currentAuction[date];
                        return !existing || !Array.isArray(existing) || existing.length === 0;
                    });

                    if (missingDates.length === 0) {
                        window.showToast('✅ 当前早盘竞价数据已完整，没有需要补全的日期');
                        return;
                    }

                    if (!confirm(`将从旧备份补全 ${missingDates.length} 天缺失的早盘竞价数据（已有数据的日期不受影响，其他模块不受影响），是否继续？`)) {
                        return;
                    }

                    // 备份当前auction，便于误操作后可撤回
                    window.backupAuctionData('window.save');

                    missingDates.forEach(date => {
                        // 阶段四 Bug 3 修复：直接写 _auctionMemCache（即 allData.auction），
                        // 并走 patchAuctionFieldBatch 把数据字段同步到云端
                        const rows = Array.isArray(importedAuction[date]) ? importedAuction[date] : [];
                        // 方案2：优先用备份文件携带的 auctionWatchlist 索引重建正式成员名单。
                        // 行对象不携带 in_watchlist 字段，索引是正式/影子身份的唯一权威来源。
                        // 旧备份无此字段时，回退到 _extractWatchlistNamesFromRows。
                        const idxForDate = (importedWatchlistIdx && importedWatchlistIdx[date]) || null;
                        if (Array.isArray(idxForDate) && idxForDate.length > 0) {
                            window._setAuctionWatchlistForDate(date, idxForDate);
                        } else {
                            window._setAuctionWatchlistForDate(date, window._extractWatchlistNamesFromRows(rows));
                        }
                        window.setAuctionDateData(date, rows, 'window.handleFileImport');
                        // 用户主动确认了"补全缺失日期"操作，标记这些日期为脏，
                        // 允许下次推送时用补全后的本地数据覆盖云端（云端该日期本来就是空的）
                        window.markAuctionDirty(date);
                        // 同步数据字段到云端（camelCase → snake_case）
                        const scMap = window._scMapCache || {};
                        const dayList = Array.isArray(importedAuction[date]) ? importedAuction[date] : [];
                        const patches = dayList
                            .filter(function(s) { return s && s.stock; })
                            .map(function(item) {
                                const nameTrim = item.stock.trim();
                                return {
                                    stock: nameTrim,
                                    code: scMap[nameTrim] || item.code || '',
                                    volume: item.volume || '',
                                    yest_volume: item.yestVolume || '',
                                    note: item.note || '',
                                    change_pct: item.changePct || '',
                                    topics: item.topics || '',
                                    selected: item.selected || false,
                                    bought: item.bought || false,
                                    sold: item.sold || false,
                                    fixed: item.fixed || false
                                };
                            });
                        if (patches.length > 0) {
                            window.patchAuctionFieldBatch(date, patches).catch(function(e) { window._dbgLog('[AUCTION-ERR] window.handleFileImport history-fill window.patchAuctionFieldBatch ' + date + ' ' + (e && e.message || e)); });
                        }
                    });

                    window.invalidateTopicCache();
                    window.renderAuction();
                    window.showToast(`✅ 已补全 ${missingDates.length} 天早盘竞价数据！`);
                } catch (err) {
                    console.error('补全早盘竞价数据出错:', err);
                    window.showToast('❌ 文件格式错误: ' + err.message);
                }
            };
            reader.readAsText(file);
            event.target.value = '';
        }

        // 处理文本导入

        // 处理文本导入
        export function handleTextImport() {
            const text = document.getElementById('importTextArea').value.trim();
            if (!text) {
                window.showToast('❌ 请输入数据内容');
                return;
            }
            
            try {
                const imported = JSON.parse(text);
                if (confirm('导入将覆盖现有数据，是否继续？')) {
                    // bidding（竞价变化）已改为纯云端表 + 内存缓存，是独立于本次
                    // 导入的数据源。整体导入覆盖的是 stocks/jiwang/... 等其它模块，
                    // 不应该连带影响 bidding 云端数据——哪怕导入的内容里带有
                    // bidding 字段，也不再读取/覆盖，避免旧/损坏的备份把云端数据冲掉。
                    // allData.bidding 继续指向持久内存缓存 _biddingMemCache。
                    if (!window._biddingMemCache) window._biddingMemCache = {};
                    // jiwang 同理，已改为纯云端表 + 内存缓存，合并进 _jiwangMemCache
                    // 并把涉及日期标脏，交给 saveData()/scheduleJiwangPush() 推送到云端表。
                    if (!window._jiwangMemCache) window._jiwangMemCache = {};
                    if (imported.jiwang && typeof imported.jiwang === 'object') {
                        Object.assign(window._jiwangMemCache, imported.jiwang);
                        Object.keys(imported.jiwang).forEach(function(d) { window.markJiwangDirty(d); });
                    }
                    // 阶段八：stocks / rank / multi / hotspot / pattern / tagTitles
                    // 导入数据写入独立内存缓存，避免 allData 与缓存断开引用
                    Object.assign(_stocksMemCache, imported.stocks || {});
                    Object.assign(_rankMemCache, imported.rank || {});
                    Object.assign(_multiMemCache, imported.multi || {});
                    Object.assign(_hotspotMemCache, imported.hotspot || {});
                    Object.assign(_patternMemCache, imported.pattern || {});
                    Object.assign(_tagTitlesMemCache, imported.tagTitles || {});

                    window.allData = {
                        stocks: _stocksMemCache,
                        jiwang: window._jiwangMemCache,
                        rank: _rankMemCache,
                        multi: _multiMemCache,
                        hotspot: _hotspotMemCache,
                        pattern: _patternMemCache,
                        bidding: window._biddingMemCache,
                        auction: imported.auction || {},
                        tagTitles: _tagTitlesMemCache
                    };

                    // 标记所有涉及日期为脏，确保推送到 Supabase
                    if (imported.stocks) Object.keys(imported.stocks).forEach(d => remainingBoards.markDirty('stocks', d));
                    if (imported.rank) Object.keys(imported.rank).forEach(d => remainingBoards.markDirty('rank', d));
                    if (imported.multi) Object.keys(imported.multi).forEach(d => remainingBoards.markDirty('multi', d));
                    if (imported.hotspot) Object.keys(imported.hotspot).forEach(d => remainingBoards.markDirty('hotspot', d));
                    if (imported.pattern) Object.keys(imported.pattern).forEach(d => remainingBoards.markDirty('pattern', d));
                    if (imported.tagTitles) Object.keys(imported.tagTitles).forEach(d => remainingBoards.markDirty('tagTitles', d));

                    // 修复tagTitles数据结构
                    if (window.allData.tagTitles) {
                        // 先找到最新的有效日期
                        const validDates = Object.keys(window.allData.tagTitles).filter(d => d && d.length === 10).sort();
                        const latestValidDate = validDates.length > 0 ? validDates[validDates.length - 1] : null;
                        
                        // 检查是否有空key的数据需要迁移
                        if (window.allData.tagTitles['']) {
                            const emptyKeyData = window.allData.tagTitles[''];
                            // 如果有有效日期，迁移到最新日期；否则迁移到当前日期
                            const targetDate = latestValidDate || window.currentDate;
                            
                            // 合并空key数据到目标日期（而不是覆盖）
                            if (!window.allData.tagTitles[targetDate]) {
                                window.allData.tagTitles[targetDate] = emptyKeyData;
                            } else {
                                // 合并标签数据
                                ['recentMulti', 'sectorEtf', 'topicDirection'].forEach(type => {
                                    if (emptyKeyData[type]) {
                                        if (!window.allData.tagTitles[targetDate][type]) {
                                            window.allData.tagTitles[targetDate][type] = emptyKeyData[type];
                                        } else {
                                            // 合并tags数组（去重）
                                            const existingTags = window.allData.tagTitles[targetDate][type].tags || [];
                                            const newTags = emptyKeyData[type].tags || [];
                                            const mergedTags = [...new Set([...existingTags, ...newTags])];
                                            window.allData.tagTitles[targetDate][type].tags = mergedTags;
                                            
                                            // 合并active状态
                                            if (emptyKeyData[type].active) {
                                                if (!window.allData.tagTitles[targetDate][type].active) {
                                                    window.allData.tagTitles[targetDate][type].active = {};
                                                }
                                                Object.assign(window.allData.tagTitles[targetDate][type].active, emptyKeyData[type].active);
                                            }
                                            
                                            // 保留score（如果空key有score且目标没有）
                                            if (emptyKeyData[type].score !== undefined && window.allData.tagTitles[targetDate][type].score === undefined) {
                                                window.allData.tagTitles[targetDate][type].score = emptyKeyData[type].score;
                                            }
                                        }
                                    }
                                });
                                
                                // 合并consecutiveUp
                                if (emptyKeyData.consecutiveUp && !window.allData.tagTitles[targetDate].consecutiveUp) {
                                    window.allData.tagTitles[targetDate].consecutiveUp = emptyKeyData.consecutiveUp;
                                }
                            }
                            delete window.allData.tagTitles[''];
                        }
                        
                        // 删除所有无效key
                        Object.keys(window.allData.tagTitles).forEach(key => {
                            if (!key || key.length !== 10) {
                                delete window.allData.tagTitles[key];
                            }
                        });
                        
                        Object.keys(window.allData.tagTitles).forEach(date => {
                            const dateData = window.allData.tagTitles[date];
                            if (!dateData) return;
                            
                            ['recentMulti', 'sectorEtf', 'topicDirection'].forEach(type => {
                                if (!dateData[type]) {
                                    dateData[type] = { tags: [], active: {}, score: 0 };
                                }
                                if (!dateData[type].tags) dateData[type].tags = [];
                                if (!dateData[type].active) dateData[type].active = {};
                                if (dateData[type].score === undefined) dateData[type].score = 0;
                            });
                            if (!dateData.consecutiveUp) {
                                dateData.consecutiveUp = { duoban: 0, bankuai: 0, ticai: 0 };
                            }
                        });
                    }
                    
                    // 找到导入数据中最新的日期并跳转
                    const allDates = [
                        ...Object.keys(window.allData.stocks || {}),
                        ...Object.keys(window.allData.tagTitles || {})
                    ].filter(d => d && d.length === 10).sort();
                    
                    if (allDates.length > 0) {
                        const latestDate = allDates[allDates.length - 1];
                        if (latestDate >= '2025-01-01') {
                            window.setCurrentDate(latestDate);
                            localStorage.setItem('lastEditedDate_' + window.DATA_VERSION, window.currentDate);
                            const datePicker = document.getElementById('datePicker');
                            if (datePicker) datePicker.value = window.currentDate;
                        }
                    }
                    
                    // 导入其他独立存储的数据
                    if (imported.duibanData) {
                        localStorage.setItem('duibanData', JSON.stringify(imported.duibanData));
                    }
                    if (imported.duibanComment) {
                        localStorage.setItem('duibanComment', JSON.stringify(imported.duibanComment));
                    }
                    if (imported.stockEtfData) {
                        localStorage.setItem('stockEtfData', JSON.stringify(imported.stockEtfData));
                    }
                    if (imported.stockEtfComment) {
                        localStorage.setItem('stockEtfComment', JSON.stringify(imported.stockEtfComment));
                    }
                    if (imported.coreTopics) {
                        localStorage.setItem('coreTopics', JSON.stringify(imported.coreTopics));
                    }
                    if (imported.biddingDefaultTemplate) {
                        localStorage.setItem('biddingDefaultTemplate_v41', JSON.stringify(imported.biddingDefaultTemplate));
                    }
                    if (imported.holidays) {
                        window.allData.holidays = imported.holidays;
                    }
                    if (imported.scoreSettings) {
                        ['recentMulti', 'sectorEtf', 'topicDirection'].forEach(type => {
                            if (imported.scoreSettings[type]) {
                                localStorage.setItem('scoreSettings_' + type, JSON.stringify(imported.scoreSettings[type]));
                            }
                        });
                    }
                    if (imported.hasFumianTopics) {
                        Object.keys(imported.hasFumianTopics).forEach(key => {
                            localStorage.setItem(key, imported.hasFumianTopics[key]);
                        });
                    }
                    if (imported.summaries) {
                        Object.keys(imported.summaries).forEach(key => {
                            localStorage.setItem(key, imported.summaries[key]);
                        });
                    }
                    if (imported.copiedStocksData && Object.keys(imported.copiedStocksData).length > 0) {
                        localStorage.setItem('copiedStocksData', JSON.stringify(imported.copiedStocksData));
                    }
                    
                    window.saveData();
                    // 强制清除缓存，确保下次读取最新数据
                    window.allData = null;
                    window.loadAllData();
                    window.renderList();
                    window.renderJiwang();
                    window.renderRank();
                    window.renderAuction();
                    window.renderMulti();
                    window.renderHotspot();
                    window.renderPattern();
                    window.renderBidding();
                    window.renderDuiban();
                    window.renderEtf();
                    window.closeImportTextModal();
                    window.showToast('✅ 数据导入成功！');
                }
            } catch (err) {
                window.showToast('❌ 数据格式错误，请检查JSON内容');
            }
        }

        // 获取最近编辑的日期

        // 获取最近编辑的日期
        export function getLastEditedDate() {
            const data = window.loadAllData();
            const allDates = new Set();
            
            // 收集所有有数据的日期
            Object.keys(data.stocks || {}).forEach(date => {
                if (data.stocks[date] && data.stocks[date].length > 0) {
                    allDates.add(date);
                }
            });
            Object.keys(data.jiwang || {}).forEach(date => {
                const jiwang = data.jiwang[date];
                if (jiwang && (jiwang.diezhang || jiwang.qingxu || jiwang.jujiao || jiwang.kxian || jiwang.guancha || jiwang.guochengJieguo || jiwang.shouguJieguo || jiwang.jielun)) {
                    allDates.add(date);
                }
            });
            Object.keys(data.rank || {}).forEach(date => {
                if (data.rank[date] && data.rank[date].length > 0) {
                    allDates.add(date);
                }
            });
            Object.keys(data.multi || {}).forEach(date => {
                if (data.multi[date] && data.multi[date].length > 0) {
                    allDates.add(date);
                }
            });
            Object.keys(data.hotspot || {}).forEach(date => {
                if (data.hotspot[date] && data.hotspot[date].trim() !== '') {
                    allDates.add(date);
                }
            });
            Object.keys(data.pattern || {}).forEach(date => {
                const pattern = data.pattern[date];
                if (pattern && pattern.content && pattern.content.trim() !== '') {
                    allDates.add(date);
                }
            });
            Object.keys(data.bidding || {}).forEach(date => {
                const bidding = data.bidding[date];
                if (bidding && bidding.length > 0) {
                    allDates.add(date);
                }
            });
            
            if (allDates.size === 0) {
                return null;
            }
            
            // 返回最新的日期
            return Array.from(allDates).sort().pop();
        }


