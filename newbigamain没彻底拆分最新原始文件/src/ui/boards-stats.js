// boards-stats.js — 从 boards-render.js 拆分（看板域: boards-stats.js）

        // 渲染圆形统计
        export function renderCircleStats() {
            const stats = window.getStats();
            const profit = stats.profit;
            const gain = stats.gain;
            
            const profitCard = document.getElementById('profitCard'),
                  profitValue = document.getElementById('profitValue');
            
            if (profit !== undefined && profit !== '' && !isNaN(parseFloat(profit))) {
                const formattedProfit = window.formatAmount(profit);
                profitValue.textContent = parseFloat(profit) > 0 ? '+' + formattedProfit : formattedProfit;
                profitCard.className = 'circle-card';
                if (parseFloat(profit) > 0) profitCard.classList.add('positive');
                else if (parseFloat(profit) < 0) profitCard.classList.add('negative');
            } else {
                profitValue.textContent = '-';
                profitCard.className = 'circle-card';
            }
            
            const gainCard = document.getElementById('gainCard'),
                  gainValue = document.getElementById('gainValue');
            
            if (gain !== undefined && gain !== '' && !isNaN(parseFloat(gain))) {
                gainValue.textContent = (parseFloat(gain) > 0 ? '+' : '') + gain + '%';
                gainCard.className = 'circle-card';
                if (parseFloat(gain) > 0) gainCard.classList.add('positive');
                else if (parseFloat(gain) < 0) gainCard.classList.add('negative');
            } else {
                gainValue.textContent = '-';
                gainCard.className = 'circle-card';
            }
            
            // 渲染行情阶段区域
            window.renderMarketStage();
            // 渲染评论
            window.renderComment();
        }

        // 打开圆形统计编辑（今日盈亏和账户涨幅）

        // 打开圆形统计编辑（今日盈亏和账户涨幅）
        export function openCircleStatsEdit() {
            const stats = window.getStats();
            document.getElementById('editProfit').value = stats.profit !== undefined ? stats.profit : '';
            document.getElementById('editGain').value = stats.gain !== undefined ? stats.gain : '';
            
            // 确保新字段存在
            if (stats.balance === undefined) stats.balance = '';
            if (stats.marketStage === undefined) stats.marketStage = '';
            if (stats.recentMulti === undefined) stats.recentMulti = false;
            if (stats.topicDirection === undefined) stats.topicDirection = false;
            if (stats.sectorEtf === undefined) stats.sectorEtf = false;
            
            document.getElementById('editBalance').value = stats.balance;
            document.getElementById('editMarketStage').value = stats.marketStage || '';
            
            // 设置复选框状态
            const recentMultiCheck = document.getElementById('editRecentMultiCheck');
            if (recentMultiCheck) {
                recentMultiCheck.textContent = stats.recentMulti ? '✓' : '×';
                recentMultiCheck.className = `checkbox-option ${stats.recentMulti ? 'checked' : 'unchecked'}`;
            }
            
            const topicDirectionCheck = document.getElementById('editTopicDirectionCheck');
            if (topicDirectionCheck) {
                topicDirectionCheck.textContent = stats.topicDirection ? '✓' : '×';
                topicDirectionCheck.className = `checkbox-option ${stats.topicDirection ? 'checked' : 'unchecked'}`;
            }
            
            const sectorEtfCheck = document.getElementById('editSectorEtfCheck');
            if (sectorEtfCheck) {
                sectorEtfCheck.textContent = stats.sectorEtf ? '✓' : '×';
                sectorEtfCheck.className = `checkbox-option ${stats.sectorEtf ? 'checked' : 'unchecked'}`;
            }
            
            document.getElementById('circleStatsModal').classList.add('active');
        }

        // 关闭圆形统计编辑

        // 关闭圆形统计编辑
        export function closeCircleStatsModal() {
            document.getElementById('circleStatsModal').classList.remove('active');
        }

        // 保存圆形统计数据

        // 保存圆形统计数据
        export function saveCircleStats() {
            const stats = window.getStats();
            const profitInput = document.getElementById('editProfit').value.trim();
            const gainInput = document.getElementById('editGain').value.trim();
            const balanceInput = document.getElementById('editBalance').value.trim();
            const marketStageInput = document.getElementById('editMarketStage').value;
            
            // 处理盈亏数据
            if (profitInput === '') {
                stats.profit = '';
            } else {
                const profitNum = parseFloat(profitInput);
                if (!isNaN(profitNum)) {
                    stats.profit = profitNum;
                } else {
                    window.showToast('❌ 今日盈亏请输入有效的数字！');
                    return;
                }
            }
            
            // 处理涨幅数据
            if (gainInput === '') {
                stats.gain = '';
            } else {
                const gainNum = parseFloat(gainInput);
                if (!isNaN(gainNum)) {
                    stats.gain = gainNum;
                } else {
                    window.showToast('❌ 账户涨幅请输入有效的数字！');
                    return;
                }
            }
            
            // 处理账户余额数据
            if (balanceInput === '') {
                stats.balance = '';
            } else {
                const balanceNum = parseFloat(balanceInput);
                if (!isNaN(balanceNum)) {
                    stats.balance = balanceNum;
                } else {
                    window.showToast('❌ 账户余额请输入有效的数字！');
                    return;
                }
            }
            
            // 处理行情阶段
            stats.marketStage = marketStageInput || '';
            
            // 处理板块ETF复选框
            const sectorEtfCheck = document.getElementById('editSectorEtfCheck');
            if (sectorEtfCheck) {
                stats.sectorEtf = sectorEtfCheck.classList.contains('checked');
            }
            
            window.markJiwangDirty(window.currentDate);
            window.saveData();
            
            // 同步今日盈亏到竞价变化中的账号溢价
            const bidding = window.getBiddingData();
            let biddingData = bidding[window.currentDate];
            if (biddingData) {
                const accountPremiumIndex = biddingData.findIndex(row => row.name === '账号溢价');
                if (accountPremiumIndex !== -1) {
                    if (stats.profit !== '' && stats.profit !== undefined) {
                        biddingData[accountPremiumIndex].close = stats.profit.toString();
                    } else {
                        biddingData[accountPremiumIndex].close = '';
                    }
                    bidding[window.currentDate] = biddingData;
                    window.saveData();
                    window.renderBidding();
                }
            }
            
            window.renderCircleStats();
            window.closeCircleStatsModal();
            window.pushJiwangNow(window.currentDate, '✅ 统计数据已保存并同步到云端');
            
            // 实时更新连涨连跌天数柱状图
            window.autoCalculateConsecutiveDays();
        }

        // 清除圆形统计数据

        // 清除圆形统计数据
        export function clearCircleStats() {
            const stats = window.getStats();
            stats.profit = '';
            stats.gain = '';
            stats.balance = '';
            stats.marketStage = '';
            stats.recentMulti = false;
            stats.topicDirection = false;
            window.markJiwangDirty(window.currentDate);
            window.saveData();
            
            // 同步清除竞价变化中的账号溢价
            const bidding = window.getBiddingData();
            let biddingData = bidding[window.currentDate];
            if (biddingData) {
                const accountPremiumIndex = biddingData.findIndex(row => row.name === '账号溢价');
                if (accountPremiumIndex !== -1) {
                    biddingData[accountPremiumIndex].close = '';
                    bidding[window.currentDate] = biddingData;
                    window.saveData();
                    window.renderBidding();
                }
            }
            
            window.renderCircleStats();
            window.closeCircleStatsModal();
            window.pushJiwangNow(window.currentDate, '✅ 统计数据已清除并同步到云端');
            
            // 实时更新连涨连跌天数柱状图
            window.autoCalculateConsecutiveDays();
        }

        // 自动计算连涨连跌天数
        // 对应关系：竞价变化"最近多板%" -> 连涨连跌"最近多板"
        //          竞价变化"板块ETF(46)" -> 连涨连跌"板块ETF"
        //          竞价变化"昨成交额前五" -> 连涨连跌"题材方向"
        //          记忘看板"昨收盘结果" -> 连涨连跌"大盘"

        // 自动计算连涨连跌天数
        // 对应关系：竞价变化"最近多板%" -> 连涨连跌"最近多板"
        //          竞价变化"板块ETF(46)" -> 连涨连跌"板块ETF"
        //          竞价变化"昨成交额前五" -> 连涨连跌"题材方向"
        //          记忘看板"昨收盘结果" -> 连涨连跌"大盘"
        export function autoCalculateConsecutiveDays() {
            const biddingAllData = window.getBiddingData();
            const jiwangAllData = window.getJiwangData();
            
            const allDatesSet = new Set([
                ...Object.keys(biddingAllData),
                ...Object.keys(jiwangAllData)
            ]);
            const allDates = Array.from(allDatesSet).sort();
            
            if (allDates.length === 0) return;
            
            const nameMapping = {
                '最近多板%': 'duoban',
                '板块ETF(48)': 'bankuai',   // Fix Bug2: 原为(46)，与默认模板(48)不符
                '昨成交额前五': 'ticai'
            };
            
            const consecutiveState = {
                duoban: { direction: 0, count: 0 },
                bankuai: { direction: 0, count: 0 },
                ticai: { direction: 0, count: 0 },
                dapan: { direction: 0, count: 0 }
            };
            
            allDates.forEach(date => {
                const dayData = biddingAllData[date];
                const jiwangData = jiwangAllData[date];
                const tagData = window.getTagTitlesByDate(date);
                if (!tagData.consecutiveUp) tagData.consecutiveUp = { duoban: 0, bankuai: 0, ticai: 0, dapan: 0 };
                
                const todayHasData = {
                    duoban: false,
                    bankuai: false,
                    ticai: false,
                    dapan: false
                };
                
                if (dayData && Array.isArray(dayData)) {
                    dayData.forEach(row => {
                        const itemName = row.name || '';
                        let targetKey = nameMapping[itemName];
                        
                        if (!targetKey && itemName.startsWith('板块ETF')) {
                            targetKey = 'bankuai';
                        }
                        
                        if (!targetKey) return;
                        
                        const time930Str = (row.time930 || '').toString().trim();
                        const closeStr = (row.close || '').toString().trim();
                        const time930 = parseFloat(time930Str);
                        const close = parseFloat(closeStr);
                        
                        if (time930Str === '' || closeStr === '' || isNaN(time930) || isNaN(close)) return;
                        
                        todayHasData[targetKey] = true;
                        
                        let todayDirection;
                        if (targetKey === 'ticai') {
                            if (close === time930) {
                                todayDirection = (close >= 3) ? 1 : -1;
                            } else {
                                todayDirection = (close > time930) ? 1 : -1;
                            }
                        } else {
                            todayDirection = (close > time930) ? 1 : -1;
                        }
                        
                        const state = consecutiveState[targetKey];
                        if (todayDirection !== state.direction) {
                            state.direction = todayDirection;
                            state.count = todayDirection;
                        } else {
                            state.count += (todayDirection > 0 ? 1 : -1);
                        }
                        if (state.count > 10) state.count = 10;
                        if (state.count < -10) state.count = -10;
                        tagData.consecutiveUp[targetKey] = state.count;
                    });
                }
                
                if (jiwangData && jiwangData.shouguJieguo) {
                    const shouguJieguo = jiwangData.shouguJieguo.trim();
                    if (shouguJieguo !== '' && shouguJieguo !== ':') {
                        const parts = shouguJieguo.split(':');
                        if (parts.length === 2) {
                            const dieCount = parseFloat(parts[0].trim());
                            const zhangCount = parseFloat(parts[1].trim());
                            
                            if (!isNaN(dieCount) && !isNaN(zhangCount) && zhangCount > 0) {
                                todayHasData.dapan = true;
                                const ratio = dieCount / zhangCount;
                                const todayDirection = ratio > 1 ? -1 : 1;
                                
                                const state = consecutiveState.dapan;
                                if (todayDirection !== state.direction) {
                                    state.direction = todayDirection;
                                    state.count = todayDirection;
                                } else {
                                    state.count += (todayDirection > 0 ? 1 : -1);
                                }
                                if (state.count > 10) state.count = 10;
                                if (state.count < -10) state.count = -10;
                                tagData.consecutiveUp.dapan = state.count;
                            }
                        }
                    }
                }
            });
            
            window.saveData();
            window.renderConsecutiveUp();
        }

        // 获取上一个交易日的日期（跳过周末和休假）

        // 获取上一个交易日的日期（跳过周末和休假）
        export function getYesterdayDate(date) {
            const d = new Date(date);
            d.setDate(d.getDate() - 1);
            // 构建 YYYY-MM-DD 格式的日期字符串
            const toISODate = (dt) => {
                const year = dt.getFullYear();
                const month = String(dt.getMonth() + 1).padStart(2, '0');
                const day = String(dt.getDate()).padStart(2, '0');
                return `${year}-${month}-${day}`;
            };
            // 跳过非交易日（周末或用户标记的休假）
            while (!window.isTradingDay(toISODate(d))) {
                d.setDate(d.getDate() - 1);
            }
            const year = d.getFullYear();
            const month = String(d.getMonth() + 1).padStart(2, '0');
            const day = String(d.getDate()).padStart(2, '0');
            return `${year}-${month}-${day}`;
        }

        // 自动计算最近多板评分
        
        // 检查是否有负面题材

        // 检查是否有负面题材
        export function checkHasFumianTopic() {
            return localStorage.getItem('hasFumianTopic_' + window.currentDate) === 'true';
        }
        

        export function autoCalculateRecentMultiScore() {
            const tagData = window.getTodayTagTitles();
            const yesterdayDate = window.getYesterdayDate(window.currentDate);
            const yesterdayTagData = window.getTagTitlesByDate(yesterdayDate);
            const yesterdayConsecutiveUp = yesterdayTagData.consecutiveUp || { duoban: 0, bankuai: 0, ticai: 0 };
            const todayJiwang = window.getTodayJiwang() || {};
            const rawSettings = window.getScoreSettings('recentMulti');
            const s = {};
            Object.keys(rawSettings).forEach(key => {
                const val = rawSettings[key];
                s[key] = (val === '' || val === null || val === undefined) ? 0 : val;
            });
            
            let score = 0;
            const yesterdayDuobanDays = yesterdayConsecutiveUp.duoban || 0;
            const yesterdayBankuaiDays = yesterdayConsecutiveUp.bankuai || 0;
            const yesterdayTicaiDays = yesterdayConsecutiveUp.ticai || 0;
            
            // 一、根据上交易日连涨连跌天数计算基础分数
            if (yesterdayDuobanDays === -1) {
                score = s.die1;
            } else if (yesterdayDuobanDays === -2) {
                score = s.die2;
            } else if (yesterdayDuobanDays === -3) {
                score = s.die3;
            } else if (yesterdayDuobanDays === -4) {
                score = s.die4;
            } else if (yesterdayDuobanDays <= -5) {
                score = s.die5;
            } else if (yesterdayDuobanDays === 1) {
                score = s.zhang1;
            } else if (yesterdayDuobanDays === 2) {
                score = s.zhang2;
            } else if (yesterdayDuobanDays >= 3) {
                score = s.zhang3;
            }
            
            // 二、根据今天记忘看板得出结论调整分数
            if (todayJiwang.jielun === '空仓') {
                score += s.kongcang;
            } else if (todayJiwang.jielun === '出手') {
                score += s.chushou;
            }
            
            // 三、羊群效应
            const bankuaiIsDown = yesterdayBankuaiDays < 0;
            const bankuaiIsUp = yesterdayBankuaiDays > 0;
            const ticaiIsDown = yesterdayTicaiDays < 0;
            const ticaiIsUp = yesterdayTicaiDays > 0;
            
            if (yesterdayDuobanDays <= -1) {
                if (bankuaiIsDown && ticaiIsDown) {
                    score += s.yangqun1;
                } else if (bankuaiIsUp && ticaiIsUp) {
                    score += s.yangqun2;
                } else if (bankuaiIsUp && ticaiIsDown) {
                    score += s.yangqun3;
                } else if (bankuaiIsDown && ticaiIsUp) {
                    score += s.yangqun4;
                }
            }
            else if (yesterdayDuobanDays >= 1 && yesterdayDuobanDays <= 2) {
                if (bankuaiIsUp && ticaiIsUp) {
                    score += s.yangqun5;
                } else if (bankuaiIsUp && ticaiIsDown) {
                    score += s.yangqun6;
                } else if (bankuaiIsDown && ticaiIsUp) {
                    score += s.yangqun7;
                }
            }
            else if (yesterdayDuobanDays >= 3) {
                if (bankuaiIsUp && ticaiIsUp) {
                    score += s.yangqun8;
                } else if (bankuaiIsDown && ticaiIsUp) {
                    score += s.yangqun9;
                } else if (bankuaiIsUp && ticaiIsDown) {
                    score += s.yangqun10;
                } else if (bankuaiIsDown && ticaiIsDown) {
                    score += s.yangqun11;
                }
            }
            
            // 四、竞价变化看板 - 最近多板9:30跌幅超-1% + 大盘（%）评分
            try {
                const biddingData = window.getBiddingData();
                const currentBidding = biddingData[window.currentDate];
                if (currentBidding && currentBidding.length > 0) {
                    // 最近多板9:30跌幅超-1%
                    const duobanRow = currentBidding.find(row => row.name && row.name.trim() === '最近多板%');
                    if (duobanRow && duobanRow.time930) {
                        const time930Value = parseFloat(duobanRow.time930);
                        if (!isNaN(time930Value) && time930Value < -1) {
                            score += s.jingjiaDie1;
                        }
                    }
                    
                    // 大盘（%）评分
                    const dapanRow = currentBidding.find(row => row.name && row.name.trim() === '大盘（%）');
                    if (dapanRow && dapanRow.time930) {
                        const dapanValue = parseFloat(dapanRow.time930);
                        if (!isNaN(dapanValue)) {
                            if (dapanValue > 1) {
                                score += s.dapanMore1;
                            } else if (dapanValue < -1) {
                                score += s.dapanLess1;
                            } else if (dapanValue <= -0.5) {
                                // Fix Bug1: 使用<=−0.5明确覆盖[−1,−0.5]区间（已被else if排除<−1的情况）
                                score += s.dapanLess05;
                            }
                        }
                    }
                }
            } catch(e) { console.error('评分计算错误1:', e); }
            
            // 五、早盘竞价第一页占比≥4.5%股票数量
            try {
                const todayAuction = window.getTodayGroupList(window.currentGroup);
                if (todayAuction && todayAuction.length > 0) {
                    let ratio45Count = 0;
                    todayAuction.forEach(item => {
                        const volume = parseFloat(item.volume) || 0;
                        const yestVolume = parseFloat(item.yestVolume) || 0;
                        if (yestVolume > 0) {
                            const ratioValue = (volume / yestVolume) * 100;
                            if (ratioValue >= 4.5) {
                                ratio45Count++;
                            }
                        }
                    });
                    if (ratio45Count > 20) {
                        score += s.zhang5More20;
                    } else if (ratio45Count > 15) {
                        score += s.zhang5More15;
                    } else if (ratio45Count >= 10) {
                        score += s.zhang5More10;
                    } else if (ratio45Count < 10) {
                        score += s.zhang5Less10;
                    }
                }
            } catch(e) { console.error('评分计算错误2:', e); }
            
            // 六、有星题材（第三页）
            try {
                const todayAuction = window.getTodayGroupList(window.currentGroup);
                const yesterdayDate = window.getYesterdayDate(window.currentDate);
                const yesterdayAuction = yesterdayDate ? (window.getGroupData(window.currentGroup)[yesterdayDate] || []) : [];
                const todayGroups = window.getTopicGroups(todayAuction || []);
                const yesterdayGroups = yesterdayDate ? window.getTopicGroups(yesterdayAuction || []) : [];
                
                let xingxianCount = 0;
                let xingzengCount = 0;
                let xingpingCount = 0;
                
                todayGroups.forEach(todayGroup => {
                    if (!todayGroup.topic || todayGroup.topic === '---') return;
                    
                    const todayStarCount = todayGroup.starCount || 0;
                    const yesterdayGroup = yesterdayGroups.find(g => g.topic === todayGroup.topic);
                    const yesterdayStarCount = yesterdayGroup ? (yesterdayGroup.starCount || 0) : 0;
                    
                    if (todayStarCount > 0 && yesterdayStarCount === 0) {
                        xingxianCount++;
                    } else if (todayStarCount > yesterdayStarCount) {
                        xingzengCount++;
                    } else if (todayStarCount > 0 && todayStarCount === yesterdayStarCount) {
                        xingpingCount++;
                    }
                });
                
                if (xingxianCount >= 4) {
                    score += s.xingxian4;
                } else if (xingxianCount === 3) {
                    score += s.xingxian3;
                } else if (xingxianCount === 2) {
                    score += s.xingxian2;
                } else if (xingxianCount === 1) {
                    score += s.xingxian1;
                }
                
                if (xingzengCount >= 3) {
                    score += s.xingzeng3;
                } else if (xingzengCount === 2) {
                    score += s.xingzeng2;
                } else if (xingzengCount === 1) {
                    score += s.xingzeng1;
                }
                
                if (xingpingCount >= 3) {
                    score += s.xingping3;
                } else if (xingpingCount === 2) {
                    score += s.xingping2;
                } else if (xingpingCount === 1) {
                    score += s.xingping1;
                }
                
                // 星爆：某个题材今天的星星数 ≥ 昨日该题材的星星数 × 4
                let xingbaoCount = 0;
                todayGroups.forEach(g => {
                    if (!g.topic || g.topic === '---') return;
                    const todayStarCount = g.starCount || 0;
                    const yesterdayGroup = yesterdayGroups.find(yg => yg.topic === g.topic);
                    const yesterdayStarCount = yesterdayGroup ? (yesterdayGroup.starCount || 0) : 0;
                    if (todayStarCount >= 4 && todayStarCount >= yesterdayStarCount * 4) {
                        xingbaoCount++;
                    }
                });
                if (xingbaoCount > 0) {
                    score += s.xingbao;
                }
                
                // 星王增多：上交易日星最多的题材，今天数量增多
                if (yesterdayGroups.length > 0) {
                    let maxStarYesterday = 0;
                    let maxStarTopicYesterday = null;
                    yesterdayGroups.forEach(g => {
                        if (g.topic && g.topic !== '---' && (g.starCount || 0) > maxStarYesterday) {
                            maxStarYesterday = g.starCount || 0;
                            maxStarTopicYesterday = g.topic;
                        }
                    });
                    if (maxStarTopicYesterday && maxStarYesterday > 0) {
                        const todayMaxStarGroup = todayGroups.find(g => g.topic === maxStarTopicYesterday);
                        if (todayMaxStarGroup && (todayMaxStarGroup.starCount || 0) > maxStarYesterday) {
                            score += s.xingwangZeng;
                        }
                    }
                }
            } catch(e) { console.error('评分计算错误3:', e); }
            
            // 七、强度分（需要用到昨天数据）
            let yesterdayAuction = [];
            try {
                yesterdayAuction = window.getYesterdayDate(window.currentDate) ? (window.getGroupData(window.currentGroup)[window.getYesterdayDate(window.currentDate)] || []) : [];
            } catch(e) { yesterdayAuction = []; }

            const auctionData = window.getGroupData(window.currentGroup);
            const auctionList = auctionData[window.currentDate] || [];
            if (auctionList.length > 0) {
                let strongCount = 0;
                auctionList.forEach(item => {
                    let hasDown = false;
                    if (yesterdayAuction.length > 0 && item.stock) {
                        const prevItem = yesterdayAuction.find(p => p.stock && p.stock.trim() === item.stock.trim());
                        if (prevItem && prevItem.yestVolume) {
                            const prevVolume = parseFloat(prevItem.volume) || 0;
                            const prevYestVolume = parseFloat(prevItem.yestVolume) || 0;
                            if (prevYestVolume > 0) {
                                const prevRatioValue = (prevVolume / prevYestVolume) * 100;
                                const currRatioValue = (parseFloat(item.volume) || 0) / (parseFloat(item.yestVolume) || 1) * 100;
                                if (currRatioValue < prevRatioValue) {
                                    hasDown = true;
                                }
                            }
                        }
                    }
                    if (!hasDown) {
                        strongCount++;
                    }
                });
                
                const strength = Math.round((strongCount / auctionList.length) * 100);
                
                if (strength > 50) {
                    score += s.qiangduMore50;
                } else if (strength >= 40 && strength <= 50) {
                    score += s.qiangdu40to50;
                } else if (strength >= 30 && strength < 40) {
                    score += s.qiangdu30to40;
                } else if (strength < 30) {
                    score += s.qiangduLess30;
                }
            }
            
            // 八、负面题材反馈
            const hasFumianTopic = window.checkHasFumianTopic();
            if (hasFumianTopic) {
                score += s.fumianzhuti;
            }
            
            if (score > 20) score = 20;
            if (score < -20) score = -20;
            
            if (!tagData.recentMulti) tagData.recentMulti = { tags: [], active: {}, score: 0 };
            tagData.recentMulti.score = score;
            
            window.renderRecentMultiScore();
            
            window.autoCalculateSectorEtfScore();
        }

        // 渲染最近多板评分

        // 渲染最近多板评分
        export function renderRecentMultiScore() {
            const tagData = window.getTodayTagTitles();
            const score = tagData.recentMulti ? (tagData.recentMulti.score || 0) : 0;
            
            const slider = document.getElementById('recentMultiScoreSlider');
            const valueEl = document.getElementById('recentMultiScoreValue');
            const starsEl = document.getElementById('recentMultiStars');
            
            if (slider) slider.value = score;
            if (valueEl) valueEl.textContent = score;
            if (starsEl) window.updateStarsDisplay('recentMultiStars', score);
        }

        // 自动计算板块ETF评分

        // 自动计算板块ETF评分
        export function autoCalculateSectorEtfScore() {
            const tagData = window.getTodayTagTitles();
            const yesterdayDate = window.getYesterdayDate(window.currentDate);
            const yesterdayTagData = window.getTagTitlesByDate(yesterdayDate);
            const yesterdayConsecutiveUp = yesterdayTagData.consecutiveUp || { duoban: 0, bankuai: 0, ticai: 0 };
            const todayJiwang = window.getTodayJiwang() || {};
            const rawSettings = window.getScoreSettings('sectorEtf');
            const s = {};
            Object.keys(rawSettings).forEach(key => {
                const val = rawSettings[key];
                s[key] = (val === '' || val === null || val === undefined) ? 0 : val;
            });
            
            let score = 0;
            const yesterdayBankuaiDays = yesterdayConsecutiveUp.bankuai || 0;
            const yesterdayDuobanDays = yesterdayConsecutiveUp.duoban || 0;
            const yesterdayTicaiDays = yesterdayConsecutiveUp.ticai || 0;
            
            // 一、根据上交易日最近多板连涨连跌天数计算基础分数
            if (yesterdayDuobanDays === -1) {
                score = s.die1;
            } else if (yesterdayDuobanDays === -2) {
                score = s.die2;
            } else if (yesterdayDuobanDays === -3) {
                score = s.die3;
            } else if (yesterdayDuobanDays === -4) {
                score = s.die4;
            } else if (yesterdayDuobanDays <= -5) {
                score = s.die5;
            } else if (yesterdayDuobanDays === 1) {
                score = s.zhang1;
            } else if (yesterdayDuobanDays === 2) {
                score = s.zhang2;
            } else if (yesterdayDuobanDays >= 3) {
                score = s.zhang3;
            }
            
            // 二、根据今天记忘看板得出结论调整分数
            if (todayJiwang.jielun === '空仓') {
                score += s.kongcang;
            } else if (todayJiwang.jielun === '出手') {
                score += s.chushou;
            }
            
            // 三、羊群效应
            const bankuaiIsDown = yesterdayBankuaiDays < 0;
            const bankuaiIsUp = yesterdayBankuaiDays > 0;
            const ticaiIsDown = yesterdayTicaiDays < 0;
            const ticaiIsUp = yesterdayTicaiDays > 0;
            
            if (yesterdayDuobanDays <= -1) {
                if (bankuaiIsDown && ticaiIsDown) {
                    score += s.yangqun1;
                } else if (bankuaiIsUp && ticaiIsUp) {
                    score += s.yangqun2;
                } else if (bankuaiIsUp && ticaiIsDown) {
                    score += s.yangqun3;
                } else if (bankuaiIsDown && ticaiIsUp) {
                    score += s.yangqun4;
                }
            }
            else if (yesterdayDuobanDays >= 1 && yesterdayDuobanDays <= 2) {
                if (bankuaiIsUp && ticaiIsUp) {
                    score += s.yangqun5;
                } else if (bankuaiIsUp && ticaiIsDown) {
                    score += s.yangqun6;
                } else if (bankuaiIsDown && ticaiIsUp) {
                    score += s.yangqun7;
                }
            }
            else if (yesterdayDuobanDays >= 3) {
                if (bankuaiIsUp && ticaiIsUp) {
                    score += s.yangqun8;
                } else if (bankuaiIsDown && ticaiIsUp) {
                    score += s.yangqun9;
                } else if (bankuaiIsUp && ticaiIsDown) {
                    score += s.yangqun10;
                } else if (bankuaiIsDown && ticaiIsDown) {
                    score += s.yangqun11;
                }
            }
            
            // 四、竞价变化看板 - 最近多板9:30跌幅超-1% + 大盘（%）评分
            try {
                const biddingData = window.getBiddingData();
                const currentBidding = biddingData[window.currentDate];
                if (currentBidding && currentBidding.length > 0) {
                    // 最近多板9:30跌幅超-1%
                    const duobanRow = currentBidding.find(row => row.name && row.name.trim() === '最近多板%');
                    if (duobanRow && duobanRow.time930) {
                        const time930Value = parseFloat(duobanRow.time930);
                        if (!isNaN(time930Value) && time930Value < -1) {
                            score += s.jingjiaDie1;
                        }
                    }
                    
                    // 大盘（%）评分
                    const dapanRow = currentBidding.find(row => row.name && row.name.trim() === '大盘（%）');
                    if (dapanRow && dapanRow.time930) {
                        const dapanValue = parseFloat(dapanRow.time930);
                        if (!isNaN(dapanValue)) {
                            if (dapanValue > 1) {
                                score += s.dapanMore1;
                            } else if (dapanValue < -1) {
                                score += s.dapanLess1;
                            } else if (dapanValue <= -0.5) {
                                // Fix Bug1: 使用<=−0.5明确覆盖[−1,−0.5]区间（已被else if排除<−1的情况）
                                score += s.dapanLess05;
                            }
                        }
                    }
                }
            } catch(e) { console.error('评分计算错误4:', e); }
            
            // 五、早盘竞价第一页占比≥4.5%股票数量
            try {
                const todayAuction = window.getTodayGroupList(window.currentGroup);
                if (todayAuction && todayAuction.length > 0) {
                    let ratio45Count = 0;
                    todayAuction.forEach(item => {
                        const volume = parseFloat(item.volume) || 0;
                        const yestVolume = parseFloat(item.yestVolume) || 0;
                        if (yestVolume > 0) {
                            const ratioValue = (volume / yestVolume) * 100;
                            if (ratioValue >= 4.5) {
                                ratio45Count++;
                            }
                        }
                    });
                    if (ratio45Count > 20) {
                        score += s.zhang5More20;
                    } else if (ratio45Count > 15) {
                        score += s.zhang5More15;
                    } else if (ratio45Count >= 10) {
                        score += s.zhang5More10;
                    } else if (ratio45Count < 10) {
                        score += s.zhang5Less10;
                    }
                }
            } catch(e) { console.error('评分计算错误5:', e); }
            
            // 六、有星题材（第三页）
            try {
                const todayAuction = window.getTodayGroupList(window.currentGroup);
                const yesterdayDate = window.getYesterdayDate(window.currentDate);
                const yesterdayAuction = yesterdayDate ? (window.getGroupData(window.currentGroup)[yesterdayDate] || []) : [];
                const todayGroups = window.getTopicGroups(todayAuction || []);
                const yesterdayGroups = yesterdayDate ? window.getTopicGroups(yesterdayAuction || []) : [];
                
                let xingxianCount = 0;
                let xingzengCount = 0;
                let xingpingCount = 0;
                
                todayGroups.forEach(todayGroup => {
                    if (!todayGroup.topic || todayGroup.topic === '---') return;
                    
                    const todayStarCount = todayGroup.starCount || 0;
                    const yesterdayGroup = yesterdayGroups.find(g => g.topic === todayGroup.topic);
                    const yesterdayStarCount = yesterdayGroup ? (yesterdayGroup.starCount || 0) : 0;
                    
                    if (todayStarCount > 0 && yesterdayStarCount === 0) {
                        xingxianCount++;
                    } else if (todayStarCount > yesterdayStarCount) {
                        xingzengCount++;
                    } else if (todayStarCount > 0 && todayStarCount === yesterdayStarCount) {
                        xingpingCount++;
                    }
                });
                
                if (xingxianCount >= 4) {
                    score += s.xingxian4;
                } else if (xingxianCount === 3) {
                    score += s.xingxian3;
                } else if (xingxianCount === 2) {
                    score += s.xingxian2;
                } else if (xingxianCount === 1) {
                    score += s.xingxian1;
                }
                
                if (xingzengCount >= 3) {
                    score += s.xingzeng3;
                } else if (xingzengCount === 2) {
                    score += s.xingzeng2;
                } else if (xingzengCount === 1) {
                    score += s.xingzeng1;
                }
                
                if (xingpingCount >= 3) {
                    score += s.xingping3;
                } else if (xingpingCount === 2) {
                    score += s.xingping2;
                } else if (xingpingCount === 1) {
                    score += s.xingping1;
                }
                
                // 星爆：某个题材今天的星星数 ≥ 昨日该题材的星星数 × 4
                let xingbaoCount = 0;
                todayGroups.forEach(g => {
                    if (!g.topic || g.topic === '---') return;
                    const todayStarCount = g.starCount || 0;
                    const yesterdayGroup = yesterdayGroups.find(yg => yg.topic === g.topic);
                    const yesterdayStarCount = yesterdayGroup ? (yesterdayGroup.starCount || 0) : 0;
                    if (todayStarCount >= 4 && todayStarCount >= yesterdayStarCount * 4) {
                        xingbaoCount++;
                    }
                });
                if (xingbaoCount > 0) {
                    score += s.xingbao;
                }
                
                // 星王增多：上交易日星最多的题材，今天数量增多
                if (yesterdayGroups.length > 0) {
                    let maxStarYesterday = 0;
                    let maxStarTopicYesterday = null;
                    yesterdayGroups.forEach(g => {
                        if (g.topic && g.topic !== '---' && (g.starCount || 0) > maxStarYesterday) {
                            maxStarYesterday = g.starCount || 0;
                            maxStarTopicYesterday = g.topic;
                        }
                    });
                    if (maxStarTopicYesterday && maxStarYesterday > 0) {
                        const todayMaxStarGroup = todayGroups.find(g => g.topic === maxStarTopicYesterday);
                        if (todayMaxStarGroup && (todayMaxStarGroup.starCount || 0) > maxStarYesterday) {
                            score += s.xingwangZeng;
                        }
                    }
                }
            } catch(e) { console.error('评分计算错误6:', e); }
            
            // 七、强度分（需要用到昨天数据）
            let yesterdayAuction = [];
            try {
                yesterdayAuction = window.getYesterdayDate(window.currentDate) ? (window.getGroupData(window.currentGroup)[window.getYesterdayDate(window.currentDate)] || []) : [];
            } catch(e) { yesterdayAuction = []; }

            const auctionData = window.getGroupData(window.currentGroup);
            const auctionList = auctionData[window.currentDate] || [];
            if (auctionList.length > 0) {
                let strongCount = 0;
                auctionList.forEach(item => {
                    let hasDown = false;
                    if (yesterdayAuction.length > 0 && item.stock) {
                        const prevItem = yesterdayAuction.find(p => p.stock && p.stock.trim() === item.stock.trim());
                        if (prevItem && prevItem.yestVolume) {
                            const prevVolume = parseFloat(prevItem.volume) || 0;
                            const prevYestVolume = parseFloat(prevItem.yestVolume) || 0;
                            if (prevYestVolume > 0) {
                                const prevRatioValue = (prevVolume / prevYestVolume) * 100;
                                const currRatioValue = (parseFloat(item.volume) || 0) / (parseFloat(item.yestVolume) || 1) * 100;
                                if (currRatioValue < prevRatioValue) {
                                    hasDown = true;
                                }
                            }
                        }
                    }
                    if (!hasDown) {
                        strongCount++;
                    }
                });
                
                const strength = Math.round((strongCount / auctionList.length) * 100);
                
                if (strength > 50) {
                    score += s.qiangduMore50_banKuai;
                } else if (strength >= 40 && strength <= 50) {
                    score += s.qiangdu40to50_banKuai;
                } else if (strength >= 30 && strength < 40) {
                    score += s.qiangdu30to40_banKuai;
                } else if (strength < 30) {
                    score += s.qiangduLess30_banKuai;
                }
            }
            
            // 八、负面题材反馈
            const hasFumianTopic = window.checkHasFumianTopic();
            if (hasFumianTopic) {
                score += s.fumianzhuti;
            }
            
            if (score > 20) score = 20;
            if (score < -20) score = -20;
            
            if (!tagData.sectorEtf) tagData.sectorEtf = { tags: [], active: {}, score: 0 };
            tagData.sectorEtf.score = score;
            
            window.renderSectorEtfScore();
            
            window.autoCalculateTopicDirectionScore();
        }

        // 渲染板块ETF评分

        // 渲染板块ETF评分
        export function renderSectorEtfScore() {
            const tagData = window.getTodayTagTitles();
            const score = tagData.sectorEtf ? (tagData.sectorEtf.score || 0) : 0;
            
            const slider = document.getElementById('sectorEtfScore');
            const valueEl = document.getElementById('sectorEtfScoreValue');
            const starsEl = document.getElementById('sectorEtfStars');
            
            if (slider) slider.value = score;
            if (valueEl) valueEl.textContent = score;
            if (starsEl) window.updateStarsDisplay('sectorEtfStars', score);
        }

        // 自动计算题材方向评分

        // 自动计算题材方向评分
        export function autoCalculateTopicDirectionScore() {
            const tagData = window.getTodayTagTitles();
            const yesterdayDate = window.getYesterdayDate(window.currentDate);
            const yesterdayTagData = window.getTagTitlesByDate(yesterdayDate);
            const yesterdayConsecutiveUp = yesterdayTagData.consecutiveUp || { duoban: 0, bankuai: 0, ticai: 0 };
            const todayJiwang = window.getTodayJiwang() || {};
            const rawSettings = window.getScoreSettings('topicDirection');
            const s = {};
            Object.keys(rawSettings).forEach(key => {
                const val = rawSettings[key];
                s[key] = (val === '' || val === null || val === undefined) ? 0 : val;
            });
            
            let score = 0;
            const yesterdayTicaiDays = yesterdayConsecutiveUp.ticai || 0;
            const yesterdayDuobanDays = yesterdayConsecutiveUp.duoban || 0;
            const yesterdayBankuaiDays = yesterdayConsecutiveUp.bankuai || 0;
            
            // 一、根据昨天连涨连跌天数计算基础分数
            if (yesterdayTicaiDays === -1) {
                score = s.die1;
            } else if (yesterdayTicaiDays === -2) {
                score = s.die2;
            } else if (yesterdayTicaiDays === -3) {
                score = s.die3;
            } else if (yesterdayTicaiDays === -4) {
                score = s.die4;
            } else if (yesterdayTicaiDays <= -5) {
                score = s.die5;
            } else if (yesterdayTicaiDays === 1) {
                score = s.zhang1;
            } else if (yesterdayTicaiDays === 2) {
                score = s.zhang2;
            } else if (yesterdayTicaiDays === 3) {
                score = s.zhang3;
            } else if (yesterdayTicaiDays >= 4) {
                score = s.zhang4 || s.zhang3;
            }
            
            // 二、根据今天记忘看板得出结论调整分数
            if (todayJiwang.jielun === '空仓') {
                score += s.kongcang;
            } else if (todayJiwang.jielun === '出手') {
                score += s.chushou;
            }
            
            // 三、羊群效应（仅当昨天最近多板连跌且天数<3时）
            if (yesterdayDuobanDays < 0 && yesterdayDuobanDays > -3) {
                const bankuaiIsDown = yesterdayBankuaiDays < 0;
                const bankuaiIsUp = yesterdayBankuaiDays > 0;
                const ticaiIsDown = yesterdayTicaiDays < 0;
                const ticaiIsUp = yesterdayTicaiDays > 0;
                
                if (bankuaiIsDown && ticaiIsDown) {
                    score += s.yangqun1;
                } else if (bankuaiIsUp && ticaiIsUp) {
                    score += s.yangqun2;
                } else if (bankuaiIsUp && ticaiIsDown) {
                    score += s.yangqun3;
                } else if (bankuaiIsDown && ticaiIsUp) {
                    score += s.yangqun4;
                }
            }
            
            // 四、竞价变化看板 - 最近多板9:30跌幅超-1% + 大盘（%）评分
            try {
                const biddingData = window.getBiddingData();
                const currentBidding = biddingData[window.currentDate];
                if (currentBidding && currentBidding.length > 0) {
                    // 最近多板9:30跌幅超-1%
                    const duobanRow = currentBidding.find(row => row.name && row.name.trim() === '最近多板%');
                    if (duobanRow && duobanRow.time930) {
                        const time930Value = parseFloat(duobanRow.time930);
                        if (!isNaN(time930Value) && time930Value < -1) {
                            score += s.jingjiaDie1;
                        }
                    }
                    
                    // 大盘（%）评分
                    const dapanRow = currentBidding.find(row => row.name && row.name.trim() === '大盘（%）');
                    if (dapanRow && dapanRow.time930) {
                        const dapanValue = parseFloat(dapanRow.time930);
                        if (!isNaN(dapanValue)) {
                            if (dapanValue > 1) {
                                score += s.dapanMore1;
                            } else if (dapanValue < -1) {
                                score += s.dapanLess1;
                            } else if (dapanValue <= -0.5) {
                                // Fix Bug1: 使用<=−0.5明确覆盖[−1,−0.5]区间（已被else if排除<−1的情况）
                                score += s.dapanLess05;
                            }
                        }
                    }
                }
            } catch(e) { console.error('评分计算错误7:', e); }
            
            // 五、早盘竞价第一页占比≥4.5%股票数量
            try {
                const todayAuction = window.getTodayGroupList(window.currentGroup);
                if (todayAuction && todayAuction.length > 0) {
                    let ratio45Count = 0;
                    todayAuction.forEach(item => {
                        const volume = parseFloat(item.volume) || 0;
                        const yestVolume = parseFloat(item.yestVolume) || 0;
                        if (yestVolume > 0) {
                            const ratioValue = (volume / yestVolume) * 100;
                            if (ratioValue >= 4.5) {
                                ratio45Count++;
                            }
                        }
                    });
                    if (ratio45Count > 20) {
                        score += s.zhang5More20;
                    } else if (ratio45Count > 15) {
                        score += s.zhang5More15;
                    } else if (ratio45Count >= 10) {
                        score += s.zhang5More10;
                    } else if (ratio45Count < 10) {
                        score += s.zhang5Less10;
                    }
                }
            } catch(e) { console.error('评分计算错误8:', e); }
            
            // 六、有星题材（第三页）
            try {
                const todayAuction = window.getTodayGroupList(window.currentGroup);
                const yesterdayDate = window.getYesterdayDate(window.currentDate);
                const yesterdayAuction = yesterdayDate ? (window.getGroupData(window.currentGroup)[yesterdayDate] || []) : [];
                const todayGroups = window.getTopicGroups(todayAuction || []);
                const yesterdayGroups = yesterdayDate ? window.getTopicGroups(yesterdayAuction || []) : [];
                
                let xingxianCount = 0;
                let xingzengCount = 0;
                let xingpingCount = 0;
                
                todayGroups.forEach(todayGroup => {
                    if (!todayGroup.topic || todayGroup.topic === '---') return;
                    
                    const todayStarCount = todayGroup.starCount || 0;
                    const yesterdayGroup = yesterdayGroups.find(g => g.topic === todayGroup.topic);
                    const yesterdayStarCount = yesterdayGroup ? (yesterdayGroup.starCount || 0) : 0;
                    
                    if (todayStarCount > 0 && yesterdayStarCount === 0) {
                        xingxianCount++;
                    } else if (todayStarCount > yesterdayStarCount) {
                        xingzengCount++;
                    } else if (todayStarCount > 0 && todayStarCount === yesterdayStarCount) {
                        xingpingCount++;
                    }
                });
                
                if (xingxianCount >= 4) {
                    score += s.xingxian4;
                } else if (xingxianCount === 3) {
                    score += s.xingxian3;
                } else if (xingxianCount === 2) {
                    score += s.xingxian2;
                } else if (xingxianCount === 1) {
                    score += s.xingxian1;
                }
                
                if (xingzengCount >= 3) {
                    score += s.xingzeng3;
                } else if (xingzengCount === 2) {
                    score += s.xingzeng2;
                } else if (xingzengCount === 1) {
                    score += s.xingzeng1;
                }
                
                if (xingpingCount >= 3) {
                    score += s.xingping3;
                } else if (xingpingCount === 2) {
                    score += s.xingping2;
                } else if (xingpingCount === 1) {
                    score += s.xingping1;
                }
                
                // 星爆：某个题材今天的星星数 ≥ 昨日该题材的星星数 × 4
                let xingbaoCount = 0;
                todayGroups.forEach(g => {
                    if (!g.topic || g.topic === '---') return;
                    const todayStarCount = g.starCount || 0;
                    const yesterdayGroup = yesterdayGroups.find(yg => yg.topic === g.topic);
                    const yesterdayStarCount = yesterdayGroup ? (yesterdayGroup.starCount || 0) : 0;
                    if (todayStarCount >= 4 && todayStarCount >= yesterdayStarCount * 4) {
                        xingbaoCount++;
                    }
                });
                if (xingbaoCount > 0) {
                    score += s.xingbao;
                }
                
                // 星王增多：上交易日星最多的题材，今天数量增多
                if (yesterdayGroups.length > 0) {
                    let maxStarYesterday = 0;
                    let maxStarTopicYesterday = null;
                    yesterdayGroups.forEach(g => {
                        if (g.topic && g.topic !== '---' && (g.starCount || 0) > maxStarYesterday) {
                            maxStarYesterday = g.starCount || 0;
                            maxStarTopicYesterday = g.topic;
                        }
                    });
                    if (maxStarTopicYesterday && maxStarYesterday > 0) {
                        const todayMaxStarGroup = todayGroups.find(g => g.topic === maxStarTopicYesterday);
                        if (todayMaxStarGroup && (todayMaxStarGroup.starCount || 0) > maxStarYesterday) {
                            score += s.xingwangZeng;
                        }
                    }
                }
            } catch(e) { console.error('评分计算错误9:', e); }
            
            // 七、强度分（需要用到昨天数据）
            let yesterdayAuction = [];
            try {
                yesterdayAuction = window.getYesterdayDate(window.currentDate) ? (window.getGroupData(window.currentGroup)[window.getYesterdayDate(window.currentDate)] || []) : [];
            } catch(e) { yesterdayAuction = []; }

            const auctionData = window.getGroupData(window.currentGroup);
            const auctionList = auctionData[window.currentDate] || [];
            if (auctionList.length > 0) {
                let strongCount = 0;
                auctionList.forEach(item => {
                    let hasDown = false;
                    if (yesterdayAuction.length > 0 && item.stock) {
                        const prevItem = yesterdayAuction.find(p => p.stock && p.stock.trim() === item.stock.trim());
                        if (prevItem && prevItem.yestVolume) {
                            const prevVolume = parseFloat(prevItem.volume) || 0;
                            const prevYestVolume = parseFloat(prevItem.yestVolume) || 0;
                            if (prevYestVolume > 0) {
                                const prevRatioValue = (prevVolume / prevYestVolume) * 100;
                                const currRatioValue = (parseFloat(item.volume) || 0) / (parseFloat(item.yestVolume) || 1) * 100;
                                if (currRatioValue < prevRatioValue) {
                                    hasDown = true;
                                }
                            }
                        }
                    }
                    if (!hasDown) {
                        strongCount++;
                    }
                });
                
                const strength = Math.round((strongCount / auctionList.length) * 100);
                
                if (strength > 50) {
                    score += s.qiangduMore50_ticai;
                } else if (strength >= 40 && strength <= 50) {
                    score += s.qiangdu40to50_ticai;
                } else if (strength >= 30 && strength < 40) {
                    score += s.qiangdu30to40_ticai;
                } else if (strength < 30) {
                    score += s.qiangduLess30_ticai;
                }
            }
            
            // 八、负面题材反馈
            const hasFumianTopic = window.checkHasFumianTopic();
            if (hasFumianTopic) {
                score += s.fumianzhuti;
            }
            
            if (score > 20) score = 20;
            if (score < -20) score = -20;
            
            if (!tagData.topicDirection) tagData.topicDirection = { tags: [], active: {}, score: 0 };
            tagData.topicDirection.score = score;
            
            window.saveData();
            window.renderTopicDirectionScore();
        }

        // 渲染题材方向评分

        // 渲染题材方向评分
        export function renderTopicDirectionScore() {
            const tagData = window.getTodayTagTitles();
            const score = tagData.topicDirection ? (tagData.topicDirection.score || 0) : 0;
            
            const slider = document.getElementById('topicDirectionScore');
            const valueEl = document.getElementById('topicDirectionScoreValue');
            const starsEl = document.getElementById('topicDirectionStars');
            
            if (slider) slider.value = score;
            if (valueEl) valueEl.textContent = score;
            if (starsEl) window.updateStarsDisplay('topicDirectionStars', score);
        }

        // 根据日期获取标签数据

        // 根据日期获取标签数据
        export function getTagTitlesByDate(date) {
            window.allData = window.loadAllData();
            if (!window.allData.tagTitles[date]) {
                window.allData.tagTitles[date] = {
                    recentMulti: { tags: [], active: {}, score: 0 },
                    sectorEtf: { tags: [], active: {}, score: 0 },
                    topicDirection: { tags: [], active: {}, score: 0 },
                    consecutiveUp: { duoban: 0, bankuai: 0, ticai: 0 }
                };
            }
            return window.allData.tagTitles[date];
        }
        
        // 获取上一个有竞价变化数据的交易日

        // 获取上一个有竞价变化数据的交易日
        export function getPreviousTradingDayWithData(date) {
            const biddingAllData = window.getBiddingData();
            const jiwangAllData = window.getJiwangData();
            const allDatesSet = new Set([...Object.keys(biddingAllData), ...Object.keys(jiwangAllData)]);
            const allDates = Array.from(allDatesSet).sort().reverse();
            
            for (const d of allDates) {
                if (d >= date) continue;
                
                const bidding = biddingAllData[d];
                const jiwang = jiwangAllData[d];
                
                let hasValidData = false;
                
                if (bidding && Array.isArray(bidding)) {
                    for (const row of bidding) {
                        const time930 = (row.time930 || '').toString().trim();
                        const close = (row.close || '').toString().trim();
                        if ((row.name === '最近多板%' || row.name.startsWith('板块ETF') || row.name === '昨成交额前五') 
                            && time930 !== '' && close !== '') {
                            // Fix Bug2: 原为精确匹配'板块ETF(46)'，与默认模板'板块ETF(48)'不符导致hasValidData失效
                            // 改为startsWith('板块ETF')，兼容任意数字后缀
                            hasValidData = true;
                            break;
                        }
                    }
                }
                
                if (!hasValidData && jiwang && jiwang.shouguJieguo) {
                    const shougu = jiwang.shouguJieguo.trim();
                    if (shougu !== '' && shougu !== ':') {
                        const parts = shougu.split(':');
                        if (parts.length === 2 && parts[0].trim() !== '' && parts[1].trim() !== '') {
                            hasValidData = true;
                        }
                    }
                }
                
                if (hasValidData) return d;
            }
            return null;
        }

        // 渲染连涨连跌天数柱状图

        // 渲染连涨连跌天数柱状图
        export function renderConsecutiveUp() {
            // 如果当前日期不是交易日，所有柱子都不显示
            if (!window.isTradingDay(window.currentDate)) {
                ['duoban', 'bankuai', 'ticai', 'dapan', 'lianzhuan'].forEach(type => {
                    const barUp = document.getElementById('bar-up-' + type);
                    const barDown = document.getElementById('bar-down-' + type);
                    const daysEl = document.getElementById('days-' + type);
                    
                    if (barUp) {
                        barUp.style.height = '0';
                        barUp.style.background = 'transparent';
                        barUp.classList.remove('dashed-bar');
                    }
                    if (barDown) {
                        barDown.style.height = '0';
                        barDown.style.background = 'transparent';
                        barDown.classList.remove('dashed-bar');
                    }
                    if (daysEl) {
                        daysEl.textContent = '';
                        daysEl.className = 'bar-days';
                    }
                });
                return;
            }
            
            const data = window.getTodayTagTitles();
            const todayConsecutiveUp = data.consecutiveUp || { duoban: 0, bankuai: 0, ticai: 0, dapan: 0 };
            
            const todayBidding = window.getTodayBidding();
            const todayJiwang = window.getTodayJiwang();
            
            const hasTodayData = {
                duoban: false,
                bankuai: false,
                ticai: false,
                dapan: false
            };
            
            if (todayBidding && Array.isArray(todayBidding)) {
                todayBidding.forEach(row => {
                    const time930 = (row.time930 || '').toString().trim();
                    const close = (row.close || '').toString().trim();
                    if (row.name === '最近多板%' && time930 !== '' && close !== '') hasTodayData.duoban = true;
                    if (row.name && row.name.startsWith('板块ETF') && time930 !== '' && close !== '') hasTodayData.bankuai = true;
                    if (row.name === '昨成交额前五' && time930 !== '' && close !== '') hasTodayData.ticai = true;
                });
            }
            
            if (todayJiwang && todayJiwang.shouguJieguo) {
                const shougu = todayJiwang.shouguJieguo.trim();
                if (shougu !== '' && shougu !== ':') {
                    const parts = shougu.split(':');
                    if (parts.length === 2 && parts[0].trim() !== '' && parts[1].trim() !== '') {
                        hasTodayData.dapan = true;
                    }
                }
            }
            
            // 获取上个交易日的数据作为参考
            const prevDate = window.getPreviousTradingDayWithData(window.currentDate);
            let prevConsecutiveUp = { duoban: 0, bankuai: 0, ticai: 0, dapan: 0 };
            if (prevDate) {
                const prevData = window.getTagTitlesByDate(prevDate);
                prevConsecutiveUp = prevData.consecutiveUp || { duoban: 0, bankuai: 0, ticai: 0, dapan: 0 };
            }
            
            // 每个项目独立判断：有今天数据用今天的，没有则用上个交易日的
            const consecutiveUp = {
                duoban: hasTodayData.duoban ? todayConsecutiveUp.duoban : prevConsecutiveUp.duoban,
                bankuai: hasTodayData.bankuai ? todayConsecutiveUp.bankuai : prevConsecutiveUp.bankuai,
                ticai: hasTodayData.ticai ? todayConsecutiveUp.ticai : prevConsecutiveUp.ticai,
                dapan: hasTodayData.dapan ? todayConsecutiveUp.dapan : prevConsecutiveUp.dapan
            };
            
            const maxDays = 10;
            const barHeightPercent = 150 / maxDays;
            

            function renderBar(type, days, hasData) {
                const barUp = document.getElementById('bar-up-' + type);
                const barDown = document.getElementById('bar-down-' + type);
                const daysEl = document.getElementById('days-' + type);
                
                if (!barUp || !barDown || !daysEl) return;
                
                barUp.style.height = '0';
                barDown.style.height = '0';
                barUp.dataset.value = 0;
                barDown.dataset.value = 0;
                
                barUp.classList.remove('dashed-bar');
                barDown.classList.remove('dashed-bar');
                daysEl.classList.remove('dashed-text');
                
                daysEl.style.bottom = '';
                daysEl.style.top = '';
                
                const isRed = days >= 3;
                const barColor = isRed 
                    ? 'linear-gradient(to top, #ef4444, #f87171)' 
                    : 'linear-gradient(to top, #10b981, #34d399)';
                const textColor = isRed ? '#ef4444' : '#10b981';
                
                if (days > 0) {
                    const barHeight = days * barHeightPercent;
                    barUp.style.height = barHeight + 'px';
                    barUp.style.background = hasData ? barColor : 'transparent';
                    barUp.dataset.value = days;
                    
                    if (!hasData) {
                        barUp.classList.add('dashed-bar');
                        daysEl.classList.add('dashed-text');
                    }
                    
                    daysEl.textContent = '+' + days + '天';
                    daysEl.style.color = hasData ? textColor : '#9ca3af';
                    daysEl.className = 'bar-days ' + (isRed ? 'positive-red' : 'positive-green');
                    if (!hasData) daysEl.classList.add('dashed-text');
                    daysEl.style.bottom = 'calc(50% + ' + (barHeight + 3) + 'px)';
                } else if (days < 0) {
                    const barHeight = Math.abs(days) * barHeightPercent;
                    barDown.style.height = barHeight + 'px';
                    barDown.style.background = hasData ? 'linear-gradient(to bottom, #10b981, #34d399)' : 'transparent';
                    barDown.dataset.value = days;
                    
                    if (!hasData) {
                        barDown.classList.add('dashed-bar');
                        daysEl.classList.add('dashed-text');
                    }
                    
                    daysEl.textContent = days + '天';
                    daysEl.style.color = hasData ? '#10b981' : '#9ca3af';
                    daysEl.className = 'bar-days negative-green';
                    if (!hasData) daysEl.classList.add('dashed-text');
                    daysEl.style.top = 'calc(50% + ' + (barHeight + 3) + 'px)';
                } else {
                    daysEl.textContent = '0天';
                    daysEl.className = 'bar-days zero';
                    if (!hasData) {
                        daysEl.classList.add('dashed-text');
                        daysEl.style.color = '#9ca3af';
                    }
                    daysEl.style.bottom = 'calc(50% + 5px)';
                }
            }
            window.renderBar = renderBar;
            
            window.renderBar('duoban', consecutiveUp.duoban || 0, hasTodayData.duoban);
            window.renderBar('bankuai', consecutiveUp.bankuai || 0, hasTodayData.bankuai);
            window.renderBar('ticai', consecutiveUp.ticai || 0, hasTodayData.ticai);
            window.renderBar('dapan', consecutiveUp.dapan || 0, hasTodayData.dapan);
            
            // 计算连赚
            const lianzhuanResult = window.calculateConsecutiveProfit();
            window.renderBar('lianzhuan', lianzhuanResult.days, lianzhuanResult.hasData);
        }

        // 计算连赚（基于今日盈亏）

        // 计算连赚（基于今日盈亏）
        export function calculateConsecutiveProfit() {
            const jiwangData = window.getJiwangData();
            
            const todayStats = jiwangData[window.currentDate]?.stats;
            const todayProfit = todayStats?.profit;
            const hasTodayProfit = todayProfit !== undefined && todayProfit !== '' && !isNaN(parseFloat(todayProfit));
            
            if (hasTodayProfit) {
                const todayValue = parseFloat(todayProfit);
                let days = 0;
                let lastSign = null;
                
                if (todayValue > 0) {
                    lastSign = 'positive';
                    days = 1;
                } else if (todayValue < 0) {
                    lastSign = 'negative';
                    days = -1;
                }
                
                if (lastSign) {
                    let prevDate = window.getPreviousTradingDay(window.currentDate);
                    
                    while (prevDate) {
                        const prevStats = jiwangData[prevDate]?.stats;
                        const prevProfit = prevStats?.profit;
                        
                        if (prevProfit !== undefined && prevProfit !== '' && !isNaN(parseFloat(prevProfit))) {
                            const prevValue = parseFloat(prevProfit);
                            
                            if (prevValue > 0 && lastSign === 'positive') {
                                days++;
                            } else if (prevValue < 0 && lastSign === 'negative') {
                                days--;
                            } else {
                                break;
                            }
                        } else {
                            break;
                        }
                        
                        prevDate = window.getPreviousTradingDay(prevDate);
                    }
                    
                    return { days: days, hasData: true };
                }
                
                return { days: 0, hasData: true };
            }
            
            // 今天没有今日盈亏数据，查找上一个有今日盈亏数据的交易日
            const prevDateWithProfit = window.getPreviousTradingDayWithProfit(window.currentDate);
            if (prevDateWithProfit) {
                const prevDays = window.calculateConsecutiveProfitForDate(prevDateWithProfit);
                return { days: prevDays, hasData: false };
            }
            
            return { days: 0, hasData: false };
        }

        // 计算指定日期的连赚天数

        // 计算指定日期的连赚天数
        export function calculateConsecutiveProfitForDate(dateStr) {
            const jiwangData = window.getJiwangData();
            const stats = jiwangData[dateStr]?.stats;
            const profit = stats?.profit;
            
            if (profit === undefined || profit === '' || isNaN(parseFloat(profit))) {
                return 0;
            }
            
            const value = parseFloat(profit);
            let days = 0;
            let lastSign = null;
            
            if (value > 0) {
                lastSign = 'positive';
                days = 1;
            } else if (value < 0) {
                lastSign = 'negative';
                days = -1;
            } else {
                return 0;
            }
            
            let prevDate = window.getPreviousTradingDay(dateStr);
            
            while (prevDate) {
                const prevStats = jiwangData[prevDate]?.stats;
                const prevProfit = prevStats?.profit;
                
                if (prevProfit !== undefined && prevProfit !== '' && !isNaN(parseFloat(prevProfit))) {
                    const prevValue = parseFloat(prevProfit);
                    
                    if (prevValue > 0 && lastSign === 'positive') {
                        days++;
                    } else if (prevValue < 0 && lastSign === 'negative') {
                        days--;
                    } else {
                        break;
                    }
                } else {
                    break;
                }
                
                prevDate = window.getPreviousTradingDay(prevDate);
            }
            
            return days;
        }

        // 获取上一个有今日盈亏数据的交易日

        // 获取上一个有今日盈亏数据的交易日
        export function getPreviousTradingDayWithProfit(dateStr) {
            const jiwangData = window.getJiwangData();
            
            let prevDate = window.getPreviousTradingDay(dateStr);
            
            while (prevDate) {
                const stats = jiwangData[prevDate]?.stats;
                const profit = stats?.profit;
                
                if (profit !== undefined && profit !== '' && !isNaN(parseFloat(profit))) {
                    return prevDate;
                }
                
                prevDate = window.getPreviousTradingDay(prevDate);
            }
            
            return null;
        }

        // 获取上一个交易日
        // [PERF-CORE] 结果 memo：日历事实不会变，假期表引用变化时自动失效。
        // 该函数此前在每次看板计算里被调用数百次（每行标签派生都要回扫一次），
        // memo 后降为 O(1) 查表。
        const _prevTdMemo = new Map();

        export function getPreviousTradingDay(dateStr) {
            if (!dateStr) return null;
            const hol = window.getHolidays();
            const cached = _prevTdMemo.get(dateStr);
            if (cached && cached.hol === hol) return cached.v;
            const date = new Date(dateStr + 'T00:00:00');
            date.setDate(date.getDate() - 1);
            let result = null;
            // 最多查找60天防止死循环
            for (let i = 0; i < 60; i++) {
                const year = date.getFullYear();
                const month = String(date.getMonth() + 1).padStart(2, '0');
                const day = String(date.getDate()).padStart(2, '0');
                const checkDateStr = `${year}-${month}-${day}`;

                if (checkDateStr < '2025-01-01') { result = null; break; }

                if (window.isTradingDay(checkDateStr)) {
                    result = checkDateStr;
                    break;
                }

                date.setDate(date.getDate() - 1);
            }
            _prevTdMemo.set(dateStr, { hol: hol, v: result });
            return result;
        }

        // 获取 N 个交易日前的日期（递归调用 getPreviousTradingDay）

        // 判断是否为非交易日（周末或用户标记的休假）
        export function isWeekend(dateStr) {
            // 先判断是否为周末
            const date = new Date(dateStr + 'T00:00:00');
            const day = date.getDay();
            if (day === 0 || day === 6) return true;
            
            // 再判断是否为用户标记的休假
            return !window.isTradingDay(dateStr);
        }

        // 获取本周交易日范围（周一到周五）

        // 获取本周交易日范围（周一到周五）
        export function getWeekTradingDays(dateStr) {
            const date = new Date(dateStr + 'T00:00:00');
            const day = date.getDay(); // 0=周日, 1=周一, ..., 6=周六
            
            // 计算本周一和本周五
            let monday = new Date(date);
            let friday = new Date(date);
            
            if (day === 0) { // 周日，回退到本周一（减6天），本周五就是上周五（减2天）
                monday.setDate(date.getDate() - 6);
                friday.setDate(date.getDate() - 2);
            } else if (day === 6) { // 周六，回退到本周一（减5天），本周五就是上周五（减1天）
                monday.setDate(date.getDate() - 5);
                friday.setDate(date.getDate() - 1);
            } else { // 工作日
                const diffToMonday = day - 1;
                const diffToFriday = 5 - day;
                monday.setDate(date.getDate() - diffToMonday);
                friday.setDate(date.getDate() + diffToFriday);
            }
            
            const formatDate = (d) => {
                const year = d.getFullYear();
                const month = String(d.getMonth() + 1).padStart(2, '0');
                const day = String(d.getDate()).padStart(2, '0');
                return `${year}-${month}-${day}`;
            };
            
            return {
                monday: formatDate(monday),
                friday: formatDate(friday),
                mondayObj: monday,
                fridayObj: friday
            };
        }

        // 获取上周五的日期

        // 获取上周五的日期
        export function getLastFriday(dateStr) {
            const date = new Date(dateStr + 'T00:00:00');
            const day = date.getDay();
            
            let friday = new Date(date);
            if (day === 0) { // 周日，回退2天到周五
                friday.setDate(date.getDate() - 2);
            } else if (day === 6) { // 周六，回退1天到周五
                friday.setDate(date.getDate() - 1);
            } else {
                // 工作日，回退到上周五
                const daysToSubtract = day + 2; // 周一(1)回退3天，周二(2)回退4天...
                friday.setDate(date.getDate() - daysToSubtract);
            }
            
            const year = friday.getFullYear();
            const month = String(friday.getMonth() + 1).padStart(2, '0');
            const dayStr = String(friday.getDate()).padStart(2, '0');
            return `${year}-${month}-${dayStr}`;
        }

        // 获取本月日期范围（月初到月末）

        // 获取本月日期范围（月初到月末）
        export function getMonthTradingDays(dateStr) {
            const date = new Date(dateStr + 'T00:00:00');
            const year = date.getFullYear();
            const month = date.getMonth();
            
            // 本月第一天
            const firstDay = new Date(year, month, 1);
            // 本月最后一天
            const lastDay = new Date(year, month + 1, 0);
            
            const formatDate = (d) => {
                const y = d.getFullYear();
                const m = String(d.getMonth() + 1).padStart(2, '0');
                const day = String(d.getDate()).padStart(2, '0');
                return `${y}-${m}-${day}`;
            };
            
            return {
                firstDay: formatDate(firstDay),
                lastDay: formatDate(lastDay),
                firstDayObj: firstDay,
                lastDayObj: lastDay
            };
        }

        // 显示本周统计（用于导航按钮）- 跳转到当前日期所在周的周六

        // 显示本周统计（用于导航按钮）- 跳转到当前日期所在周的周六
        export function showWeeklyStats() {
            // 隐藏月统计看板
            const monthlyBoard = document.getElementById('monthlyStatsBoard');
            if (monthlyBoard) {
                monthlyBoard.classList.remove('active');
            }
            
            // 只在非周末日期保存跳转前的日期
            if (!window.isWeekend(window.currentDate)) {
                localStorage.setItem('statsNavBeforeDate', window.currentDate);
            }
            
            // 基于当前查看的日期计算，而不是今天
            const baseDate = new Date(window.currentDate + 'T00:00:00');
            const dayOfWeek = baseDate.getDay(); // 0=周日, 1=周一, ..., 6=周六
            
            // 计算本周六的日期
            let saturday = new Date(baseDate);
            let daysToSaturday;
            
            if (dayOfWeek === 0) {
                // 周日：显示上周六（昨天）
                daysToSaturday = -1;
            } else {
                // 周一到周六：计算距离本周六还有几天（周六是6）
                daysToSaturday = (6 - dayOfWeek + 7) % 7;
            }
            
            saturday.setDate(baseDate.getDate() + daysToSaturday);
            
            // 格式化日期
            const year = saturday.getFullYear();
            const month = String(saturday.getMonth() + 1).padStart(2, '0');
            const day = String(saturday.getDate()).padStart(2, '0');
            const saturdayStr = `${year}-${month}-${day}`;
            
            // 跳转到周六
            window.setCurrentDate(saturdayStr);
            window.allData = null;
            window.setFilter('all');
            window.renderList();
            // 重新计算评分
            window.autoCalculateRecentMultiScore();
        }

        // 显示上周统计（用于导航按钮）- 跳转到上周六

        // 显示上周统计（用于导航按钮）- 跳转到上周六
        export function showLastWeekStats() {
            // 隐藏月统计看板
            const monthlyBoard = document.getElementById('monthlyStatsBoard');
            if (monthlyBoard) {
                monthlyBoard.classList.remove('active');
            }
            
            // 只在非周末日期保存跳转前的日期
            if (!window.isWeekend(window.currentDate)) {
                localStorage.setItem('statsNavBeforeDate', window.currentDate);
            }
            
            // 基于当前查看的日期计算，而不是今天
            const baseDate = new Date(window.currentDate + 'T00:00:00');
            const dayOfWeek = baseDate.getDay(); // 0=周日, 1=周一, ..., 6=周六
            
            // 计算上周六的日期
            let lastSaturday = new Date(baseDate);
            
            // 距离上周六的天数
            // 周六(6): -7天, 周日(0): -1天, 周一(1): -2天, 周二(2): -3天
            // 周三(3): -4天, 周四(4): -5天, 周五(5): -6天
            const daysToLastSaturday = -((dayOfWeek + 1) % 7 + 6) % 7 - 1;
            
            lastSaturday.setDate(baseDate.getDate() + daysToLastSaturday);
            
            // 格式化日期
            const year = lastSaturday.getFullYear();
            const month = String(lastSaturday.getMonth() + 1).padStart(2, '0');
            const day = String(lastSaturday.getDate()).padStart(2, '0');
            const lastSaturdayStr = `${year}-${month}-${day}`;
            
            // 跳转到上周六
            window.setCurrentDate(lastSaturdayStr);
            window.allData = null;
            window.setFilter('all');
            window.renderList();
            // 重新计算评分
            window.autoCalculateRecentMultiScore();
        }
        
        // 显示本月统计（用于导航按钮）- 显示月统计看板（不跳转日期）

        // 显示本月统计（用于导航按钮）- 显示月统计看板（不跳转日期）
        export function showMonthlyStats() {
            // 只在非周末日期保存跳转前的日期
            if (!window.isWeekend(window.currentDate)) {
                localStorage.setItem('statsNavBeforeDate', window.currentDate);
            }
            
            // 如果是交易日，跳转到本周六
            if (!window.isWeekend(window.currentDate)) {
                const date = new Date(window.currentDate + 'T00:00:00');
                const dayOfWeek = date.getDay();
                // 计算本周六的日期
                const saturday = new Date(date);
                saturday.setDate(date.getDate() + (6 - dayOfWeek));
                const saturdayStr = saturday.toISOString().split('T')[0];
                
                // 跳转到周六
                window.setCurrentDate(saturdayStr);
                window.allData = null;
                window.setFilter('all');
                window.renderList();
                window.autoCalculateRecentMultiScore();
                return;
            }
            
            // 周末时显示月统计看板
            const monthlyBoard = document.getElementById('monthlyStatsBoard');
            const weekendBoard = document.getElementById('weekendStatsBoard');
            
            if (monthlyBoard && weekendBoard) {
                monthlyBoard.classList.add('active');
                weekendBoard.classList.remove('active');
                window.renderMonthlyStats();
            }
        }

        // 渲染周末统计

        // 渲染周末统计
        export function renderWeekendStats() {
            const weekendBoard = document.getElementById('weekendStatsBoard');
            const monthlyBoard = document.getElementById('monthlyStatsBoard');
            const isWeekendDay = window.isWeekend(window.currentDate);
            
            // 获取当前是周几：0=周日, 6=周六
            const date = new Date(window.currentDate + 'T00:00:00');
            const dayOfWeek = date.getDay();
            
            // 显示或隐藏统计看板，切换body class
            if (isWeekendDay) {
                document.body.classList.add('weekend-mode');
                // 先清除之前的模式
                document.body.classList.remove('saturday-mode', 'sunday-mode');
                if (dayOfWeek === 6) {
                    // 周六显示周统计
                    weekendBoard.classList.add('active');
                    monthlyBoard.classList.remove('active');
                    document.body.classList.add('saturday-mode');
                    // 渲染周统计
                    window.renderWeeklyStats();
                } else {
                    // 周日显示周末总结模板
                    weekendBoard.classList.add('active');
                    monthlyBoard.classList.remove('active');
                    document.body.classList.add('sunday-mode');
                    // 渲染周末总结
                    window.renderWeekendSummary();
                }
            } else {
                // 交易日：只隐藏周统计看板，不隐藏月统计看板（月统计看板由用户手动控制）
                weekendBoard.classList.remove('active');
                document.body.classList.remove('weekend-mode', 'saturday-mode', 'sunday-mode');
                return;
            }
        }
        
        // 渲染"总计统计"（固定从2026-02-01统计到"当前翻看的日期"，不随周/月切换而重新框定统计口径，
        // 但会随你翻页查看的日期变化——翻到6-27就统计到6-27，翻到今天就统计到今天）
        // suffix: '' 用于本周/上周统计看板的元素id，'M' 用于本月统计看板的元素id

        // 渲染"总计统计"（固定从2026-02-01统计到"当前翻看的日期"，不随周/月切换而重新框定统计口径，
        // 但会随你翻页查看的日期变化——翻到6-27就统计到6-27，翻到今天就统计到今天）
        // suffix: '' 用于本周/上周统计看板的元素id，'M' 用于本月统计看板的元素id
        export function renderTotalStats(suffix) {
            const TOTAL_START_DATE = '2026-02-01';

            // 结束日期：使用当前正在翻看的 window.currentDate（而不是系统真实的今天）
            const todayStr = window.currentDate;

            let tradingDaysCount = 0;
            let emptyCount = 0;
            let chushouCount = 0;
            let emptyRightCount = 0;
            let emptyWrongCount = 0;
            let chushouRightCount = 0;
            let chushouWrongCount = 0;

            const jiwangData = window.getJiwangData();
            let currentCheck = new Date(TOTAL_START_DATE + 'T00:00:00');
            const endCheck = new Date(todayStr + 'T00:00:00');

            while (currentCheck <= endCheck) {
                const year = currentCheck.getFullYear();
                const month = String(currentCheck.getMonth() + 1).padStart(2, '0');
                const day = String(currentCheck.getDate()).padStart(2, '0');
                const dateStr = `${year}-${month}-${day}`;

                if (window.isTradingDay(dateStr)) {
                    tradingDaysCount++;
                    const dayJiwang = jiwangData[dateStr];
                    if (dayJiwang) {
                        if (dayJiwang.jielun === '空仓') {
                            emptyCount++;
                        } else if (dayJiwang.jielun === '出手') {
                            chushouCount++;
                        }
                        if (dayJiwang.chushou === '空仓对了') {
                            emptyRightCount++;
                        } else if (dayJiwang.chushou === '空仓错了') {
                            emptyWrongCount++;
                        } else if (dayJiwang.chushou === '出手对了') {
                            chushouRightCount++;
                        } else if (dayJiwang.chushou === '出手错了') {
                            chushouWrongCount++;
                        }
                    }
                }

                currentCheck.setDate(currentCheck.getDate() + 1);
            }

            const emptyWinRate = emptyCount > 0 ? ((emptyRightCount / emptyCount) * 100).toFixed(1) : '0.0';
            const chushouWinRate = chushouCount > 0 ? ((chushouRightCount / chushouCount) * 100).toFixed(1) : '0.0';
            const unrecordedCount = tradingDaysCount - emptyCount - chushouCount; // 未记录/未填写"得出结论"的交易日天数

            const setText = (id, value) => {
                const el = document.getElementById(id);
                if (el) el.textContent = value;
            };

            setText('totalDateRange' + suffix, `${TOTAL_START_DATE} 至 ${todayStr}`);
            setText('totalTradingDays' + suffix, tradingDaysCount);
            setText('totalEmptyCount' + suffix, emptyCount);
            setText('totalChushouCount' + suffix, chushouCount);
            setText('totalUnrecordedCount' + suffix, unrecordedCount);
            setText('totalEmptyRightCount' + suffix, emptyRightCount);
            setText('totalEmptyWrongCount' + suffix, emptyWrongCount);
            setText('totalChushouRightCount' + suffix, chushouRightCount);
            setText('totalChushouWrongCount' + suffix, chushouWrongCount);
            setText('totalEmptyWinRate' + suffix, emptyWinRate + '%');
            setText('totalChushouWinRate' + suffix, chushouWinRate + '%');
        }

        // 渲染周统计

        // 渲染周统计
        export function renderWeeklyStats() {
            // 设置标题为本周交易统计
            const titleEl = document.querySelector('#weekendStatsBoard .weekend-title');
            if (titleEl) {
                titleEl.textContent = '📊 本周交易统计';
            }
            
            const weekRange = window.getWeekTradingDays(window.currentDate);
            // [FIX] 不能把 window.allData 整体覆盖成“仅股票”的映射：
            // getJiwangData()/getRankData()/getEtfData() 都依赖 window.allData.jiwang/.rank/.etf
            // （经 loadAllData 的 500ms 缓存返回同一个对象）。若此处被覆盖成股票映射，
            // 后续读取 getJiwangData()[dateStr] 会得到 undefined 而抛错，导致整段统计渲染中断、全部显示 0。
            // 因此只取股票映射存到局部变量，window.allData 保持完整对象。
            const _stocksData = window.getStocksData() || {};
            const _rankData = window.getRankData() || {};
            const _etfData = window.getEtfData() || {};
            let _duibanData = {};
            try { _duibanData = JSON.parse(localStorage.getItem('duibanData') || '{}'); } catch (e) {}
            
            // 设置日期范围显示
            document.getElementById('weekendDateRange').textContent = 
                `${weekRange.monday} 至 ${weekRange.friday}`;
            
            // 统计本周数据
            let tradingDaysCount = 0; // 成交天数
            let emptyCount = 0; // 空仓次数（得出结论为空仓）
            let chushouCount = 0; // 出手次数（得出结论为出手）
            let emptyRightCount = 0; // 空仓对了次数
            let emptyWrongCount = 0; // 空仓错了次数
            let chushouRightCount = 0; // 出手对了次数
            let chushouWrongCount = 0; // 出手错了次数
            let duibanCount = 0;
            let topicCount = 0;
            let etfCheckedCount = 0;
            let duibanRightCount = 0; // 最近多板对了次数（同时勾选最近多板且出手/空仓对了）
            let topicRightCount = 0; // 题材方向对了次数
            let etfRightCount = 0; // 板块ETF对了次数
            let weekTotalProfit = 0; // 本周累计盈亏（正数表示赚，负数表示亏）
            
            const stockRankings = {}; // 股票上榜次数统计 {name: {count, concept}}
            const etfRankings = {}; // ETF勾选次数统计
            const duibanRankings = {}; // 最近多板表现统计 {jingtu: {count, shuliang}}
            const dailyProfits = []; // 每天盈亏数据 {date, profit}
            const dailyBalances = []; // 每天账户余额数据 {date, balance}
            
            // 遍历本周每一天
            let currentCheck = new Date(weekRange.mondayObj);
            const endCheck = new Date(weekRange.fridayObj);
            
            while (currentCheck <= endCheck) {
                const year = currentCheck.getFullYear();
                const month = String(currentCheck.getMonth() + 1).padStart(2, '0');
                const day = String(currentCheck.getDate()).padStart(2, '0');
                const dateStr = `${year}-${month}-${day}`;
                
                const tradingDay = window.isTradingDay(dateStr);
                
                // 只统计交易日
                if (tradingDay) {
                    tradingDaysCount++; // 成交天数+1
                    const dayData = _stocksData[dateStr] || [];
                    
                    // 1. 统计出手情况（记忘看板中"得出结论"和"出手情况"）
                    const dayJiwang = window.getJiwangData()[dateStr];
                    if (dayJiwang) {
                        // 统计得出结论
                        if (dayJiwang.jielun === '空仓') {
                            emptyCount++;
                        } else if (dayJiwang.jielun === '出手') {
                            chushouCount++;
                        }
                        // 统计出手情况
                        if (dayJiwang.chushou === '空仓对了') {
                            emptyRightCount++;
                        } else if (dayJiwang.chushou === '空仓错了') {
                            emptyWrongCount++;
                        } else if (dayJiwang.chushou === '出手对了') {
                            chushouRightCount++;
                        } else if (dayJiwang.chushou === '出手错了') {
                            chushouWrongCount++;
                        }
                    }
                    
                    // 2. 统计最近多板记录数（从圆形统计stats.recentMulti统计）
                    // 并判断是否同时"对了"
                    const dayJiwangStats = dayJiwang ? dayJiwang.stats : null;
                    const isDuibanChecked = dayJiwangStats && dayJiwangStats.recentMulti === true;
                    const isTopicChecked = dayJiwangStats && dayJiwangStats.topicDirection === true;
                    const isEtfChecked = dayJiwangStats && dayJiwangStats.sectorEtf === true;
                    const isRight = dayJiwang && (dayJiwang.chushou === '空仓对了' || dayJiwang.chushou === '出手对了');
                    
                    if (isDuibanChecked) {
                        duibanCount++;
                        if (isRight) duibanRightCount++;
                    }
                    
                    // 3. 统计题材方向记录数（从圆形统计stats.topicDirection统计）
                    if (isTopicChecked) {
                        topicCount++;
                        if (isRight) topicRightCount++;
                    }
                    
                    // 4. 统计板块ETF记录数（从圆形统计stats.sectorEtf统计）
                    if (isEtfChecked) {
                        etfCheckedCount++;
                        if (isRight) etfRightCount++;
                    }
                    
                    // 5. 统计昨日最大成交额上榜股票（从allData.rank获取）
                    const rankData = _rankData;
                    const dayRank = rankData[dateStr];
                    if (dayRank && Array.isArray(dayRank)) {
                        dayRank.forEach(item => {
                            if (item.stock) {
                                if (!stockRankings[item.stock]) {
                                    stockRankings[item.stock] = { count: 0, concept: '' };
                                }
                                stockRankings[item.stock].count++;
                                // 实时更新题材概念（取最新的）
                                if (item.concept) {
                                    stockRankings[item.stock].concept = item.concept;
                                }
                            }
                        });
                    }

                    // 6. 统计最近多板表现（从duibanData获取）
                    const duibanData = _duibanData;
                    const dayDuiban = duibanData[dateStr];
                    if (dayDuiban && Array.isArray(dayDuiban)) {
                        dayDuiban.forEach(item => {
                            if (item.jingtu) {
                                if (!duibanRankings[item.jingtu]) {
                                    duibanRankings[item.jingtu] = { count: 0, shuliang: 0 };
                                }
                                duibanRankings[item.jingtu].count++;
                                // 累计数量（shuliang字段）
                                const shuliangNum = parseFloat(item.shuliang) || 0;
                                duibanRankings[item.jingtu].shuliang += shuliangNum;
                            }
                        });
                    }

                    // 7. 统计早盘板块ETF表现（从stockEtfData获取）
                    const etfData = _etfData;
                    const dayEtf = etfData[dateStr];
                    if (dayEtf && Array.isArray(dayEtf)) {
                        dayEtf.forEach(item => {
                            if (item.name) {
                                if (!etfRankings[item.name]) {
                                    etfRankings[item.name] = { count: 0, yizi: 0 };
                                }
                                etfRankings[item.name].count++;
                                // 累计数量（yizi字段）
                                const yiziNum = parseFloat(item.yizi) || 0;
                                etfRankings[item.name].yizi += yiziNum;
                            }
                        });
                    }
                    
                    // 8. 统计盈亏（从dayJiwang.stats.profit获取，复用上面已获取的dayJiwang）
                    let todayProfit = 0;
                    let todayBalance = null;
                    if (dayJiwang && dayJiwang.stats && dayJiwang.stats.profit !== undefined && dayJiwang.stats.profit !== '') {
                        todayProfit = parseFloat(dayJiwang.stats.profit) || 0;
                        weekTotalProfit += todayProfit; // 累计每天盈亏
                    }
                    // 获取当天账户余额
                    if (dayJiwang && dayJiwang.stats && dayJiwang.stats.balance !== undefined && dayJiwang.stats.balance !== '') {
                        todayBalance = parseFloat(dayJiwang.stats.balance) || null;
                    }
                    // 记录每天盈亏数据（无论是否有数据都记录，没有则为0）
                    dailyProfits.push({
                        date: dateStr,
                        dateLabel: `${month}/${day}`,
                        profit: todayProfit
                    });
                    // 记录每天账户余额数据
                    dailyBalances.push({
                        date: dateStr,
                        dateLabel: `${month}/${day}`,
                        balance: todayBalance
                    });
                }
                
                currentCheck.setDate(currentCheck.getDate() + 1);
            }
            
            // 更新概览统计
            document.getElementById('weekendEmptyCount').textContent = emptyCount;
            document.getElementById('weekendDuibanCount').textContent = duibanCount;
            document.getElementById('weekendTopicCount').textContent = topicCount;
            document.getElementById('weekendEtfCount').textContent = etfCheckedCount;
            
            // 计算记录统计胜率（必须同时满足：勾选了记录类型 且 出手/空仓对了）
            // 最近多板胜率 = 最近多板对了次数 / 最近多板记录次数
            const duibanWinRate = duibanCount > 0 
                ? ((duibanRightCount / duibanCount) * 100).toFixed(1) 
                : '0.0';
            document.getElementById('weekendDuibanWinRate').textContent = duibanWinRate + '%';
            
            // 题材方向胜率 = 题材方向对了次数 / 题材方向记录次数
            const topicWinRate = topicCount > 0 
                ? ((topicRightCount / topicCount) * 100).toFixed(1) 
                : '0.0';
            document.getElementById('weekendTopicWinRate').textContent = topicWinRate + '%';
            
            // 板块ETF胜率 = 板块ETF对了次数 / 板块ETF记录次数
            const etfWinRate = etfCheckedCount > 0 
                ? ((etfRightCount / etfCheckedCount) * 100).toFixed(1) 
                : '0.0';
            document.getElementById('weekendEtfWinRate').textContent = etfWinRate + '%';
            
            // 更新出手情况统计
            document.getElementById('weekendTradingDays').textContent = tradingDaysCount;
            document.getElementById('weekendChushouCount').textContent = chushouCount;
            document.getElementById('weekendEmptyRightCount').textContent = emptyRightCount;
            document.getElementById('weekendEmptyWrongCount').textContent = emptyWrongCount;
            document.getElementById('weekendChushouRightCount').textContent = chushouRightCount;
            document.getElementById('weekendChushouWrongCount').textContent = chushouWrongCount;
            
            // 计算并更新胜率
            const emptyWinRate = emptyCount > 0 ? ((emptyRightCount / emptyCount) * 100).toFixed(1) : 0;
            const chushouWinRate = chushouCount > 0 ? ((chushouRightCount / chushouCount) * 100).toFixed(1) : 0;
            document.getElementById('weekendEmptyWinRate').textContent = emptyWinRate + '%';
            document.getElementById('weekendChushouWinRate').textContent = chushouWinRate + '%';
            
            // 更新总计统计（固定从2026-02-01统计到今天）
            window.renderTotalStats('');
            
            // 更新上榜最多股票
            const sortedStocks = Object.entries(stockRankings)
                .sort((a, b) => b[1].count - a[1].count);

            const topStocksEl = document.getElementById('weekendTopStocks');
            if (sortedStocks.length > 0) {
                topStocksEl.innerHTML = sortedStocks.map(([name, data]) => `
                    <div class="weekend-stock-item">
                        <span class="weekend-stock-name">${name}</span>
                        <span class="weekend-stock-concept" style="font-size:12px;color:#64748b;margin:0 8px;">${data.concept || '-'}</span>
                        <span class="weekend-stock-count">${data.count}次</span>
                    </div>
                `).join('');
            } else {
                topStocksEl.innerHTML = '<div class="weekend-stock-item"><span class="weekend-stock-name">暂无数据</span></div>';
            }
            
            // 更新最近多板表现统计
            const sortedDuiban = Object.entries(duibanRankings)
                .sort((a, b) => b[1].count - a[1].count)
                .slice(0, 5);

            const duibanPerfEl = document.getElementById('weekendDuibanPerformance');
            if (sortedDuiban.length > 0) {
                duibanPerfEl.innerHTML = sortedDuiban.map(([jingtu, data]) => {
                    return `
                        <div class="weekend-stock-item" style="display: grid; grid-template-columns: 1fr 60px 50px; gap: 8px; align-items: center;">
                            <span class="weekend-stock-name" style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${jingtu}</span>
                            <span style="font-size:12px;color:#64748b;text-align:center;">${data.shuliang || 0}</span>
                            <span class="weekend-stock-count" style="justify-self: end;">${data.count}次</span>
                        </div>
                    `;
                }).join('');
            } else {
                duibanPerfEl.innerHTML = '<div class="weekend-stock-item"><span class="weekend-stock-name">暂无数据</span></div>';
            }

            // 更新ETF统计（按数量yizi由高到低排序）
            const sortedEtfs = Object.entries(etfRankings)
                .sort((a, b) => (b[1].yizi || 0) - (a[1].yizi || 0))
                .slice(0, 5);

            const topEtfsEl = document.getElementById('weekendTopEtfs');
            if (sortedEtfs.length > 0) {
                topEtfsEl.innerHTML = sortedEtfs.map(([name, data]) => {
                    const nameWithEtf = name.endsWith('ETF') ? name : name + 'ETF';
                    return `
                        <div class="weekend-stock-item" style="display: grid; grid-template-columns: 1fr 60px 50px; gap: 8px; align-items: center;">
                            <span class="weekend-stock-name" style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${nameWithEtf}</span>
                            <span style="font-size:12px;color:#64748b;text-align:center;">${data.yizi || 0}</span>
                            <span class="weekend-stock-count" style="justify-self: end;">${data.count}次</span>
                        </div>
                    `;
                }).join('');
            } else {
                topEtfsEl.innerHTML = '<div class="weekend-stock-item"><span class="weekend-stock-name">暂无数据</span></div>';
            }
            
            // 更新盈亏统计（根据本周累计盈亏决定显示位置）
            if (weekTotalProfit >= 0) {
                // 整体盈利，显示在"赚"格
                document.getElementById('weekendTotalProfit').textContent = weekTotalProfit.toFixed(0);
                document.getElementById('weekendTotalLoss').textContent = '0';
            } else {
                // 整体亏损，显示在"亏"格（前面加负号）
                document.getElementById('weekendTotalProfit').textContent = '0';
                document.getElementById('weekendTotalLoss').textContent = '-' + Math.abs(weekTotalProfit).toFixed(0);
            }
            
            // 获取本周最后一个交易日的账户余额
            const jiwangData = window.getJiwangData();
            let lastTradingBalance = '-';
            
            // 从本周最后一天（周五）往前遍历，找到最后一个有数据的交易日
            let checkDate = new Date(weekRange.fridayObj);
            const startDate = new Date(weekRange.mondayObj);
            while (checkDate >= startDate) {
                const year = checkDate.getFullYear();
                const month = String(checkDate.getMonth() + 1).padStart(2, '0');
                const day = String(checkDate.getDate()).padStart(2, '0');
                const dateStr = `${year}-${month}-${day}`;
                
                // 只检查交易日
                if (window.isTradingDay(dateStr)) {
                    if (jiwangData[dateStr] && jiwangData[dateStr].stats && jiwangData[dateStr].stats.balance) {
                        const balance = parseFloat(jiwangData[dateStr].stats.balance);
                        if (!isNaN(balance)) {
                            lastTradingBalance = balance.toLocaleString('zh-CN');
                            break;
                        }
                    }
                }
                
                checkDate.setDate(checkDate.getDate() - 1);
            }
            
            document.getElementById('weekendBalance').textContent = lastTradingBalance;
            
            // 绘制本周盈亏曲线图
            window.drawProfitChart('weekendProfitChart', dailyProfits);
            
            // 绘制本周账户余额曲线图
            window.drawBalanceChart('weekendBalanceChart', dailyBalances);
            
            // 渲染本周总结心得
            window.renderWeeklySummary();
        }
        
        // 绘制账户余额曲线图

        // 绘制账户余额曲线图
        export function drawBalanceChart(canvasId, dailyBalances) {
            const canvas = document.getElementById(canvasId);
            if (!canvas) return;
            
            const ctx = canvas.getContext('2d');
            const width = canvas.width;
            const height = canvas.height;
            
            // 清空画布
            ctx.clearRect(0, 0, width, height);
            
            // 过滤掉没有余额数据的天数
            const validBalances = dailyBalances.filter(d => d.balance !== null);
            
            if (validBalances.length === 0) {
                // 无数据时显示提示
                ctx.fillStyle = '#9ca3af';
                ctx.font = '14px sans-serif';
                ctx.textAlign = 'center';
                ctx.fillText('暂无数据', width / 2, height / 2);
                return;
            }
            
            // 计算数据范围
            const balances = validBalances.map(d => d.balance);
            const maxBalance = Math.max(...balances);
            const minBalance = Math.min(...balances);
            const range = maxBalance - minBalance || 1;
            
            // 设置边距（与盈亏曲线一致）
            const padding = { top: 20, right: 10, bottom: 30, left: 50 };
            const chartWidth = width - padding.left - padding.right;
            const chartHeight = height - padding.top - padding.bottom;
            
            // 计算平均值线位置（作为参考线）
            const avgBalance = balances.reduce((a, b) => a + b, 0) / balances.length;
            const avgY = padding.top + chartHeight * ((maxBalance - avgBalance) / range);
            
            // 绘制平均值参考线（虚线样式）
            ctx.strokeStyle = '#9ca3af';
            ctx.lineWidth = 1.5;
            ctx.setLineDash([5, 5]);
            ctx.beginPath();
            ctx.moveTo(padding.left, avgY);
            ctx.lineTo(width - padding.right, avgY);
            ctx.stroke();
            ctx.setLineDash([]);
            
            // 绘制Y轴刻度
            ctx.fillStyle = '#6b7280';
            ctx.font = '10px sans-serif';
            ctx.textAlign = 'right';
            ctx.textBaseline = 'middle';
            
            // 最大值
            ctx.fillText(maxBalance.toFixed(0), padding.left - 5, padding.top);
            // 平均值
            ctx.fillText(avgBalance.toFixed(0), padding.left - 5, avgY);
            // 最小值
            ctx.fillText(minBalance.toFixed(0), padding.left - 5, padding.top + chartHeight);
            
            // 绘制折线（给右侧留出20px空间）
            const rightPadding = 20;
            const availableWidth = chartWidth - rightPadding;
            const stepX = availableWidth / (dailyBalances.length - 1 || 1);
            
            ctx.strokeStyle = '#3b82f6';
            ctx.lineWidth = 2;
            ctx.beginPath();
            
            let lastValidPoint = null;
            dailyBalances.forEach((data, index) => {
                const x = padding.left + index * stepX;
                const y = padding.top + chartHeight * ((maxBalance - (data.balance || maxBalance)) / range);
                
                if (data.balance !== null) {
                    if (lastValidPoint === null) {
                        ctx.moveTo(x, y);
                    } else {
                        ctx.lineTo(x, y);
                    }
                    lastValidPoint = { x, y };
                }
            });
            
            ctx.stroke();
            
            // 绘制数据点
            dailyBalances.forEach((data, index) => {
                if (data.balance === null) return;
                
                const x = padding.left + index * stepX;
                const y = padding.top + chartHeight * ((maxBalance - data.balance) / range);
                
                // 根据余额相对于平均值设置颜色（高于平均红色，低于平均绿色）
                const pointColor = data.balance >= avgBalance ? '#ef4444' : '#10b981';
                ctx.fillStyle = pointColor;
                ctx.beginPath();
                ctx.arc(x, y, 4, 0, Math.PI * 2);
                ctx.fill();
                
                // 绘制余额数字标签（在点的上方）
                ctx.fillStyle = pointColor;
                ctx.font = 'bold 10px sans-serif';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'bottom';
                ctx.fillText(data.balance.toFixed(0), x, y - 8);
                
                // 绘制日期标签（只显示部分，避免拥挤）
                if (dailyBalances.length <= 7 || index % Math.ceil(dailyBalances.length / 7) === 0) {
                    ctx.fillStyle = '#6b7280';
                    ctx.font = '9px sans-serif';
                    ctx.textAlign = 'center';
                    ctx.textBaseline = 'top';
                    ctx.fillText(data.dateLabel, x, height - padding.bottom + 5);
                }
            });
        }
        
        // 绘制盈亏曲线图

        // 绘制盈亏曲线图
        export function drawProfitChart(canvasId, dailyProfits) {
            const canvas = document.getElementById(canvasId);
            if (!canvas) return;
            
            const ctx = canvas.getContext('2d');
            const width = canvas.width;
            const height = canvas.height;
            
            // 清空画布
            ctx.clearRect(0, 0, width, height);
            
            if (dailyProfits.length === 0) {
                // 无数据时显示提示
                ctx.fillStyle = '#9ca3af';
                ctx.font = '14px sans-serif';
                ctx.textAlign = 'center';
                ctx.fillText('暂无数据', width / 2, height / 2);
                return;
            }
            
            // 计算数据范围
            const profits = dailyProfits.map(d => d.profit);
            const maxProfit = Math.max(...profits, 0);
            const minProfit = Math.min(...profits, 0);
            const range = maxProfit - minProfit || 1;
            
            // 设置边距
            const padding = { top: 20, right: 10, bottom: 30, left: 50 };
            const chartWidth = width - padding.left - padding.right;
            const chartHeight = height - padding.top - padding.bottom;
            
            // 计算零线位置
            const zeroY = padding.top + chartHeight * (maxProfit / range);
            
            // 绘制零线
            ctx.strokeStyle = '#9ca3af';
            ctx.lineWidth = 1.5;
            ctx.setLineDash([5, 5]);
            ctx.beginPath();
            ctx.moveTo(padding.left, zeroY);
            ctx.lineTo(width - padding.right, zeroY);
            ctx.stroke();
            ctx.setLineDash([]);
            
            // 绘制Y轴刻度
            ctx.fillStyle = '#6b7280';
            ctx.font = '10px sans-serif';
            ctx.textAlign = 'right';
            ctx.textBaseline = 'middle';
            
            // 最大值
            ctx.fillText(maxProfit.toFixed(0), padding.left - 5, padding.top);
            // 零值
            ctx.fillText('0', padding.left - 5, zeroY);
            // 最小值
            ctx.fillText(minProfit.toFixed(0), padding.left - 5, padding.top + chartHeight);
            
            // 绘制折线（给右侧留出20px空间）
            const rightPadding = 20;
            const availableWidth = chartWidth - rightPadding;
            const stepX = availableWidth / (dailyProfits.length - 1 || 1);
            
            ctx.strokeStyle = '#3b82f6';
            ctx.lineWidth = 2;
            ctx.beginPath();
            
            dailyProfits.forEach((data, index) => {
                const x = padding.left + index * stepX;
                const y = padding.top + chartHeight * ((maxProfit - data.profit) / range);
                
                if (index === 0) {
                    ctx.moveTo(x, y);
                } else {
                    ctx.lineTo(x, y);
                }
            });
            
            ctx.stroke();
            
            // 绘制数据点
            dailyProfits.forEach((data, index) => {
                const x = padding.left + index * stepX;
                const y = padding.top + chartHeight * ((maxProfit - data.profit) / range);
                
                // 根据盈亏设置颜色（绿色表示亏损，红色表示盈利）
                const pointColor = data.profit >= 0 ? '#ef4444' : '#10b981';
                ctx.fillStyle = pointColor;
                ctx.beginPath();
                ctx.arc(x, y, 4, 0, Math.PI * 2);
                ctx.fill();
                
                // 绘制盈亏数字标签（在点的上方）
                ctx.fillStyle = pointColor;
                ctx.font = 'bold 10px sans-serif';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'bottom';
                const profitText = data.profit >= 0 ? `+${data.profit.toFixed(0)}` : data.profit.toFixed(0);
                ctx.fillText(profitText, x, y - 8);
                
                // 绘制日期标签（只显示部分，避免拥挤）
                if (dailyProfits.length <= 7 || index % Math.ceil(dailyProfits.length / 7) === 0) {
                    ctx.fillStyle = '#6b7280';
                    ctx.font = '9px sans-serif';
                    ctx.textAlign = 'center';
                    ctx.textBaseline = 'top';
                    ctx.fillText(data.dateLabel, x, height - padding.bottom + 5);
                }
            });
        }
        
        // 渲染月统计

        // 渲染月统计
        export function renderMonthlyStats() {
            const monthRange = window.getMonthTradingDays(window.currentDate);
            const _rankData = window.getRankData() || {};
            const _etfData = window.getEtfData() || {};
            let _duibanData = {};
            try { _duibanData = JSON.parse(localStorage.getItem('duibanData') || '{}'); } catch (e) {}
            
            // 遍历本月每一天（只统计到当前日期为止）
            let currentCheck = new Date(monthRange.firstDayObj);
            const today = new Date(window.currentDate + 'T00:00:00');
            const endCheck = new Date(Math.min(monthRange.lastDayObj.getTime(), today.getTime()));
            
            // 设置日期范围显示（显示实际统计的范围）
            const formatDate = (d) => {
                const y = d.getFullYear();
                const m = String(d.getMonth() + 1).padStart(2, '0');
                const day = String(d.getDate()).padStart(2, '0');
                return `${y}-${m}-${day}`;
            };
            document.getElementById('monthlyDateRange').textContent = 
                `${monthRange.firstDay} 至 ${formatDate(endCheck)}`;
            
            // 统计本月数据
            let tradingDaysCount = 0; // 成交天数
            let emptyCount = 0; // 空仓次数
            let chushouCount = 0; // 出手次数
            let emptyRightCount = 0; // 空仓对了次数
            let emptyWrongCount = 0; // 空仓错了次数
            let chushouRightCount = 0; // 出手对了次数
            let chushouWrongCount = 0; // 出手错了次数
            let duibanCount = 0;
            let topicCount = 0;
            let etfCheckedCount = 0;
            let duibanRightCount = 0; // 最近多板对了次数（同时勾选最近多板且出手/空仓对了）
            let topicRightCount = 0; // 题材方向对了次数
            let etfRightCount = 0; // 板块ETF对了次数
            let monthTotalProfit = 0; // 本月累计盈亏
            
            const stockRankings = {}; // 股票上榜次数统计
            const etfRankings = {}; // ETF勾选次数统计
            const duibanRankings = {}; // 最近多板表现统计
            const dailyProfits = []; // 每天盈亏数据 {date, profit}
            const dailyBalances = []; // 每天账户余额数据 {date, balance}
            
            while (currentCheck <= endCheck) {
                const year = currentCheck.getFullYear();
                const month = String(currentCheck.getMonth() + 1).padStart(2, '0');
                const day = String(currentCheck.getDate()).padStart(2, '0');
                const dateStr = `${year}-${month}-${day}`;
                
                const tradingDay = window.isTradingDay(dateStr);
                
                // 只统计交易日
                if (tradingDay) {
                    tradingDaysCount++;
                    const dayJiwang = window.getJiwangData()[dateStr];
                    
                    if (dayJiwang) {
                        // 统计得出结论
                        if (dayJiwang.jielun === '空仓') {
                            emptyCount++;
                        } else if (dayJiwang.jielun === '出手') {
                            chushouCount++;
                        }
                        // 统计出手情况
                        if (dayJiwang.chushou === '空仓对了') {
                            emptyRightCount++;
                        } else if (dayJiwang.chushou === '空仓错了') {
                            emptyWrongCount++;
                        } else if (dayJiwang.chushou === '出手对了') {
                            chushouRightCount++;
                        } else if (dayJiwang.chushou === '出手错了') {
                            chushouWrongCount++;
                        }
                    }
                    
                    // 统计最近多板记录数
                    // 并判断是否同时"对了"
                    const dayJiwangStats = dayJiwang ? dayJiwang.stats : null;
                    const isDuibanChecked = dayJiwangStats && dayJiwangStats.recentMulti === true;
                    const isTopicChecked = dayJiwangStats && dayJiwangStats.topicDirection === true;
                    const isEtfChecked = dayJiwangStats && dayJiwangStats.sectorEtf === true;
                    const isRight = dayJiwang && (dayJiwang.chushou === '空仓对了' || dayJiwang.chushou === '出手对了');
                    
                    if (isDuibanChecked) {
                        duibanCount++;
                        if (isRight) duibanRightCount++;
                    }
                    
                    // 统计题材方向记录数
                    if (isTopicChecked) {
                        topicCount++;
                        if (isRight) topicRightCount++;
                    }
                    
                    // 统计板块ETF记录数
                    if (isEtfChecked) {
                        etfCheckedCount++;
                        if (isRight) etfRightCount++;
                    }
                    
                    // 统计昨日最大成交额上榜股票
                    const rankData = _rankData;
                    const dayRank = rankData[dateStr];
                    if (dayRank && Array.isArray(dayRank)) {
                        dayRank.forEach(item => {
                            if (item.stock) {
                                if (!stockRankings[item.stock]) {
                                    stockRankings[item.stock] = { count: 0, concept: '' };
                                }
                                stockRankings[item.stock].count++;
                                if (item.concept) {
                                    stockRankings[item.stock].concept = item.concept;
                                }
                            }
                        });
                    }

                    // 统计最近多板表现
                    const duibanData = _duibanData;
                    const dayDuiban = duibanData[dateStr];
                    if (dayDuiban && Array.isArray(dayDuiban)) {
                        dayDuiban.forEach(item => {
                            if (item.jingtu) {
                                if (!duibanRankings[item.jingtu]) {
                                    duibanRankings[item.jingtu] = { count: 0, shuliang: 0 };
                                }
                                duibanRankings[item.jingtu].count++;
                                const shuliangNum = parseFloat(item.shuliang) || 0;
                                duibanRankings[item.jingtu].shuliang += shuliangNum;
                            }
                        });
                    }

                    // 统计早盘板块ETF表现
                    const etfData = _etfData;
                    const dayEtf = etfData[dateStr];
                    if (dayEtf && Array.isArray(dayEtf)) {
                        dayEtf.forEach(item => {
                            if (item.name) {
                                if (!etfRankings[item.name]) {
                                    etfRankings[item.name] = { count: 0, yizi: 0 };
                                }
                                etfRankings[item.name].count++;
                                const yiziNum = parseFloat(item.yizi) || 0;
                                etfRankings[item.name].yizi += yiziNum;
                            }
                        });
                    }
                    
                    // 统计盈亏
                    let todayProfit = 0;
                    let todayBalance = null;
                    if (dayJiwang && dayJiwang.stats && dayJiwang.stats.profit !== undefined && dayJiwang.stats.profit !== '') {
                        todayProfit = parseFloat(dayJiwang.stats.profit) || 0;
                        monthTotalProfit += todayProfit;
                    }
                    // 获取当天账户余额
                    if (dayJiwang && dayJiwang.stats && dayJiwang.stats.balance !== undefined && dayJiwang.stats.balance !== '') {
                        todayBalance = parseFloat(dayJiwang.stats.balance) || null;
                    }
                    // 记录每天盈亏数据（无论是否有数据都记录，没有则为0）
                    dailyProfits.push({
                        date: dateStr,
                        dateLabel: `${month}/${day}`,
                        profit: todayProfit
                    });
                    // 记录每天账户余额数据
                    dailyBalances.push({
                        date: dateStr,
                        dateLabel: `${month}/${day}`,
                        balance: todayBalance
                    });
                }
                
                currentCheck.setDate(currentCheck.getDate() + 1);
            }
            
            // 更新概览统计
            document.getElementById('monthlyEmptyCount').textContent = emptyCount;
            document.getElementById('monthlyDuibanCount').textContent = duibanCount;
            document.getElementById('monthlyTopicCount').textContent = topicCount;
            document.getElementById('monthlyEtfCount').textContent = etfCheckedCount;
            
            // 更新出手情况统计
            document.getElementById('monthlyTradingDays').textContent = tradingDaysCount;
            document.getElementById('monthlyChushouCount').textContent = chushouCount;
            document.getElementById('monthlyEmptyRightCount').textContent = emptyRightCount;
            document.getElementById('monthlyEmptyWrongCount').textContent = emptyWrongCount;
            document.getElementById('monthlyChushouRightCount').textContent = chushouRightCount;
            document.getElementById('monthlyChushouWrongCount').textContent = chushouWrongCount;
            
            // 计算并更新胜率
            const emptyWinRate = emptyCount > 0 ? ((emptyRightCount / emptyCount) * 100).toFixed(1) : 0;
            const chushouWinRate = chushouCount > 0 ? ((chushouRightCount / chushouCount) * 100).toFixed(1) : 0;
            document.getElementById('monthlyEmptyWinRate').textContent = emptyWinRate + '%';
            document.getElementById('monthlyChushouWinRate').textContent = chushouWinRate + '%';
            
            // 计算记录统计胜率（必须同时满足：勾选了记录类型 且 出手/空仓对了）
            // 最近多板胜率 = 最近多板对了次数 / 最近多板记录次数
            const monthlyDuibanWinRate = duibanCount > 0 
                ? ((duibanRightCount / duibanCount) * 100).toFixed(1) 
                : '0.0';
            document.getElementById('monthlyDuibanWinRate').textContent = monthlyDuibanWinRate + '%';
            
            // 题材方向胜率 = 题材方向对了次数 / 题材方向记录次数
            const monthlyTopicWinRate = topicCount > 0 
                ? ((topicRightCount / topicCount) * 100).toFixed(1) 
                : '0.0';
            document.getElementById('monthlyTopicWinRate').textContent = monthlyTopicWinRate + '%';
            
            // 板块ETF胜率 = 板块ETF对了次数 / 板块ETF记录次数
            const monthlyEtfWinRate = etfCheckedCount > 0 
                ? ((etfRightCount / etfCheckedCount) * 100).toFixed(1) 
                : '0.0';
            
            // 更新总计统计（固定从2026-02-01统计到今天）
            window.renderTotalStats('M');
            document.getElementById('monthlyEtfWinRate').textContent = monthlyEtfWinRate + '%';
            
            // 更新上榜最多股票
            const sortedStocks = Object.entries(stockRankings)
                .sort((a, b) => b[1].count - a[1].count);

            const topStocksEl = document.getElementById('monthlyTopStocks');
            if (sortedStocks.length > 0) {
                topStocksEl.innerHTML = sortedStocks.map(([name, data]) => `
                    <div class="weekend-stock-item">
                        <span class="weekend-stock-name">${name}</span>
                        <span class="weekend-stock-concept" style="font-size:12px;color:#64748b;margin:0 8px;">${data.concept || '-'}</span>
                        <span class="weekend-stock-count">${data.count}次</span>
                    </div>
                `).join('');
            } else {
                topStocksEl.innerHTML = '<div class="weekend-stock-item"><span class="weekend-stock-name">暂无数据</span></div>';
            }
            
            // 更新最近多板表现统计
            const sortedDuiban = Object.entries(duibanRankings)
                .sort((a, b) => b[1].count - a[1].count)
                .slice(0, 5);

            const duibanPerfEl = document.getElementById('monthlyDuibanPerformance');
            if (sortedDuiban.length > 0) {
                duibanPerfEl.innerHTML = sortedDuiban.map(([jingtu, data]) => {
                    return `
                        <div class="weekend-stock-item" style="display: grid; grid-template-columns: 1fr 60px 50px; gap: 8px; align-items: center;">
                            <span class="weekend-stock-name" style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${jingtu}</span>
                            <span style="font-size:12px;color:#64748b;text-align:center;">${data.shuliang || 0}</span>
                            <span class="weekend-stock-count" style="justify-self: end;">${data.count}次</span>
                        </div>
                    `;
                }).join('');
            } else {
                duibanPerfEl.innerHTML = '<div class="weekend-stock-item"><span class="weekend-stock-name">暂无数据</span></div>';
            }

            // 更新ETF统计（按数量yizi由高到低排序）
            const sortedEtfs = Object.entries(etfRankings)
                .sort((a, b) => (b[1].yizi || 0) - (a[1].yizi || 0))
                .slice(0, 5);

            const topEtfsEl = document.getElementById('monthlyTopEtfs');
            if (sortedEtfs.length > 0) {
                topEtfsEl.innerHTML = sortedEtfs.map(([name, data]) => {
                    const nameWithEtf = name.endsWith('ETF') ? name : name + 'ETF';
                    return `
                        <div class="weekend-stock-item" style="display: grid; grid-template-columns: 1fr 60px 50px; gap: 8px; align-items: center;">
                            <span class="weekend-stock-name" style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${nameWithEtf}</span>
                            <span style="font-size:12px;color:#64748b;text-align:center;">${data.yizi || 0}</span>
                            <span class="weekend-stock-count" style="justify-self: end;">${data.count}次</span>
                        </div>
                    `;
                }).join('');
            } else {
                topEtfsEl.innerHTML = '<div class="weekend-stock-item"><span class="weekend-stock-name">暂无数据</span></div>';
            }
            
            // 更新盈亏统计
            if (monthTotalProfit >= 0) {
                document.getElementById('monthlyTotalProfit').textContent = monthTotalProfit.toFixed(0);
                document.getElementById('monthlyTotalLoss').textContent = '0';
            } else {
                document.getElementById('monthlyTotalProfit').textContent = '0';
                document.getElementById('monthlyTotalLoss').textContent = '-' + Math.abs(monthTotalProfit).toFixed(0);
            }
            
            // 获取上个交易日的账户余额（从当前日期往前找，只找交易日）
            const jiwangData = window.getJiwangData();
            let lastTradingBalance = '-';
            
            // 从当前日期往前遍历，找到最后一个有数据的交易日（跳过周末）
            let checkDate = new Date(window.currentDate + 'T00:00:00');
            const startDate = new Date(monthRange.firstDayObj);
            while (checkDate >= startDate) {
                const year = checkDate.getFullYear();
                const month = String(checkDate.getMonth() + 1).padStart(2, '0');
                const day = String(checkDate.getDate()).padStart(2, '0');
                const dateStr = `${year}-${month}-${day}`;
                
                // 只检查交易日
                if (window.isTradingDay(dateStr)) {
                    if (jiwangData[dateStr] && jiwangData[dateStr].stats && jiwangData[dateStr].stats.balance) {
                        const balance = parseFloat(jiwangData[dateStr].stats.balance);
                        if (!isNaN(balance)) {
                            lastTradingBalance = balance.toLocaleString('zh-CN');
                            break;
                        }
                    }
                }
                
                checkDate.setDate(checkDate.getDate() - 1);
            }
            
            document.getElementById('monthlyBalance').textContent = lastTradingBalance;
            
            // 绘制本月盈亏曲线图
            window.drawProfitChart('monthlyProfitChart', dailyProfits);
            
            // 绘制本月账户余额曲线图
            window.drawBalanceChart('monthlyBalanceChart', dailyBalances);
            
            // 渲染本月总结心得
            window.renderMonthlySummary();
        }
        
        // 切换上榜最多看板的展开/收起状态

        // 切换上榜最多看板的展开/收起状态
        export function toggleWeekendStockList(type) {
            const listId = type === 'weekend' ? 'weekendTopStocks' : 'monthlyTopStocks';
            const titleSelector = type === 'weekend' 
                ? '#weekendStatsBoard .weekend-section:nth-child(5) .weekend-section-title'
                : '#monthlyStatsBoard .weekend-section:nth-child(5) .weekend-section-title';
            
            const listEl = document.getElementById(listId);
            const titleEl = document.querySelector(titleSelector);
            
            if (listEl.classList.contains('collapsed')) {
                listEl.classList.remove('collapsed');
                listEl.classList.add('expanded');
                titleEl.classList.add('expanded');
            } else {
                listEl.classList.remove('expanded');
                listEl.classList.add('collapsed');
                titleEl.classList.remove('expanded');
            }
        }

        // 渲染本周总结心得

        // 渲染本周总结心得
        export function renderWeeklySummary() {
            const weekRange = window.getWeekTradingDays(window.currentDate);
            const summaryKey = `weekly_summary_${weekRange.monday}_${weekRange.friday}`;
            const summary = localStorage.getItem(summaryKey) || '';
            
            const summaryContent = document.getElementById('weekendSummaryContent');
            if (summary) {
                summaryContent.innerHTML = `<div class="weekend-summary-text">${window.escapeHtml(summary)}</div>`;
            } else {
                summaryContent.innerHTML = '<div class="weekend-summary-placeholder">暂无总结心得，点击输入</div>';
            }
        }

        // 渲染周末总结（周日专用）

        // 渲染周末总结（周日专用）
        export function renderWeekendSummary() {
            const date = new Date(window.currentDate + 'T00:00:00');
            const year = date.getFullYear();
            const month = String(date.getMonth() + 1).padStart(2, '0');
            const day = String(date.getDate()).padStart(2, '0');
            
            // 设置标题为周末总结
            const titleEl = document.querySelector('#weekendStatsBoard .weekend-title');
            if (titleEl) {
                titleEl.textContent = '📝 周末总结';
            }
            
            // 设置日期范围显示（本周一到本周日）
            const weekRange = window.getWeekTradingDays(window.currentDate);
            const subtitleEl = document.getElementById('weekendDateRange');
            if (subtitleEl) {
                subtitleEl.textContent = `${weekRange.monday} 至 ${year}-${month}-${day}`;
            }
            
            // 获取周末总结数据
            const summaryKey = `weekend_summary_${weekRange.monday}_${year}-${month}-${day}`;
            const summaryData = JSON.parse(localStorage.getItem(summaryKey) || '{}');
            
            // 更新本周回顾
            const reviewContent = document.getElementById('weekendReviewContent');
            if (reviewContent) {
                if (summaryData.review) {
                    reviewContent.innerHTML = `<div class="weekend-summary-text">${window.escapeHtml(summaryData.review)}</div>`;
                } else {
                    reviewContent.innerHTML = '<div class="weekend-summary-placeholder">暂无内容，点击输入</div>';
                }
            }
            
            // 更新经验总结
            const experienceContent = document.getElementById('weekendExperienceContent');
            if (experienceContent) {
                if (summaryData.experience) {
                    experienceContent.innerHTML = `<div class="weekend-summary-text">${window.escapeHtml(summaryData.experience)}</div>`;
                } else {
                    experienceContent.innerHTML = '<div class="weekend-summary-placeholder">暂无内容，点击输入</div>';
                }
            }
            
            // 更新下周计划
            const planContent = document.getElementById('weekendPlanContent');
            if (planContent) {
                if (summaryData.plan) {
                    planContent.innerHTML = `<div class="weekend-summary-text">${window.escapeHtml(summaryData.plan)}</div>`;
                } else {
                    planContent.innerHTML = '<div class="weekend-summary-placeholder">暂无内容，点击输入</div>';
                }
            }
        }

        // 渲染本月总结心得

        // 渲染本月总结心得
        export function renderMonthlySummary() {
            const monthRange = window.getMonthTradingDays(window.currentDate);
            const summaryKey = `monthly_summary_${monthRange.firstDay}_${monthRange.lastDay}`;
            const summary = localStorage.getItem(summaryKey) || '';
            
            const summaryContent = document.getElementById('monthlySummaryContent');
            if (summary) {
                summaryContent.innerHTML = `<div class="weekend-summary-text">${window.escapeHtml(summary)}</div>`;
            } else {
                summaryContent.innerHTML = '<div class="weekend-summary-placeholder">暂无总结心得，点击输入</div>';
            }
        }

        // 打开本周总结心得模态框

        // 打开本周总结心得模态框
        export function openWeekendSummaryModal() {
            const weekRange = window.getWeekTradingDays(window.currentDate);
            const summaryKey = `weekly_summary_${weekRange.monday}_${weekRange.friday}`;
            const summary = localStorage.getItem(summaryKey) || '';
            
            document.getElementById('weekendSummaryText').value = summary;
            document.getElementById('weekendSummaryModal').classList.add('active');
        }

        // 关闭本周总结心得模态框

        // 关闭本周总结心得模态框
        export function closeWeekendSummaryModal() {
            document.getElementById('weekendSummaryModal').classList.remove('active');
        }

        // 保存本周总结心得

        // 保存本周总结心得
        export function saveWeekendSummary() {
            const weekRange = window.getWeekTradingDays(window.currentDate);
            const summaryKey = `weekly_summary_${weekRange.monday}_${weekRange.friday}`;
            const summary = document.getElementById('weekendSummaryText').value.trim();
            
            localStorage.setItem(summaryKey, summary);
            window.closeWeekendSummaryModal();
            window.renderWeeklySummary();
        }

        // 打开周末总结-本周回顾模态框

        // 打开周末总结-本周回顾模态框
        export function openWeekendReviewModal() {
            const weekRange = window.getWeekTradingDays(window.currentDate);
            const date = new Date(window.currentDate + 'T00:00:00');
            const year = date.getFullYear();
            const month = String(date.getMonth() + 1).padStart(2, '0');
            const day = String(date.getDate()).padStart(2, '0');
            const summaryKey = `weekend_summary_${weekRange.monday}_${year}-${month}-${day}`;
            const summaryData = JSON.parse(localStorage.getItem(summaryKey) || '{}');
            
            document.getElementById('weekendReviewText').value = summaryData.review || '';
            document.getElementById('weekendReviewModal').classList.add('active');
        }

        // 关闭周末总结-本周回顾模态框

        // 关闭周末总结-本周回顾模态框
        export function closeWeekendReviewModal() {
            document.getElementById('weekendReviewModal').classList.remove('active');
        }

        // 保存周末总结-本周回顾

        // 保存周末总结-本周回顾
        export function saveWeekendReview() {
            const weekRange = window.getWeekTradingDays(window.currentDate);
            const date = new Date(window.currentDate + 'T00:00:00');
            const year = date.getFullYear();
            const month = String(date.getMonth() + 1).padStart(2, '0');
            const day = String(date.getDate()).padStart(2, '0');
            const summaryKey = `weekend_summary_${weekRange.monday}_${year}-${month}-${day}`;
            const summaryData = JSON.parse(localStorage.getItem(summaryKey) || '{}');
            summaryData.review = document.getElementById('weekendReviewText').value.trim();
            
            localStorage.setItem(summaryKey, JSON.stringify(summaryData));
            window.closeWeekendReviewModal();
            window.renderWeekendSummary();
        }

        // 打开周末总结-经验总结模态框

        // 打开周末总结-经验总结模态框
        export function openWeekendExperienceModal() {
            const weekRange = window.getWeekTradingDays(window.currentDate);
            const date = new Date(window.currentDate + 'T00:00:00');
            const year = date.getFullYear();
            const month = String(date.getMonth() + 1).padStart(2, '0');
            const day = String(date.getDate()).padStart(2, '0');
            const summaryKey = `weekend_summary_${weekRange.monday}_${year}-${month}-${day}`;
            const summaryData = JSON.parse(localStorage.getItem(summaryKey) || '{}');
            
            document.getElementById('weekendExperienceText').value = summaryData.experience || '';
            document.getElementById('weekendExperienceModal').classList.add('active');
        }

        // 关闭周末总结-经验总结模态框

        // 关闭周末总结-经验总结模态框
        export function closeWeekendExperienceModal() {
            document.getElementById('weekendExperienceModal').classList.remove('active');
        }

        // 保存周末总结-经验总结

        // 保存周末总结-经验总结
        export function saveWeekendExperience() {
            const weekRange = window.getWeekTradingDays(window.currentDate);
            const date = new Date(window.currentDate + 'T00:00:00');
            const year = date.getFullYear();
            const month = String(date.getMonth() + 1).padStart(2, '0');
            const day = String(date.getDate()).padStart(2, '0');
            const summaryKey = `weekend_summary_${weekRange.monday}_${year}-${month}-${day}`;
            const summaryData = JSON.parse(localStorage.getItem(summaryKey) || '{}');
            summaryData.experience = document.getElementById('weekendExperienceText').value.trim();
            
            localStorage.setItem(summaryKey, JSON.stringify(summaryData));
            window.closeWeekendExperienceModal();
            window.renderWeekendSummary();
        }

        // 打开周末总结-下周计划模态框

        // 打开周末总结-下周计划模态框
        export function openWeekendPlanModal() {
            const weekRange = window.getWeekTradingDays(window.currentDate);
            const date = new Date(window.currentDate + 'T00:00:00');
            const year = date.getFullYear();
            const month = String(date.getMonth() + 1).padStart(2, '0');
            const day = String(date.getDate()).padStart(2, '0');
            const summaryKey = `weekend_summary_${weekRange.monday}_${year}-${month}-${day}`;
            const summaryData = JSON.parse(localStorage.getItem(summaryKey) || '{}');
            
            document.getElementById('weekendPlanText').value = summaryData.plan || '';
            document.getElementById('weekendPlanModal').classList.add('active');
        }

        // 关闭周末总结-下周计划模态框

        // 关闭周末总结-下周计划模态框
        export function closeWeekendPlanModal() {
            document.getElementById('weekendPlanModal').classList.remove('active');
        }

        // 保存周末总结-下周计划

        // 保存周末总结-下周计划
        export function saveWeekendPlan() {
            const weekRange = window.getWeekTradingDays(window.currentDate);
            const date = new Date(window.currentDate + 'T00:00:00');
            const year = date.getFullYear();
            const month = String(date.getMonth() + 1).padStart(2, '0');
            const day = String(date.getDate()).padStart(2, '0');
            const summaryKey = `weekend_summary_${weekRange.monday}_${year}-${month}-${day}`;
            const summaryData = JSON.parse(localStorage.getItem(summaryKey) || '{}');
            summaryData.plan = document.getElementById('weekendPlanText').value.trim();
            
            localStorage.setItem(summaryKey, JSON.stringify(summaryData));
            window.closeWeekendPlanModal();
            window.renderWeekendSummary();
        }

        // 打开本月总结心得模态框

        // 打开本月总结心得模态框
        export function openMonthlySummaryModal() {
            const monthRange = window.getMonthTradingDays(window.currentDate);
            const summaryKey = `monthly_summary_${monthRange.firstDay}_${monthRange.lastDay}`;
            const summary = localStorage.getItem(summaryKey) || '';
            
            document.getElementById('monthlySummaryText').value = summary;
            document.getElementById('monthlySummaryModal').classList.add('active');
        }

        // 关闭本月总结心得模态框

        // 关闭本月总结心得模态框
        export function closeMonthlySummaryModal() {
            document.getElementById('monthlySummaryModal').classList.remove('active');
        }

        // 评分设置相关函数
        let currentScoreSettingType = 'recentMulti';
        
        const defaultScoreSettings = {
            recentMulti: {
                die1: -5, die2: -3, die3: 5, die4: 6, die5: 7,
                zhang1: 5, zhang2: 3, zhang3: -5,
                kongcang: -5, chushou: 5,
                yangqun1: -6, yangqun2: -3, yangqun3: -4, yangqun4: -3,
                yangqun5: 6, yangqun6: 5, yangqun7: 4,
                yangqun8: -5, yangqun9: -6, yangqun10: -6, yangqun11: -7,
                jingjiaDie1: -5,
                dapanMore1: 5, dapanLess05: -8, dapanLess1: -10,
                zhang5More20: 10, zhang5More15: 8, zhang5More10: 2, zhang5Less10: -5,
                xingxian1: 3, xingxian2: 5, xingxian3: 7, xingxian4: 10,
                xingzeng1: 5, xingzeng2: 8, xingzeng3: 10,
                xingping1: 2, xingping2: 4, xingping3: 6,
                xingbao: 10, xingwangZeng: 15,
                qiangduMore50: 10, qiangdu40to50: 0, qiangdu30to40: -15, qiangduLess30: -20,
                qiangduMore50_banKuai: 10, qiangdu40to50_banKuai: 0, qiangdu30to40_banKuai: 10, qiangduLess30_banKuai: 0,
                qiangduMore50_ticai: 10, qiangdu40to50_ticai: 0, qiangdu30to40_ticai: 0, qiangduLess30_ticai: 10,
                fumianzhuti: -10
            },
            sectorEtf: {
                die1: 2, die2: 3, die3: 4, die4: 5, die5: 6,
                zhang1: 5, zhang2: 6, zhang3: -5,
                kongcang: -5, chushou: 5,
                yangqun1: -6, yangqun2: 5, yangqun3: 6, yangqun4: 0,
                yangqun5: 6, yangqun6: 5, yangqun7: -4,
                yangqun8: 5, yangqun9: -6, yangqun10: -6, yangqun11: -7,
                jingjiaDie1: -5,
                dapanMore1: 5, dapanLess05: -8, dapanLess1: -10,
                zhang5More20: 10, zhang5More15: 8, zhang5More10: 2, zhang5Less10: -5,
                xingxian1: 3, xingxian2: 5, xingxian3: 7, xingxian4: 10,
                xingzeng1: 5, xingzeng2: 8, xingzeng3: 10,
                xingping1: 2, xingping2: 4, xingping3: 6,
                xingbao: 10, xingwangZeng: 15,
                qiangduMore50: 10, qiangdu40to50: 0, qiangdu30to40: 10, qiangduLess30: 0,
                qiangduMore50_banKuai: 10, qiangdu40to50_banKuai: 0, qiangdu30to40_banKuai: 10, qiangduLess30_banKuai: 0,
                qiangduMore50_ticai: 10, qiangdu40to50_ticai: 0, qiangdu30to40_ticai: 0, qiangduLess30_ticai: 10,
                fumianzhuti: -10
            },
            topicDirection: {
                die1: -5, die2: -6, die3: -7, die4: -5, die5: -4,
                zhang1: 5, zhang2: 6, zhang3: 3, zhang4: -7,
                kongcang: -3, chushou: 3,
                yangqun1: -6, yangqun2: 6, yangqun3: -5, yangqun4: 4,
                yangqun5: 0, yangqun6: 0, yangqun7: 0,
                yangqun8: 0, yangqun9: 0, yangqun10: 0, yangqun11: 0,
                jingjiaDie1: -5,
                dapanMore1: 5, dapanLess05: -8, dapanLess1: -10,
                zhang5More20: 10, zhang5More15: 8, zhang5More10: 2, zhang5Less10: -5,
                xingxian1: 3, xingxian2: 5, xingxian3: 7, xingxian4: 10,
                xingzeng1: 5, xingzeng2: 8, xingzeng3: 10,
                xingping1: 2, xingping2: 4, xingping3: 6,
                xingbao: 10, xingwangZeng: 15,
                qiangduMore50: 10, qiangdu40to50: 0, qiangdu30to40: 0, qiangduLess30: 10,
                qiangduMore50_banKuai: 10, qiangdu40to50_banKuai: 0, qiangdu30to40_banKuai: 10, qiangduLess30_banKuai: 0,
                qiangduMore50_ticai: 10, qiangdu40to50_ticai: 0, qiangdu30to40_ticai: 0, qiangduLess30_ticai: 10,
                fumianzhuti: -10
            }
        };


        export function getScoreSettings(type) {
            const stored = localStorage.getItem(`scoreSettings_${type}`);
            if (stored) {
                return JSON.parse(stored);
            }
            return defaultScoreSettings[type] || defaultScoreSettings.recentMulti;
        }


        export function saveScoreSettingsToStorage(type, settings) {
            localStorage.setItem(`scoreSettings_${type}`, JSON.stringify(settings));
        }


        export function openScoreSettingModal(type) {
            currentScoreSettingType = type;
            const settings = window.getScoreSettings(type);
            
            const titleEl = document.getElementById('scoreSettingTitle');
            const typeNames = {
                recentMulti: '最近多板评分设置',
                sectorEtf: '板块ETF评分设置',
                topicDirection: '题材方向评分设置'
            };
            titleEl.textContent = typeNames[type] || '评分设置';
            
            // 更新强度分标题
            const qiangduTitleEl = document.getElementById('scoreQiangduTitle');
            const qiangduTitles = {
                recentMulti: '七、最近多板强度分',
                sectorEtf: '七、板块ETF强度分',
                topicDirection: '七、题材方向强度分'
            };
            qiangduTitleEl.textContent = qiangduTitles[type] || '七、强度分';
            
            const zhang4Container = document.getElementById('scoreZhang4Container');
            if (type === 'topicDirection') {
                zhang4Container.style.display = 'flex';
            } else {
                zhang4Container.style.display = 'none';
            }
            
            document.getElementById('scoreDie1').value = settings.die1;
            document.getElementById('scoreDie2').value = settings.die2;
            document.getElementById('scoreDie3').value = settings.die3;
            document.getElementById('scoreDie4').value = settings.die4;
            document.getElementById('scoreDie5').value = settings.die5;
            document.getElementById('scoreZhang1').value = settings.zhang1;
            document.getElementById('scoreZhang2').value = settings.zhang2;
            document.getElementById('scoreZhang3').value = settings.zhang3;
            document.getElementById('scoreZhang4').value = settings.zhang4 !== undefined ? settings.zhang4 : -7;
            document.getElementById('scoreKongcang').value = settings.kongcang;
            document.getElementById('scoreChushou').value = settings.chushou;
            document.getElementById('scoreYangqun1').value = settings.yangqun1;
            document.getElementById('scoreYangqun2').value = settings.yangqun2;
            document.getElementById('scoreYangqun3').value = settings.yangqun3;
            document.getElementById('scoreYangqun4').value = settings.yangqun4;
            document.getElementById('scoreYangqun5').value = settings.yangqun5;
            document.getElementById('scoreYangqun6').value = settings.yangqun6;
            document.getElementById('scoreYangqun7').value = settings.yangqun7;
            document.getElementById('scoreYangqun8').value = settings.yangqun8;
            document.getElementById('scoreYangqun9').value = settings.yangqun9;
            document.getElementById('scoreYangqun10').value = settings.yangqun10;
            document.getElementById('scoreYangqun11').value = settings.yangqun11;
            document.getElementById('scoreJingjiaDie1').value = settings.jingjiaDie1 !== undefined ? settings.jingjiaDie1 : -5;
            document.getElementById('scoreDapanMore1').value = settings.dapanMore1 !== undefined ? settings.dapanMore1 : 5;
            document.getElementById('scoreDapanLess05').value = settings.dapanLess05 !== undefined ? settings.dapanLess05 : -8;
            document.getElementById('scoreDapanLess1').value = settings.dapanLess1 !== undefined ? settings.dapanLess1 : -10;
            document.getElementById('scoreZhang5More20').value = settings.zhang5More20 !== undefined ? settings.zhang5More20 : 10;
            document.getElementById('scoreZhang5More15').value = settings.zhang5More15 !== undefined ? settings.zhang5More15 : 8;
            document.getElementById('scoreZhang5More10').value = settings.zhang5More10 !== undefined ? settings.zhang5More10 : 2;
            document.getElementById('scoreZhang5Less10').value = settings.zhang5Less10 !== undefined ? settings.zhang5Less10 : -5;
            document.getElementById('scoreXingxian1').value = settings.xingxian1 !== undefined ? settings.xingxian1 : 3;
            document.getElementById('scoreXingxian2').value = settings.xingxian2 !== undefined ? settings.xingxian2 : 5;
            document.getElementById('scoreXingxian3').value = settings.xingxian3 !== undefined ? settings.xingxian3 : 7;
            document.getElementById('scoreXingxian4').value = settings.xingxian4 !== undefined ? settings.xingxian4 : 10;
            document.getElementById('scoreXingzeng1').value = settings.xingzeng1 !== undefined ? settings.xingzeng1 : 5;
            document.getElementById('scoreXingzeng2').value = settings.xingzeng2 !== undefined ? settings.xingzeng2 : 8;
            document.getElementById('scoreXingzeng3').value = settings.xingzeng3 !== undefined ? settings.xingzeng3 : 10;
            document.getElementById('scoreXingping1').value = settings.xingping1 !== undefined ? settings.xingping1 : 2;
            document.getElementById('scoreXingping2').value = settings.xingping2 !== undefined ? settings.xingping2 : 4;
            document.getElementById('scoreXingping3').value = settings.xingping3 !== undefined ? settings.xingping3 : 6;
            document.getElementById('scoreXingbao').value = settings.xingbao !== undefined ? settings.xingbao : 10;
            document.getElementById('scoreXingwangZeng').value = settings.xingwangZeng !== undefined ? settings.xingwangZeng : 15;
            
            // 根据类型加载对应的强度分值
            if (type === 'recentMulti') {
                document.getElementById('scoreQiangduMore50').value = settings.qiangduMore50 !== undefined ? settings.qiangduMore50 : 10;
                document.getElementById('scoreQiangdu40to50').value = settings.qiangdu40to50 !== undefined ? settings.qiangdu40to50 : 0;
                document.getElementById('scoreQiangdu30to40').value = settings.qiangdu30to40 !== undefined ? settings.qiangdu30to40 : -15;
                document.getElementById('scoreQiangduLess30').value = settings.qiangduLess30 !== undefined ? settings.qiangduLess30 : -20;
            } else if (type === 'sectorEtf') {
                document.getElementById('scoreQiangduMore50').value = settings.qiangduMore50_banKuai !== undefined ? settings.qiangduMore50_banKuai : 10;
                document.getElementById('scoreQiangdu40to50').value = settings.qiangdu40to50_banKuai !== undefined ? settings.qiangdu40to50_banKuai : 0;
                document.getElementById('scoreQiangdu30to40').value = settings.qiangdu30to40_banKuai !== undefined ? settings.qiangdu30to40_banKuai : 10;
                document.getElementById('scoreQiangduLess30').value = settings.qiangduLess30_banKuai !== undefined ? settings.qiangduLess30_banKuai : 0;
            } else if (type === 'topicDirection') {
                document.getElementById('scoreQiangduMore50').value = settings.qiangduMore50_ticai !== undefined ? settings.qiangduMore50_ticai : 10;
                document.getElementById('scoreQiangdu40to50').value = settings.qiangdu40to50_ticai !== undefined ? settings.qiangdu40to50_ticai : 0;
                document.getElementById('scoreQiangdu30to40').value = settings.qiangdu30to40_ticai !== undefined ? settings.qiangdu30to40_ticai : 0;
                document.getElementById('scoreQiangduLess30').value = settings.qiangduLess30_ticai !== undefined ? settings.qiangduLess30_ticai : 10;
            }
            
            document.getElementById('scoreFumianzhuti').value = settings.fumianzhuti !== undefined ? settings.fumianzhuti : -10;
            
            const hasFumian = localStorage.getItem('hasFumianTopic_' + window.currentDate);
            document.getElementById('hasFumianTopicCheckbox').checked = hasFumian === 'true';
            
            window.updateScoreInputBorders();
            
            document.getElementById('scoreSettingModal').classList.add('active');
        }


        export function updateScoreInputBorders() {
            // 先移除所有 matched-today 类
            const inputs = document.querySelectorAll('.score-setting-input');
            inputs.forEach(input => {
                input.classList.remove('matched-today');
            });
            
            // 获取当天符合的条件并添加黄色框
            const matchedInputs = window.getMatchedInputsToday(currentScoreSettingType);
            matchedInputs.forEach(inputId => {
                const input = document.getElementById(inputId);
                if (input) {
                    input.classList.add('matched-today');
                }
            });
        }
        
        // 获取当天符合条件对应的输入框ID

        // 获取当天符合条件对应的输入框ID
        export function getMatchedInputsToday(type) {
            const matched = [];
            
            try {
                const tagData = window.getTodayTagTitles();
                const yesterdayDate = window.getYesterdayDate(window.currentDate);
                const yesterdayTagData = window.getTagTitlesByDate(yesterdayDate);
                const yesterdayConsecutiveUp = yesterdayTagData.consecutiveUp || { duoban: 0, bankuai: 0, ticai: 0 };
                const todayJiwang = window.getTodayJiwang() || {};
                const settings = window.getScoreSettings(type);
                
                // 一、连跌天数（基于上交易日数据）
                const yesterdayDuobanDays = yesterdayConsecutiveUp.duoban || 0;
                const yesterdayBankuaiDays = yesterdayConsecutiveUp.bankuai || 0;
                const yesterdayTicaiDays = yesterdayConsecutiveUp.ticai || 0;
                
                if (yesterdayDuobanDays === -1) matched.push('scoreDie1');
                else if (yesterdayDuobanDays === -2) matched.push('scoreDie2');
                else if (yesterdayDuobanDays === -3) matched.push('scoreDie3');
                else if (yesterdayDuobanDays === -4) matched.push('scoreDie4');
                else if (yesterdayDuobanDays <= -5) matched.push('scoreDie5');
                
                // 二、连涨天数（基于上交易日数据）
                let zhangCount = 0;
                if (type === 'recentMulti') zhangCount = yesterdayDuobanDays;
                else if (type === 'sectorEtf') zhangCount = yesterdayBankuaiDays;
                else if (type === 'topicDirection') zhangCount = yesterdayTicaiDays;
                
                if (zhangCount === 1) matched.push('scoreZhang1');
                else if (zhangCount === 2) matched.push('scoreZhang2');
                else if (zhangCount === 3) matched.push('scoreZhang3');
                else if (zhangCount >= 4) matched.push('scoreZhang4');
                
                // 三、记忘看板结论
                if (todayJiwang.jielun === '空仓') matched.push('scoreKongcang');
                else if (todayJiwang.jielun === '出手') matched.push('scoreChushou');
                
                // 四、羊群效应（基于上交易日数据）
                const bankuaiIsDown = yesterdayBankuaiDays < 0;
                const bankuaiIsUp = yesterdayBankuaiDays > 0;
                const ticaiIsDown = yesterdayTicaiDays < 0;
                const ticaiIsUp = yesterdayTicaiDays > 0;
                
                if (yesterdayDuobanDays <= -1) {
                    if (bankuaiIsDown && ticaiIsDown) matched.push('scoreYangqun1');
                    else if (bankuaiIsUp && ticaiIsUp) matched.push('scoreYangqun2');
                    else if (bankuaiIsUp && ticaiIsDown) matched.push('scoreYangqun3');
                    else if (bankuaiIsDown && ticaiIsUp) matched.push('scoreYangqun4');
                } else if (yesterdayDuobanDays >= 1) {
                    if (bankuaiIsDown && ticaiIsDown) matched.push('scoreYangqun5');
                    else if (bankuaiIsUp && ticaiIsUp) matched.push('scoreYangqun6');
                    else if (bankuaiIsUp && ticaiIsDown) matched.push('scoreYangqun7');
                    else if (bankuaiIsDown && ticaiIsUp) matched.push('scoreYangqun8');
                } else if (yesterdayDuobanDays === 0) {
                    if (bankuaiIsDown && ticaiIsDown) matched.push('scoreYangqun9');
                    else if (bankuaiIsUp && ticaiIsUp) matched.push('scoreYangqun10');
                    else if (bankuaiIsDown && ticaiIsUp || bankuaiIsUp && ticaiIsDown) matched.push('scoreYangqun11');
                }
                
                // 五、竞价变化看板
                const biddingData = window.getTodayBidding();
                if (biddingData && Array.isArray(biddingData)) {
                    // 最近多板%跌幅
                    const duobanRow = biddingData.find(row => row.name === '最近多板%');
                    if (duobanRow) {
                        const time930 = parseFloat(duobanRow.time930);
                        if (!isNaN(time930) && time930 < -1) {
                            matched.push('scoreJingjiaDie1');
                        }
                    }
                    
                    // 大盘%
                    const dapanRow = biddingData.find(row => row.name === '大盘（%）');
                    if (dapanRow) {
                        const dapan930 = parseFloat(dapanRow.time930);
                        if (!isNaN(dapan930)) {
                            if (dapan930 > 1) matched.push('scoreDapanMore1');
                            else if (dapan930 < -1) matched.push('scoreDapanLess1');
                            else if (dapan930 >= -1 && dapan930 < -0.5) matched.push('scoreDapanLess05');
                        }
                    }
                }
                
                // 六、早盘竞价占比≥4.5%数量
                const auctionData = window.getAuctionData();
                const auctionList = auctionData[window.currentDate] || [];
                if (auctionList.length > 0) {
                    let ratio45Count = 0;
                    auctionList.forEach(item => {
                        const volume = parseFloat(item.volume) || 0;
                        const yestVolume = parseFloat(item.yestVolume) || 0;
                        if (yestVolume > 0) {
                            const ratio = (volume / yestVolume) * 100;
                            if (ratio >= 4.5) ratio45Count++;
                        }
                    });
                    
                    if (ratio45Count > 20) matched.push('scoreZhang5More20');
                    else if (ratio45Count > 15) matched.push('scoreZhang5More15');
                    else if (ratio45Count >= 10) matched.push('scoreZhang5More10');
                    else if (ratio45Count < 10) matched.push('scoreZhang5Less10');
                }
                
                // 七、有星题材
                const todayAuction = auctionData[window.currentDate] || [];
                const yesterdayAuction = yesterdayDate ? auctionData[yesterdayDate] : [];
                const todayGroups = window.getTopicGroups(todayAuction);
                const yesterdayGroups = yesterdayDate ? window.getTopicGroups(yesterdayAuction || []) : [];
                
                let xingxianCount = 0, xingzengCount = 0, xingpingCount = 0;
                todayGroups.forEach(todayGroup => {
                    if (!todayGroup.topic || todayGroup.topic === '---') return;
                    const todayStarCount = todayGroup.starCount || 0;
                    const yesterdayGroup = yesterdayGroups.find(g => g.topic === todayGroup.topic);
                    const yesterdayStarCount = yesterdayGroup ? (yesterdayGroup.starCount || 0) : 0;
                    
                    if (todayStarCount > 0 && yesterdayStarCount === 0) xingxianCount++;
                    else if (todayStarCount > yesterdayStarCount) xingzengCount++;
                    else if (todayStarCount > 0 && todayStarCount === yesterdayStarCount) xingpingCount++;
                });
                
                if (xingxianCount >= 4) matched.push('scoreXingxian4');
                else if (xingxianCount === 3) matched.push('scoreXingxian3');
                else if (xingxianCount === 2) matched.push('scoreXingxian2');
                else if (xingxianCount === 1) matched.push('scoreXingxian1');
                
                if (xingzengCount >= 3) matched.push('scoreXingzeng3');
                else if (xingzengCount === 2) matched.push('scoreXingzeng2');
                else if (xingzengCount === 1) matched.push('scoreXingzeng1');
                
                if (xingpingCount >= 3) matched.push('scoreXingping3');
                else if (xingpingCount === 2) matched.push('scoreXingping2');
                else if (xingpingCount === 1) matched.push('scoreXingping1');
                
                // 星爆
                let xingbaoCount = 0;
                todayGroups.forEach(g => {
                    if (!g.topic || g.topic === '---') return;
                    const todayStarCount = g.starCount || 0;
                    const yesterdayGroup = yesterdayGroups.find(yg => yg.topic === g.topic);
                    const yesterdayStarCount = yesterdayGroup ? (yesterdayGroup.starCount || 0) : 0;
                    if (todayStarCount >= 4 && todayStarCount >= yesterdayStarCount * 4) {
                        xingbaoCount++;
                    }
                });
                if (xingbaoCount > 0) matched.push('scoreXingbao');
                
                // 星王增多
                if (yesterdayGroups.length > 0) {
                    let maxStarYesterday = 0;
                    let maxStarTopicYesterday = null;
                    yesterdayGroups.forEach(g => {
                        if (g.topic && g.topic !== '---' && (g.starCount || 0) > maxStarYesterday) {
                            maxStarYesterday = g.starCount || 0;
                            maxStarTopicYesterday = g.topic;
                        }
                    });
                    if (maxStarTopicYesterday) {
                        const todayGroup = todayGroups.find(g => g.topic === maxStarTopicYesterday);
                        if (todayGroup && (todayGroup.starCount || 0) > maxStarYesterday) {
                            matched.push('scoreXingwangZeng');
                        }
                    }
                }
                
                // 八、强度分
                if (auctionList.length > 0) {
                    let strongCount = 0;
                    const prevDate = window.getPreviousTradingDay(window.currentDate);
                    const prevAuctionList = prevDate ? (auctionData[prevDate] || []) : [];
                    
                    auctionList.forEach(item => {
                        let hasDown = false;
                        if (prevAuctionList.length > 0 && item.stock) {
                            const prevItem = prevAuctionList.find(p => p.stock && p.stock.trim() === item.stock.trim());
                            if (prevItem && prevItem.yestVolume) {
                                const prevVolume = parseFloat(prevItem.volume) || 0;
                                const prevYestVolume = parseFloat(prevItem.yestVolume) || 0;
                                if (prevYestVolume > 0) {
                                    const prevRatioValue = (prevVolume / prevYestVolume) * 100;
                                    const currRatioValue = (parseFloat(item.volume) || 0) / (parseFloat(item.yestVolume) || 1) * 100;
                                    if (currRatioValue < prevRatioValue) {
                                        hasDown = true;
                                    }
                                }
                            }
                        }
                        if (!hasDown) strongCount++;
                    });
                    
                    const strength = auctionList.length > 0 ? Math.round((strongCount / auctionList.length) * 100) : 0;
                    
                    if (strength > 50) matched.push('scoreQiangduMore50');
                    else if (strength >= 40 && strength <= 50) matched.push('scoreQiangdu40to50');
                    else if (strength >= 30 && strength < 40) matched.push('scoreQiangdu30to40');
                    else if (strength < 30) matched.push('scoreQiangduLess30');
                }
                
                // 九、负面题材反馈
                const hasFumian = localStorage.getItem('hasFumianTopic_' + window.currentDate);
                if (hasFumian === 'true') {
                    matched.push('scoreFumianzhuti');
                }
                
            } catch (e) {
                console.error('获取当天匹配条件失败:', e);
            }
            
            return matched;
        }


        export function closeScoreSettingModal() {
            document.getElementById('scoreSettingModal').classList.remove('active');
        }


        export function saveScoreSetting() {
            const settings = {
                die1: parseInt(document.getElementById('scoreDie1').value) || 0,
                die2: parseInt(document.getElementById('scoreDie2').value) || 0,
                die3: parseInt(document.getElementById('scoreDie3').value) || 0,
                die4: parseInt(document.getElementById('scoreDie4').value) || 0,
                die5: parseInt(document.getElementById('scoreDie5').value) || 0,
                zhang1: parseInt(document.getElementById('scoreZhang1').value) || 0,
                zhang2: parseInt(document.getElementById('scoreZhang2').value) || 0,
                zhang3: parseInt(document.getElementById('scoreZhang3').value) || 0,
                zhang4: parseInt(document.getElementById('scoreZhang4').value) || 0,
                kongcang: parseInt(document.getElementById('scoreKongcang').value) || 0,
                chushou: parseInt(document.getElementById('scoreChushou').value) || 0,
                yangqun1: parseInt(document.getElementById('scoreYangqun1').value) || 0,
                yangqun2: parseInt(document.getElementById('scoreYangqun2').value) || 0,
                yangqun3: parseInt(document.getElementById('scoreYangqun3').value) || 0,
                yangqun4: parseInt(document.getElementById('scoreYangqun4').value) || 0,
                yangqun5: parseInt(document.getElementById('scoreYangqun5').value) || 0,
                yangqun6: parseInt(document.getElementById('scoreYangqun6').value) || 0,
                yangqun7: parseInt(document.getElementById('scoreYangqun7').value) || 0,
                yangqun8: parseInt(document.getElementById('scoreYangqun8').value) || 0,
                yangqun9: parseInt(document.getElementById('scoreYangqun9').value) || 0,
                yangqun10: parseInt(document.getElementById('scoreYangqun10').value) || 0,
                yangqun11: parseInt(document.getElementById('scoreYangqun11').value) || 0,
                jingjiaDie1: parseInt(document.getElementById('scoreJingjiaDie1').value) || 0,
                dapanMore1: parseInt(document.getElementById('scoreDapanMore1').value) || 0,
                dapanLess05: parseInt(document.getElementById('scoreDapanLess05').value) || 0,
                dapanLess1: parseInt(document.getElementById('scoreDapanLess1').value) || 0,
                zhang5More20: parseInt(document.getElementById('scoreZhang5More20').value) || 0,
                zhang5More15: parseInt(document.getElementById('scoreZhang5More15').value) || 0,
                zhang5More10: parseInt(document.getElementById('scoreZhang5More10').value) || 0,
                zhang5Less10: parseInt(document.getElementById('scoreZhang5Less10').value) || 0,
                xingxian1: parseInt(document.getElementById('scoreXingxian1').value) || 0,
                xingxian2: parseInt(document.getElementById('scoreXingxian2').value) || 0,
                xingxian3: parseInt(document.getElementById('scoreXingxian3').value) || 0,
                xingxian4: parseInt(document.getElementById('scoreXingxian4').value) || 0,
                xingzeng1: parseInt(document.getElementById('scoreXingzeng1').value) || 0,
                xingzeng2: parseInt(document.getElementById('scoreXingzeng2').value) || 0,
                xingzeng3: parseInt(document.getElementById('scoreXingzeng3').value) || 0,
                xingping1: parseInt(document.getElementById('scoreXingping1').value) || 0,
                xingping2: parseInt(document.getElementById('scoreXingping2').value) || 0,
                xingping3: parseInt(document.getElementById('scoreXingping3').value) || 0,
                xingbao: parseInt(document.getElementById('scoreXingbao').value) || 0,
                xingwangZeng: parseInt(document.getElementById('scoreXingwangZeng').value) || 0,
                fumianzhuti: parseInt(document.getElementById('scoreFumianzhuti').value) || 0
            };
            
            // 根据类型保存对应的强度分值
            const qiangduMore50 = parseInt(document.getElementById('scoreQiangduMore50').value) || 0;
            const qiangdu40to50 = parseInt(document.getElementById('scoreQiangdu40to50').value) || 0;
            const qiangdu30to40 = parseInt(document.getElementById('scoreQiangdu30to40').value) || 0;
            const qiangduLess30 = parseInt(document.getElementById('scoreQiangduLess30').value) || 0;
            
            if (currentScoreSettingType === 'recentMulti') {
                settings.qiangduMore50 = qiangduMore50;
                settings.qiangdu40to50 = qiangdu40to50;
                settings.qiangdu30to40 = qiangdu30to40;
                settings.qiangduLess30 = qiangduLess30;
            } else if (currentScoreSettingType === 'sectorEtf') {
                settings.qiangduMore50_banKuai = qiangduMore50;
                settings.qiangdu40to50_banKuai = qiangdu40to50;
                settings.qiangdu30to40_banKuai = qiangdu30to40;
                settings.qiangduLess30_banKuai = qiangduLess30;
            } else if (currentScoreSettingType === 'topicDirection') {
                settings.qiangduMore50_ticai = qiangduMore50;
                settings.qiangdu40to50_ticai = qiangdu40to50;
                settings.qiangdu30to40_ticai = qiangdu30to40;
                settings.qiangduLess30_ticai = qiangduLess30;
            }
            
            window.saveScoreSettingsToStorage(currentScoreSettingType, settings);
            
            const hasFumian = document.getElementById('hasFumianTopicCheckbox').checked;
            localStorage.setItem('hasFumianTopic_' + window.currentDate, hasFumian);
            
            window.closeScoreSettingModal();
            
            if (currentScoreSettingType === 'recentMulti') {
                window.autoCalculateRecentMultiScore();
            } else if (currentScoreSettingType === 'sectorEtf') {
                window.autoCalculateSectorEtfScore();
            } else if (currentScoreSettingType === 'topicDirection') {
                window.autoCalculateTopicDirectionScore();
            }
        }


        export function resetScoreSetting() {
            const defaults = defaultScoreSettings[currentScoreSettingType];
            
            document.getElementById('scoreDie1').value = defaults.die1;
            document.getElementById('scoreDie2').value = defaults.die2;
            document.getElementById('scoreDie3').value = defaults.die3;
            document.getElementById('scoreDie4').value = defaults.die4;
            document.getElementById('scoreDie5').value = defaults.die5;
            document.getElementById('scoreZhang1').value = defaults.zhang1;
            document.getElementById('scoreZhang2').value = defaults.zhang2;
            document.getElementById('scoreZhang3').value = defaults.zhang3;
            document.getElementById('scoreZhang4').value = defaults.zhang4 || -7;
            document.getElementById('scoreKongcang').value = defaults.kongcang;
            document.getElementById('scoreChushou').value = defaults.chushou;
            document.getElementById('scoreYangqun1').value = defaults.yangqun1;
            document.getElementById('scoreYangqun2').value = defaults.yangqun2;
            document.getElementById('scoreYangqun3').value = defaults.yangqun3;
            document.getElementById('scoreYangqun4').value = defaults.yangqun4;
            document.getElementById('scoreYangqun5').value = defaults.yangqun5;
            document.getElementById('scoreYangqun6').value = defaults.yangqun6;
            document.getElementById('scoreYangqun7').value = defaults.yangqun7;
            document.getElementById('scoreYangqun8').value = defaults.yangqun8;
            document.getElementById('scoreYangqun9').value = defaults.yangqun9;
            document.getElementById('scoreYangqun10').value = defaults.yangqun10;
            document.getElementById('scoreYangqun11').value = defaults.yangqun11;
            document.getElementById('scoreJingjiaDie1').value = defaults.jingjiaDie1;
            document.getElementById('scoreDapanMore1').value = defaults.dapanMore1;
            document.getElementById('scoreDapanLess05').value = defaults.dapanLess05;
            document.getElementById('scoreDapanLess1').value = defaults.dapanLess1;
            document.getElementById('scoreZhang5More20').value = defaults.zhang5More20;
            document.getElementById('scoreZhang5More15').value = defaults.zhang5More15;
            document.getElementById('scoreZhang5More10').value = defaults.zhang5More10;
            document.getElementById('scoreZhang5Less10').value = defaults.zhang5Less10;
            document.getElementById('scoreXingxian1').value = defaults.xingxian1;
            document.getElementById('scoreXingxian2').value = defaults.xingxian2;
            document.getElementById('scoreXingxian3').value = defaults.xingxian3;
            document.getElementById('scoreXingxian4').value = defaults.xingxian4;
            document.getElementById('scoreXingzeng1').value = defaults.xingzeng1;
            document.getElementById('scoreXingzeng2').value = defaults.xingzeng2;
            document.getElementById('scoreXingzeng3').value = defaults.xingzeng3;
            document.getElementById('scoreXingping1').value = defaults.xingping1;
            document.getElementById('scoreXingping2').value = defaults.xingping2;
            document.getElementById('scoreXingping3').value = defaults.xingping3;
            document.getElementById('scoreXingbao').value = defaults.xingbao;
            document.getElementById('scoreXingwangZeng').value = defaults.xingwangZeng;
            
            // 根据类型设置对应的强度分默认值
            if (currentScoreSettingType === 'recentMulti') {
                document.getElementById('scoreQiangduMore50').value = defaults.qiangduMore50;
                document.getElementById('scoreQiangdu40to50').value = defaults.qiangdu40to50;
                document.getElementById('scoreQiangdu30to40').value = defaults.qiangdu30to40;
                document.getElementById('scoreQiangduLess30').value = defaults.qiangduLess30;
            } else if (currentScoreSettingType === 'sectorEtf') {
                document.getElementById('scoreQiangduMore50').value = defaults.qiangduMore50_banKuai;
                document.getElementById('scoreQiangdu40to50').value = defaults.qiangdu40to50_banKuai;
                document.getElementById('scoreQiangdu30to40').value = defaults.qiangdu30to40_banKuai;
                document.getElementById('scoreQiangduLess30').value = defaults.qiangduLess30_banKuai;
            } else if (currentScoreSettingType === 'topicDirection') {
                document.getElementById('scoreQiangduMore50').value = defaults.qiangduMore50_ticai;
                document.getElementById('scoreQiangdu40to50').value = defaults.qiangdu40to50_ticai;
                document.getElementById('scoreQiangdu30to40').value = defaults.qiangdu30to40_ticai;
                document.getElementById('scoreQiangduLess30').value = defaults.qiangduLess30_ticai;
            }
            
            document.getElementById('scoreFumianzhuti').value = defaults.fumianzhuti;
            document.getElementById('hasFumianTopicCheckbox').checked = false;
            window.updateScoreInputBorders();
        }


        export function clearScoreSetting() {
            const allInputIds = [
                'scoreDie1', 'scoreDie2', 'scoreDie3', 'scoreDie4', 'scoreDie5',
                'scoreZhang1', 'scoreZhang2', 'scoreZhang3', 'scoreZhang4',
                'scoreKongcang', 'scoreChushou',
                'scoreYangqun1', 'scoreYangqun2', 'scoreYangqun3', 'scoreYangqun4',
                'scoreYangqun5', 'scoreYangqun6', 'scoreYangqun7', 'scoreYangqun8',
                'scoreYangqun9', 'scoreYangqun10', 'scoreYangqun11',
                'scoreJingjiaDie1', 'scoreDapanMore1', 'scoreDapanLess05', 'scoreDapanLess1',
                'scoreZhang5More20', 'scoreZhang5More15',
                'scoreZhang5More10', 'scoreZhang5Less10',
                'scoreXingxian1', 'scoreXingxian2', 'scoreXingxian3', 'scoreXingxian4',
                'scoreXingzeng1', 'scoreXingzeng2', 'scoreXingzeng3',
                'scoreXingping1', 'scoreXingping2', 'scoreXingping3',
                'scoreXingbao', 'scoreXingwangZeng',
                'scoreQiangduMore50', 'scoreQiangdu40to50', 'scoreQiangdu30to40', 'scoreQiangduLess30',
                'scoreFumianzhuti'
            ];
            
            allInputIds.forEach(id => {
                const el = document.getElementById(id);
                if (el) {
                    el.value = '';
                }
            });
            
            document.getElementById('hasFumianTopicCheckbox').checked = false;
            
            const emptySettings = {
                die1: '', die2: '', die3: '', die4: '', die5: '',
                zhang1: '', zhang2: '', zhang3: '', zhang4: '',
                kongcang: '', chushou: '',
                yangqun1: '', yangqun2: '', yangqun3: '', yangqun4: '',
                yangqun5: '', yangqun6: '', yangqun7: '', yangqun8: '',
                yangqun9: '', yangqun10: '', yangqun11: '',
                jingjiaDie1: '',
                dapanMore1: '', dapanLess05: '', dapanLess1: '',
                zhang5More20: '', zhang5More15: '', zhang5More10: '', zhang5Less10: '',
                xingxian1: '', xingxian2: '', xingxian3: '', xingxian4: '',
                xingzeng1: '', xingzeng2: '', xingzeng3: '',
                xingping1: '', xingping2: '', xingping3: '',
                xingbao: '', xingwangZeng: '',
                qiangduMore50: '', qiangdu40to50: '', qiangdu30to40: '', qiangduLess30: '',
                qiangduMore50_banKuai: '', qiangdu40to50_banKuai: '', qiangdu30to40_banKuai: '', qiangduLess30_banKuai: '',
                qiangduMore50_ticai: '', qiangdu40to50_ticai: '', qiangdu30to40_ticai: '', qiangduLess30_ticai: '',
                fumianzhuti: ''
            };
            
            window.saveScoreSettingsToStorage(currentScoreSettingType, emptySettings);
            localStorage.setItem('hasFumianTopic_' + window.currentDate, 'false');
            
            window.updateScoreInputBorders();
            
            if (currentScoreSettingType === 'recentMulti') {
                window.autoCalculateRecentMultiScore();
            } else if (currentScoreSettingType === 'sectorEtf') {
                window.autoCalculateSectorEtfScore();
            } else if (currentScoreSettingType === 'topicDirection') {
                window.autoCalculateTopicDirectionScore();
            }
        }

        // 保存本月总结心得

