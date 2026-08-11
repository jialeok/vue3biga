        export function renderAuctionPage2(dataSource='auction') {
            const _p = dataSource === 'hot' ? 'hot' : 'auction';
            // 同步第二页排序开关到 store（Vue 路径读 store；innerHTML 路径仍读 DOM）
            window._syncSortStateToStore(dataSource, 2);
            // 同步开关状态到内容容器，控制左侧标记 CSS 显示/隐藏
            window._updateAuctionHighlightContainerState(dataSource);

            // ===== Vue 化展示层（全量切换：默认走 Vue，不再依赖特性开关）=====
            // 两个 tab 各自挂载独立 Vue 实例（per-tab app），均由 store 响应式驱动。
            // 不再按 currentGroup 区分——背景 tab 也用 Vue 渲染，避免 innerHTML 回退路径
            // clobber 已挂载的 Vue DOM（与 renderAuction 主表保持一致）。
            // 复刻原 .auction-topic-* 结构以复用现有 CSS；交互（行单击展开趋势图、
            // 题材列长按编辑、股票名/占比单击跳第一页+高亮、组展开行单击整组展开）
            // 全部走既有全局 handler。数据层无副作用，纯展示层替换。挂载失败时回退 innerHTML。
            if (typeof window.mountPage2BoardSandbox === 'function') {
                const _vueEl = document.getElementById(_p + 'Content2');
                if (_vueEl) {
                    if (!window._auctionVuePage2Apps) window._auctionVuePage2Apps = {};
                    if (!window._auctionVuePage2Apps[_p] || !_vueEl.querySelector('.auction-scroll-container,.auction-topic-placeholder')) {
                        try { window._auctionVuePage2Apps[_p] = window.mountPage2BoardSandbox(dataSource, _p + 'Content2'); }
                        catch (e) { window._dbgLog('[AUCTION-VUE] Page2 挂载失败，回退 innerHTML：' + e.message); }
                    }
                    // store 响应式会自动更新第二页；恢复用户已展开的题材组（Vue 路径下
                    // 展开状态已在 store.p2ExpandedTopics，render 时自动恢复，无需再调 DOM 版）
                    if (window.auctionStore) { window.auctionStore.currentDate = window.currentDate; window.auctionStore.currentGroup = window.currentGroup; }
                    return;
                }
            }

            const auctionList = window.getTodayGroupList(dataSource);
            const auctionContent2 = document.getElementById(_p + 'Content2');
            
            if (auctionList.length === 0) {
                auctionContent2.innerHTML = `
                    <div class="auction-topic-placeholder">暂无数据</div>
                `;
                return;
            }

            const groups = window.getTopicGroups(auctionList);
            
            if (groups.length === 0) {
                auctionContent2.innerHTML = `
                    <div class="auction-topic-placeholder">暂无题材分类数据（双击打开核心词管理）</div>
                `;
                return;
            }

            // 获取上一个交易日的数据用于对比
            const prevDate = window.getPreviousTradingDay(window.currentDate);
            const auctionData = window.getGroupData(dataSource);
            const prevAuctionList = prevDate ? (auctionData[prevDate] || []) : [];

            // 计算竞放量达标股票集合（今日竞价量/昨日竞价量四舍五入后 >= 1.5），复用第一页逻辑
            const highRatioInfo2 = window.getHighRatioStocksForDate(window.currentDate, dataSource);
            // 是否开启"环比"（分组内部按 今日竞价量/昨日竞价量 从高到低排列）
            const sortByRatioEnabled2 = document.getElementById(_p + 'SortByRatioToggle2')?.checked;
            // 是否开启"平行"（分组内部把 今日竞价量>T-1竞价量 且 T-1成交量>T-2成交量 的股票排最前面）
            const sortByParallelEnabled2 = document.getElementById(_p + 'SortByParallelToggle2')?.checked;
            // 是否开启"竞/昨"（在平行基础上，进一步要求 今/昨比 > 昨/前比）；集合本身不依赖开关，随时计算以便"竞/昨数"常驻显示
            const sortByJingYestEnabled2 = document.getElementById(_p + 'SortByJingYestToggle2')?.checked;
            const sortByJingYestRatioEnabled2 = document.getElementById(_p + 'SortByJingYestRatioToggle2')?.checked;
            const sortByThreeDayJingDieEnabled2 = document.getElementById(_p + 'SortByThreeDayJingDieToggle2')?.checked;
            const parallelStockNames2 = (sortByParallelEnabled2 || sortByJingYestRatioEnabled2) ? window.getParallelStocksForDate(window.currentDate, dataSource) : null;
            const threeDayJingDieSet2 = sortByThreeDayJingDieEnabled2 ? window.getThreeDayJingDieSet(window.currentDate, dataSource) : null;
            // "竞/昨"高光：统一用 getJingYestHighlightSetForDate（含 digitGap≤1 过滤），与第一页/排序 tier0 口径一致
            const jingYestHighlightSet2 = window.getJingYestHighlightSetForDate(window.currentDate, dataSource);
            // 若"竞/昨"（第二页）开启且高光子集为空，弹一次警示Toast；用同一个防抖标记避免与第一页同一时刻重复弹出
            if ((sortByJingYestEnabled2 || sortByJingYestRatioEnabled2) && jingYestHighlightSet2 && jingYestHighlightSet2.size === 0) {
                window.maybeShowJingYestEmptyToast();
            }

            // 统计每只股票出现在多少个题材中（排除"其它"）
            const stockTopicCount = {};
            groups.forEach(group => {
                if (group.topic === '其它') return;
                group.stocks.forEach(stock => {
                    if (stock.stock) {
                        stockTopicCount[stock.stock] = (stockTopicCount[stock.stock] || 0) + 1;
                    }
                });
            });

            // 计算每个题材组的强度并存储箭头信息
            groups.forEach(group => {
                if (group.topic === '其它') {
                    group.strength = null;
                    return;
                }
                
                let strongCount = 0;
                group.stocks.forEach(stock => {
                    let hasDownArrow = false;
                    if (prevAuctionList.length > 0 && stock.stock) {
                        const prevItem = prevAuctionList.find(p => p.stock && p.stock.trim() === stock.stock.trim());
                        if (prevItem && prevItem.yestVolume) {
                            const prevVolume = parseFloat(prevItem.volume) || 0;
                            const prevYestVolume = parseFloat(prevItem.yestVolume) || 0;
                            if (prevYestVolume > 0) {
                                const prevRatioValue = (prevVolume / prevYestVolume) * 100;
                                const currRatio = Math.round(stock.ratioValue);
                                const prevRatio = Math.round(prevRatioValue);
                                if (currRatio < prevRatio) {
                                    hasDownArrow = true;
                                }
                            }
                        }
                    }
                    if (!hasDownArrow) {
                        strongCount++;
                    }
                });
                
                group.strength = group.stocks.length > 0 ? Math.round((strongCount / group.stocks.length) * 100) : 0;
            });

            // 获取第三页的题材排序顺序
            const topicSortOrder = window.getTopicSortOrder();
            
            // 按第三页顺序排序，不在第三页的放后面，"其它"放最后
            const otherGroup = groups.find(g => g.topic === '其它');
            let sortedGroups;
            
            if (window.isStrengthSortEnabled) {
                // 强度排序模式：按当天强度由高到低排序
                sortedGroups = groups.filter(g => g.topic !== '其它').sort((a, b) => {
                    return (b.strength || 0) - (a.strength || 0);
                });
            } else {
                // 默认排序模式
                sortedGroups = groups.filter(g => g.topic !== '其它').sort((a, b) => {
                    const aIndex = topicSortOrder.indexOf(a.topic);
                    const bIndex = topicSortOrder.indexOf(b.topic);
                    
                    // 都在第三页中，按第三页顺序排
                    if (aIndex !== -1 && bIndex !== -1) {
                        return aIndex - bIndex;
                    }
                    // a在第三页，b不在，a排前面
                    if (aIndex !== -1 && bIndex === -1) {
                        return -1;
                    }
                    // a不在第三页，b在，b排前面
                    if (aIndex === -1 && bIndex !== -1) {
                        return 1;
                    }
                    // 都不在第三页，按强度排序
                    return (b.strength || 0) - (a.strength || 0);
                });
            }
            if (otherGroup) {
                sortedGroups.push(otherGroup);
            }

            let html = `
                <div class="auction-scroll-container">
                    <div class="auction-header-row">
                        <div class="auction-header-item auction-header-stock" style="flex:0 0 75px;padding-left:10px;">股票名称</div>
                        <div class="auction-header-item auction-header-change" style="flex:0 0 55px;">涨幅</div>
                        <div class="auction-header-item auction-header-volume" style="flex:1;text-align:left;padding-left:8px;">题材</div>
                        <div class="auction-header-item auction-header-strength-sort" style="flex:0 0 70px;cursor:pointer;" onclick="window.toggleStrengthSort()">
                            <span id="strengthSortBtn" class="${window.isStrengthSortEnabled ? 'strength-sort-active' : ''}">${window.isStrengthSortEnabled ? '▼强度' : '强度'}</span>
                        </div>
                        <div class="auction-header-item auction-header-ratio" style="flex:0 0 50px;">占比</div>
                    </div>
            `;

            let page2RowSeq = 0;
            sortedGroups.forEach(group => {
                // 统计本周该题材在昨日最大成交额看板中出现的次数
                let rankAppearCount = 0;
                try {
                    rankAppearCount = window.getTopicRankCountThisWeek(group.topic);
                } catch (e) {
                    console.error('Error getting rank count:', e);
                }
                const rankAppearText = rankAppearCount > 0 ? ` 上榜${rankAppearCount}次` : '';
                
                // 根据占比≥4.5%的股票数量显示星星（"其它"分类不显示星星）
                let starText = '';
                if (group.topic !== '其它') {
                    starText = window.getStarSymbols(group.starCount);
                }
                
                // 强度显示（"其它"分类不显示）
                let strengthText = '';
                if (group.topic !== '其它' && group.strength !== null) {
                    strengthText = ` 强度<span style="color:#ef4444;">${group.strength}%</span>`;
                }
                
                // 判断该题材是否允许展开（排除"其它"和"并购重组"）
                const topicAllowsGroupExpand = group.topic !== '其它' && group.topic !== '并购重组';
                const groupExpandRow = topicAllowsGroupExpand
                    ? `<div class="auction-topic-expand-row" data-topic="${group.topic}"><span class="auction-topic-expand-arrow">▼</span></div>`
                    : '';
                
                html += `
                    <div class="auction-topic-group" data-topic-group="${group.topic}">
                        ${groupExpandRow}
                        <div class="auction-topic-header" data-topic="${group.topic}">
                            <span class="auction-topic-left">【${group.topic}】${rankAppearText}</span>
                            <span class="auction-topic-stars">${starText}</span>
                            <span class="auction-topic-strength">${strengthText}</span>
                            <span class="auction-topic-count">${group.stocks.length}只</span>
                        </div>
                `;
                
                // 若开启"环比"，题材分组顺序不变，仅对分组内部个股按三层排序：
                //   1. 达标（今日竞价量/昨日竞价量 四舍五入到一位小数 >= 1.5，与竞放量高光口径一致）：位数差从小到大，位数差相同再按比值从高到低
                //   2. 不达标但比值能算出来：同样按位数差从小到大、比值从高到低排
                //   3. 比值无法计算（昨日无记录/竞价量为0/断点）：保持原相对顺序，垫底
                let stocksToRender = group.stocks;
                if (sortByRatioEnabled2) {
                    const prevAuctionListForSort = prevAuctionList;
                    stocksToRender = group.stocks
                        .map((s, pos) => {
                            const stockName = s.stock ? s.stock.trim() : '';
                            if (!stockName) return { s, pos, ratio: null, digitGap: null, tier: 2 };
                            const todayItem = auctionList.find(item => item.stock && item.stock.trim() === stockName);
                            const todayVolume = todayItem ? window.getNumericVolume(todayItem.volume) : null;
                            const yestVolume = todayItem ? window.getNumericVolume(todayItem.yestVolume) : null;
                            let ratio = null;
                            if (todayVolume !== null && todayVolume !== 0) {
                                const prevItem = prevAuctionListForSort.find(p => p.stock && p.stock.trim() === stockName);
                                const prevVolume = prevItem ? window.getNumericVolume(prevItem.volume) : null;
                                if (prevVolume !== null && prevVolume !== 0) {
                                    ratio = todayVolume / prevVolume;
                                }
                            }
                            // 位数差：|今日竞价量位数 - 今日昨日成交量位数|，与"平行"/"竞/昨"保持同一套定义
                            const digitGap = (todayVolume !== null && yestVolume !== null) ? Math.abs(window.getDigitCount(todayVolume) - window.getDigitCount(yestVolume)) : null;
                            // tier: 0 = 达标（竞放量高光），1 = 不达标但比值可算，2 = 比值无法计算
                            const isHighRatio = highRatioInfo2.stockNames.has(stockName);
                            const tier = isHighRatio ? 0 : (ratio !== null ? 1 : 2);
                            return { s, pos, ratio, digitGap, tier };
                        })
                        .sort((a, b) => {
                            if (a.tier !== b.tier) return a.tier - b.tier;
                            if (a.tier === 0 || a.tier === 1) {
                                if (a.digitGap === null && b.digitGap === null) return a.pos - b.pos;
                                if (a.digitGap === null) return 1;
                                if (b.digitGap === null) return -1;
                                if (a.digitGap !== b.digitGap) return a.digitGap - b.digitGap; // 位数差从小到大
                                return b.ratio - a.ratio; // 位数差相同时，比值从高到低
                            }
                            return a.pos - b.pos; // tier2：保持原相对顺序
                        })
                        .map(x => x.s);
                } else if (sortByJingYestRatioEnabled2) {
                    // "竞/昨占比"排序：按 UI 显示的占比(volume/yestVolume)从高到低；符合竞昨条件(高光)排前面，仅平行达标排中间，都不达标排后面
                    stocksToRender = group.stocks
                        .map((s, pos) => {
                            const name = s.stock ? s.stock.trim() : '';
                            const isParallel = parallelStockNames2 && parallelStockNames2.has(name);
                            const isHighlight = name && jingYestHighlightSet2 && jingYestHighlightSet2.has(name);
                            const tier = isHighlight ? 0 : (isParallel ? 1 : 2);
                            const vol = parseFloat(s.volume) || 0;
                            const yvol = parseFloat(s.yestVolume) || 0;
                            const jr = (vol > 0 && yvol > 0) ? (vol / yvol) : null;
                            return { s, pos, jr, tier };
                        })
                        .sort((a, b) => {
                            if (a.tier !== b.tier) return a.tier - b.tier;
                            if (a.jr === null && b.jr === null) return a.pos - b.pos;
                            if (a.jr === null) return 1;
                            if (b.jr === null) return -1;
                            return b.jr - a.jr;
                        })
                        .map(x => x.s);
                } else if (sortByThreeDayJingDieEnabled2) {
                    // "连续竞跌"排序：按下跌天数从多到少排，天数相同按占比(volume/yestVolume)从低到高排
                    stocksToRender = group.stocks
                        .map((s, pos) => {
                            const name = s.stock ? s.stock.trim() : '';
                            const dd = name && threeDayJingDieSet2 ? (threeDayJingDieSet2.get(name) || 0) : 0;
                            const vol = parseFloat(s.volume) || 0;
                            const yvol = parseFloat(s.yestVolume) || 0;
                            const jr = (vol > 0 && yvol > 0) ? (vol / yvol) : null;
                            return { s, pos, dd, jr };
                        })
                        .sort((a, b) => {
                            if (a.dd !== b.dd) return b.dd - a.dd;
                            if (a.jr === null && b.jr === null) return a.pos - b.pos;
                            if (a.jr === null) return 1;
                            if (b.jr === null) return -1;
                            return a.jr - b.jr;
                        })
                        .map(x => x.s);
                } else if (sortByParallelEnabled2 && parallelStockNames2) {
                    if (sortByJingYestEnabled2) {
                        // "竞/昨"是"平行"的加强筛选，排序需三层：
                        //   1. 竞/昨真正达标（高光条件：平行 + 差值>0 + 位数差<=1）：按"位数差"从小到大排，位数差相同再按差值从高到低排
                        //   2. 平行达标但不满足高光条件（差值<=0，或差值>0但位数差>1）：同样按位数差/差值排序（差值不要求>0，能算出来就参与）
                        //   3. 平行也不达标：保持原相对顺序，垫底
                        // tier0 用 jingYestHighlightSet2（已过滤 digitGap<=1），与实际高光显示口径保持一致
                        const allRatioDiffInfo2 = window.getRatioDiffInfoForDate(window.currentDate, dataSource);
                        stocksToRender = group.stocks
                            .map((s, pos) => {
                                const name = s.stock ? s.stock.trim() : '';
                                const isParallel = parallelStockNames2.has(name);
                                const isHighlight = name && jingYestHighlightSet2 && jingYestHighlightSet2.has(name);
                                // tier: 0 = 竞/昨真正达标（高光），1 = 仅平行达标（含差值>0但位数差>1的情况），2 = 都不达标
                                const tier = isHighlight ? 0 : (isParallel ? 1 : 2);
                                const fallbackInfo = (tier === 0 || tier === 1) ? allRatioDiffInfo2.get(name) : null;
                                const diff = fallbackInfo ? fallbackInfo.diff : null;
                                const digitGap = fallbackInfo ? fallbackInfo.digitGap : null;
                                return { s, pos, diff, digitGap, tier };
                            })
                            .sort((a, b) => {
                                if (a.tier !== b.tier) return a.tier - b.tier;
                                if (a.tier === 0 || a.tier === 1) {
                                    if (a.digitGap === null && b.digitGap === null) return a.pos - b.pos;
                                    if (a.digitGap === null) return 1;
                                    if (b.digitGap === null) return -1;
                                    if (a.digitGap !== b.digitGap) return a.digitGap - b.digitGap; // 位数差从小到大
                                    return b.diff - a.diff; // 位数差相同时，差值从高到低
                                }
                                return a.pos - b.pos; // tier2：保持原相对顺序
                            })
                            .map(x => x.s);
                    } else {
                        // 纯"平行"（"竞/昨"未开启）：题材分组顺序不变，组内排序与其它场景保持同一套三层模式：
                        //   1. 平行达标：按位数差从小到大排，位数差相同按差值(今/昨比-昨/前比)从高到低排（差值不要求>0）
                        //   2. 不达标：保持原相对顺序，垫底
                        const allRatioDiffInfoForParallel2 = window.getRatioDiffInfoForDate(window.currentDate, dataSource);
                        stocksToRender = group.stocks
                            .map((s, pos) => {
                                const name = s.stock ? s.stock.trim() : '';
                                const qualifies = name && parallelStockNames2.has(name);
                                const info = qualifies ? allRatioDiffInfoForParallel2.get(name) : null;
                                return { s, pos, qualifies, diff: info ? info.diff : null, digitGap: info ? info.digitGap : null };
                            })
                            .sort((a, b) => {
                                if (a.qualifies !== b.qualifies) return a.qualifies ? -1 : 1;
                                if (a.qualifies) {
                                    if (a.digitGap === null && b.digitGap === null) return a.pos - b.pos;
                                    if (a.digitGap === null) return 1;
                                    if (b.digitGap === null) return -1;
                                    if (a.digitGap !== b.digitGap) return a.digitGap - b.digitGap; // 位数差从小到大
                                    return b.diff - a.diff; // 位数差相同时，差值从高到低
                                }
                                return a.pos - b.pos; // 不达标：保持原相对顺序
                            })
                            .map(x => x.s);
                    }
                }
                
                stocksToRender.forEach(stock => {
                    let ratioClass = 'auction-topic-ratio';
                    if (stock.ratioValue >= 10) {
                        ratioClass = 'auction-topic-ratio highlight';
                    } else if (stock.ratioValue >= 4.5) {
                        ratioClass = 'auction-topic-ratio highlight-light';
                    }
                    
                    // 与昨天对比占比
                    let ratioArrow = '';
                    if (prevAuctionList.length > 0 && stock.stock) {
                        const prevItem = prevAuctionList.find(p => p.stock && p.stock.trim() === stock.stock.trim());
                        if (prevItem && prevItem.yestVolume) {
                            const prevVolume = parseFloat(prevItem.volume) || 0;
                            const prevYestVolume = parseFloat(prevItem.yestVolume) || 0;
                            if (prevYestVolume > 0) {
                                const prevRatioValue = (prevVolume / prevYestVolume) * 100;
                                const prevRatio = Math.round(prevRatioValue);
                                const currRatio = Math.round(stock.ratioValue);
                                if (currRatio > prevRatio) {
                                    ratioArrow = '<span style="color:#ef4444;">⬆</span>';
                                } else if (currRatio < prevRatio) {
                                    ratioArrow = '<span style="color:#10b981;">⬇</span>';
                                }
                            }
                        }
                    }
                    
                    const changeValue = window.getChangePctDisplay(stock);
                    let changeClass = 'auction-topic-change';
                    if (changeValue.includes('涨停') || (changeValue.startsWith('-') === false && changeValue !== '-')) {
                        changeClass = 'auction-topic-change auction-change-red';
                    } else if (changeValue.startsWith('-')) {
                        changeClass = 'auction-topic-change auction-change-green';
                    }
                    
                    const topicsDisplay = stock.topics ? stock.topics.join(',').replace(/[，、;；]/g, ',') : '-';
                    
                    // 判断股票是否出现在多个题材中
                    const topicCount = stockTopicCount[stock.stock] || 1;
                    let stockStyle = '';
                    let topicNameStyle = '';
                    if (topicCount >= 3) {
                        // 3个及以上题材：股票名称红色加粗500，题材列灰色加粗400
                        stockStyle = 'color:#ef4444;font-weight:500;';
                        topicNameStyle = 'color:#6b7280;font-weight:400;';
                    } else if (topicCount === 2) {
                        // 2个题材：股票名称黑色加粗500，题材列灰色加粗400
                        stockStyle = 'color:#1f2937;font-weight:500;';
                        topicNameStyle = 'color:#6b7280;font-weight:400;';
                    } else {
                        // 1个题材：股票名称60%黑加粗500，题材列灰色加粗400
                        stockStyle = 'color:rgba(0,0,0,0.6);font-weight:500;';
                        topicNameStyle = 'color:#6b7280;font-weight:400;';
                    }
                    
                    // 检查第一页中对应股票的状态，同步颜色
                    const auctionItem = auctionList.find(item => item.stock && item.stock.trim() === stock.stock.trim());
                    let rowClass = 'auction-topic-row';
                    if (auctionItem) {
                        // 方案 B：标签从 stocksData 实时派生，不读 auctionItem.bought/sold/fixed
                        const _ts2 = window.getAuctionTagState(auctionItem.stock.trim(), window.currentDate);
                        if (_ts2.sold) {
                            rowClass = 'auction-topic-row sold';
                        } else if (_ts2.bought) {
                            rowClass = 'auction-topic-row bought';
                        } else if (_ts2.selected) {
                            rowClass = 'auction-topic-row selected';
                        } else if (auctionItem.selected === true) {
                            rowClass = 'auction-topic-row manual-selected';
                        }
                    }
                    // 竞放量高光：仅在"环比"开关打开时才显示；平行高光：仅在"平行"开关打开且"竞/昨"未开启时才显示，优先于竞放量高光
                    // 竞/昨高光：仅在"竞/昨"开关打开时才显示，优先于平行高光；开启后不再叠加平行高光，避免混淆
                    const isJingYestMatch2 = (sortByJingYestEnabled2 || sortByJingYestRatioEnabled2) && jingYestHighlightSet2 && stock.stock && jingYestHighlightSet2.has(stock.stock.trim());
                    const isParallelMatch2 = sortByParallelEnabled2 && !sortByJingYestEnabled2 && !sortByJingYestRatioEnabled2 && parallelStockNames2 && stock.stock && parallelStockNames2.has(stock.stock.trim());
                    const isHighRatioMatch2 = sortByRatioEnabled2 && stock.stock && highRatioInfo2.stockNames.has(stock.stock.trim());
                    const isThreeDayJingDieMatch2 = sortByThreeDayJingDieEnabled2 && threeDayJingDieSet2 && stock.stock && (threeDayJingDieSet2.get(stock.stock.trim()) || 0) >= 2;
                    if (isJingYestMatch2) {
                        rowClass += ' jing-yest-match';
                    } else if (isParallelMatch2) {
                        rowClass += ' parallel-match';
                    } else if (isThreeDayJingDieMatch2) {
                        rowClass += ' three-day-jing-die';
                    } else if (isHighRatioMatch2) {
                        rowClass += ' high-ratio';
                    }

                    // 是否允许展开趋势图：排除"其它"和"并购重组"这两个分组
                    const topicAllowsExpand = group.topic !== '其它' && group.topic !== '并购重组';
                    const rowKey = 'p2-' + group.topic + '-' + page2RowSeq++;
                    const trendTriggerClass = topicAllowsExpand ? 'auction-trend-trigger-p2' : '';
                    
                    html += `
                        <div class="${rowClass} ${trendTriggerClass}" data-stock="${stock.stock || ''}" data-rowkey="${rowKey}">
                            <div class="auction-topic-stock auction-topic-no-select" style="${stockStyle}">${stock.stock || '-'}</div>
                            <div class="${changeClass} auction-topic-no-select">${changeValue}</div>
                            <div class="auction-topic-name auction-topic-editable auction-topic-no-select" data-stock="${stock.stock}" style="${topicNameStyle}">${topicsDisplay}</div>
                            <div class="${ratioClass} auction-topic-no-select">${stock.ratio}${ratioArrow}</div>
                        </div>
                    `;
                    if (topicAllowsExpand) {
                        html += `<div class="auction-trend-panel" id="${_p}TrendPanelP2-${rowKey}" data-stock="${stock.stock || ''}" style="display:none;"></div>`;
                    }
                });
                
                html += `</div>`;
            });

            html += `</div>`;
            
            auctionContent2.innerHTML = html;
            
            window.bindAuctionTopicEdit();

            // 绑定第二页"点击行展开/收起趋势图"事件
            auctionContent2.querySelectorAll('.auction-trend-trigger-p2').forEach(rowEl => {
                rowEl.style.cursor = 'pointer';
                rowEl.addEventListener('click', function(e) {
                    e.stopPropagation();
                    const stockName = this.dataset.stock;
                    const rowKey = this.dataset.rowkey;
                    if (stockName && rowKey) {
                        window.toggleAuctionTrendPanelP2(rowKey, stockName);
                    }
                });
            });

            // 若"全部展开"开关已打开，渲染完成后自动展开（切换排序/搜索/重新渲染后维持状态）
            if (document.getElementById(_p + 'ExpandAllToggle2')?.checked) {
                window.expandAllAuctionTrendPanelsP2(_p);
            } else {
                // 否则恢复用户此前手动展开过的题材组（避免 Realtime 重渲染导致展开状态丢失）
                window.restoreExpandedTopicGroupsP2(dataSource);
            }

            // "竞/昨数"（第二页）：常驻显示实际允许高光的达标股票数量，不带箭头
            const jingYestCountEl2 = document.getElementById(_p + 'JingYestCount2');
            if (jingYestCountEl2) {
                jingYestCountEl2.textContent = jingYestHighlightSet2 ? jingYestHighlightSet2.size : '-';
            }

            // 更新"竞放量数"统计及与昨天的对比箭头（第二页复用第一页同一套计算函数）
            const highRatioCountEl2 = document.getElementById(_p + 'HighRatioCount2');
            const highRatioArrowEl2 = document.getElementById(_p + 'HighRatioArrow2');
            if (highRatioCountEl2) {
                highRatioCountEl2.textContent = highRatioInfo2.count;
            }
            if (highRatioArrowEl2) {
                const prevDateForRatio2 = window.getPreviousTradingDay(window.currentDate);
                if (prevDateForRatio2) {
                    const highRatioYesterday2 = window.getHighRatioStocksForDate(prevDateForRatio2, dataSource);
                    if (highRatioInfo2.count > highRatioYesterday2.count) {
                        highRatioArrowEl2.textContent = ' ⬆';
                        highRatioArrowEl2.style.color = '#dc2626';
                    } else if (highRatioInfo2.count < highRatioYesterday2.count) {
                        highRatioArrowEl2.textContent = ' ⬇';
                        highRatioArrowEl2.style.color = '#16a34a';
                    } else {
                        highRatioArrowEl2.textContent = ' -';
                        highRatioArrowEl2.style.color = '#92400e';
                    }
                } else {
                    highRatioArrowEl2.textContent = '';
                }
            }
        }

        // 获取第三页题材排序顺序
        export function getTopicSortOrder(dataSource='auction') {
            const allTradingDays = window.getLastNTradingDays(6);
            if (allTradingDays.length === 0) return [];

            const tradingDays = allTradingDays.slice(0, 5);
            const topicData = {};
            const auctionData = window.getGroupData(dataSource);
            const allTopicData = {};
            
            allTradingDays.forEach(dateStr => {
                const dayAuctionList = auctionData[dateStr] || [];
                if (dayAuctionList.length === 0) return;
                
                const groups = window.getTopicGroups(dayAuctionList);
                
                groups.forEach(group => {
                    if (group.topic === '其它' || group.topic === '并购重组') return;
                    
                    if (!allTopicData[group.topic]) {
                        allTopicData[group.topic] = [];
                    }
                    
                    let strongCount = 0;
                    const prevDate = window.getPreviousTradingDay(dateStr);
                    const prevAuctionList = prevDate ? (auctionData[prevDate] || []) : [];
                    
                    let upCount = 0;
                    let downCount = 0;
                    
                    group.stocks.forEach(stock => {
                        let hasDownArrow = false;
                        if (prevAuctionList.length > 0 && stock.stock) {
                            const prevItem = prevAuctionList.find(p => p.stock && p.stock.trim() === stock.stock.trim());
                            if (prevItem && prevItem.yestVolume) {
                                const prevVolume = parseFloat(prevItem.volume) || 0;
                                const prevYestVolume = parseFloat(prevItem.yestVolume) || 0;
                                if (prevYestVolume > 0) {
                                    const prevRatioValue = (prevVolume / prevYestVolume) * 100;
                                    const currRatio = Math.round(stock.ratioValue);
                                    const prevRatio = Math.round(prevRatioValue);
                                    if (currRatio < prevRatio) {
                                        hasDownArrow = true;
                                    }
                                }
                            }
                        }
                        if (!hasDownArrow) {
                            strongCount++;
                        }
                        
                        const changeValue = window.getChangePctDisplay(stock);
                        if (changeValue && changeValue !== '-') {
                            if (changeValue.includes('涨停') || (!changeValue.startsWith('-') && !changeValue.includes('跌停'))) {
                                upCount++;
                            } else if (changeValue.startsWith('-') || changeValue.includes('跌停')) {
                                downCount++;
                            }
                        }
                        // 没有涨幅数据的不计入涨跌统计
                    });
                    
                    const strength = group.stocks.length > 0 ? Math.round((strongCount / group.stocks.length) * 100) : 0;
                    const isUp = upCount >= downCount;
                    const hasChangeData = upCount > 0 || downCount > 0;
                    
                    let rankAppearCount = 0;
                    try {
                        rankAppearCount = window.getTopicRankCountByDate(group.topic, dateStr);
                    } catch (e) {}
                    
                    allTopicData[group.topic].push({
                        date: dateStr,
                        rankCount: rankAppearCount,
                        starCount: group.starCount,
                        strength: strength,
                        stockCount: group.stocks.length,
                        isUp: isUp,
                        hasData: true,
                        hasChangeData: hasChangeData
                    });
                });
            });
            
            Object.keys(allTopicData).forEach(topic => {
                topicData[topic] = allTopicData[topic].filter(d => tradingDays.includes(d.date));
            });
            
            // 为每个题材补全5个交易日的数据
            Object.keys(topicData).forEach(topic => {
                const existingDates = topicData[topic].map(d => d.date);
                tradingDays.forEach(dateStr => {
                    if (!existingDates.includes(dateStr)) {
                        topicData[topic].push({
                            date: dateStr,
                            rankCount: 0,
                            starCount: 0,
                            starText: '-',
                            strength: 0,
                            stockCount: 0,
                            isUp: null,
                            hasData: false,
                            strengthUp: false
                        });
                    } else {
                        const item = topicData[topic].find(d => d.date === dateStr);
                        if (item) item.hasData = true;
                    }
                });
            });
            
            // 计算每个日期的强度箭头类型
            Object.keys(topicData).forEach(topic => {
                topicData[topic].forEach((dayData, index) => {
                    if (!dayData.hasData) {
                        dayData.strengthUp = false;
                        return;
                    }
                    
                    let prevDayData = null;
                    const currentIndex = tradingDays.indexOf(dayData.date);
                    if (currentIndex < tradingDays.length - 1) {
                        prevDayData = topicData[topic].find(d => d.date === tradingDays[currentIndex + 1]);
                    }
                    
                    const currStrength = dayData.strength || 0;
                    const prevStrength = prevDayData ? (prevDayData.strength || 0) : 0;
                    const currStarCount = dayData.starCount || 0;
                    const prevStarCount = prevDayData ? (prevDayData.starCount || 0) : 0;
                    
                    if (currStrength > prevStrength) {
                        dayData.strengthUp = true;
                    } else if (currStrength < prevStrength) {
                        if (prevStrength > 70 && prevStarCount > 0) {
                            dayData.strengthUp = true;
                        } else if (prevStarCount === 0 && currStarCount > 0) {
                            dayData.strengthUp = true;
                        } else {
                            dayData.strengthUp = false;
                        }
                    } else {
                        dayData.strengthUp = true;
                    }
                });
            });
            
            const validTopics = Object.entries(topicData)
                .filter(([topic, data]) => data.filter(d => d.hasData).length >= 2)
                .map(([topic, data]) => ({ topic, data }));
            
            if (validTopics.length === 0) return [];
            
            // 排序：1.今天有数据 2.今天有星 3.强度不下降 4.涨天数多 5.星星总数多
            validTopics.sort((a, b) => {
                const todayDate = tradingDays[0];
                const prevDate = tradingDays[1];
                
                const aTodayData = a.data.find(d => d.date === todayDate);
                const aPrevData = a.data.find(d => d.date === prevDate);
                const bTodayData = b.data.find(d => d.date === todayDate);
                const bPrevData = b.data.find(d => d.date === prevDate);
                
                // 第一优先级：今天有数据的排前面
                const aTodayHasData = aTodayData?.hasData || false;
                const bTodayHasData = bTodayData?.hasData || false;
                if (aTodayHasData !== bTodayHasData) {
                    return bTodayHasData ? 1 : -1;
                }
                
                // 第二优先级：今天有星的排前面
                const aTodayHasStar = aTodayData?.hasData && (aTodayData.starCount || 0) > 0;
                const bTodayHasStar = bTodayData?.hasData && (bTodayData.starCount || 0) > 0;
                if (aTodayHasStar !== bTodayHasStar) {
                    return bTodayHasStar ? 1 : -1;
                }
                
                // 获取强度（没有数据看作0）
                const aTodayStrength = aTodayData?.hasData ? (aTodayData.strength || 0) : 0;
                const aPrevStrength = aPrevData?.hasData ? (aPrevData.strength || 0) : 0;
                const bTodayStrength = bTodayData?.hasData ? (bTodayData.strength || 0) : 0;
                const bPrevStrength = bPrevData?.hasData ? (bPrevData.strength || 0) : 0;
                
                // 获取星星数
                const aTodayStarCount = aTodayData?.hasData ? (aTodayData.starCount || 0) : 0;
                const aPrevStarCount = aPrevData?.hasData ? (aPrevData.starCount || 0) : 0;
                const bTodayStarCount = bTodayData?.hasData ? (bTodayData.starCount || 0) : 0;
                const bPrevStarCount = bPrevData?.hasData ? (bPrevData.starCount || 0) : 0;
                
                // 第三优先级：强度不下降的排前面（包含特殊规则）
                // 判断是否"不下降"：正常不下降 或 规则A(上交易日强度>70%且有星) 或 规则B(上交易日没星今天有星)
                const aStrengthNotDown = aTodayStrength >= aPrevStrength || 
                    (aTodayStrength < aPrevStrength && aPrevStrength > 70 && aPrevStarCount > 0) ||
                    (aTodayStrength < aPrevStrength && aPrevStarCount === 0 && aTodayStarCount > 0);
                const bStrengthNotDown = bTodayStrength >= bPrevStrength || 
                    (bTodayStrength < bPrevStrength && bPrevStrength > 70 && bPrevStarCount > 0) ||
                    (bTodayStrength < bPrevStrength && bPrevStarCount === 0 && bTodayStarCount > 0);
                if (aStrengthNotDown !== bStrengthNotDown) {
                    return bStrengthNotDown ? 1 : -1;
                }
                
                // 第四优先级：涨天数多的排前面（有涨幅数据且上涨的天数）
                const aUpDays = a.data.filter(d => d.hasChangeData && d.isUp).length;
                const bUpDays = b.data.filter(d => d.hasChangeData && d.isUp).length;
                if (aUpDays !== bUpDays) {
                    return bUpDays - aUpDays;
                }
                
                // 第五优先级：星星总数多的排前面
                const aTotalStars = a.data.filter(d => d.hasData).reduce((sum, d) => sum + (d.starCount || 0), 0);
                const bTotalStars = b.data.filter(d => d.hasData).reduce((sum, d) => sum + (d.starCount || 0), 0);
                return bTotalStars - aTotalStars;
            });
            
            return validTopics.map(t => t.topic);
        }

        // 获取股票的星星标签
        export function getStarTagsForStock(stockName) {
            if (!stockName) return null;
            
            const auctionData = window.getAuctionData();
            const todayAuctionList = auctionData[window.currentDate] || [];
            const prevDate = window.getPreviousTradingDay(window.currentDate);
            const prevAuctionList = prevDate ? (auctionData[prevDate] || []) : [];
            
            if (todayAuctionList.length === 0) return null;
            
            const todayGroups = window.getTopicGroups(todayAuctionList);
            const prevGroups = prevDate ? window.getTopicGroups(prevAuctionList) : [];
            
            const stockTopics = [];
            
            todayGroups.forEach(group => {
                if (group.topic === '其它' || group.topic === '并购重组') return;
                
                const hasStock = group.stocks.some(s => s.stock && s.stock.trim() === stockName.trim());
                if (!hasStock) return;
                
                const todayStarCount = group.starCount || 0;
                const prevGroup = prevGroups.find(g => g.topic === group.topic);
                const prevStarCount = prevGroup ? (prevGroup.starCount || 0) : 0;
                
                stockTopics.push({
                    topic: group.topic,
                    todayStarCount: todayStarCount,
                    prevStarCount: prevStarCount,
                    starChange: todayStarCount - prevStarCount
                });
            });
            
            if (stockTopics.length === 0) return null;
            
            let maxStarTopic = null;
            let maxStarCount = 0;
            todayGroups.forEach(group => {
                if (group.topic === '其它' || group.topic === '并购重组') return;
                if ((group.starCount || 0) > maxStarCount) {
                    maxStarCount = group.starCount || 0;
                    maxStarTopic = group.topic;
                }
            });
            
            let bestTag = null;
            let bestPriority = 0;
            
            stockTopics.forEach(st => {
                let tag = null;
                let priority = 0;
                
                if (st.todayStarCount > st.prevStarCount && st.todayStarCount > 5) {
                    tag = '星爆';
                    priority = 1;
                } else if (st.topic === maxStarTopic && maxStarCount > 0) {
                    tag = '星最多';
                    priority = 2;
                } else if (st.todayStarCount > 0 && st.prevStarCount === 0) {
                    tag = '星现';
                    priority = 3;
                } else if (st.todayStarCount > st.prevStarCount) {
                    tag = '星增';
                    priority = 4;
                } else if (st.todayStarCount === st.prevStarCount && st.todayStarCount > 0) {
                    tag = '星平';
                    priority = 5;
                } else if (st.todayStarCount < st.prevStarCount && st.todayStarCount > 0) {
                    tag = '星减';
                    priority = 6;
                } else if (st.todayStarCount === 0 && st.prevStarCount > 0) {
                    tag = '星无';
                    priority = 7;
                }
                
                if (tag && (priority < bestPriority || bestPriority === 0)) {
                    bestTag = tag;
                    bestPriority = priority;
                }
            });
            
            return bestTag;
        }

        // 获取股票的盈亏状态（从卖出记录）
        export function getStockProfitStatus(stockName, stocksData) {
            if (!stockName || !stocksData) return null;
            
            // 获取当前日期的股票数据
            const todayStocks = stocksData[window.currentDate] || [];
            const stock = todayStocks.find(s => s.name && s.name.trim() === stockName.trim());
            if (!stock || !stock.soldRecords || stock.soldRecords.length === 0) return null;
            
            // 按日期排序，获取最新的记录
            const sortedRecords = [...stock.soldRecords].sort((a, b) => {
                return new Date(b.date) - new Date(a.date);
            });
            
            const latestRecord = sortedRecords[0];
            if (!latestRecord || !latestRecord.profit) return null;
            
            // 解析盈利金额
            const profitStr = latestRecord.profit.replace(/[^\d.-]/g, '');
            const profitValue = parseFloat(profitStr);
            
            if (isNaN(profitValue)) return null;
            
            return profitValue >= 0 ? '赚' : '亏';
        }

        // 渲染第三页（题材五日统计）
        export function renderAuctionPage3(dataSource='auction') {
            const _p = dataSource === 'hot' ? 'hot' : 'auction';

            // ===== Vue 化展示层（全量切换：默认走 Vue，不再依赖特性开关）=====
            // 两个 tab 各自挂载独立 Vue 实例（per-tab app），均由 store 响应式驱动。
            // 不再按 currentGroup 区分——背景 tab 也用 Vue 渲染，避免 innerHTML 回退路径
            // clobber 已挂载的 Vue DOM（与 renderAuction 主表保持一致）。
            // 复刻原 .auction-topic-history-* 结构以复用现有 CSS；复制按钮走既有
            // copyAllTopicStocks / copyTopicStocks 全局 handler。数据层无副作用。挂载失败时回退 innerHTML。
            if (typeof window.mountPage3BoardSandbox === 'function') {
                const __rp3T0 = performance.now();
                const _vueEl = document.getElementById(_p + 'Content3');
                if (_vueEl) {
                    if (!window._auctionVuePage3Apps) window._auctionVuePage3Apps = {};
                    const __alreadyMounted = !!window._auctionVuePage3Apps[_p];
                    const __hasMarker = !!_vueEl.querySelector('.auction-topic-history-group,.auction-topic-placeholder');
                    if (!__alreadyMounted || !__hasMarker) {
                        window._dbgLog('[PERF-MOUNT] window.renderAuctionPage3/' + dataSource + ' 判定需要(重新)挂载：已挂载标记=' + __alreadyMounted + '，DOM含标记类=' + __hasMarker);
                        try { window._auctionVuePage3Apps[_p] = window.mountPage3BoardSandbox(dataSource, _p + 'Content3'); }
                        catch (e) { window._dbgLog('[AUCTION-VUE] Page3 挂载失败，回退 innerHTML：' + e.message); }
                    }
                    if (window.auctionStore) { window.auctionStore.currentDate = window.currentDate; window.auctionStore.currentGroup = window.currentGroup; }
                    const __rp3Total = performance.now() - __rp3T0;
                    if (__rp3Total > 30) {
                        window._dbgLog('[PERF-MOUNT] window.renderAuctionPage3/' + dataSource + ' 总耗时=' + __rp3Total.toFixed(1) + 'ms（含querySelector判断+可能的挂载）');
                    }
                    return;
                }
            }

            const auctionContent3 = document.getElementById(_p + 'Content3');

            // 获取最近6个交易日（第6天用于计算第5天的强度变化）
            const allTradingDays = window.getLastNTradingDays(6);
            if (allTradingDays.length === 0) {
                auctionContent3.innerHTML = '<div class="auction-topic-placeholder">暂无交易日数据</div>';
                return;
            }
            
            // 只显示最近5天的数据
            const tradingDays = allTradingDays.slice(0, 5);
            
            // 收集每个题材在交易日内的数据
            const topicData = {};
            const auctionData = window.getGroupData(dataSource);
            
            // 收集所有6天的数据用于计算
            const allTopicData = {};
            
            allTradingDays.forEach(dateStr => {
                const dayAuctionList = auctionData[dateStr] || [];
                if (dayAuctionList.length === 0) return;
                
                const groups = window.getTopicGroups(dayAuctionList);
                
                groups.forEach(group => {
                    if (group.topic === '其它' || group.topic === '并购重组') return;
                    
                    if (!allTopicData[group.topic]) {
                        allTopicData[group.topic] = [];
                    }
                    
                    // 计算强度
                    let strongCount = 0;
                    const prevDate = window.getPreviousTradingDay(dateStr);
                    const prevAuctionList = prevDate ? (auctionData[prevDate] || []) : [];
                    
                    // 计算涨跌数量
                    let upCount = 0;
                    let downCount = 0;
                    
                    group.stocks.forEach(stock => {
                        let hasDownArrow = false;
                        if (prevAuctionList.length > 0 && stock.stock) {
                            const prevItem = prevAuctionList.find(p => p.stock && p.stock.trim() === stock.stock.trim());
                            if (prevItem && prevItem.yestVolume) {
                                const prevVolume = parseFloat(prevItem.volume) || 0;
                                const prevYestVolume = parseFloat(prevItem.yestVolume) || 0;
                                if (prevYestVolume > 0) {
                                    const prevRatioValue = (prevVolume / prevYestVolume) * 100;
                                    const currRatio = Math.round(stock.ratioValue);
                                    const prevRatio = Math.round(prevRatioValue);
                                    if (currRatio < prevRatio) {
                                        hasDownArrow = true;
                                    }
                                }
                            }
                        }
                        if (!hasDownArrow) {
                            strongCount++;
                        }
                        
                        // 计算涨跌
                        const changeValue = window.getChangePctDisplay(stock);
                        if (changeValue && changeValue !== '-') {
                            if (changeValue.includes('涨停') || (!changeValue.startsWith('-') && !changeValue.includes('跌停'))) {
                                upCount++;
                            } else if (changeValue.startsWith('-') || changeValue.includes('跌停')) {
                                downCount++;
                            }
                        }
                        // 没有涨幅数据的不计入涨跌统计
                    });
                    
                    const strength = group.stocks.length > 0 ? Math.round((strongCount / group.stocks.length) * 100) : 0;
                    
                    // 判断涨跌：上涨数 >= 下跌数 为涨，否则为跌
                    const isUp = upCount >= downCount;
                    // 是否有涨幅数据
                    const hasChangeData = upCount > 0 || downCount > 0;
                    
                    // 获取上榜次数
                    let rankAppearCount = 0;
                    try {
                        rankAppearCount = window.getTopicRankCountByDate(group.topic, dateStr);
                    } catch (e) {}
                    
                    // 星星符号
                    const starText = window.getStarSymbols(group.starCount);
                    
                    allTopicData[group.topic].push({
                        date: dateStr,
                        rankCount: rankAppearCount,
                        starCount: group.starCount,
                        starText: starText,
                        strength: strength,
                        stockCount: group.stocks.length,
                        isUp: isUp,
                        hasData: true,
                        hasChangeData: hasChangeData
                    });
                });
            });
            
            // 只保留最近5天的数据用于显示
            Object.keys(allTopicData).forEach(topic => {
                topicData[topic] = allTopicData[topic].filter(d => tradingDays.includes(d.date));
            });
            
            // 为每个题材补全5个交易日的数据
            Object.keys(topicData).forEach(topic => {
                const existingDates = topicData[topic].map(d => d.date);
                tradingDays.forEach(dateStr => {
                    if (!existingDates.includes(dateStr)) {
                        // 补充没有数据的日期
                        topicData[topic].push({
                            date: dateStr,
                            rankCount: 0,
                            starCount: 0,
                            starText: '-',
                            strength: 0,
                            stockCount: 0,
                            isUp: null,
                            hasData: false,
                            strengthUp: false
                        });
                    } else {
                        // 标记有数据
                        const item = topicData[topic].find(d => d.date === dateStr);
                        if (item) item.hasData = true;
                    }
                });
            });
            
            // 计算每个日期的强度箭头类型
            Object.keys(topicData).forEach(topic => {
                topicData[topic].forEach((dayData, index) => {
                    if (!dayData.hasData) {
                        dayData.strengthUp = false;
                        return;
                    }
                    
                    // 找到上一个交易日的数据
                    let prevDayData = null;
                    const currentIndex = tradingDays.indexOf(dayData.date);
                    if (currentIndex < tradingDays.length - 1) {
                        prevDayData = topicData[topic].find(d => d.date === tradingDays[currentIndex + 1]);
                    }
                    
                    const currStrength = dayData.strength || 0;
                    const prevStrength = prevDayData ? (prevDayData.strength || 0) : 0;
                    const currStarCount = dayData.starCount || 0;
                    const prevStarCount = prevDayData ? (prevDayData.starCount || 0) : 0;
                    
                    // 计算箭头类型
                    if (currStrength > prevStrength) {
                        dayData.strengthUp = true; // 上升
                    } else if (currStrength < prevStrength) {
                        // 检查特殊规则
                        if (prevStrength > 70 && prevStarCount > 0) {
                            // 规则A：上交易日强度>70%且有星 → 维持
                            dayData.strengthUp = true;
                        } else if (prevStarCount === 0 && currStarCount > 0) {
                            // 规则B：上交易日没星，今天有星 → 上升
                            dayData.strengthUp = true;
                        } else {
                            dayData.strengthUp = false; // 下降
                        }
                    } else {
                        dayData.strengthUp = true; // 平
                    }
                });
            });
            
            // 过滤出现次数>=2的题材（有数据的日期>=2）
            const validTopics = Object.entries(topicData)
                .filter(([topic, data]) => data.filter(d => d.hasData).length >= 2)
                .map(([topic, data]) => ({ topic, data }));
            
            if (validTopics.length === 0) {
                auctionContent3.innerHTML = '<div class="auction-topic-placeholder">暂无符合条件的题材（需5日内出现2次以上）</div>';
                return;
            }
            
            // 排序：1.今天有数据 2.今天有星 3.强度不下降 4.涨天数多 5.星星总数多
            validTopics.sort((a, b) => {
                // 获取今天和上交易日的数据
                const todayDate = tradingDays[0];
                const prevDate = tradingDays[1];
                
                const aTodayData = a.data.find(d => d.date === todayDate);
                const aPrevData = a.data.find(d => d.date === prevDate);
                const bTodayData = b.data.find(d => d.date === todayDate);
                const bPrevData = b.data.find(d => d.date === prevDate);
                
                // 强度排序模式：按当天强度由高到低排序
                if (window.isStrengthSortEnabled) {
                    const aTodayStrength = aTodayData?.hasData ? (aTodayData.strength || 0) : 0;
                    const bTodayStrength = bTodayData?.hasData ? (bTodayData.strength || 0) : 0;
                    return bTodayStrength - aTodayStrength;
                }
                
                // 第一优先级：今天有数据的排前面
                const aTodayHasData = aTodayData?.hasData || false;
                const bTodayHasData = bTodayData?.hasData || false;
                if (aTodayHasData !== bTodayHasData) {
                    return bTodayHasData ? 1 : -1;
                }
                
                // 第二优先级：今天有星的排前面
                const aTodayHasStar = aTodayData?.hasData && (aTodayData.starCount || 0) > 0;
                const bTodayHasStar = bTodayData?.hasData && (bTodayData.starCount || 0) > 0;
                if (aTodayHasStar !== bTodayHasStar) {
                    return bTodayHasStar ? 1 : -1;
                }
                
                // 获取强度（没有数据看作0）
                const aTodayStrength = aTodayData?.hasData ? (aTodayData.strength || 0) : 0;
                const aPrevStrength = aPrevData?.hasData ? (aPrevData.strength || 0) : 0;
                const bTodayStrength = bTodayData?.hasData ? (bTodayData.strength || 0) : 0;
                const bPrevStrength = bPrevData?.hasData ? (bPrevData.strength || 0) : 0;
                
                // 获取星星数
                const aTodayStarCount = aTodayData?.hasData ? (aTodayData.starCount || 0) : 0;
                const aPrevStarCount = aPrevData?.hasData ? (aPrevData.starCount || 0) : 0;
                const bTodayStarCount = bTodayData?.hasData ? (bTodayData.starCount || 0) : 0;
                const bPrevStarCount = bPrevData?.hasData ? (bPrevData.starCount || 0) : 0;
                
                // 第三优先级：强度不下降的排前面（包含特殊规则）
                const aStrengthNotDown = aTodayStrength >= aPrevStrength || 
                    (aTodayStrength < aPrevStrength && aPrevStrength > 70 && aPrevStarCount > 0) ||
                    (aTodayStrength < aPrevStrength && aPrevStarCount === 0 && aTodayStarCount > 0);
                const bStrengthNotDown = bTodayStrength >= bPrevStrength || 
                    (bTodayStrength < bPrevStrength && bPrevStrength > 70 && bPrevStarCount > 0) ||
                    (bTodayStrength < bPrevStrength && bPrevStarCount === 0 && bTodayStarCount > 0);
                if (aStrengthNotDown !== bStrengthNotDown) {
                    return bStrengthNotDown ? 1 : -1;
                }
                
                // 第四优先级：涨天数多的排前面（有涨幅数据且上涨的天数）
                const aUpDays = a.data.filter(d => d.hasChangeData && d.isUp).length;
                const bUpDays = b.data.filter(d => d.hasChangeData && d.isUp).length;
                if (aUpDays !== bUpDays) {
                    return bUpDays - aUpDays;
                }
                
                // 第五优先级：星星总数多的排前面
                const aTotalStars = a.data.filter(d => d.hasData).reduce((sum, d) => sum + (d.starCount || 0), 0);
                const bTotalStars = b.data.filter(d => d.hasData).reduce((sum, d) => sum + (d.starCount || 0), 0);
                return bTotalStars - aTotalStars;
            });

            let html = '';
            
            validTopics.forEach(({ topic, data }) => {
                // 按日期降序排序（最新的在前面）
                data.sort((a, b) => b.date.localeCompare(a.date));
                
                // 检查今天是否有数据
                const todayData = data.find(d => d.date === window.currentDate);
                const hasTodayData = todayData && todayData.hasData;
                
                html += `
                    <div class="auction-topic-history-group">
                        <div class="auction-topic-history-title">
                            <span>${topic}</span>
                            ${hasTodayData ? `<span class="auction-topic-copy-btns"><span class="auction-topic-copy-btn" onclick="window.copyAllTopicStocks('${topic}', '${dataSource}')">全复制</span><span class="auction-topic-copy-btn" onclick="window.copyTopicStocks('${topic}', 5, '${dataSource}')">复制5%</span><span class="auction-topic-copy-btn" onclick="window.copyTopicStocks('${topic}', 2, '${dataSource}')">复制2%</span></span>` : ''}
                        </div>
                        <div class="auction-topic-history-header">
                            <span class="auction-history-col auction-history-date">日期</span>
                            <span class="auction-history-col auction-history-rank">上榜次数</span>
                            <span class="auction-history-col auction-history-star">星评</span>
                            <span class="auction-history-col auction-history-strength">强度</span>
                            <span class="auction-history-col auction-history-count">总数</span>
                            <span class="auction-history-col auction-history-arrow">变化</span>
                        </div>
                `;
                
                data.forEach((dayData, index) => {
                    const isToday = dayData.date === window.currentDate;
                    const rowClass = isToday ? 'auction-topic-history-row today' : 'auction-topic-history-row';
                    
                    // 格式化日期：2026-02-26 -> 2月26
                    const dateParts = dayData.date.split('-');
                    const formattedDate = `${parseInt(dateParts[1])}月${parseInt(dateParts[2])}`;
                    
                    // 计算箭头：和后一天对比（日期降序，后一天是更早的日期）
                    let arrow = '';
                    if (index < data.length - 1) {
                        // 有下一条数据，直接对比
                        const prevDayData = data[index + 1];
                        if (prevDayData) {
                            // 获取强度（没有数据看作0）
                            const currStrength = dayData.hasData ? (dayData.strength || 0) : 0;
                            const prevStrength = prevDayData.hasData ? (prevDayData.strength || 0) : 0;
                            const currStarCount = dayData.hasData ? (dayData.starCount || 0) : 0;
                            const prevStarCount = prevDayData.hasData ? (prevDayData.starCount || 0) : 0;
                            
                            // 如果当前日期没有数据，显示"-"
                            if (!dayData.hasData) {
                                arrow = '<span style="color:#9ca3af;">-</span>';
                            } else if (currStrength > prevStrength) {
                                arrow = '<span style="color:#ef4444;">⬆</span>';
                            } else if (currStrength < prevStrength) {
                                // 检查特殊规则
                                if (prevStrength > 70 && prevStarCount > 0) {
                                    // 规则A：上交易日强度>70%且有星 → 维持
                                    arrow = '<span style="color:#ef4444;">≈</span>';
                                } else if (prevStarCount === 0 && currStarCount > 0) {
                                    // 规则B：上交易日没星，今天有星 → 上升
                                    arrow = '<span style="color:#ef4444;">⬆</span>';
                                } else {
                                    arrow = '<span style="color:#10b981;">⬇</span>';
                                }
                            } else {
                                arrow = '<span style="color:#f97316;">平</span>';
                            }
                        }
                    } else {
                        // 最后一条记录，从allTopicData中查找前一天的数据
                        const prevDate = window.getPreviousTradingDay(dayData.date);
                        if (prevDate) {
                            const prevDayData = allTopicData[topic]?.find(d => d.date === prevDate);
                            const currStrength = dayData.hasData ? (dayData.strength || 0) : 0;
                            const prevStrength = prevDayData ? (prevDayData.strength || 0) : 0;
                            const currStarCount = dayData.hasData ? (dayData.starCount || 0) : 0;
                            const prevStarCount = prevDayData ? (prevDayData.starCount || 0) : 0;
                            
                            // 如果当前日期没有数据，显示"-"
                            if (!dayData.hasData) {
                                arrow = '<span style="color:#9ca3af;">-</span>';
                            } else if (currStrength > prevStrength) {
                                arrow = '<span style="color:#ef4444;">⬆</span>';
                            } else if (currStrength < prevStrength) {
                                // 检查特殊规则
                                if (prevStrength > 70 && prevStarCount > 0) {
                                    // 规则A：上交易日强度>70%且有星 → 维持
                                    arrow = '<span style="color:#ef4444;">≈</span>';
                                } else if (prevStarCount === 0 && currStarCount > 0) {
                                    // 规则B：上交易日没星，今天有星 → 上升
                                    arrow = '<span style="color:#ef4444;">⬆</span>';
                                } else {
                                    arrow = '<span style="color:#10b981;">⬇</span>';
                                }
                            } else {
                                arrow = '<span style="color:#f97316;">平</span>';
                            }
                        }
                    }
                    
                    // 上榜次数颜色
                    const rankColor = dayData.rankCount === 0 ? '#9ca3af' : '#9333ea';
                    
                    // 判断是否有数据
                    if (dayData.hasData) {
                        // 有数据的日期
                        if (dayData.hasChangeData) {
                            // 有涨幅数据：显示涨跌
                            const trendColor = dayData.isUp ? '#ef4444' : '#10b981';
                            const trendText = dayData.isUp ? '涨' : '跌';
                            
                            // 星评样式：6★及以上加大加粗
                            const starStyle = (dayData.starCount >= 6) ? 'font-size:13px;font-weight:600;' : '';
                            
                            html += `
                                <div class="${rowClass}" data-topic="${topic}" data-date="${dayData.date}">
                                    <span class="auction-history-col auction-history-date">${formattedDate}</span>
                                    <span class="auction-history-col auction-history-rank" style="color:${rankColor};">上榜${dayData.rankCount}次</span>
                                    <span class="auction-history-col auction-history-star" style="color:${trendColor};${starStyle}">${dayData.starText}</span>
                                    <span class="auction-history-col auction-history-strength" style="font-size:12px;font-weight:500;"><span style="color:${trendColor};">${dayData.strength}%</span></span>
                                    <span class="auction-history-col auction-history-count" style="font-size:12px;font-weight:500;color:${trendColor};">${dayData.stockCount}</span>
                                    <span class="auction-history-col auction-history-arrow" style="font-size:12px;font-weight:500;"><span style="color:${trendColor};">${trendText}</span>${arrow}</span>
                                </div>
                            `;
                        } else {
                            // 没有涨幅数据：只显示箭头，不显示涨跌
                            // 星评/强度/总数样式：有星显示橙色，无星保持默认
                            const starColor = (dayData.starCount > 0) ? '#f97316' : '#333';
                            const starStyle = (dayData.starCount >= 6) ? 'font-size:13px;font-weight:600;' : '';
                            
                            html += `
                                <div class="${rowClass}" data-topic="${topic}" data-date="${dayData.date}">
                                    <span class="auction-history-col auction-history-date">${formattedDate}</span>
                                    <span class="auction-history-col auction-history-rank" style="color:${rankColor};">上榜${dayData.rankCount}次</span>
                                    <span class="auction-history-col auction-history-star" style="color:${starColor};${starStyle}">${dayData.starText}</span>
                                    <span class="auction-history-col auction-history-strength" style="font-size:12px;font-weight:500;"><span style="color:${starColor};">${dayData.strength}%</span></span>
                                    <span class="auction-history-col auction-history-count" style="font-size:12px;font-weight:500;color:${starColor};">${dayData.stockCount}</span>
                                    <span class="auction-history-col auction-history-arrow" style="font-size:12px;font-weight:500;">${arrow}</span>
                                </div>
                            `;
                        }
                    } else {
                        // 没有数据的日期：只显示箭头，不显示涨跌
                        html += `
                            <div class="${rowClass}" data-topic="${topic}" data-date="${dayData.date}">
                                <span class="auction-history-col auction-history-date">${formattedDate}</span>
                                <span class="auction-history-col auction-history-rank" style="color:${rankColor};">上榜0次</span>
                                <span class="auction-history-col auction-history-star">-</span>
                                <span class="auction-history-col auction-history-strength" style="font-size:12px;font-weight:500;"><span style="color:#333;">0%</span></span>
                                <span class="auction-history-col auction-history-count" style="font-size:12px;font-weight:500;color:#333;">0</span>
                                <span class="auction-history-col auction-history-arrow" style="font-size:12px;font-weight:500;">${arrow}</span>
                            </div>
                        `;
                    }
                });
                
                html += '</div>';
            });
            
            auctionContent3.innerHTML = html;
        }

        // 渲染星标签统计看板（星无/星现/星平/星增/星减 占比伞形图 + 数量横向柱状图）
        // _lastStarStatsSignature：上一次实际渲染时的数据指纹，用于判断本次调用数据是否真的发生变化（治本：避免无意义的重复渲染）
        // _lastStarStatsShape：上一次渲染出的 DOM 结构类型（'empty' | 'nostar' | 'full'），结构不同才整体重建，结构相同只做局部更新（治标：避免整体 innerHTML 重建造成的闪烁）
        let _lastStarStatsSignature = null;
        let _lastStarStatsShape = null;
        export function renderAuctionStatsBoard(dataSource='auction') {
            const container = document.getElementById('starStatsContent');
            if (!container) return;

            // 分组守卫：星标签统计看板只有一份 DOM，但"早盘竞价"和"热门股票"是两个独立 tab，
            // 各自有自己的云端 Realtime 订阅，会在后台异步触发渲染。
            // 如果不加这层判断，不管用户停留在哪个 tab，两边的数据都会抢占同一块看板，
            // 表现为看板内容在两组不同统计结果之间来回跳变（闪烁、颜色/数字忽变）。
            // 因此：只有当本次渲染请求的分组等于用户当前正在查看的分组时，才允许更新看板。
            if (dataSource !== window.currentGroup) return;

            // ===== Vue 化展示层（全量切换：默认走 Vue，不再依赖特性开关）=====
            // 统计看板改由 Vue StatsBoard 响应式渲染。看板只有一份 DOM（两个 tab
            // 共用），上方分组守卫已确保仅当前 tab 处理；切换 tab 时 dataSource 变化，
            // 这里检测到变化会重新挂载（卸载旧实例），保证看板跟着当前 tab 走。
            // 原签名/shape patch-in-place 机制退役（Vue diff 天然替代，见方案 §12）。
            // 挂载失败时回退 innerHTML。
            if (typeof window.mountStatsBoardSandbox === 'function') {
                if (!window._auctionVueStatsApp || window._auctionVueStatsDs !== dataSource
                        || !container.querySelector('.star-stats-donut-svg,.star-stats-empty,.star-stats-summary')) {
                    try {
                        if (window._auctionVueStatsApp && typeof window._auctionVueStatsApp.unmount === 'function') {
                            window._auctionVueStatsApp.unmount();
                        }
                        window._auctionVueStatsApp = window.mountStatsBoardSandbox(dataSource, 'starStatsContent');
                        window._auctionVueStatsDs = dataSource;
                    }
                    catch (e) { window._dbgLog('[AUCTION-VUE] Stats 挂载失败，回退 innerHTML：' + e.message); }
                }
                if (window.auctionStore) { window.auctionStore.currentDate = window.currentDate; window.auctionStore.currentGroup = window.currentGroup; }
                // store 响应式会自动更新看板内容（同 tab 的 Realtime 推送）
                return;
            }

            const todayAuction = window.getTodayGroupList(dataSource);
            const yesterdayDate = window.getYesterdayDate(window.currentDate);
            const yesterdayAuction = yesterdayDate ? (window.getGroupData(dataSource)[yesterdayDate] || []) : [];
            const todayGroups = window.getTopicGroups(todayAuction || []);
            const yesterdayGroups = yesterdayDate ? window.getTopicGroups(yesterdayAuction || []) : [];

            if (!todayGroups || todayGroups.length === 0) {
                const sig = 'empty|' + dataSource + '|' + window.currentDate;
                if (_lastStarStatsSignature === sig && _lastStarStatsShape === 'empty') return;
                _lastStarStatsSignature = sig;
                _lastStarStatsShape = 'empty';
                container.innerHTML = '<div class="star-stats-empty">暂无题材数据</div>';
                return;
            }

            // 分类统计：星无、星现、星平、星增、星减
            const cats = {
                xianian: { label: '星无', count: 0, color: '#94a3b8' },
                xingxian: { label: '星现', count: 0, color: '#f43f5e' },
                xingping: { label: '星平', count: 0, color: '#3b82f6' },
                xingzeng: { label: '星增', count: 0, color: '#f59e0b' },
                xingjian: { label: '星减', count: 0, color: '#10b981' }
            };

            let maxStockTopic = null;
            let maxStockCount = 0;

            todayGroups.forEach(group => {
                if (!group.topic || group.topic === '---' || group.topic === '其它' || group.topic === '并购重组') return;

                const todayStarCount = group.starCount || 0;
                const yesterdayGroup = yesterdayGroups.find(g => g.topic === group.topic);
                const yesterdayStarCount = yesterdayGroup ? (yesterdayGroup.starCount || 0) : 0;

                if (todayStarCount === 0) {
                    // 今天没星：无论昨天有没有星，都算星无
                    cats.xianian.count++;
                } else if (todayStarCount > 0 && yesterdayStarCount === 0) {
                    cats.xingxian.count++;
                } else if (todayStarCount > 0 && todayStarCount === yesterdayStarCount) {
                    cats.xingping.count++;
                } else if (todayStarCount > yesterdayStarCount) {
                    cats.xingzeng.count++;
                } else if (todayStarCount > 0 && todayStarCount < yesterdayStarCount) {
                    cats.xingjian.count++;
                }

                const stockCount = group.stocks ? group.stocks.length : 0;
                if (stockCount > maxStockCount) {
                    maxStockCount = stockCount;
                    maxStockTopic = group.topic;
                }
            });

            const topicCount = todayGroups.filter(g => g.topic && g.topic !== '---' && g.topic !== '其它' && g.topic !== '并购重组').length;
            const total = cats.xianian.count + cats.xingxian.count + cats.xingping.count + cats.xingzeng.count + cats.xingjian.count;

            // 个股数量对比（今日 vs 昨日的早盘竞价看板股票总数）
            const todayStockCount = (todayAuction || []).length;
            const yesterdayStockCount = (yesterdayAuction || []).length;
            let stockCountArrow = '';
            if (todayStockCount > yesterdayStockCount) {
                stockCountArrow = '↑';
            } else if (todayStockCount < yesterdayStockCount) {
                stockCountArrow = '↓';
            } else {
                stockCountArrow = '-';
            }
            const stockCountArrowColor = '#1f2937'; // 统一黑色，箭头方向逻辑不变
            const stockCountHtml = `${todayStockCount}<span style="color:${stockCountArrowColor};margin-left:2px;">${stockCountArrow}</span>`;

            if (total === 0) {
                const sig = 'nostar|' + topicCount + '|' + stockCountHtml + '|' + maxStockTopic + '|' + maxStockCount;
                if (_lastStarStatsSignature === sig && _lastStarStatsShape === 'nostar') return;
                _lastStarStatsSignature = sig;
                _lastStarStatsShape = 'nostar';
                container.innerHTML = `
                    <div class="star-stats-summary">
                        <div class="star-stats-summary-item">
                            <div class="star-stats-summary-label">题材数量</div>
                            <div class="star-stats-summary-value">${topicCount}</div>
                        </div>
                        <div class="star-stats-summary-item">
                            <div class="star-stats-summary-label">个股数量</div>
                            <div class="star-stats-summary-value">${stockCountHtml}</div>
                        </div>
                        <div class="star-stats-summary-item">
                            <div class="star-stats-summary-label">个股总数最多题材</div>
                            <div class="star-stats-summary-value topic-name">${maxStockTopic ? maxStockTopic + '（' + maxStockCount + '）' : '-'}</div>
                        </div>
                    </div>
                    <div class="star-stats-empty">暂无星变化数据</div>
                `;
                return;
            }

            // 构建伞形图（甜甜圈图，SVG）
            const order = ['xianian', 'xingxian', 'xingping', 'xingzeng', 'xingjian'];
            const size = 220;
            const cx = size / 2, cy = size / 2;
            const strokeWidth = 34;
            const r = (size - strokeWidth) / 2;
            const circumference = 2 * Math.PI * r;

            let offsetAcc = 0;
            let segments = '';
            order.forEach(key => {
                const c = cats[key];
                if (c.count <= 0) return;
                const fraction = c.count / total;
                const dash = fraction * circumference;
                const gap = circumference - dash;
                const rotation = (offsetAcc / total) * 360 - 90;
                segments += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${c.color}" stroke-width="${strokeWidth}"
                    stroke-dasharray="${dash} ${gap}" stroke-dashoffset="0"
                    transform="rotate(${rotation} ${cx} ${cy})" stroke-linecap="butt"></circle>`;
                offsetAcc += c.count;
            });

            // 读取标题栏强度数值与箭头（auctionStrengthValue/auctionStrengthArrow 是"早盘竞价"和"热门股票"
            // 两个 tab 共用的同一套 DOM，renderAuction 内部已按当前 dataSource 各自算好并写入，这里直接复用即可）
            const strengthValueEl = document.getElementById('auctionStrengthValue');
            const strengthArrowEl = document.getElementById('auctionStrengthArrow');
            const strengthText = strengthValueEl ? strengthValueEl.textContent.trim() : '-';
            const strengthArrow = strengthArrowEl ? strengthArrowEl.textContent.trim() : '-';

            // 读取当天"记忘看板/竞价变化"得出结论（同一天数据），空仓时视为假强度，强制绿色
            const todayJiwang = window.getTodayJiwang();
            const isKongcang = todayJiwang && todayJiwang.jielun === '空仓';

            let centerColor = '#1f2937';
            let displayArrow = '';
            let centerLabel = '强度';
            if (isKongcang) {
                centerColor = '#10b981'; // 空仓：无论强度箭头方向，一律视为假强度，绿色
                displayArrow = strengthArrow === '⬇' ? '↓' : (strengthArrow === '⬆' ? '↑' : '');
                centerLabel = '空仓';
            } else if (strengthArrow === '⬇') {
                centerColor = '#10b981'; // 强度变弱：绿色
                displayArrow = '↓';
                centerLabel = '空仓';
            } else if (strengthArrow === '⬆') {
                centerColor = '#ef4444'; // 强度变强：红色
                displayArrow = '↑';
                centerLabel = '出手';
            } else {
                centerColor = '#1f2937';
                displayArrow = '';
                centerLabel = '强度';
            }

            // ---- 治本：内容指纹比对，数据没有实质变化就直接跳过，不碰 DOM ----
            const signature = [
                'full',
                order.map(k => cats[k].count).join(','),
                topicCount, stockCountHtml, maxStockTopic, maxStockCount,
                strengthText, displayArrow, centerLabel, centerColor
            ].join('|');
            if (_lastStarStatsSignature === signature && _lastStarStatsShape === 'full') {
                return;
            }

            const donutSvg = `
                <svg class="star-stats-donut-svg" viewBox="0 0 ${size} ${size}" id="starStatsDonutSvg">
                    <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#f1f5f9" stroke-width="${strokeWidth}"></circle>
                    ${segments}
                    <text x="${cx}" y="${cy - 4}" text-anchor="middle" class="star-stats-donut-center-value" id="starStatsDonutValue" style="fill:${centerColor}">${strengthText}${displayArrow}</text>
                    <text x="${cx}" y="${cy + 16}" text-anchor="middle" class="star-stats-donut-center-label" id="starStatsDonutLabel" style="fill:${centerColor}">${centerLabel}</text>
                </svg>
            `;

            const legendHtml = order.map(key => {
                const c = cats[key];
                const pct = total > 0 ? Math.round((c.count / total) * 100) : 0;
                return `
                    <div class="star-stats-legend-item" data-cat="${key}">
                        <span class="star-stats-legend-dot" style="background:${c.color}"></span>
                        <span>${c.label}</span>
                        <span class="star-stats-legend-value">${c.count}（${pct}%）</span>
                    </div>
                `;
            }).join('');

            // 横向柱状图（数量）
            const maxCount = Math.max(...order.map(key => cats[key].count), 1);
            const barsHtml = order.map(key => {
                const c = cats[key];
                const widthPct = Math.round((c.count / maxCount) * 100);
                return `
                    <div class="star-stats-bar-row" data-cat="${key}">
                        <div class="star-stats-bar-label">${c.label}</div>
                        <div class="star-stats-bar-track">
                            <div class="star-stats-bar-fill" style="width:${widthPct}%;background:${c.color}"></div>
                        </div>
                        <div class="star-stats-bar-value">${c.count}</div>
                    </div>
                `;
            }).join('');

            // ---- 治标：结构相同时只做局部 DOM 更新，避免整体 innerHTML 重建导致的闪烁 ----
            const canPatchInPlace = _lastStarStatsShape === 'full'
                && container.querySelector('#starStatsDonutSvg')
                && container.querySelectorAll('.star-stats-legend-item').length === order.length
                && container.querySelectorAll('.star-stats-bar-row').length === order.length;

            if (canPatchInPlace) {
                // 局部更新甜甜圈图：整个 SVG 替换（弧线数量本身可能增减），但汇总区/图例/柱状图逐项更新
                const svgEl = container.querySelector('#starStatsDonutSvg');
                svgEl.outerHTML = donutSvg;

                const summaryValues = container.querySelectorAll('.star-stats-summary-value');
                if (summaryValues[0]) summaryValues[0].textContent = topicCount;
                if (summaryValues[1]) summaryValues[1].innerHTML = stockCountHtml;
                if (summaryValues[2]) summaryValues[2].innerHTML = maxStockTopic ? maxStockTopic + '（' + maxStockCount + '）' : '-';

                order.forEach(key => {
                    const c = cats[key];
                    const pct = total > 0 ? Math.round((c.count / total) * 100) : 0;
                    const legendItem = container.querySelector('.star-stats-legend-item[data-cat="' + key + '"] .star-stats-legend-value');
                    if (legendItem) legendItem.textContent = `${c.count}（${pct}%）`;

                    const barRow = container.querySelector('.star-stats-bar-row[data-cat="' + key + '"]');
                    if (barRow) {
                        const widthPct = Math.round((c.count / maxCount) * 100);
                        const fillEl = barRow.querySelector('.star-stats-bar-fill');
                        const valueEl = barRow.querySelector('.star-stats-bar-value');
                        if (fillEl) fillEl.style.width = widthPct + '%';
                        if (valueEl) valueEl.textContent = c.count;
                    }
                });
            } else {
                container.innerHTML = `
                    <div class="star-stats-donut-wrap">
                        ${donutSvg}
                        <div class="star-stats-legend">${legendHtml}</div>
                    </div>
                    <div class="star-stats-summary">
                        <div class="star-stats-summary-item">
                            <div class="star-stats-summary-label">题材数量</div>
                            <div class="star-stats-summary-value">${topicCount}</div>
                        </div>
                        <div class="star-stats-summary-item">
                            <div class="star-stats-summary-label">个股数量</div>
                            <div class="star-stats-summary-value">${stockCountHtml}</div>
                        </div>
                        <div class="star-stats-summary-item">
                            <div class="star-stats-summary-label">个股总数最多题材</div>
                            <div class="star-stats-summary-value topic-name">${maxStockTopic ? maxStockTopic + '（' + maxStockCount + '）' : '-'}</div>
                        </div>
                    </div>
                    <div class="star-stats-divider"></div>
                    <div class="star-stats-bars">${barsHtml}</div>
                `;
            }

            _lastStarStatsSignature = signature;
            _lastStarStatsShape = 'full';
        }

        // 第四页数据存储（按日期存储）
        let copiedStocksData = {};

        // 保存第四页数据到localStorage
        export function saveCopiedStocks() {
            try {
                localStorage.setItem('copiedStocksData', JSON.stringify(copiedStocksData));
            } catch (e) {
                alert('保存失败，可能是存储空间不足');
            }
        }

        // 从localStorage加载第四页数据
        export function loadCopiedStocks() {
            try {
                const data = localStorage.getItem('copiedStocksData');
                if (data) {
                    const parsed = JSON.parse(data);
                    // 检查是否有旧数据（键是数字而不是日期字符串）
                    const keys = Object.keys(parsed);
                    const hasOldData = keys.some(k => /^\d+$/.test(k));
                    if (hasOldData) {
                        // 清除旧数据
                        localStorage.removeItem('copiedStocksData');
                        copiedStocksData = {};
                    } else {
                        copiedStocksData = parsed;
                    }
                }
            } catch (e) {
                copiedStocksData = {};
            }
        }

        // 获取当前日期的第四页数据
        export function getCopiedStocksByDate() {
            if (!copiedStocksData[window.currentDate]) {
                copiedStocksData[window.currentDate] = [];
            }
            return copiedStocksData[window.currentDate];
        }

        // 复制题材股票到第四页
        export function copyTopicStocks(topic, minRatio, dataSource='auction') {
            // 获取当天数据（和第二页一样）
            const auctionList = window.getTodayGroupList(dataSource);
            
            if (!auctionList || auctionList.length === 0) {
                alert('没有找到当天的数据');
                return;
            }
            
            // 获取上一个交易日的数据用于对比
            const prevDate = window.getPreviousTradingDay(window.currentDate);
            const auctionData = window.getGroupData(dataSource);
            const prevAuctionList = prevDate ? (auctionData[prevDate] || []) : [];
            
            // 获取题材分组（和第二页一样）
            const groups = window.getTopicGroups(auctionList);
            
            // 找到该题材
            const topicGroup = groups.find(g => g.topic === topic);
            if (!topicGroup || !topicGroup.stocks || topicGroup.stocks.length === 0) {
                alert('没有找到该题材的股票数据');
                return;
            }
            
            // 过滤占比>=minRatio%的股票，并按占比降序排序（使用四舍五入后的值，和第二页显示一致）
            const stocksToCopy = topicGroup.stocks
                .filter(s => Math.round(s.ratioValue) >= minRatio)
                .sort((a, b) => b.ratioValue - a.ratioValue);
            
            if (stocksToCopy.length === 0) {
                alert(`该题材没有占比>=${minRatio}%的股票`);
                return;
            }
            
            // 添加到第四页数据（计算箭头，和第二页一样）
            stocksToCopy.forEach(stock => {
                // 计算箭头
                let arrow = '';
                if (prevAuctionList.length > 0 && stock.stock) {
                    const prevItem = prevAuctionList.find(p => p.stock && p.stock.trim() === stock.stock.trim());
                    if (prevItem && prevItem.yestVolume) {
                        const prevVolume = parseFloat(prevItem.volume) || 0;
                        const prevYestVolume = parseFloat(prevItem.yestVolume) || 0;
                        if (prevYestVolume > 0) {
                            const prevRatioValue = (prevVolume / prevYestVolume) * 100;
                            const prevRatio = Math.round(prevRatioValue);
                            const currRatio = Math.round(stock.ratioValue);
                            if (currRatio > prevRatio) {
                                arrow = '⬆';
                            } else if (currRatio < prevRatio) {
                                arrow = '⬇';
                            }
                        }
                    }
                }
                
                // 获取当前日期的数据并添加
                const currentStocks = window.getCopiedStocksByDate();
                currentStocks.push({
                    name: stock.stock,
                    topic: topic,
                    ratio: Math.round(stock.ratioValue),
                    arrow: arrow
                });
            });
            
            // 展开看板
            const auctionBoard = document.getElementById('auctionBoard');
            if (auctionBoard) {
                auctionBoard.classList.remove('collapsed');
                const btn = document.getElementById('auctionToggleBtn');
                if (btn) {
                    btn.textContent = '▲';
                }
            }
            
            // 保存数据
            window.saveCopiedStocks();
            
            // 渲染第四页并跳转
            window.renderAuctionPage4(dataSource);
            window.switchAuctionPage(3);
        }

        // 全复制题材股票到第四页（无占比限制）
        export function copyAllTopicStocks(topic, dataSource='auction') {
            // 获取当天数据
            const auctionList = window.getTodayGroupList(dataSource);
            
            if (!auctionList || auctionList.length === 0) {
                alert('没有找到当天的数据');
                return;
            }
            
            // 获取上一个交易日的数据用于对比
            const prevDate = window.getPreviousTradingDay(window.currentDate);
            const auctionData = window.getGroupData(dataSource);
            const prevAuctionList = prevDate ? (auctionData[prevDate] || []) : [];
            
            // 获取题材分组
            const groups = window.getTopicGroups(auctionList);
            
            // 找到该题材
            const topicGroup = groups.find(g => g.topic === topic);
            if (!topicGroup || !topicGroup.stocks || topicGroup.stocks.length === 0) {
                alert('没有找到该题材的股票数据');
                return;
            }
            
            // 复制所有股票，不限制占比
            const stocksToCopy = topicGroup.stocks.sort((a, b) => b.ratioValue - a.ratioValue);
            
            if (stocksToCopy.length === 0) {
                alert('该题材没有股票');
                return;
            }
            
            // 添加到第四页数据
            stocksToCopy.forEach(stock => {
                let arrow = '';
                if (prevAuctionList.length > 0 && stock.stock) {
                    const prevItem = prevAuctionList.find(p => p.stock && p.stock.trim() === stock.stock.trim());
                    if (prevItem && prevItem.yestVolume) {
                        const prevVolume = parseFloat(prevItem.volume) || 0;
                        const prevYestVolume = parseFloat(prevItem.yestVolume) || 0;
                        if (prevYestVolume > 0) {
                            const prevRatioValue = (prevVolume / prevYestVolume) * 100;
                            const prevRatio = Math.round(prevRatioValue);
                            const currRatio = Math.round(stock.ratioValue);
                            if (currRatio > prevRatio) {
                                arrow = '⬆';
                            } else if (currRatio < prevRatio) {
                                arrow = '⬇';
                            }
                        }
                    }
                }
                
                const currentStocks = window.getCopiedStocksByDate();
                currentStocks.push({
                    name: stock.stock,
                    topic: topic,
                    ratio: Math.round(stock.ratioValue),
                    arrow: arrow
                });
            });
            
            // 展开看板
            const auctionBoard = document.getElementById('auctionBoard');
            if (auctionBoard) {
                auctionBoard.classList.remove('collapsed');
                const btn = document.getElementById('auctionToggleBtn');
                if (btn) {
                    btn.textContent = '▲';
                }
            }
            
            // 保存数据
            window.saveCopiedStocks();
            
            // 渲染第四页并跳转
            window.renderAuctionPage4(dataSource);
            window.switchAuctionPage(3);
        }

        // 渲染第四页
        export function renderAuctionPage4(dataSource=currentGroup) {
            const _p = dataSource === 'hot' ? 'hot' : 'auction';
            const auctionContent4 = document.getElementById(_p + 'Content4');
            const currentStocks = window.getCopiedStocksByDate();
            
            if (!currentStocks || currentStocks.length === 0) {
                auctionContent4.innerHTML = '<div class="auction-copied-placeholder">暂无复制的股票<br>请从第三页复制题材股票</div>';
                return;
            }
            
            // 统计每个股票出现的题材
            const stockTopics = {};
            currentStocks.forEach((stock, index) => {
                if (!stockTopics[stock.name]) {
                    stockTopics[stock.name] = { stocks: [], topics: new Set() };
                }
                stockTopics[stock.name].stocks.push({ ...stock, originalIndex: index });
                stockTopics[stock.name].topics.add(stock.topic);
            });
            
            // 分离重复股票和不重复股票
            const duplicateStocks = [];
            const uniqueStocks = [];
            
            Object.keys(stockTopics).forEach(stockName => {
                const data = stockTopics[stockName];
                if (data.topics.size > 1) {
                    // 重复股票：合并所有题材，同时记录所有 originalIndex 用于批量删除
                    const mergedStock = {
                        name: stockName,
                        topic: Array.from(data.topics).join(','),
                        ratio: data.stocks[0].ratio,
                        arrow: data.stocks[0].arrow,
                        originalIndex: data.stocks[0].originalIndex,
                        allOriginalIndexes: data.stocks.map(s => s.originalIndex), // 所有原始下标
                        isDuplicate: true
                    };
                    duplicateStocks.push(mergedStock);
                } else {
                    // 不重复股票
                    uniqueStocks.push({
                        ...data.stocks[0],
                        allOriginalIndexes: [data.stocks[0].originalIndex],
                        isDuplicate: false
                    });
                }
            });
            
            // 渲染股票行
            function renderStockRow(stock, index) {
                let ratioClass = 'auction-copied-ratio';
                if (stock.ratio >= 10) {
                    ratioClass = 'auction-copied-ratio highlight';
                } else if (stock.ratio >= 4.5) {
                    ratioClass = 'auction-copied-ratio highlight-light';
                }
                
                let arrowHtml = '';
                if (stock.arrow === '⬆') {
                    arrowHtml = '<span style="color:#ef4444;">⬆</span>';
                } else if (stock.arrow === '⬇') {
                    arrowHtml = '<span style="color:#10b981;">⬇</span>';
                }
                
                // 将所有原始下标编码到 data-indexes，删除时批量处理
                const indexesAttr = (stock.allOriginalIndexes || [stock.originalIndex]).join(',');
                
                return `
                    <div class="auction-copied-row" data-index="${stock.originalIndex}" data-indexes="${indexesAttr}">
                        <span class="auction-copied-stock">${stock.name}</span>
                        <span class="auction-copied-topic">${stock.topic}</span>
                        <span class="${ratioClass}">${stock.ratio}%${arrowHtml}</span>
                        <span class="auction-copied-delete">✕</span>
                    </div>
                `;
            }
            window.renderStockRow = renderStockRow;
            
            let html = '';
            
            // 渲染重复股票
            duplicateStocks.forEach(stock => {
                html += window.renderStockRow(stock, 0);
            });
            
            // 重复和不重复之间添加6px空白
            if (duplicateStocks.length > 0 && uniqueStocks.length > 0) {
                html += '<div style="height: 6px;"></div>';
            }
            
            // 渲染不重复股票
            uniqueStocks.forEach(stock => {
                html += window.renderStockRow(stock, 0);
            });
            
            auctionContent4.innerHTML = html;
            
            // 绑定删除按钮事件
            auctionContent4.querySelectorAll('.auction-copied-delete').forEach(btn => {
                btn.addEventListener('click', function(e) {
                    e.preventDefault();
                    e.stopPropagation();
                    const row = this.closest('.auction-copied-row');
                    const indexesStr = row.getAttribute('data-indexes');
                    // 解析所有下标，倒序删除避免下标偏移
                    const indexes = indexesStr
                        ? indexesStr.split(',').map(Number).filter(n => !isNaN(n)).sort((a, b) => b - a)
                        : [parseInt(row.getAttribute('data-index'))];
                    window.deleteCopiedStockByIndexes(indexes);
                });
            });
        }

        // 删除单行股票（兼容旧调用）
        export function deleteCopiedStock(index) {
            window.deleteCopiedStockByIndexes([index]);
        }

        // 批量删除股票（倒序删除，避免下标偏移）
        export function deleteCopiedStockByIndexes(sortedDescIndexes) {
            const currentStocks = window.getCopiedStocksByDate();
            sortedDescIndexes.forEach(idx => {
                if (idx >= 0 && idx < currentStocks.length) {
                    currentStocks.splice(idx, 1);
                }
            });
            window.saveCopiedStocks();
            window.renderAuctionPage4();
        }

        // 全部清除
        export function clearAllCopiedStocks() {
            const currentStocks = window.getCopiedStocksByDate();
            if (currentStocks.length === 0) return;
            if (confirm('确定要清除所有复制的股票吗？')) {
                copiedStocksData[window.currentDate] = [];
                window.saveCopiedStocks();
                window.renderAuctionPage4();
            }
        }

        // 从第三页跳转到第二页
        let lastJumpFromPage3 = null; // 记录从第三页跳转的信息
        
        export function jumpFromPage3ToPage2(topic, dateStr) {
            // 保存原始日期和目标日期（只在内存中记录，不持久化临时跳转状态）
            lastJumpFromPage3 = { 
                topic, 
                targetDateStr: dateStr,
                originalDateStr: window.currentDate 
            };
            
            // 仅切换内存中的 window.currentDate，不调用 saveData()
            // 避免临时跳转日期被写入 lastEditedDate，导致下次打开App日期错乱
            window.setCurrentDate(dateStr);
            window.updateDateDisplay();
            
            // 清除所有高亮
            document.querySelectorAll('.auction-topic-history-row.highlight-jump').forEach(el => {
                el.classList.remove('highlight-jump');
            });
            document.querySelectorAll('.auction-topic-header.highlight-jump').forEach(el => {
                el.classList.remove('highlight-jump');
            });
            
            // 切换到第二页
            window.switchAuctionPage(1);
            
            // 渲染第二页数据
            window.renderAuction();
            
            // 延迟高亮并滚动到中间位置
            setTimeout(() => {
                // 查找题材标题行
                const topicHeaders = document.querySelectorAll('.auction-topic-header');
                let targetHeader = null;
                topicHeaders.forEach(header => {
                    const topicLeftEl = header.querySelector('.auction-topic-left');
                    if (topicLeftEl) {
                        const topicText = topicLeftEl.textContent.trim();
                        // 提取题材名称，格式为【题材名】上榜n次
                        const match = topicText.match(/【(.+?)】/);
                        if (match && match[1] === topic) {
                            targetHeader = header;
                        }
                    }
                });
                
                if (targetHeader) {
                    targetHeader.classList.add('highlight-jump');
                    // 滚动到中间位置
                    targetHeader.scrollIntoView({
                        behavior: 'smooth',
                        block: 'center'
                    });
                }
            }, 100);
        }

        // 从第二页跳转回第三页
        export function jumpFromPage2ToPage3(topic) {
            // 清除所有高亮
            document.querySelectorAll('.auction-topic-history-row.highlight-jump').forEach(el => {
                el.classList.remove('highlight-jump');
            });
            document.querySelectorAll('.auction-topic-header.highlight-jump').forEach(el => {
                el.classList.remove('highlight-jump');
            });
            
            // 获取跳转信息
            const jumpInfo = lastJumpFromPage3;
            
            // 恢复到原始日期
            // Bug2修复：即使 jumpInfo 为 null（用户中途手动滑页），也能安全恢复
            // 恢复策略：有记录用记录，无记录用 lastEditedDate 兜底，确保日期不乱
            if (jumpInfo && jumpInfo.originalDateStr) {
                window.setCurrentDate(jumpInfo.originalDateStr);
            } else {
                // 兜底：从 localStorage 读取上次正常保存的日期
                const savedDate = localStorage.getItem('lastEditedDate_' + window.DATA_VERSION);
                if (savedDate && savedDate >= '2025-01-01') {
                    window.setCurrentDate(savedDate);
                }
            }
            window.updateDateDisplay();
            // 此处恢复的是真实的工作日期，正常持久化
            window.saveData();
            lastJumpFromPage3 = null; // 清除跳转记录
            
            // 切换到第三页
            window.switchAuctionPage(2);
            
            // 渲染第三页数据
            window.renderAuction();
            
            // 延迟高亮并滚动到中间位置
            setTimeout(() => {
                // 查找对应的日期行（使用目标日期）
                const targetRow = jumpInfo
                    ? document.querySelector(`.auction-topic-history-row[data-topic="${topic}"][data-date="${jumpInfo.targetDateStr}"]`)
                    : null;
                if (targetRow) {
                    targetRow.classList.add('highlight-jump');
                    // 滚动到中间位置
                    targetRow.scrollIntoView({
                        behavior: 'smooth',
                        block: 'center'
                    });
                }
            }, 100);
        }

        // 获取最近N个交易日
        export function getLastNTradingDays(n) {
            const days = [];
            let date = new Date(window.currentDate + 'T00:00:00');
            
            while (days.length < n) {
                const year = date.getFullYear();
                const month = String(date.getMonth() + 1).padStart(2, '0');
                const day = String(date.getDate()).padStart(2, '0');
                const dateStr = `${year}-${month}-${day}`;
                
                if (dateStr < '2025-01-01') break;
                
                if (window.isTradingDay(dateStr)) {
                    days.push(dateStr);
                }
                
                date.setDate(date.getDate() - 1);
            }
            
            return days;
        }

        // 获取星星符号
        export function getStarSymbols(starCount) {
            if (starCount <= 0) return '-';
            if (starCount >= 6) return starCount + '★';
            return '★'.repeat(starCount);
        }

        // 获取指定日期的题材上榜次数（缓存版，逻辑与原实现完全一致）
        // 原实现每次调用都会重新 forEach 整个当天 rank 列表；这里改成
        // 按 dateStr 缓存一个 Map(topic -> count)，同一天同一题材只算一次。
        // 缓存失效条件：rankData[dateStr] 的数组引用变化（编辑保存/清空/云端拉取都会换新引用），
        // 数组不存在时（如被 delete）也会自然 miss 缓存并返回 0，与原逻辑一致。
        //
        // 【关键发现】诊断日志显示 calls === earlyReturn（100%提前返回），但耗时依然很高——
        // 说明真正的热点根本不在这个函数的扫描逻辑里，而在于原实现内部每次都调用
        // getRankData() → loadAllData() → syncStocksDataToStore()，而后者会给 Vue 响应式
        // store 的 stocksData 属性重新赋值（哪怕值没变），每次赋值都会触发响应式通知。
        // 这个函数在一次 Page3 渲染里会被调用 天数×题材数（约100+）次，等于每次渲染
        // 都触发 100+ 次不必要的响应式写入。加了可选的 rankData 参数，调用方（Vue computed）
        // 可以在循环开始前只调用一次 getRankData()，把结果传进来，避免重复触发。
        // 不传参时行为与原来完全一致（向后兼容第 20060/20434 行的旧调用点）。
        window._rankCacheStats = { hit: 0, missNoEntry: 0, missRefChanged: 0, missNoTopic: 0, calls: 0, earlyReturn: 0 };
        export function getTopicRankCountByDate(topic, dateStr, rankDataParam) {
            window._rankCacheStats.calls++;
            const rankData = rankDataParam || window.getRankData();
            const dayRank = rankData[dateStr];
            if (window._rankCacheStats.calls <= 5 && typeof window._dbgLog === 'function') {
                window._dbgLog('[RANK-CACHE] 第' + window._rankCacheStats.calls + '次调用 topic=' + topic + ' dateStr=' + dateStr + ' | rankData类型=' + (rankData ? typeof rankData : String(rankData)) + ' | dayRank是否数组=' + Array.isArray(dayRank) + ' | dayRank长度=' + (Array.isArray(dayRank) ? dayRank.length : 'N/A'));
            }
            if (!dayRank || !Array.isArray(dayRank)) {
                window._rankCacheStats.earlyReturn++;
                return 0;
            }

            let entry = window._topicRankByDateCache.get(dateStr);
            if (!entry) {
                window._rankCacheStats.missNoEntry++;
                entry = { ref: dayRank, map: new Map() };
                window._topicRankByDateCache.set(dateStr, entry);
            } else if (entry.ref !== dayRank) {
                window._rankCacheStats.missRefChanged++;
                entry = { ref: dayRank, map: new Map() };
                window._topicRankByDateCache.set(dateStr, entry);
            }

            if (entry.map.has(topic)) {
                window._rankCacheStats.hit++;
                return entry.map.get(topic);
            }
            window._rankCacheStats.missNoTopic++;

            let count = 0;
            dayRank.forEach(item => {
                if (item.concept && item.concept.includes(topic)) {
                    count++;
                }
            });
            entry.map.set(topic, count);
            return count;
        }

        export function bindAuctionTopicEdit() {
            document.querySelectorAll('.auction-topic-no-select').forEach(el => {
                el.addEventListener('contextmenu', function(e) {
                    e.preventDefault();
                });
            });
            
            // 给股票名称添加点击事件，跳回第一页
            document.querySelectorAll('.auction-topic-stock').forEach(el => {
                el.style.cursor = 'pointer';
                el.addEventListener('click', function(e) {
                    e.stopPropagation();
                    const stockName = this.textContent.trim();
                    if (stockName && stockName !== '-') {
                        window.jumpToAuctionPage1(stockName);
                    }
                });
            });
            
            // 给占比列添加点击事件，跳回第一页
            document.querySelectorAll('.auction-topic-ratio').forEach(el => {
                el.style.cursor = 'pointer';
                el.addEventListener('click', function(e) {
                    e.stopPropagation();
                    const row = this.closest('.auction-topic-row');
                    if (row) {
                        const stockEl = row.querySelector('.auction-topic-stock');
                        if (stockEl) {
                            const stockName = stockEl.textContent.trim();
                            if (stockName && stockName !== '-') {
                                window.jumpToAuctionPage1(stockName);
                            }
                        }
                    }
                });
            });
            
            document.querySelectorAll('.auction-topic-editable').forEach(el => {
                let pressTimer;
                let isMoved = false;
                
                el.style.cursor = 'pointer';
                el.style.webkitUserSelect = 'none';
                el.style.userSelect = 'none';
                el.style.webkitTouchCallout = 'none';
                
                const startHandler = function(e) {
                    // 多指触摸（如三指下滑截图手势）不触发长按编辑，直接跳过
                    if (e.touches && e.touches.length > 1) {
                        clearTimeout(pressTimer);
                        return;
                    }
                    isMoved = false;
                    pressTimer = setTimeout(() => {
                        const stockName = el.dataset.stock;
                        if (stockName) {
                            window.openAuctionNoteEditFromPage2(stockName);
                        }
                    }, 500);
                };
                
                const moveHandler = function(e) {
                    isMoved = true;
                    clearTimeout(pressTimer);
                };
                
                const endHandler = function(e) {
                    clearTimeout(pressTimer);
                };

                // 触摸被系统手势（如截图、来电）中断时，浏览器会触发 touchcancel 而非 touchend，
                // 必须监听并清除计时器，否则会在手势结束后误判为"长按"从而弹出编辑框
                const cancelHandler = function(e) {
                    clearTimeout(pressTimer);
                };
                
                el.addEventListener('mousedown', startHandler);
                el.addEventListener('mouseup', endHandler);
                el.addEventListener('mouseleave', endHandler);
                el.addEventListener('touchstart', startHandler, { passive: true });
                el.addEventListener('touchmove', moveHandler, { passive: true });
                el.addEventListener('touchend', endHandler);
                el.addEventListener('touchcancel', cancelHandler);
                el.addEventListener('contextmenu', function(e) {
                    e.preventDefault();
                });
            });
        }

        export function openAuctionNoteEditFromPage2(stockName) {
            const targetDate = window.auctionStore ? window.auctionStore.currentDate : window.currentDate;
            const auctionData = window.getGroupData(window.currentGroup);
            const auctionList = auctionData[targetDate] || [];
            const item = auctionList.find(a => a.stock === stockName);
            if (!item) {
                alert('未找到该股票数据');
                return;
            }
            
            const currentNote = item.note || '';
            const newNote = prompt(`修改 "${stockName}" 的注释:`, currentNote);
            
            if (newNote !== null) {
                // 将中文标点转换为英文逗号（节省空间）
                const normalizedNote = newNote.replace(/[，、;；]/g, ',');
                const index = auctionList.findIndex(a => a.stock === stockName);
                if (index !== -1) {
                    auctionList[index].note = normalizedNote;
                    if (window.currentGroup === 'hot') {
                        auctionData[targetDate] = auctionList;
                    } else {
                        window.setAuctionDateData(targetDate, auctionList, 'window.openAuctionNoteEditFromPage2');
                        window.markAuctionDirty(targetDate);
                    }

                    if (window.currentGroup === 'hot') {
                        window.saveData();
                        // 字段级 PATCH：本次只改了 note 一个字段（对齐同函数 auction 分支 20137 行的处理方式）
                        window.patchHotField(targetDate, stockName, { note: normalizedNote }).catch(function(e) {
                            console.warn('window.patchHotField note 失败（window.openAuctionNoteEditFromPage2）:', e);
                        });
                    } else {
                        window.saveData();
                        // 阶段二 C：改为字段级 patch，只更新 note 字段（不动 hot_stocks 分支）
                        window.patchAuctionField(targetDate, stockName, { note: normalizedNote }).catch(function(e) {
                            console.warn('window.patchAuctionField note 失败（window.openAuctionNoteEditFromPage2）:', e);
                        });
                    }
                    window.scheduleCloudPush();

                    // 同步更新已添加股票的收盘涨幅
                    window.syncStockCloseFromAuction(stockName, normalizedNote);

                    // 同步推送到 stock_topics 表（按 stock 维度，跨日期共享），避免下次打开时题材丢失
                    const topicsArr = window.extractTopics(normalizedNote);
                    const scMap = window._scMapCache || {};
                    const stockCode = scMap[stockName.trim()] || (item ? (item.code || '') : '');
                    window.pushStockTopicsToCloud(stockName, topicsArr, stockCode).catch(function(e) {
                        console.warn('window.pushStockTopicsToCloud 失败（window.openAuctionNoteEditFromPage2）:', e);
                    });

                    // 同步更新股票列表中的题材，统一保存一次
                    window.syncStockTopicsFromAuction();
                    window.saveModule('stocks');
                    
                    window.renderAuction(window.currentGroup);
                    window.renderList();
                }
            }
        }

        export function extractChangeFromNote(note) {
            if (!note) return '-';
            const matches = note.match(/[+-]?\d+\.?\d*%/g);
            if (matches && matches.length > 0) {
                // [BUG-FIX 2026-07-26] 之前直接返回第一个百分比，导致 62%/87%/59%/55%
                // 等"竞价量/昨竞价量"比例被误显示为涨幅。A 股主板涨停 10%、创业板/科创板
                // 20%、新股首日 44%，超过 20% 的几乎都是误把占比当成涨幅，统一返回 '-'。
                for (var i = 0; i < matches.length; i++) {
                    var num = parseFloat(matches[i]);
                    if (!isNaN(num) && Math.abs(num) <= 20) {
                        return matches[i];
                    }
                }
                return '-';
            }
            if (note.includes('涨停')) return '涨停';
            if (note.includes('跌停')) return '跌停';
            return '-';
        }

        // [BUG-FIX 2026-07-26] getChangePctDisplay 同步增加涨幅上限校验，
        // 防止 changePct 字段被错误写入 62%/87% 等占比数据后直接展示。
        export function getChangePctDisplay(item) {
            if (item && item.changePct) {
                // 涨停/跌停/停牌等非数字值直接返回
                if (/^[+-]?\d+\.?\d*%$/.test(item.changePct)) {
                    var num = parseFloat(item.changePct);
                    if (!isNaN(num) && Math.abs(num) <= 20) {
                        return item.changePct;
                    }
                    window._dbgLog('[CHANGE-WARN] changePct 超出 20% 上限，疑似占比数据：' + item.stock + ' = ' + item.changePct);
                    return '-';
                }
                return item.changePct;
            }
            return window.extractChangeFromNote(item ? item.note : '');
        }

        // 从 note 解析出 { changePct, topics }
        export function parseNoteToFields(note) {
            if (!note) return { changePct: '', topics: '' };
            var changePct = '';
            var pctMatch = note.match(/([+-]?\d+\.?\d*%)/);
            if (pctMatch) {
                changePct = pctMatch[1];
            } else if (note.includes('涨停')) {
                changePct = '涨停';
            } else if (note.includes('跌停')) {
                changePct = '跌停';
            } else if (note.includes('停牌')) {
                changePct = '停牌';
            }
            var bracketMatches = note.match(/[(（]([^)）]+)[)）]/g) || [];
            var topics = bracketMatches.map(function(m) {
                return m.replace(/[()（）]/g, '');
            }).join(',').replace(/[，、;；]/g, ',');
            return { changePct: changePct, topics: topics };
        }

        // 清理题材字符串中的无意义编号条目（如"题材32/题材33"），仅用于展示
        export function cleanTopicsForDisplay(topics) {
            if (!topics) return '';
            return topics.split(/[+，,，、;；]/).map(function(t) { return t.trim(); }).filter(function(t) {
                if (!t) return false;
                if (/^题材\d+$/.test(t)) return false;   // 题材35 / 题材36
                if (/^\d+$/.test(t)) return false;     // 纯数字
                if (t.length < 2) return false;        // 单字符
                return true;
            }).join('，');
        }

        // 从 changePct + topics 反向构建 note（向后兼容）
        export function buildNoteFromFields(changePct, topics) {
            var note = changePct || '';
            var cleanTopics = window.cleanTopicsForDisplay(topics);
            if (cleanTopics) {
                note += '(' + cleanTopics + ')';
            }
            return note;
        }

        // 获取用于展示的完整 note（优先用 changePct + topics 重建，回退到旧 note）
        export function getDisplayNote(item) {
            if (!item) return '';
            if (item.changePct || item.topics) {
                var topics = item.topics || '';
                // [BUG-FIX 2026-07-26] 兼容过渡期数据：拆分字段里有涨幅但缺少题材时，
                // 若旧 note 仍包含题材，则回退解析 note 中的题材，避免第二页全部落入"其它"。
                if (!topics && item.note) {
                    var parsed = window.parseNoteToFields(item.note);
                    topics = parsed.topics;
                }
                return window.buildNoteFromFields(item.changePct, topics);
            }
            // [BUG-FIX 2026-07-27] 旧 note 直接作为展示时，同样过滤"题材32/题材33"等无意义编号条目
            if (item.note) {
                var parsed = window.parseNoteToFields(item.note);
                return window.buildNoteFromFields(parsed.changePct, parsed.topics);
            }
            return '';
        }

        // 仅用于第一页展示：当天字段为空时，回退到历史/云端题材缓存
        // 注意：编辑框预填等场景请继续使用 getDisplayNote，不要用这个函数，
        // 避免把历史题材误存成"今天的注释"
        export function getDisplayNoteWithHistory(item) {
            if (!item) return '';
            const todayNote = window.getDisplayNote(item);
            // 仅当 todayNote 已包含题材（括号内）时才直接返回；
            // 否则即使 todayNote 有涨幅（如 "+5%"），也尝试用历史题材补全
            if (todayNote && window.extractTopics(todayNote).length > 0) return todayNote;
            if (item.stock) {
                const historyNote = window.getStockHistoryTopics(item.stock);
                if (historyNote) {
                    // historyNote 格式 "(题材1，题材2)"，提取题材字符串
                    const historyTopics = historyNote.replace(/^\(/, '').replace(/\)$/, '');
                    // 和今天的 changePct 拼接（若有），如 "+5%(题材1，题材2)"
                    return window.buildNoteFromFields(item.changePct, historyTopics);
                }
            }
            return todayNote || '';
        }

        // 提取涨幅显示值：已在 extractChangeFromNote 后定义（含 20% 上限校验），
        // 这里保留 migrateNoteToFields 等下游函数的衔接位置。

        // 迁移本地 auctionData 中旧 note 到 changePct + topics 字段
        export function migrateNoteToFields() {
            var auctionData = window.getAuctionData();
            var migrated = false;
            Object.keys(auctionData).forEach(function(date) {
                (auctionData[date] || []).forEach(function(item) {
                    if (item && (!item.changePct || !item.topics) && item.note) {
                        var parsed = window.parseNoteToFields(item.note);
                        if (!item.changePct) item.changePct = parsed.changePct;
                        if (!item.topics) item.topics = parsed.topics;
                        migrated = true;
                    }
                });
            });
            if (migrated) window.saveModule('auction');
        }

        // [BUG-FIX 2026-07-26] 一次性清理：移除本地 auctionData / hotAuctionData 里
        // 已存在的 "题材35/题材36" 等编号条目，以及把 changePct 字段里被误写入的
        // 超过 20% 的占比数据清空。只在首次加载时执行一次（用 localStorage 标记）。
        export function cleanupInvalidTopicsAndChangePct() {
            if (localStorage.getItem('_cleanupTopicNumDone') === '1') return;
            var cleanedTopics = 0;
            var cleanedChangePct = 0;
            // 处理 auction 数据
            try {
                var auctionData = window.getAuctionData();
                Object.keys(auctionData).forEach(function(date) {
                    (auctionData[date] || []).forEach(function(item) {
                        if (!item) return;
                        // 清理 topics 字段里的 "题材N"
                        if (item.topics) {
                            var arr = item.topics.split(/[+，、,;；]/).map(function(t) { return t.trim(); });
                            var filtered = arr.filter(function(t) {
                                if (!t) return false;
                                if (/^题材\d+$/.test(t)) { cleanedTopics++; return false; }
                                if (/^\d+$/.test(t)) { cleanedTopics++; return false; }
                                if (t.length < 2) { cleanedTopics++; return false; }
                                return true;
                            });
                            if (filtered.length !== arr.length) {
                                item.topics = filtered.join('，');
                            }
                        }
                        // 清理 note 字段里的 "(题材35)" 等括号内容
                        if (item.note && /[(（]([^)）]*题\d+[^)）]*)[)）]/.test(item.note)) {
                            item.note = item.note.replace(/[(（]([^)）]+)[)）]/g, function(m, p1) {
                                var arr = p1.split(/[+，、,;；]/).map(function(t) { return t.trim(); });
                                var filtered = arr.filter(function(t) {
                                    if (/^题材\d+$/.test(t)) { cleanedTopics++; return false; }
                                    if (/^\d+$/.test(t)) { cleanedTopics++; return false; }
                                    if (t.length < 2) { cleanedTopics++; return false; }
                                    return true;
                                });
                                return filtered.length > 0 ? '(' + filtered.join('，') + ')' : '';
                            });
                        }
                        // 清理 changePct 字段里超过 20% 的占比数据
                        if (item.changePct && /^[+-]?\d+\.?\d*%$/.test(item.changePct)) {
                            var num = parseFloat(item.changePct);
                            if (!isNaN(num) && Math.abs(num) > 20) {
                                window._dbgLog('[CLEANUP] 清空异常 changePct: ' + item.stock + ' = ' + item.changePct);
                                item.changePct = '';
                                cleanedChangePct++;
                            }
                        }
                    });
                });
                window.saveModule('auction');
            } catch (e) {
                window._dbgLog('[CLEANUP-ERR] auction 清理失败: ' + e);
            }
            // 处理 hot 数据
            try {
                var hotData = window.getHotAuctionData();
                Object.keys(hotData).forEach(function(date) {
                    (hotData[date] || []).forEach(function(item) {
                        if (!item) return;
                        if (item.topics) {
                            var arr2 = item.topics.split(/[+，、,;；]/).map(function(t) { return t.trim(); });
                            var filtered2 = arr2.filter(function(t) {
                                if (!t) return false;
                                if (/^题材\d+$/.test(t)) { cleanedTopics++; return false; }
                                if (/^\d+$/.test(t)) { cleanedTopics++; return false; }
                                if (t.length < 2) { cleanedTopics++; return false; }
                                return true;
                            });
                            if (filtered2.length !== arr2.length) {
                                item.topics = filtered2.join('，');
                            }
                        }
                        if (item.note && /[(（]([^)）]*题\d+[^)）]*)[)）]/.test(item.note)) {
                            item.note = item.note.replace(/[(（]([^)）]+)[)）]/g, function(m, p1) {
                                var arr = p1.split(/[+，、,;；]/).map(function(t) { return t.trim(); });
                                var filtered = arr.filter(function(t) {
                                    if (/^题材\d+$/.test(t)) { cleanedTopics++; return false; }
                                    if (/^\d+$/.test(t)) { cleanedTopics++; return false; }
                                    if (t.length < 2) { cleanedTopics++; return false; }
                                    return true;
                                });
                                return filtered.length > 0 ? '(' + filtered.join('，') + ')' : '';
                            });
                        }
                        if (item.changePct && /^[+-]?\d+\.?\d*%$/.test(item.changePct)) {
                            var num2 = parseFloat(item.changePct);
                            if (!isNaN(num2) && Math.abs(num2) > 20) {
                                window._dbgLog('[CLEANUP] 清空异常 hot changePct: ' + item.stock + ' = ' + item.changePct);
                                item.changePct = '';
                                cleanedChangePct++;
                            }
                        }
                    });
                });
                window.saveModule('hot');
            } catch (e) {
                window._dbgLog('[CLEANUP-ERR] hot 清理失败: ' + e);
            }
            // 清理旧的核心词库里的 "新能源汽车2"（已改名为"智能驾驶"）
            try {
                var coreStr = localStorage.getItem('coreTopics');
                if (coreStr) {
                    var coreArr = JSON.parse(coreStr);
                    if (Array.isArray(coreArr)) {
                        var hadOld = coreArr.some(function(c) { return c && c.name === '新能源汽车2'; });
                        if (hadOld) {
                            // 重置为默认核心词库（已包含正确的"智能驾驶"分类）
                            localStorage.removeItem('coreTopics');
                            window._dbgLog('[CLEANUP] 检测到旧"新能源汽车2"核心词，已重置为默认核心词库（34 个分类）');
                        }
                    }
                }
            } catch (e) {
                window._dbgLog('[CLEANUP-ERR] coreTopics 重置失败: ' + e);
            }
            localStorage.setItem('_cleanupTopicNumDone', '1');
            window._dbgLog('[CLEANUP] 一次性清理完成：清理题材条目 ' + cleanedTopics + ' 个，清空异常涨幅 ' + cleanedChangePct + ' 个');
        }

        // 打开核心词管理弹窗
        export function openCoreTopicModal() {
            window.renderCoreTopicList();
            document.getElementById('coreTopicModal').classList.add('active');
        }

        // 关闭核心词管理弹窗
        export function closeCoreTopicModal() {
            document.getElementById('coreTopicModal').classList.remove('active');
            window.renderAuction();
        }

        // 渲染核心词列表
        export function renderCoreTopicList() {
            const coreTopics = window.getCoreTopics();
            const container = document.getElementById('coreTopicList');
            
            let html = '';
            coreTopics.forEach((core, index) => {
                html += `
                    <div class="core-topic-item" style="display: flex; align-items: center; padding: 10px; border: 1px solid #e2e8f0; border-radius: 6px; margin-bottom: 8px; background: #fafafa;">
                        <div style="flex: 1;">
                            <div style="font-weight: 600; color: #1f2937; font-size: 14px;">${core.name}</div>
                            <div style="font-size: 12px; color: #6b7280; margin-top: 4px;">同义词：${core.synonyms && core.synonyms.length > 0 ? core.synonyms.join('、') : '无'}</div>
                        </div>
                        <button type="button" onclick="window.editCoreTopic(${index})" style="padding: 4px 8px; font-size: 12px; background: #e0e7ff; color: #4f46e5; border: none; border-radius: 4px; cursor: pointer; margin-right: 4px;">编辑</button>
                        <button type="button" onclick="window.deleteCoreTopic(${index})" style="padding: 4px 8px; font-size: 12px; background: #fee2e2; color: #dc2626; border: none; border-radius: 4px; cursor: pointer;">删除</button>
                    </div>
                `;
            });
            
            if (coreTopics.length === 0) {
                html = '<div style="text-align: center; color: #9ca3af; padding: 20px;">暂无核心词，请添加</div>';
            }
            
            container.innerHTML = html;
        }

        // 添加核心词
        export function addCoreTopic() {
            const nameInput = document.getElementById('newCoreTopicName');
            const synonymsInput = document.getElementById('newCoreTopicSynonyms');
            
            const name = nameInput.value.trim();
            const synonymsStr = synonymsInput.value.trim();
            
            if (!name) {
                alert('请输入核心词名称');
                return;
            }
            
            const coreTopics = window.getCoreTopics();
            
            if (coreTopics.find(c => c.name === name)) {
                alert('该核心词已存在');
                return;
            }
            
            const synonyms = synonymsStr ? synonymsStr.split(/[,，]/).map(s => s.trim()).filter(s => s) : [];
            
            coreTopics.push({ name, synonyms });
            window.saveCoreTopics(coreTopics);
            
            nameInput.value = '';
            synonymsInput.value = '';
            
            window.renderCoreTopicList();
        }

        // 编辑核心词（使用自定义弹窗，避免系统 prompt 在切换应用后内容丢失）
        let _coreTopicEditIndex = null;
        export function editCoreTopic(index) {
            const coreTopics = window.getCoreTopics();
            const core = coreTopics[index];
            if (!core) return;

            _coreTopicEditIndex = index;
            document.getElementById('coreTopicEditName').value = core.name || '';
            document.getElementById('coreTopicEditSynonyms').value = core.synonyms ? core.synonyms.join(',') : '';
            document.getElementById('coreTopicEditModal').classList.add('active');
        }

        export function closeCoreTopicEditModal() {
            document.getElementById('coreTopicEditModal').classList.remove('active');
            _coreTopicEditIndex = null;
        }

        export function saveCoreTopicEdit() {
            if (_coreTopicEditIndex === null) return;
            const coreTopics = window.getCoreTopics();
            const core = coreTopics[_coreTopicEditIndex];
            if (!core) { window.closeCoreTopicEditModal(); return; }

            const newName = document.getElementById('coreTopicEditName').value;
            const newSynonymsStr = document.getElementById('coreTopicEditSynonyms').value;

            coreTopics[_coreTopicEditIndex].name = newName.trim() || core.name;
            coreTopics[_coreTopicEditIndex].synonyms = newSynonymsStr ? newSynonymsStr.split(/[,，]/).map(s => s.trim()).filter(s => s) : [];

            window.saveCoreTopics(coreTopics);
            window.renderCoreTopicList();
            window.closeCoreTopicEditModal();
        }

        // 删除核心词
        export function deleteCoreTopic(index) {
            if (!confirm('确定删除该核心词？')) return;
            
            const coreTopics = window.getCoreTopics();
            coreTopics.splice(index, 1);
            window.saveCoreTopics(coreTopics);
            window.renderCoreTopicList();
        }

        // 恢复默认核心词
        export function resetCoreTopics() {
            if (!confirm('确定恢复默认核心词？当前设置将被覆盖。')) return;
            
            localStorage.removeItem('coreTopics');
            window.renderCoreTopicList();
        }

        // 滑动翻页相关变量
        window.auctionCurrentPage = 0;
        let auctionTouchStartX = 0;
        let auctionTouchEndX = 0;
        let auctionSwipeInitialized = false;
        let lastClickedStockName = null; // 记录从第一页点击的股票名称

        // 切换页面
        export function switchAuctionPage(page) {
            // 清除页面上的跳转高亮（highlight-search类），但保留用户设置的选中状态
            document.querySelectorAll('.auction-item.highlight-search, .auction-topic-row.highlight-search').forEach(el => {
                el.classList.remove('highlight-search');
            });
            if (window.auctionStore) window.auctionStore.highlightStock = ''; // Vue 路径同步清除高亮

            auctionCurrentPage = page;
            if (typeof window.auctionStore !== 'undefined' && window.auctionStore) window.auctionStore.currentPage = page; // [PERF-CORE] 懒算依赖：翻页同步 store，唤醒对应页看板
            const wrapper = document.getElementById('auctionSwipeWrapper');
            const dots = document.querySelectorAll('.page-dot');

            const _p = window.currentGroup === 'hot' ? 'hot' : 'auction';
            const page1 = document.getElementById(_p + 'Page1');
            const page2 = document.getElementById(_p + 'Page2');
            const page3 = document.getElementById(_p + 'Page3');
            const page4 = document.getElementById(_p + 'Page4');
            
            if (page1 && page2 && page3 && page4) {
                page1.classList.remove('active');
                page2.classList.remove('active');
                page3.classList.remove('active');
                page4.classList.remove('active');
                
                if (page === 0) {
                    page1.classList.add('active');
                } else if (page === 1) {
                    page2.classList.add('active');
                } else if (page === 2) {
                    page3.classList.add('active');
                } else if (page === 3) {
                    page4.classList.add('active');
                }
            }
            
            dots.forEach((dot, index) => {
                if (index === page) {
                    dot.classList.add('active');
                } else {
                    dot.classList.remove('active');
                }
            });
            
            // 不再每次翻页都重新渲染，只在必要时渲染
            // renderAuction();
        }

        // 跳转到第二页并高亮指定股票
        export function jumpToAuctionPage2(stockName) {
            // 只清除跳转高亮，不清除用户设置的选中状态
            document.querySelectorAll('.auction-item.highlight-search, .auction-topic-row.highlight-search').forEach(el => {
                el.classList.remove('highlight-search');
            });
            // 记录点击的股票名称
            lastClickedStockName = stockName;

            // 切换到第二页
            window.switchAuctionPage(1);
            // 注意：highlightStock 必须在 switchAuctionPage 之后设置——switchAuctionPage
            // 内部会清空 highlightStock，先设后切会被立即清掉，导致 Vue 响应式高亮失效。
            if (window.auctionStore) window.auctionStore.highlightStock = stockName || ''; // Vue 路径同步高亮
            
            // 等待页面切换完成后，滚动到对应股票行
            setTimeout(() => {
                // 查找对应的股票行
                const rows = document.querySelectorAll('.auction-topic-row');
                let targetRow = null;
                
                rows.forEach(row => {
                    const stockEl = row.querySelector('.auction-topic-stock');
                    if (stockEl && stockEl.textContent.trim() === stockName) {
                        targetRow = row;
                        // 添加高亮样式
                        row.classList.add('highlight-search');
                    }
                });
                
                // 滚动到对应股票行
                if (targetRow) {
                    targetRow.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }
            }, 100);
        }

        // 跳转到第一页并高亮指定股票
        export function jumpToAuctionPage1(stockName) {
            // 只清除跳转高亮，不清除用户设置的选中状态
            document.querySelectorAll('.auction-item.highlight-search, .auction-topic-row.highlight-search').forEach(el => {
                el.classList.remove('highlight-search');
            });
            // 切换到第一页
            window.switchAuctionPage(0);
            // 注意：highlightStock 必须在 switchAuctionPage 之后设置（同 jumpToAuctionPage2）
            if (window.auctionStore) window.auctionStore.highlightStock = stockName || ''; // Vue 路径同步高亮
            
            // 等待页面切换完成后，高亮对应股票
            setTimeout(() => {
                // 查找对应的股票
                const stockEls = document.querySelectorAll('.auction-stock-name');
                let targetEl = null;
                
                stockEls.forEach(el => {
                    if (el.textContent.trim() === stockName) {
                        targetEl = el;
                    }
                });
                
                // 滚动到对应股票并高亮
                if (targetEl) {
                    const row = targetEl.closest('.auction-item');
                    if (row) {
                        row.classList.add('highlight-search');
                        row.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    }
                }
            }, 150);
        }

        // 初始化滑动翻页
        export function initAuctionSwipe() {
            if (auctionSwipeInitialized) return;
            auctionSwipeInitialized = true;
            
            const container = document.getElementById('auctionSwipeContainer');
            const dots = document.querySelectorAll('.page-dot');
            
            if (!container) return;

            container.addEventListener('touchstart', function(e) {
                auctionTouchStartX = e.touches[0].clientX;
            }, { passive: true });

            container.addEventListener('touchend', function(e) {
                auctionTouchEndX = e.changedTouches[0].clientX;
                window.handleAuctionSwipe();
            }, { passive: true });

            container.addEventListener('mousedown', function(e) {
                auctionTouchStartX = e.clientX;
            });

            container.addEventListener('mouseup', function(e) {
                auctionTouchEndX = e.clientX;
                window.handleAuctionSwipe();
            });

            container.addEventListener('mouseleave', function(e) {
                auctionTouchEndX = e.clientX;
                if (Math.abs(auctionTouchEndX - auctionTouchStartX) > 50) {
                    window.handleAuctionSwipe();
                }
            });

            dots.forEach(dot => {
                dot.addEventListener('click', function() {
                    const page = parseInt(this.dataset.page);
                    window.switchAuctionPage(page);
                    window.scrollToAuctionHeader();
                });
            });
            
            // 第三页日期行点击事件委托
            container.addEventListener('click', function(e) {
                const row = e.target.closest('.auction-topic-history-row');
                if (row) {
                    const topic = row.dataset.topic;
                    const dateStr = row.dataset.date;
                    if (topic && dateStr) {
                        window.jumpFromPage3ToPage2(topic, dateStr);
                    }
                }
                
                // 第二页"展开/收起本题材趋势图"独立行的点击事件委托（与标题栏跳转逻辑完全分离，不受第三页跳转场景影响）
                const expandRow = e.target.closest('.auction-topic-expand-row');
                if (expandRow) {
                    const expandTopic = expandRow.dataset.topic;
                    if (expandTopic) {
                        window.toggleTopicGroupTrendPanels(expandTopic);
                    }
                }
                
                // 第二页题材标题点击事件委托（仅在"从第三页跳转过来"场景下用于跳回第三页）
                const header = e.target.closest('.auction-topic-header');
                if (header) {
                    const topic = header.dataset.topic;
                    if (topic && lastJumpFromPage3) {
                        window.jumpFromPage2ToPage3(topic);
                    }
                }
            });
        }

        export function handleAuctionSwipe() {
            const diff = auctionTouchStartX - auctionTouchEndX;
            const threshold = 50;

            if (diff > threshold && auctionCurrentPage < 3) {
                window.switchAuctionPage(auctionCurrentPage + 1);
                window.scrollToAuctionHeader();
            } else if (diff < -threshold && auctionCurrentPage > 0) {
                window.switchAuctionPage(auctionCurrentPage - 1);
                window.scrollToAuctionHeader();
            }
        }

        // 翻页后自动滚动到早盘竞价标题
        export function scrollToAuctionHeader() {
            // 以整个 auctionBoard 为目标，确保紫色标题栏完整显示
            const board = document.getElementById('auctionBoard');
            if (!board) return;
            setTimeout(function() {
                // 顶部 sticky 导航栏高度（date-nav），动态获取
                const dateNav = document.querySelector('.date-nav');
                const navHeight = dateNav ? dateNav.getBoundingClientRect().height : 60;
                // board 距离页面顶部的绝对位置
                const boardTop = board.getBoundingClientRect().top + window.scrollY;
                // 目标滚动位置：让 board 顶部刚好在导航栏下方，留 4px 间距
                const targetY = boardTop - navHeight - 4;
                window.scrollTo({ top: targetY, behavior: 'smooth' });
            }, 80);
        }

        // ============================================================
        // 竞价看板独立标签系统（与股票卡片列表完全解耦）
        // 存储：localStorage["auctionBoardTags"] = { "2026-08-07": { "大晟文化": "buy", ... } }
        // 标签值：'buy' | 'sell' | 'hold' | 'cancel'
        // 角标显示：D 日角标由 D-1（前一交易日）的 tag 决定（被动展示）
        // 继承：D 日选 buy/sell/hold → D+1 自动加入竞价列表并显示角标；选 cancel 或不操作 → 不继承
        // ============================================================
        function _loadAuctionTags() {
            try { return JSON.parse(localStorage.getItem('auctionBoardTags') || '{}'); }
            catch (e) { return {}; }
        }
        function _saveAuctionTags(tags) {
            try { localStorage.setItem('auctionBoardTags', JSON.stringify(tags)); } catch (e) {}
        }
        function setAuctionTag(date, stockName, tag) {
            if (!date || !stockName) return;
            const tags = _loadAuctionTags();
            if (!tags[date]) tags[date] = {};
            if (tag) tags[date][stockName.trim()] = tag;
            else delete tags[date][stockName.trim()];
            _saveAuctionTags(tags);
        }
        function getAuctionTag(date, stockName) {
            if (!date || !stockName) return null;
            const tags = _loadAuctionTags();
            return (tags[date] && tags[date][stockName.trim()]) || null;
        }
        // 角标状态：从前一交易日的 tag 派生（被动展示）
        function getAuctionTagState(stockName, date) {
            const d = date || window.currentDate;
            const prevDay = window.getPreviousTradingDay ? window.getPreviousTradingDay(d) : null;
            const tag = prevDay ? getAuctionTag(prevDay, stockName) : null;
            return {
                bought: tag === 'buy',
                sold: tag === 'sell',
                selected: tag === 'hold',
                source: tag ? 'inherited' : 'none'
            };
        }
        // 当日选择（用于弹窗高亮）
        function getAuctionTagChoice(stockName, date) {
            return getAuctionTag(date || window.currentDate, stockName);
        }
        // 选 buy/sell/hold 时自动添加到次日竞价列表
        function _ensureStockInNextDay(stockName, date) {
            const nextDay = window.getNextTradingDay ? window.getNextTradingDay(date) : null;
            if (!nextDay) return;
            const auctionData = window.getAuctionData();
            const dayList = auctionData[nextDay] || [];
            const exists = dayList.some(function(s) { return s && s.stock && s.stock.trim() === stockName.trim(); });
            if (!exists) {
                dayList.push({ stock: stockName.trim(), code: window.getStockCode ? window.getStockCode(stockName) : '', volume: '', yestVolume: '', note: '', obsAutoAdded: false });
                auctionData[nextDay] = dayList;
                window.setAuctionDateData(nextDay, dayList, 'auctionBoardTags');
                if (window._addAuctionWatchlistMember) window._addAuctionWatchlistMember(nextDay, stockName.trim());
                // 持久化到 localStorage，防止切日期时数据被覆盖
                if (typeof window.saveData === 'function') window.saveData();
            }
        }
        window.setAuctionTag = setAuctionTag;
        window.getAuctionTag = getAuctionTag;
        window.getAuctionTagState = getAuctionTagState;
        window.getAuctionTagChoice = getAuctionTagChoice;

        // 长按弹出标签选择（买入/卖出/持有/取消次日观察），不影响股票卡片列表
        export function showAuctionBuyPrompt(stockName) {
            const date = window.currentDate;
            const currentChoice = getAuctionTagChoice(stockName, date);
            const overlay = document.createElement('div');
            overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.4);z-index:9999;display:flex;align-items:center;justify-content:center;';
            const popup = document.createElement('div');
            popup.style.cssText = 'background:#1e293b;border-radius:12px;padding:20px;min-width:280px;box-shadow:0 8px 32px rgba(0,0,0,0.3);';
            const title = document.createElement('div');
            title.style.cssText = 'color:#e2e8f0;font-size:15px;font-weight:600;margin-bottom:16px;text-align:center;';
            title.textContent = stockName;
            popup.appendChild(title);
            const btns = [
                { label: '买入', tag: 'buy', color: '#dc2626' },
                { label: '卖出', tag: 'sell', color: '#6b7280' },
                { label: '持有', tag: 'hold', color: '#2563eb' },

                { label: '取消标签', tag: null, color: '#475569' }
            ];
            btns.forEach(function(b) {
                const btn = document.createElement('button');
                const isActive = currentChoice === b.tag;
                btn.style.cssText = 'display:block;width:100%;padding:10px;margin-bottom:8px;border:1px solid ' + (isActive ? b.color : '#334155') + ';border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;background:' + (isActive ? b.color : '#0f172a') + ';color:' + (isActive ? '#fff' : b.color) + ';';
                btn.textContent = b.label + (isActive ? ' \u2713' : '');
                btn.onclick = function() {
                    setAuctionTag(date, stockName, b.tag);
                    if (b.tag === 'buy' || b.tag === 'sell' || b.tag === 'hold') {
                        _ensureStockInNextDay(stockName, date);
                    }
                    document.body.removeChild(overlay);
                    // 同步 bump dataVersions，确保 Vue computed 立即重算（不等微任务）
                    if (window.auctionStore && window.auctionStore.dataVersions) {
                        const _ds = window.currentGroup === 'hot' ? 'hot' : 'auction';
                        window.auctionStore.dataVersions[_ds] = (window.auctionStore.dataVersions[_ds] || 0) + 1;
                    }
                    window.renderAuction(window.currentGroup);
                };
                popup.appendChild(btn);
            });
            const closeBtn = document.createElement('button');
            closeBtn.style.cssText = 'display:block;width:100%;padding:10px;border:none;border-radius:8px;font-size:14px;cursor:pointer;background:#334155;color:#94a3b8;';
            closeBtn.textContent = '关闭';
            closeBtn.onclick = function() { document.body.removeChild(overlay); };
            popup.appendChild(closeBtn);
            overlay.appendChild(popup);
            overlay.onclick = function(e) { if (e.target === overlay) document.body.removeChild(overlay); };
            document.body.appendChild(overlay);
        }
        
        // 从竞价看板添加股票到列表
        export function addStockFromAuction(stockName) {
            const stocksData = window.getStocksData();
            if (!stocksData[window.currentDate]) {
                stocksData[window.currentDate] = [];
            }
            
            // 检查是否已存在
            const existingStock = stocksData[window.currentDate].find(s => s.name === stockName);
            if (existingStock) {
                // 已存在，添加最近多板标签
                existingStock.recentMulti = true;
                window.saveData();
                window.renderList();
                alert(`股票 "${stockName}" 已存在于列表中，已添加最近多板标签！`);
                return;
            }
            
            // 获取题材：先从当前 note 中提取，如果没有则从历史记录查找
            let xgcaiti = '';
            const auctionList = window.getTodayGroupList(window.currentGroup);
            const currentStock = auctionList.find(s => s.stock && s.stock.trim() === stockName.trim());
            
            if (currentStock && currentStock.note) {
                // 从当前 note 提取题材
                const topics = window.extractTopics(currentStock.note);
                xgcaiti = topics.join('，');
            }
            
            // 如果没有题材，从历史记录查找
            if (!xgcaiti) {
                xgcaiti = window.getStockHistoryTopics(stockName);
            }
            
            // 提取涨幅（从note字段，括号前的内容）
            let close = '';
            if (currentStock && currentStock.note) {
                const match = currentStock.note.match(/^([+-]?\d+\.?\d*)%/);
                if (match) {
                    close = match[1];
                }
            }
            
            // 创建新股票记录
            const newStock = {
                id: Date.now(),
                name: stockName,
                stage: '',
                adjust: '',
                open: '',
                close: close,
                turnover: '',
                kbiliangkai: '',
                sfliangneng: '',
                xgcaiti: xgcaiti,
                nextDay: '',
                bomb: false,
                bought: true,
                sold: false,
                sellHigh: false,
                sell1120: false,
                sell1450: false,
                hold: false,
                watch: false,
                dragon: false,
                pattern: '',
                axis: '',
                comment: '',
                remark: '',
                remarkType: '',
                track: [],
                soldRecords: [],
                recentMulti: true,
                sectorEtf: false,
                topicDirection: false
            };
            
            stocksData[window.currentDate].unshift(newStock);
            window.saveData();
            window.renderList();

            // 方案 B：标签不再写入 auctionData 行，渲染时由 deriveAuctionTagState 实时派生。
            // stocksData 已写入 bought=true，renderAuction 时 enrichAuctionItem 会自动派生显示。
            const freshAuctionList = window.getTodayGroupList(window.currentGroup);
            const auctionIndex = freshAuctionList.findIndex(s => s.stock && s.stock.trim() === stockName.trim());
            if (auctionIndex >= 0) {
                if (window.currentGroup === 'hot') { window.syncHotStocksListForDate(window.currentDate).catch(function(){}); } else { window.saveData(); }
                window.renderAuction(window.currentGroup);
            }

            window.showToast(`✅ 已添加 "${stockName}" 到股票列表`);
        }
        
        // 切换行选中状态
        // 展开某一行的趋势面板（供"全部展开"复用，不做toggle判断，直接展开）
        // dataSource 显式传入，不再依赖全局 currentGroup —— 避免渲染回调发生时
        // currentGroup 已经因为用户切换了tab而变化，导致展开了错误分组的面板
        export function expandAuctionTrendPanel(index, dataSource, force) {
            const _expStartTs = performance.now();
            const _tp = dataSource === 'hot' ? 'hot' : (dataSource === 'auction' ? 'auction' : (window.currentGroup === 'hot' ? 'hot' : 'auction'));
            const panel = document.getElementById(_tp + 'TrendPanel-' + index);
            // [PERF-CORE] 找不到面板属正常情况（竞/昨开关下被隐藏的观察组行不渲染面板），
            // 原实现每次恢复都刷 4 条警告日志并同步写 sessionStorage，直接静默跳过
            if (!panel) { window._dbgLogVerbose('[EXPAND] window.expandAuctionTrendPanel 找不到panel节点 index=' + index + '（该行未渲染，跳过）'); return; }

            const auctionList = window.getTodayGroupList(_tp);
            const item = auctionList[index];
            if (!item || !item.stock) { window._dbgLogVerbose('[EXPAND] index=' + index + ' 已失效（该位置数据为空），放弃展开'); return; }

            // [BUG-FIX 2026-07-26] 数据更新后（stocksDataVersion 变化）必须重绘已展开趋势图，
            // 否则后台按钮拉取新数据后，已展开面板仍显示旧图，需手动收起再展开或刷新页面。
            const storeVer = (typeof window.auctionStore !== 'undefined' && window.auctionStore) ? (window.auctionStore.stocksDataVersion || 0) : 0;
            const _lastVer = panel.dataset.lastRenderVer || '0';
            const _isOpen = panel.style.display === 'block';
            const _hasHtml = !!panel.innerHTML.trim();
            const _isOpenAndFresh = !force && _isOpen && _hasHtml && _lastVer === String(storeVer);
            window._dbgLogVerbose('[EXPAND] 进入 index=' + index + ' stock=' + item.stock + ' storeVer=' + storeVer + ' lastVer=' + _lastVer + ' isOpen=' + _isOpen + ' hasHtml=' + _hasHtml + ' openAndFresh=' + _isOpenAndFresh + ' force=' + !!force);
            if (_isOpenAndFresh) {
                window._dbgLogVerbose('[EXPAND] 面板已展开且数据版本未变，跳过 index=' + index + ' stock=' + item.stock);
                return;
            }

            // [BUG-FIX 2026-07-26] 同步记录到展开集合：直接调用 expandAuctionTrendPanel（如
            // "全部展开"、测试脚本、外部恢复）时也应把股票加入记忆集合，否则 Vue 重渲染后
            // restoreExpandedAuctionTrendPanels 因集合为空而无法恢复该面板。
            const _expSet = window._getExpandedStocksSet(_tp);
            _expSet.add(item.stock.trim());
            window._syncExpandedStocksToStore(_tp);

            const history = window.getAuctionStockHistory(item.stock.trim(), window.currentDate, 5, _tp);
            panel.innerHTML = window.renderAuctionTrendHtml(history);
            panel.style.display = 'block';
            panel.dataset.lastRenderVer = String(storeVer);
            window._dbgLogVerbose('[EXPAND] 展开成功 股票=' + item.stock + ' index=' + index + ' ver=' + storeVer + ' setSize=' + _expSet.size + ' | 耗时=' + Math.round(performance.now() - _expStartTs) + 'ms');
        }

        // 展开当前列表所有行的趋势面板
        export function expandAllAuctionTrendPanels(dataSource) {
            const _tp = dataSource === 'hot' ? 'hot' : (dataSource === 'auction' ? 'auction' : (window.currentGroup === 'hot' ? 'hot' : 'auction'));
            const auctionList = window.getTodayGroupList(_tp);
            const _set = window._getExpandedStocksSet(_tp);
            window._dbgLog('[EXPAND-ALL] 全部展开 dataSource=' + _tp + ' 列表=' + auctionList.length + '只 展开前setSize=' + _set.size);
            auctionList.forEach((item, idx) => {
                if (item && item.stock) _set.add(item.stock.trim());
                window.expandAuctionTrendPanel(idx, _tp, true);
            });
            window._syncExpandedStocksToStore(_tp);
            window._dbgLog('[EXPAND-ALL] 全部展开完成 dataSource=' + _tp + ' setSize=' + _set.size);
        }

        // 收起当前列表所有行的趋势面板
        export function collapseAllAuctionTrendPanels(dataSource) {
            const _tp = dataSource === 'hot' ? 'hot' : (dataSource === 'auction' ? 'auction' : (window.currentGroup === 'hot' ? 'hot' : 'auction'));
            const _contentEl = document.getElementById(_tp + 'Content');
            const _scope = _contentEl || document;
            const _set = window._getExpandedStocksSet(_tp);
            const _beforeSize = _set.size;
            _scope.querySelectorAll('.auction-trend-panel').forEach(panel => {
                panel.style.display = 'none';
                panel.innerHTML = '';
            });
            _set.clear();
            window._syncExpandedStocksToStore(_tp);
            window._dbgLog('[COLLAPSE-ALL] 全部收起 dataSource=' + _tp + ' 收起前setSize=' + _beforeSize);
        }

        // 根据指定分组的 expandedStocks 记录的展开状态，在 renderAuction 重新渲染后恢复各行的趋势面板展开
        // dataSource 显式传入，不再依赖全局 currentGroup
        export function restoreExpandedAuctionTrendPanels(dataSource) {
            const _tp = dataSource === 'hot' ? 'hot' : (dataSource === 'auction' ? 'auction' : (window.currentGroup === 'hot' ? 'hot' : 'auction'));
            const _set = window._getExpandedStocksSet(_tp);
            window._dbgLogVerbose('[RESTORE] window.restoreExpandedAuctionTrendPanels 被调用 dataSource=' + _tp + ' set=' + (_set ? [..._set].join('、') : 'null') + ' size=' + (_set ? _set.size : 0) + ' storeVer=' + (window.auctionStore && window.auctionStore.stocksDataVersion || 0));
            if (!_set || _set.size === 0) { window._dbgLogVerbose('[RESTORE] ' + _tp + ' 展开集合为空，无需恢复'); return; }
            const auctionList = window.getTodayGroupList(_tp);
            let _restored = 0;
            auctionList.forEach((item, idx) => {
                if (item && item.stock && _set.has(item.stock.trim())) {
                    window._dbgLogVerbose('[RESTORE] 恢复展开 ' + _tp + ' index=' + idx + ' stock=' + item.stock + ' ver=' + (window.auctionStore && window.auctionStore.stocksDataVersion || 0));
                    window.expandAuctionTrendPanel(idx, _tp, true);
                    _restored++;
                }
            });
            window._dbgLogVerbose('[RESTORE] ' + _tp + ' 恢复完成：集合=' + [..._set].join('、') + ' 实际恢复=' + _restored + '/' + _set.size);
        }

        // ===== 第二页（按题材分组）专用的趋势图展开逻辑 =====

        // 第二页"已展开的题材组"状态记录：存 `${dataSource}|${topic}` 格式
        // Realtime 重渲染后用此 Set 恢复展开状态，避免 1-2 秒后自动收起
        var _p2ExpandedTopics = new Set();

        // 将 _p2ExpandedTopics 同步到 Vue store（触发响应式重渲染）。
        // Vue 3 对 reactive Set 的 .add/.delete/.has 会通过集合拦截器追踪依赖。
        // 用内容级 diff 同步（而非整体换引用 new Set），相同内容不触发响应式，
        // 避免 expandAll→sync→computed 重算→watch→expandAll 的递归循环。
        // 既有 DOM 路径不受影响：_p2ExpandedTopics 仍是唯一权威源，store 只是镜像。
        export function _syncP2ExpandedToStore() {
            if (typeof window.auctionStore === 'undefined' || !window.auctionStore) return;
            try {
                const storeSet = window.auctionStore.p2ExpandedTopics;
                if (!(storeSet instanceof Set)) { window.auctionStore.p2ExpandedTopics = new Set(_p2ExpandedTopics); return; }
                storeSet.forEach(item => { if (!_p2ExpandedTopics.has(item)) storeSet.delete(item); });
                _p2ExpandedTopics.forEach(item => { if (!storeSet.has(item)) storeSet.add(item); });
            } catch (e) {}
        }

        // [DATE-SWITCH] 切换日期时统一重置所有展开状态，避免跨日期持久化。
        // 由 setCurrentDate 调用，权威源（_expandedAuctionStocksByGroup / _p2ExpandedTopics / store）全部清空，
        // 并立即隐藏当前可见的趋势面板，防止旧日期面板在新日期短暂残留。
        export function resetExpansionStateOnDateSwitch() {
            try {
                if (typeof window._expandedAuctionStocksByGroup !== 'undefined') {
                    window._expandedAuctionStocksByGroup.auction.clear();
                    window._expandedAuctionStocksByGroup.hot.clear();
                }
                if (typeof _p2ExpandedTopics !== 'undefined') _p2ExpandedTopics.clear();
                if (typeof window.auctionStore !== 'undefined' && window.auctionStore) {
                    if (window.auctionStore.expandedStocks && window.auctionStore.expandedStocks.clear) window.auctionStore.expandedStocks.clear();
                    if (window.auctionStore.p2ExpandedTopics && window.auctionStore.p2ExpandedTopics.clear) window.auctionStore.p2ExpandedTopics.clear();
                    window.auctionStore.expandAll = false;
                    window.auctionStore.expandAllP2 = false;
                }
                ['auctionExpandAllToggle', 'hotExpandAllToggle', 'auctionExpandAllToggle2', 'hotExpandAllToggle2'].forEach(function(id) {
                    const el = document.getElementById(id);
                    if (el) el.checked = false;
                });
                // 立即隐藏所有趋势面板，避免日期切换后旧面板仍可见（直到下次渲染才重建 DOM）
                document.querySelectorAll('.auction-trend-panel').forEach(function(panel) {
                    panel.style.display = 'none';
                    panel.innerHTML = '';
                });
                window._dbgLog('[DATE-SWITCH] 已重置展开状态并隐藏所有趋势面板');
            } catch (e) {
                window._dbgLog('[DATE-SWITCH] 重置展开状态失败: ' + (e && e.message));
            }
        }

        // 展开/收起第二页某一行的趋势面板（rowKey 用于定位具体行，因为同一股票可能在多个题材下重复出现）
        export function toggleAuctionTrendPanelP2(rowKey, stockName) {
            const _tp = window.currentGroup === 'hot' ? 'hot' : 'auction';
            const panel = document.getElementById(_tp + 'TrendPanelP2-' + rowKey);
            if (!panel) return;

            const isOpen = panel.style.display !== 'none';
            if (isOpen) {
                panel.style.display = 'none';
                panel.innerHTML = '';
                return;
            }

            const history = window.getAuctionStockHistory(stockName.trim(), window.currentDate, 5, _tp);
            panel.innerHTML = window.renderAuctionTrendHtml(history);
            panel.style.display = 'block';
        }

        // 展开第二页所有允许展开的行（排除"其它"和"并购重组"分组），同一股票只在第一次出现时真正渲染，避免重复占用空间
        // 展开第二页所有允许展开的行（排除"其它"和"并购重组"分组）
        // 每个题材分组内部的所有个股都独立展开，即使同一只股票在多个分组下会重复展开好几次（用户明确需要按题材分组做完整对比）
        export function expandAllAuctionTrendPanelsP2(dataSource) {
            const _tp = dataSource === 'hot' ? 'hot' : (dataSource === 'auction' ? 'auction' : (window.currentGroup === 'hot' ? 'hot' : 'auction'));
            const _content2El = document.getElementById(_tp + 'Content2');
            (_content2El || document).querySelectorAll('.auction-trend-trigger-p2').forEach(rowEl => {
                const stockName = (rowEl.dataset.stock || '').trim();
                const rowKey = rowEl.dataset.rowkey;
                if (!stockName || !rowKey) return;

                const panel = document.getElementById(_tp + 'TrendPanelP2-' + rowKey);
                if (!panel) return;
                // 性能优化：已展开且有内容的面板跳过（同 expandAuctionTrendPanel 守卫）
                if (panel.style.display === 'block' && panel.innerHTML.trim()) return;

                const history = window.getAuctionStockHistory(stockName, window.currentDate, 5, _tp);
                panel.innerHTML = window.renderAuctionTrendHtml(history);
                panel.style.display = 'block';
            });
            // 同步所有题材标题栏的箭头方向为"展开"
            (_content2El || document).querySelectorAll('.auction-topic-expand-arrow').forEach(arrowEl => {
                arrowEl.classList.add('expanded');
            });
            // 同步状态：当前 dataSource 的所有题材都加入 Set，Realtime 重渲染后可恢复
            (_content2El || document).querySelectorAll('.auction-topic-expand-row').forEach(rowEl => {
                const t = rowEl.dataset.topic;
                if (t) _p2ExpandedTopics.add(_tp + '|' + t);
            });
            window._syncP2ExpandedToStore();
        }

        // 收起第二页所有趋势面板
        export function collapseAllAuctionTrendPanelsP2(dataSource) {
            const _tp = dataSource === 'hot' ? 'hot' : (dataSource === 'auction' ? 'auction' : (window.currentGroup === 'hot' ? 'hot' : 'auction'));
            const _content2El = document.getElementById(_tp + 'Content2');
            const _scope2 = _content2El || document;
            _scope2.querySelectorAll(`[id^="${_tp}TrendPanelP2-"]`).forEach(panel => {
                panel.style.display = 'none';
                panel.innerHTML = '';
            });
            // 同步所有题材标题栏的箭头方向为"收起"
            _scope2.querySelectorAll('.auction-topic-expand-arrow').forEach(arrowEl => {
                arrowEl.classList.remove('expanded');
            });
            // 清空当前 dataSource 的所有题材状态（保留另一个 dataSource 的）
            const _prefix = _tp + '|';
            Array.from(_p2ExpandedTopics).forEach(key => {
                if (key.startsWith(_prefix)) _p2ExpandedTopics.delete(key);
            });
            window._syncP2ExpandedToStore();
        }

        // 根据 _p2ExpandedTopics 记录的展开状态，在 renderAuctionPage2 重新渲染后恢复各题材组展开
        export function restoreExpandedTopicGroupsP2(dataSource) {
            if (!_p2ExpandedTopics || _p2ExpandedTopics.size === 0) return;
            const _tp = dataSource === 'hot' ? 'hot' : 'auction';
            const _prefix = _tp + '|';
            const _content2El = document.getElementById(_tp + 'Content2');
            if (!_content2El) return;

            _p2ExpandedTopics.forEach(key => {
                if (!key.startsWith(_prefix)) return;
                const topic = key.substring(_prefix.length);
                const groupEl = _content2El.querySelector('.auction-topic-group[data-topic-group="' + CSS.escape(topic) + '"]');
                if (!groupEl) return;

                const arrowEl = groupEl.querySelector('.auction-topic-expand-arrow');
                if (arrowEl) arrowEl.classList.add('expanded');

                groupEl.querySelectorAll('.auction-trend-trigger-p2').forEach(rowEl => {
                    const stockName = (rowEl.dataset.stock || '').trim();
                    const rowKey = rowEl.dataset.rowkey;
                    if (!stockName || !rowKey) return;
                    const panel = document.getElementById(_tp + 'TrendPanelP2-' + rowKey);
                    if (!panel) return;
                    // 性能优化：已展开且有内容的面板跳过（同 expandAuctionTrendPanel 守卫）
                    if (panel.style.display === 'block' && panel.innerHTML.trim()) return;
                    const history = window.getAuctionStockHistory(stockName, window.currentDate, 5, _tp);
                    panel.innerHTML = window.renderAuctionTrendHtml(history);
                    panel.style.display = 'block';
                });
            });
        }

        // 单独展开/收起某一个题材分组下所有个股的趋势图，与"全部展开"总开关互不影响
        export function toggleTopicGroupTrendPanels(topic) {
            const _tp = window.currentGroup === 'hot' ? 'hot' : 'auction';
            const _content2El = document.getElementById(_tp + 'Content2');
            const groupEl = (_content2El || document).querySelector(`.auction-topic-group[data-topic-group="${CSS.escape(topic)}"]`);
            if (!groupEl) return;

            const rows = groupEl.querySelectorAll('.auction-trend-trigger-p2');
            if (rows.length === 0) return;

            // 判断当前分组状态：只要组内有任意一行已展开，就视为"已展开"，这次操作统一收起；否则统一展开
            let anyExpanded = false;
            rows.forEach(rowEl => {
                const rowKey = rowEl.dataset.rowkey;
                const panel = document.getElementById(_tp + 'TrendPanelP2-' + rowKey);
                if (panel && panel.style.display !== 'none' && panel.innerHTML.trim() !== '') {
                    anyExpanded = true;
                }
            });

            rows.forEach(rowEl => {
                const stockName = (rowEl.dataset.stock || '').trim();
                const rowKey = rowEl.dataset.rowkey;
                if (!stockName || !rowKey) return;
                const panel = document.getElementById(_tp + 'TrendPanelP2-' + rowKey);
                if (!panel) return;

                if (anyExpanded) {
                    panel.style.display = 'none';
                    panel.innerHTML = '';
                } else {
                    const history = window.getAuctionStockHistory(stockName, window.currentDate, 5, _tp);
                    panel.innerHTML = window.renderAuctionTrendHtml(history);
                    panel.style.display = 'block';
                }
            });

            // 更新箭头方向：展开状态朝上（180度），收起状态朝下（默认）
            const arrowEl = groupEl.querySelector('.auction-topic-expand-arrow');
            if (arrowEl) {
                if (anyExpanded) {
                    arrowEl.classList.remove('expanded');
                    _p2ExpandedTopics.delete(_tp + '|' + topic);
                } else {
                    arrowEl.classList.add('expanded');
                    _p2ExpandedTopics.add(_tp + '|' + topic);
                }
                window._syncP2ExpandedToStore();
            }
        }

        // 把 DOM 排序开关状态同步到 store（Vue 路径读 store 排序；DOM 仍是用户操作入口与
        // innerHTML 路径的数据源）。各排序开关 handler 在互斥联动应用完毕后调用本函数，
        // 再触发渲染。page=1 读第一页四开关，page=2 读第二页三开关（无"按数据"）。
        export function _syncSortStateToStore(dataSource, page) {
            if (typeof window.auctionStore === 'undefined' || !window.auctionStore) return;
            const p = dataSource === 'hot' ? 'hot' : 'auction';
            const pre = p === 'hot' ? 'hot' : 'auction';
            // 逐字段赋值（非整体替换）：Vue 3 reactive 仅在值真正变化时才触发，
            // 避免 Realtime 频繁回拉时无谓重算
            if (page === 2) {
                const r = document.getElementById(pre + 'SortByRatioToggle2');
                const pa = document.getElementById(pre + 'SortByParallelToggle2');
                const j = document.getElementById(pre + 'SortByJingYestToggle2');
                const jr = document.getElementById(pre + 'SortByJingYestRatioToggle2');
                const td = document.getElementById(pre + 'SortByThreeDayJingDieToggle2');
                const s = window.auctionStore.sortStateP2[p];
                s.byRatio = !!(r && r.checked);
                s.byParallel = !!(pa && pa.checked);
                s.byJingYest = !!(j && j.checked);
                s.byJingYestRatio = !!(jr && jr.checked);
                s.byThreeDayJingDie = !!(td && td.checked);
            } else {
                const d = document.getElementById(pre + 'SortByDataToggle');
                const r = document.getElementById(pre + 'SortByRatioToggle');
                const pa = document.getElementById(pre + 'SortByParallelToggle');
                const j = document.getElementById(pre + 'SortByJingYestToggle');
                const jr = document.getElementById(pre + 'SortByJingYestRatioToggle');
                const td = document.getElementById(pre + 'SortByThreeDayJingDieToggle');
                const s = window.auctionStore.sortState[p];
                s.byData = !!(d && d.checked);
                s.byRatio = !!(r && r.checked);
                s.byParallel = !!(pa && pa.checked);
                s.byJingYest = !!(j && j.checked);
                s.byJingYestRatio = !!(jr && jr.checked);
                s.byThreeDayJingDie = !!(td && td.checked);
            }
        }

        // [TOGGLE-PERSIST] 排序开关持久化：刷新后恢复勾选状态，使排序立即生效。
        // 按架构规范属 UI 层（读写 DOM checkbox + localStorage，toggle 为 UI 状态）。
        const _SORT_TOGGLE_KEY = 'auctionSortToggles_v1';
        const _SORT_TOGGLE_IDS = {
            auction: {
                p1: ['auctionSortByDataToggle', 'auctionSortByRatioToggle', 'auctionSortByParallelToggle', 'auctionSortByJingYestToggle', 'auctionSortByJingYestRatioToggle', 'auctionSortByThreeDayJingDieToggle'],
                p2: ['auctionSortByRatioToggle2', 'auctionSortByParallelToggle2', 'auctionSortByJingYestToggle2', 'auctionSortByJingYestRatioToggle2', 'auctionSortByThreeDayJingDieToggle2']
            },
            hot: {
                p1: ['hotSortByDataToggle', 'hotSortByRatioToggle', 'hotSortByParallelToggle', 'hotSortByJingYestToggle', 'hotSortByJingYestRatioToggle', 'hotSortByThreeDayJingDieToggle'],
                p2: ['hotSortByRatioToggle2', 'hotSortByParallelToggle2', 'hotSortByJingYestToggle2', 'hotSortByJingYestRatioToggle2', 'hotSortByThreeDayJingDieToggle2']
            }
        };

        export function _persistSortToggles() {
            try {
                const data = {};
                for (const scope of ['auction', 'hot']) {
                    data[scope] = {};
                    for (const page of ['p1', 'p2']) {
                        data[scope][page] = {};
                        for (const id of _SORT_TOGGLE_IDS[scope][page]) {
                            const el = document.getElementById(id);
                            if (el) data[scope][page][id] = el.checked;
                        }
                    }
                }
                localStorage.setItem(_SORT_TOGGLE_KEY, JSON.stringify(data));
            } catch (e) {}
        }

        // 启动时恢复：设 DOM checkbox → 同步 store → 更新容器高亮。返回是否有任一开关被恢复。
        export function _restoreAndApplySortToggles() {
            try {
                const raw = localStorage.getItem(_SORT_TOGGLE_KEY);
                if (!raw) return false;
                const data = JSON.parse(raw);
                let any = false;
                for (const scope of ['auction', 'hot']) {
                    for (const page of ['p1', 'p2']) {
                        const pageData = data[scope] && data[scope][page];
                        if (!pageData) continue;
                        for (const id of _SORT_TOGGLE_IDS[scope][page]) {
                            const el = document.getElementById(id);
                            if (el && typeof pageData[id] === 'boolean' && pageData[id]) {
                                el.checked = true;
                                any = true;
                            }
                        }
                    }
                }
                if (any) {
                    if (typeof window._syncSortStateToStore === 'function') {
                        window._syncSortStateToStore('auction', 1);
                        window._syncSortStateToStore('auction', 2);
                        window._syncSortStateToStore('hot', 1);
                        window._syncSortStateToStore('hot', 2);
                    }
                    if (typeof window._updateAuctionHighlightContainerState === 'function') {
                        window._updateAuctionHighlightContainerState('auction');
                        window._updateAuctionHighlightContainerState('hot');
                    }
                }
                return any;
            } catch (e) { return false; }
        }

        // 第二页"全部展开"开关变化时的处理
        export function onAuctionExpandAllToggle2Change() {
            const checked = document.getElementById('auctionExpandAllToggle2').checked;
            if (typeof window.auctionStore !== 'undefined' && window.auctionStore && window.auctionStore.actions) {
                window.auctionStore.actions.setExpandAll(checked, 2);
            }
            if (checked) {
                window.expandAllAuctionTrendPanelsP2('auction');
            } else {
                window.collapseAllAuctionTrendPanelsP2('auction');
            }
        }

        // 第二页"环比排序"开关变化时的处理（分组顺序不变，仅重排分组内部个股）
        // 第二页"环比"开关变化时的处理（分组顺序不变，仅重排分组内部个股）
        export function onAuctionSortByRatioToggle2Change() {
            const ratioChecked = document.getElementById('auctionSortByRatioToggle2').checked;
            if (ratioChecked) {
                // 与"平行"、"竞/昨"互斥，打开这个就关闭另外两个（"竞/昨"是"平行"的加强条件，必须一并关闭）
                const parallelToggle2 = document.getElementById('auctionSortByParallelToggle2');
                const jingYestToggle2 = document.getElementById('auctionSortByJingYestToggle2');
                const jingYestRatioToggle2 = document.getElementById('auctionSortByJingYestRatioToggle2');
                if (parallelToggle2) parallelToggle2.checked = false;
                if (jingYestToggle2) jingYestToggle2.checked = false;
                if (jingYestRatioToggle2) jingYestRatioToggle2.checked = false;
                const threeDayJingDieToggle2 = document.getElementById('auctionSortByThreeDayJingDieToggle2');
                if (threeDayJingDieToggle2) threeDayJingDieToggle2.checked = false;
            }
            window._refreshAuctionPage2OnToggle('auction');
        }

        // 第二页"平行"开关变化时的处理：今日竞价量>T-1竞价量 且 T-1成交量>T-2成交量 的股票排到分组最前面
        export function onAuctionSortByParallelToggle2Change() {
            window.resetAuctionExpansionOnToggle('auction', true);
            const parallelChecked = document.getElementById('auctionSortByParallelToggle2').checked;
            if (parallelChecked) {
                // 与"环比"互斥，打开这个就关闭另一个
                const ratioToggle2 = document.getElementById('auctionSortByRatioToggle2');
                if (ratioToggle2) ratioToggle2.checked = false;
                const threeDayJingDieToggle2 = document.getElementById('auctionSortByThreeDayJingDieToggle2');
                if (threeDayJingDieToggle2) threeDayJingDieToggle2.checked = false;
            } else {
                // 关闭"平行"时，"竞/昨"是平行的子条件，必须一并关闭
                const jingYestToggle2 = document.getElementById('auctionSortByJingYestToggle2');
                if (jingYestToggle2) jingYestToggle2.checked = false;
                const jingYestRatioToggle2 = document.getElementById('auctionSortByJingYestRatioToggle2');
                if (jingYestRatioToggle2) jingYestRatioToggle2.checked = false;
            }
            window._refreshAuctionPage2OnToggle('auction');
        }

        // 第二页"竞/昨"开关变化时的处理：在"平行"达标的基础上，进一步要求 今/昨比 > 昨/前比
        // 单向联动："竞/昨"打开会联动打开"平行"；关闭会联动关闭"平行"。
        // 排序/筛选 toggle（数据/环比/平行/竞昨）被点击时，重置展开状态：
        // 清空手动展开集合、取消"全部展开"开关、立即收起所有趋势面板，再回到默认状态。
        // 注意：不影响"全部展开"toggle 本身的正常工作——用户仍可重新打开全部展开。
        export function resetAuctionExpansionOnToggle(dataSource, isPage2) {
            try {
                const expandAllId = (dataSource === 'hot' ? 'hot' : 'auction') + (isPage2 ? 'ExpandAllToggle2' : 'ExpandAllToggle');
                const expandAllEl = document.getElementById(expandAllId);
                if (expandAllEl) expandAllEl.checked = false;
                if (isPage2) {
                    window.collapseAllAuctionTrendPanelsP2(dataSource);
                } else {
                    window.collapseAllAuctionTrendPanels(dataSource);
                }
                window._dbgLog('[TOGGLE-RESET] ' + dataSource + (isPage2 ? '/p2' : '/p1') + ' 展开状态已重置');
            } catch (e) {
                window._dbgLog('[TOGGLE-RESET] 重置失败: ' + (e && e.message));
            }
        }

        // 兜底清理：竞/昨 关闭时立即移除左侧蓝色/绿色行情标记，
        // 防止 Vue memo 路径重渲染延迟导致旧标记残留。
        export function _clearAuctionRowHighlights(dataSource) {
            const p = dataSource === 'hot' ? 'hot' : 'auction';
            const content = document.getElementById(p + 'Content');
            if (content) {
                content.querySelectorAll('.jing-yest-match, .parallel-match, .three-day-jing-die').forEach(function(el) {
                    el.classList.remove('jing-yest-match', 'parallel-match', 'three-day-jing-die');
                });
            }
            const content2 = document.getElementById(p + 'Content2');
            if (content2) {
                content2.querySelectorAll('.jing-yest-match, .parallel-match, .three-day-jing-die').forEach(function(el) {
                    el.classList.remove('jing-yest-match', 'parallel-match', 'three-day-jing-die');
                });
            }
        }

        // 根据当前开关状态，给内容容器加上/移除 jing-yest-enabled / parallel-enabled 类。
        // 左侧标记的显示完全受容器类控制，这样即使行级 class 因缓存/重绘未清掉，
        // 关闭开关后标记也会立即消失，不受 Vue memo 重渲染时机影响。
        export function _updateAuctionHighlightContainerState(dataSource) {
            const p = dataSource === 'hot' ? 'hot' : 'auction';
            const content = document.getElementById(p + 'Content');
            const content2 = document.getElementById(p + 'Content2');
            const enabled = function(el) { return !!(el && el.checked); };
            if (content) {
                content.classList.toggle('jing-yest-enabled', enabled(document.getElementById(p + 'SortByJingYestToggle')) || enabled(document.getElementById(p + 'SortByJingYestRatioToggle')));
                content.classList.toggle('parallel-enabled', enabled(document.getElementById(p + 'SortByParallelToggle')));
                content.classList.toggle('three-day-jing-die-enabled', enabled(document.getElementById(p + 'SortByThreeDayJingDieToggle')));
            }
            if (content2) {
                content2.classList.toggle('jing-yest-enabled', enabled(document.getElementById(p + 'SortByJingYestToggle2')) || enabled(document.getElementById(p + 'SortByJingYestRatioToggle2')));
                content2.classList.toggle('parallel-enabled', enabled(document.getElementById(p + 'SortByParallelToggle2')));
                content2.classList.toggle('three-day-jing-die-enabled', enabled(document.getElementById(p + 'SortByThreeDayJingDieToggle2')));
            }
        }

        // toggle 轻量刷新：只同步 store 开关状态和容器高亮类，让 Vue 响应式去重算，
        // 避免每次切换 toggle 都走完整的 renderAuction（buildTopicCache / ensureObservationStocks 等）造成卡顿。
        export function _refreshAuctionOnToggle(dataSource) {
            window._syncSortStateToStore(dataSource, 1);
            window._syncSortStateToStore(dataSource, 2);
            window._updateAuctionHighlightContainerState(dataSource);
            // [BUG-FIX] 之前只同步 store 状态 + 容器高亮类，从不重渲染行，
            // 导致“竞/昨/平行/环比”开关打开后，行级 jing-yest-match / parallel-match
            // class 与组内排序都不生效（Vue 未挂载，无响应式重算，仅靠本函数时
            // 界面毫无变化）。现补上真正的行重渲染（innerHTML 路径是当前激活路径）。
            if (typeof window.renderAuction === 'function') window.renderAuction(dataSource);
            // [TOGGLE-PERSIST] 开关变化后持久化，刷新后可恢复
            if (typeof window._persistSortToggles === 'function') window._persistSortToggles();
        }

        export function _refreshAuctionPage2OnToggle(dataSource) {
            window._syncSortStateToStore(dataSource, 2);
            window._updateAuctionHighlightContainerState(dataSource);
            // [BUG-FIX] 同上：补上行重渲染，使竞/昨/平行/环比的排序与高亮真正生效。
            if (typeof window.renderAuctionPage2 === 'function') window.renderAuctionPage2(dataSource);
            // [TOGGLE-PERSIST] 开关变化后持久化，刷新后可恢复
            if (typeof window._persistSortToggles === 'function') window._persistSortToggles();
        }

        export function onAuctionSortByJingYestToggle2Change() {
            window.resetAuctionExpansionOnToggle('auction', true);
            const jingYestChecked = document.getElementById('auctionSortByJingYestToggle2').checked;
            const parallelToggle2 = document.getElementById('auctionSortByParallelToggle2');
            if (jingYestChecked) {
                // 打开"竞/昨" → 联动打开"平行"，并保持与"环比"、"竞/昨占比"互斥
                const ratioToggle2 = document.getElementById('auctionSortByRatioToggle2');
                const jingYestRatioToggle2 = document.getElementById('auctionSortByJingYestRatioToggle2');
                if (ratioToggle2) ratioToggle2.checked = false;
                if (jingYestRatioToggle2) jingYestRatioToggle2.checked = false;
                const threeDayJingDieToggle2 = document.getElementById('auctionSortByThreeDayJingDieToggle2');
                if (threeDayJingDieToggle2) threeDayJingDieToggle2.checked = false;
                if (parallelToggle2) parallelToggle2.checked = true;
            } else {
                // 关闭"竞/昨" → 联动关闭"平行"
                if (parallelToggle2) parallelToggle2.checked = false;
                window._clearAuctionRowHighlights('auction');
            }
            window._refreshAuctionPage2OnToggle('auction');
        }

        // 第二页"竞/昨占比"开关变化时的处理：独立排序模式
        export function onAuctionSortByJingYestRatioToggle2Change() {
            window.resetAuctionExpansionOnToggle('auction', true);
            const jingYestRatioChecked = document.getElementById('auctionSortByJingYestRatioToggle2').checked;
            if (jingYestRatioChecked) {
                const ratioToggle2 = document.getElementById('auctionSortByRatioToggle2');
                const parallelToggle2 = document.getElementById('auctionSortByParallelToggle2');
                const jingYestToggle2 = document.getElementById('auctionSortByJingYestToggle2');
                if (ratioToggle2) ratioToggle2.checked = false;
                if (parallelToggle2) parallelToggle2.checked = false;
                if (jingYestToggle2) jingYestToggle2.checked = false;
                const threeDayJingDieToggle2 = document.getElementById('auctionSortByThreeDayJingDieToggle2');
                if (threeDayJingDieToggle2) threeDayJingDieToggle2.checked = false;
            } else {
                window._clearAuctionRowHighlights('auction');
            }
            window._refreshAuctionPage2OnToggle('auction');
        }

        // "全部展开"开关变化时的处理
        export function onAuctionExpandAllToggleChange() {
            const checked = document.getElementById('auctionExpandAllToggle').checked;
            if (typeof window.auctionStore !== 'undefined' && window.auctionStore && window.auctionStore.actions) {
                window.auctionStore.actions.setExpandAll(checked, 1);
            }
            if (checked) {
                window.expandAllAuctionTrendPanels('auction');
            } else {
                window.collapseAllAuctionTrendPanels('auction');
                // 关闭"全部展开"时，若"按数据排序"仍开启，保持排序但不强制展开
            }
        }

        // "按数据排序"开关变化时的处理
        export function onAuctionSortByDataToggleChange() {
            window.resetAuctionExpansionOnToggle('auction', false);
            const sortChecked = document.getElementById('auctionSortByDataToggle').checked;
            if (sortChecked) {
                // 与"环比"、"平行"互斥，打开这个就关闭另外两个
                const ratioToggle = document.getElementById('auctionSortByRatioToggle');
                const parallelToggle = document.getElementById('auctionSortByParallelToggle');
                if (ratioToggle) ratioToggle.checked = false;
                if (parallelToggle) parallelToggle.checked = false;
                // "竞/昨"是"平行"的加强条件，平行关闭时竞/昨必须一并关闭
                const jingYestToggle = document.getElementById('auctionSortByJingYestToggle');
                if (jingYestToggle) jingYestToggle.checked = false;
                const jingYestRatioToggle = document.getElementById('auctionSortByJingYestRatioToggle');
                if (jingYestRatioToggle) jingYestRatioToggle.checked = false;
                const threeDayJingDieToggle = document.getElementById('auctionSortByThreeDayJingDieToggle');
                if (threeDayJingDieToggle) threeDayJingDieToggle.checked = false;
            }
            // 重新渲染以应用新的排序顺序（renderAuction 内部会读取开关的最新状态）
            window._refreshAuctionOnToggle('auction');
        }

        // "环比"开关变化时的处理（今日竞价量 / 昨日竞价量，从高到低）
        export function onAuctionSortByRatioToggleChange() {
            window.resetAuctionExpansionOnToggle('auction', false);
            const ratioChecked = document.getElementById('auctionSortByRatioToggle').checked;
            if (ratioChecked) {
                // 与"数据"、"平行"、"竞/昨"互斥，打开这个就关闭其余三个（"竞/昨"是"平行"的加强条件，必须一并关闭）
                const sortToggle = document.getElementById('auctionSortByDataToggle');
                const parallelToggle = document.getElementById('auctionSortByParallelToggle');
                const jingYestToggle = document.getElementById('auctionSortByJingYestToggle');
                const jingYestRatioToggle = document.getElementById('auctionSortByJingYestRatioToggle');
                if (sortToggle) sortToggle.checked = false;
                if (parallelToggle) parallelToggle.checked = false;
                if (jingYestToggle) jingYestToggle.checked = false;
                if (jingYestRatioToggle) jingYestRatioToggle.checked = false;
                const threeDayJingDieToggle = document.getElementById('auctionSortByThreeDayJingDieToggle');
                if (threeDayJingDieToggle) threeDayJingDieToggle.checked = false;
                // 注意：不联动打开"全部展开"，需用户手动开启
            }
            window._refreshAuctionOnToggle('auction');
        }

        // "平行"开关变化时的处理：今日竞价量>T-1竞价量 且 T-1成交量>T-2成交量 的股票排最前面
        export function onAuctionSortByParallelToggleChange() {
            window.resetAuctionExpansionOnToggle('auction', false);
            const parallelChecked = document.getElementById('auctionSortByParallelToggle').checked;
            if (parallelChecked) {
                // 与"数据"、"环比"互斥，打开这个就关闭另外两个
                const sortToggle = document.getElementById('auctionSortByDataToggle');
                const ratioToggle = document.getElementById('auctionSortByRatioToggle');
                if (sortToggle) sortToggle.checked = false;
                if (ratioToggle) ratioToggle.checked = false;
                const threeDayJingDieToggle = document.getElementById('auctionSortByThreeDayJingDieToggle');
                if (threeDayJingDieToggle) threeDayJingDieToggle.checked = false;
                // 注意：不再联动打开"全部展开"，需用户手动开启（与第二页保持一致）
            } else {
                // 关闭"平行"时，"竞/昨"是平行的子条件，必须一并关闭，否则条件失去依据
                const jingYestToggle = document.getElementById('auctionSortByJingYestToggle');
                if (jingYestToggle) jingYestToggle.checked = false;
                const jingYestRatioToggle = document.getElementById('auctionSortByJingYestRatioToggle');
                if (jingYestRatioToggle) jingYestRatioToggle.checked = false;
            }
            window._refreshAuctionOnToggle('auction');
        }

        // "竞/昨"开关变化时的处理：在"平行"达标的基础上，进一步要求 今/昨比 > 昨/前比
        // 单向联动："竞/昨"打开会联动打开"平行"；关闭会联动关闭"平行"。
        // 反之，单独操作"平行"不会影响"竞/昨"的勾选状态（由 onAuctionSortByParallelToggleChange 里的关闭分支保证依赖关系）
        export function onAuctionSortByJingYestToggleChange() {
            window.resetAuctionExpansionOnToggle('auction', false);
            const jingYestChecked = document.getElementById('auctionSortByJingYestToggle').checked;
            const parallelToggle = document.getElementById('auctionSortByParallelToggle');
            if (jingYestChecked) {
                // 打开"竞/昨" → 联动打开"平行"，并保持与"数据"、"环比"、"竞/昨占比"互斥
                const sortToggle = document.getElementById('auctionSortByDataToggle');
                const ratioToggle = document.getElementById('auctionSortByRatioToggle');
                const jingYestRatioToggle = document.getElementById('auctionSortByJingYestRatioToggle');
                if (sortToggle) sortToggle.checked = false;
                if (ratioToggle) ratioToggle.checked = false;
                if (jingYestRatioToggle) jingYestRatioToggle.checked = false;
                const threeDayJingDieToggle = document.getElementById('auctionSortByThreeDayJingDieToggle');
                if (threeDayJingDieToggle) threeDayJingDieToggle.checked = false;
                if (parallelToggle) parallelToggle.checked = true;
            } else {
                // 关闭"竞/昨" → 联动关闭"平行"
                if (parallelToggle) parallelToggle.checked = false;
                window._clearAuctionRowHighlights('auction');
            }
            window._refreshAuctionOnToggle('auction');
        }

        // "竞/昨占比"开关变化时的处理：独立排序模式，与所有其它开关互斥
        // 打开时关闭所有其它开关（数据/环比/平行/竞昨），仅按竞昨达标条件筛选+占比排序
        // 关闭时恢复默认。不影响其它开关的正常功能。
        export function onAuctionSortByJingYestRatioToggleChange() {
            window.resetAuctionExpansionOnToggle('auction', false);
            const jingYestRatioChecked = document.getElementById('auctionSortByJingYestRatioToggle').checked;
            if (jingYestRatioChecked) {
                // 打开"竞/昨占比" → 关闭所有其它排序开关（独立模式）
                const sortToggle = document.getElementById('auctionSortByDataToggle');
                const ratioToggle = document.getElementById('auctionSortByRatioToggle');
                const parallelToggle = document.getElementById('auctionSortByParallelToggle');
                const jingYestToggle = document.getElementById('auctionSortByJingYestToggle');
                if (sortToggle) sortToggle.checked = false;
                if (ratioToggle) ratioToggle.checked = false;
                if (parallelToggle) parallelToggle.checked = false;
                if (jingYestToggle) jingYestToggle.checked = false;
                const threeDayJingDieToggle = document.getElementById('auctionSortByThreeDayJingDieToggle');
                if (threeDayJingDieToggle) threeDayJingDieToggle.checked = false;
            } else {
                window._clearAuctionRowHighlights('auction');
            }
            window._refreshAuctionOnToggle('auction');
        }

        // "三天竞跌"开关变化时的处理（竞价股票）：独立排序模式
        export function onAuctionSortByThreeDayJingDieToggleChange() {
            window.resetAuctionExpansionOnToggle('auction', false);
            const checked = document.getElementById('auctionSortByThreeDayJingDieToggle').checked;
            if (checked) {
                const sortToggle = document.getElementById('auctionSortByDataToggle');
                const ratioToggle = document.getElementById('auctionSortByRatioToggle');
                const parallelToggle = document.getElementById('auctionSortByParallelToggle');
                const jingYestToggle = document.getElementById('auctionSortByJingYestToggle');
                const jingYestRatioToggle = document.getElementById('auctionSortByJingYestRatioToggle');
                if (sortToggle) sortToggle.checked = false;
                if (ratioToggle) ratioToggle.checked = false;
                if (parallelToggle) parallelToggle.checked = false;
                if (jingYestToggle) jingYestToggle.checked = false;
                if (jingYestRatioToggle) jingYestRatioToggle.checked = false;
            } else {
                window._clearAuctionRowHighlights('auction');
            }
            window._refreshAuctionOnToggle('auction');
        }

        // 第二页"三天竞跌"开关变化时的处理（竞价股票）：独立排序模式
        export function onAuctionSortByThreeDayJingDieToggle2Change() {
            window.resetAuctionExpansionOnToggle('auction', true);
            const checked = document.getElementById('auctionSortByThreeDayJingDieToggle2').checked;
            if (checked) {
                const ratioToggle2 = document.getElementById('auctionSortByRatioToggle2');
                const parallelToggle2 = document.getElementById('auctionSortByParallelToggle2');
                const jingYestToggle2 = document.getElementById('auctionSortByJingYestToggle2');
                const jingYestRatioToggle2 = document.getElementById('auctionSortByJingYestRatioToggle2');
                if (ratioToggle2) ratioToggle2.checked = false;
                if (parallelToggle2) parallelToggle2.checked = false;
                if (jingYestToggle2) jingYestToggle2.checked = false;
                if (jingYestRatioToggle2) jingYestRatioToggle2.checked = false;
            } else {
                window._clearAuctionRowHighlights('auction');
            }
            window._refreshAuctionPage2OnToggle('auction');
        }


        // ===== 热门股票侧排序开关事件处理函数 =====
        // "全部展开"开关变化时的处理（热门股票）
        export function onHotExpandAllToggleChange() {
            const checked = document.getElementById('hotExpandAllToggle').checked;
            if (typeof window.auctionStore !== 'undefined' && window.auctionStore && window.auctionStore.actions) {
                window.auctionStore.actions.setExpandAll(checked, 1);
            }
            if (checked) {
                window.expandAllAuctionTrendPanels('hot');
            } else {
                window.collapseAllAuctionTrendPanels('hot');
            }
        }

        // "按数据排序"开关变化时的处理（热门股票）
        export function onHotSortByDataToggleChange() {
            window.resetAuctionExpansionOnToggle('hot', false);
            const sortChecked = document.getElementById('hotSortByDataToggle').checked;
            if (sortChecked) {
                const ratioToggle = document.getElementById('hotSortByRatioToggle');
                const parallelToggle = document.getElementById('hotSortByParallelToggle');
                if (ratioToggle) ratioToggle.checked = false;
                if (parallelToggle) parallelToggle.checked = false;
                // "竞/昨"是"平行"的加强条件，平行关闭时竞/昨必须一并关闭
                const jingYestToggle = document.getElementById('hotSortByJingYestToggle');
                if (jingYestToggle) jingYestToggle.checked = false;
                const jingYestRatioToggle = document.getElementById('hotSortByJingYestRatioToggle');
                if (jingYestRatioToggle) jingYestRatioToggle.checked = false;
                const threeDayJingDieToggle = document.getElementById('hotSortByThreeDayJingDieToggle');
                if (threeDayJingDieToggle) threeDayJingDieToggle.checked = false;
            }
            window._refreshAuctionOnToggle('hot');
        }

        // "环比"开关变化时的处理（热门股票）
        export function onHotSortByRatioToggleChange() {
            window.resetAuctionExpansionOnToggle('hot', false);
            const ratioChecked = document.getElementById('hotSortByRatioToggle').checked;
            if (ratioChecked) {
                const sortToggle = document.getElementById('hotSortByDataToggle');
                const parallelToggle = document.getElementById('hotSortByParallelToggle');
                const jingYestToggle = document.getElementById('hotSortByJingYestToggle');
                const jingYestRatioToggle = document.getElementById('hotSortByJingYestRatioToggle');
                if (sortToggle) sortToggle.checked = false;
                if (parallelToggle) parallelToggle.checked = false;
                if (jingYestToggle) jingYestToggle.checked = false;
                if (jingYestRatioToggle) jingYestRatioToggle.checked = false;
                const threeDayJingDieToggle = document.getElementById('hotSortByThreeDayJingDieToggle');
                if (threeDayJingDieToggle) threeDayJingDieToggle.checked = false;
            }
            window._refreshAuctionOnToggle('hot');
        }

        // "平行"开关变化时的处理（热门股票）
        export function onHotSortByParallelToggleChange() {
            window.resetAuctionExpansionOnToggle('hot', false);
            const parallelChecked = document.getElementById('hotSortByParallelToggle').checked;
            if (parallelChecked) {
                const sortToggle = document.getElementById('hotSortByDataToggle');
                const ratioToggle = document.getElementById('hotSortByRatioToggle');
                if (sortToggle) sortToggle.checked = false;
                if (ratioToggle) ratioToggle.checked = false;
                const threeDayJingDieToggle = document.getElementById('hotSortByThreeDayJingDieToggle');
                if (threeDayJingDieToggle) threeDayJingDieToggle.checked = false;
            } else {
                const jingYestToggle = document.getElementById('hotSortByJingYestToggle');
                if (jingYestToggle) jingYestToggle.checked = false;
                const jingYestRatioToggle = document.getElementById('hotSortByJingYestRatioToggle');
                if (jingYestRatioToggle) jingYestRatioToggle.checked = false;
            }
            window._refreshAuctionOnToggle('hot');
        }

        // "竞/昨"开关变化时的处理（热门股票）
        export function onHotSortByJingYestToggleChange() {
            window.resetAuctionExpansionOnToggle('hot', false);
            const jingYestChecked = document.getElementById('hotSortByJingYestToggle').checked;
            const parallelToggle = document.getElementById('hotSortByParallelToggle');
            if (jingYestChecked) {
                const sortToggle = document.getElementById('hotSortByDataToggle');
                const ratioToggle = document.getElementById('hotSortByRatioToggle');
                const jingYestRatioToggle = document.getElementById('hotSortByJingYestRatioToggle');
                if (sortToggle) sortToggle.checked = false;
                if (ratioToggle) ratioToggle.checked = false;
                if (jingYestRatioToggle) jingYestRatioToggle.checked = false;
                const threeDayJingDieToggle = document.getElementById('hotSortByThreeDayJingDieToggle');
                if (threeDayJingDieToggle) threeDayJingDieToggle.checked = false;
                if (parallelToggle) parallelToggle.checked = true;
            } else {
                if (parallelToggle) parallelToggle.checked = false;
                window._clearAuctionRowHighlights('hot');
            }
            window._refreshAuctionOnToggle('hot');
        }

        // "竞/昨占比"开关变化时的处理（热门股票）：独立排序模式
        export function onHotSortByJingYestRatioToggleChange() {
            window.resetAuctionExpansionOnToggle('hot', false);
            const jingYestRatioChecked = document.getElementById('hotSortByJingYestRatioToggle').checked;
            if (jingYestRatioChecked) {
                const sortToggle = document.getElementById('hotSortByDataToggle');
                const ratioToggle = document.getElementById('hotSortByRatioToggle');
                const parallelToggle = document.getElementById('hotSortByParallelToggle');
                const jingYestToggle = document.getElementById('hotSortByJingYestToggle');
                if (sortToggle) sortToggle.checked = false;
                if (ratioToggle) ratioToggle.checked = false;
                if (parallelToggle) parallelToggle.checked = false;
                if (jingYestToggle) jingYestToggle.checked = false;
                const threeDayJingDieToggle = document.getElementById('hotSortByThreeDayJingDieToggle');
                if (threeDayJingDieToggle) threeDayJingDieToggle.checked = false;
            } else {
                window._clearAuctionRowHighlights('hot');
            }
            window._refreshAuctionOnToggle('hot');
        }

        // 第二页"全部展开"开关变化时的处理（热门股票）
        export function onHotExpandAllToggle2Change() {
            const checked = document.getElementById('hotExpandAllToggle2').checked;
            if (typeof window.auctionStore !== 'undefined' && window.auctionStore && window.auctionStore.actions) {
                window.auctionStore.actions.setExpandAll(checked, 2);
            }
            if (checked) {
                window.expandAllAuctionTrendPanelsP2('hot');
            } else {
                window.collapseAllAuctionTrendPanelsP2('hot');
            }
        }

        // 第二页"环比"开关变化时的处理（热门股票）
        export function onHotSortByRatioToggle2Change() {
            window.resetAuctionExpansionOnToggle('hot', true);
            const ratioChecked = document.getElementById('hotSortByRatioToggle2').checked;
            if (ratioChecked) {
                const parallelToggle2 = document.getElementById('hotSortByParallelToggle2');
                const jingYestToggle2 = document.getElementById('hotSortByJingYestToggle2');
                const jingYestRatioToggle2 = document.getElementById('hotSortByJingYestRatioToggle2');
                if (parallelToggle2) parallelToggle2.checked = false;
                if (jingYestToggle2) jingYestToggle2.checked = false;
                if (jingYestRatioToggle2) jingYestRatioToggle2.checked = false;
                const threeDayJingDieToggle2 = document.getElementById('hotSortByThreeDayJingDieToggle2');
                if (threeDayJingDieToggle2) threeDayJingDieToggle2.checked = false;
            }
            window._refreshAuctionPage2OnToggle('hot');
        }

        // 第二页"平行"开关变化时的处理（热门股票）
        export function onHotSortByParallelToggle2Change() {
            window.resetAuctionExpansionOnToggle('hot', true);
            const parallelChecked = document.getElementById('hotSortByParallelToggle2').checked;
            if (parallelChecked) {
                const ratioToggle2 = document.getElementById('hotSortByRatioToggle2');
                if (ratioToggle2) ratioToggle2.checked = false;
                const threeDayJingDieToggle2 = document.getElementById('hotSortByThreeDayJingDieToggle2');
                if (threeDayJingDieToggle2) threeDayJingDieToggle2.checked = false;
            } else {
                const jingYestToggle2 = document.getElementById('hotSortByJingYestToggle2');
                if (jingYestToggle2) jingYestToggle2.checked = false;
                const jingYestRatioToggle2 = document.getElementById('hotSortByJingYestRatioToggle2');
                if (jingYestRatioToggle2) jingYestRatioToggle2.checked = false;
            }
            window._refreshAuctionPage2OnToggle('hot');
        }

        // 第二页"竞/昨"开关变化时的处理（热门股票）
        export function onHotSortByJingYestToggle2Change() {
            window.resetAuctionExpansionOnToggle('hot', true);
            const jingYestChecked = document.getElementById('hotSortByJingYestToggle2').checked;
            const parallelToggle2 = document.getElementById('hotSortByParallelToggle2');
            if (jingYestChecked) {
                const ratioToggle2 = document.getElementById('hotSortByRatioToggle2');
                const jingYestRatioToggle2 = document.getElementById('hotSortByJingYestRatioToggle2');
                if (ratioToggle2) ratioToggle2.checked = false;
                if (jingYestRatioToggle2) jingYestRatioToggle2.checked = false;
                const threeDayJingDieToggle2 = document.getElementById('hotSortByThreeDayJingDieToggle2');
                if (threeDayJingDieToggle2) threeDayJingDieToggle2.checked = false;
                if (parallelToggle2) parallelToggle2.checked = true;
            } else {
                if (parallelToggle2) parallelToggle2.checked = false;
                window._clearAuctionRowHighlights('hot');
            }
            window._refreshAuctionPage2OnToggle('hot');
        }

        // 第二页"竞/昨占比"开关变化时的处理（热门股票）：独立排序模式
        export function onHotSortByJingYestRatioToggle2Change() {
            window.resetAuctionExpansionOnToggle('hot', true);
            const jingYestRatioChecked = document.getElementById('hotSortByJingYestRatioToggle2').checked;
            if (jingYestRatioChecked) {
                const ratioToggle2 = document.getElementById('hotSortByRatioToggle2');
                const parallelToggle2 = document.getElementById('hotSortByParallelToggle2');
                const jingYestToggle2 = document.getElementById('hotSortByJingYestToggle2');
                if (ratioToggle2) ratioToggle2.checked = false;
                if (parallelToggle2) parallelToggle2.checked = false;
                if (jingYestToggle2) jingYestToggle2.checked = false;
                const threeDayJingDieToggle2 = document.getElementById('hotSortByThreeDayJingDieToggle2');
                if (threeDayJingDieToggle2) threeDayJingDieToggle2.checked = false;
            } else {
                window._clearAuctionRowHighlights('hot');
            }
            window._refreshAuctionPage2OnToggle('hot');
        }

        // "三天竞跌"开关变化时的处理（热门股票）：独立排序模式
        export function onHotSortByThreeDayJingDieToggleChange() {
            window.resetAuctionExpansionOnToggle('hot', false);
            const checked = document.getElementById('hotSortByThreeDayJingDieToggle').checked;
            if (checked) {
                const sortToggle = document.getElementById('hotSortByDataToggle');
                const ratioToggle = document.getElementById('hotSortByRatioToggle');
                const parallelToggle = document.getElementById('hotSortByParallelToggle');
                const jingYestToggle = document.getElementById('hotSortByJingYestToggle');
                const jingYestRatioToggle = document.getElementById('hotSortByJingYestRatioToggle');
                if (sortToggle) sortToggle.checked = false;
                if (ratioToggle) ratioToggle.checked = false;
                if (parallelToggle) parallelToggle.checked = false;
                if (jingYestToggle) jingYestToggle.checked = false;
                if (jingYestRatioToggle) jingYestRatioToggle.checked = false;
            } else {
                window._clearAuctionRowHighlights('hot');
            }
            window._refreshAuctionOnToggle('hot');
        }

        // 第二页"三天竞跌"开关变化时的处理（热门股票）：独立排序模式
        export function onHotSortByThreeDayJingDieToggle2Change() {
            window.resetAuctionExpansionOnToggle('hot', true);
            const checked = document.getElementById('hotSortByThreeDayJingDieToggle2').checked;
            if (checked) {
                const ratioToggle2 = document.getElementById('hotSortByRatioToggle2');
                const parallelToggle2 = document.getElementById('hotSortByParallelToggle2');
                const jingYestToggle2 = document.getElementById('hotSortByJingYestToggle2');
                const jingYestRatioToggle2 = document.getElementById('hotSortByJingYestRatioToggle2');
                if (ratioToggle2) ratioToggle2.checked = false;
                if (parallelToggle2) parallelToggle2.checked = false;
                if (jingYestToggle2) jingYestToggle2.checked = false;
                if (jingYestRatioToggle2) jingYestRatioToggle2.checked = false;
            } else {
                window._clearAuctionRowHighlights('hot');
            }
            window._refreshAuctionPage2OnToggle('hot');
        }

        // 排序规则说明浮层的固定文案（环比/平行/竞昨三个开关各自的判定与排序逻辑）
        const AUCTION_SORT_HELP_HTML = `
            <p style="color:#64748b;">位数差 = |今日竞价量位数 − 今日昨日成交量位数|（数字按十进制位数计算，如102是3位）。位数差越小，两者量级越接近。</p>
            <h4><span class="help-tag tag-ratio">环比</span></h4>
            <p>① 达标：今/昨比(今日竞价量÷昨日竞价量)≥1.5，组内按位数差从小到大排，位数差相同按比值从高到低排。</p>
            <p>② 不达标但比值可算：同样按位数差→比值排，排在①之后。</p>
            <p>③ 比值无法计算（断点/无数据）：保持原顺序，垫底。</p>
            <h4><span class="help-tag tag-parallel">平行</span></h4>
            <p>达标条件：今日竞价量＞T-1日竞价量，且 T-1日成交量＞T-2日成交量。</p>
            <p>① 达标：按位数差从小到大排，位数差相同按差值(今/昨比－昨/前比)从高到低排。</p>
            <p>② 不达标但差值可算：同样按位数差→差值排，排在①之后。</p>
            <p>③ 差值无法计算：保持原顺序，垫底。</p>
            <h4><span class="help-tag tag-jingyest">竞/昨</span></h4>
            <p>在"平行"达标基础上，进一步要求差值(今/昨比－昨/前比)＞0，开启时联动打开"平行"。</p>
            <p>① 竞/昨达标：按位数差从小到大排，位数差相同按差值从高到低排。</p>
            <p>② 仅平行达标（竞/昨未达标）：同样按位数差→差值排，排在①之后（差值不要求＞0）。</p>
            <p>③ 平行也不达标：保持原顺序，垫底。</p>
            <h4><span class="help-tag tag-jingyest">竞/昨占比</span></h4>
            <p>与"竞/昨"同一筛选条件（平行+差值＞0），但按"占比"(今/昨比)从高到低排，占比相同再按差值排。</p>
            <p>开启时联动打开"竞/昨"+"平行"，与"竞/昨"互斥（排序方式不同）。</p>
        `;

        // 展开/收起排序规则说明浮层。panelId 为对应页面（第一页/第二页）的浮层元素 id
        // 点击图标时：若面板已打开则关闭；若关闭则先关闭其它已打开的说明面板，再打开当前这个
        export function toggleAuctionSortHelp(panelId) {
            const panel = document.getElementById(panelId);
            if (!panel) return;
            const isOpen = panel.classList.contains('show');
            // 先关闭所有说明面板（保证同一时间只有一个打开）
            document.querySelectorAll('.auction-sort-help-panel.show').forEach(p => p.classList.remove('show'));
            if (!isOpen) {
                panel.innerHTML = AUCTION_SORT_HELP_HTML;
                panel.classList.add('show');
            }
        }

        // 点击页面任意其它位置时，关闭所有已打开的排序规则说明浮层
        document.addEventListener('click', function() {
            document.querySelectorAll('.auction-sort-help-panel.show').forEach(p => p.classList.remove('show'));
        });

        // 展开/收起某只股票的5日竞价量+昨日成交量趋势图
        // 注意：index 来自渲染时绑定的 data-index，但 Realtime 刷新（抓取程序写入后 800ms 防抖重渲染）
        // 可能在"渲染完成"与"用户实际点击"之间悄悄重建整个列表 DOM（innerHTML 整体替换）。
        // 一旦发生：旧的 index 可能已经对不上当前数组里的同一只股票，或者对应的面板节点已被替换。
        // 因此这里优先按点击当下 DOM 里真实显示的股票名称来定位，而不是完全信任传入的 index，
        // 从而避免出现"点了没反应"的现象。
        export function toggleAuctionTrendPanel(index) {
            const _fnStartTs = performance.now();
            const _tp = window.currentGroup === 'hot' ? 'hot' : 'auction';
            let panel = document.getElementById(_tp + 'TrendPanel-' + index);
            window._dbgLogVerbose('[TOGGLE] window.toggleAuctionTrendPanel 开始 index=' + index + ' window.currentGroup=' + window.currentGroup + ' | 初始panel是否找到=' + !!panel);

            // 优先从当前点击所在行的 DOM 结构中读取真实股票名，而不是直接信任 index
            // （index 是渲染那一刻的位置，若渲染与点击之间发生了数据刷新重渲染，两者可能已经错位）
            let stockKey = null;
            // 限定到当前 tab 的 content 容器内查找，避免早盘竞价和热门股票两个 tab 的 DOM 同时存在时
            // querySelector 返回错误 tab 的元素（auctionPage1 在 DOM 中排在 hotPage1 前面）
            const _contentEl = document.getElementById(_tp + 'Content');
            const rowEl = _contentEl ? _contentEl.querySelector('.auction-item[data-index="' + index + '"]') : null;
            // 优先从 data-stock 属性读取干净股票名（避免 textContent 包含 *、观、⚠️ 等后缀标记导致查找失败）
            if (rowEl && rowEl.dataset.stock) {
                stockKey = rowEl.dataset.stock.trim();
            } else {
                const nameEl = rowEl ? rowEl.querySelector('.auction-stock-name') : null;
                if (nameEl) {
                    const nameText = nameEl.textContent.trim();
                    if (nameText && nameText !== '-') stockKey = nameText;
                }
            }

            const auctionList = window.getTodayGroupList(window.currentGroup);
            // 如果按 DOM 读到了股票名，用名称重新定位它在当前数组中的真实下标（数据可能已刷新，index 未必仍然有效）
            let resolvedIndex = index;
            if (stockKey) {
                const freshIdx = auctionList.findIndex(it => it && it.stock && it.stock.trim() === stockKey);
                if (freshIdx >= 0) resolvedIndex = freshIdx;
            } else {
                const item = auctionList[index];
                stockKey = item && item.stock ? item.stock.trim() : null;
            }

            // 面板节点可能因为期间的重渲染已经不是原来那个了，按最终确定的下标重新获取一次
            panel = document.getElementById(_tp + 'TrendPanel-' + resolvedIndex) || panel;
            if (!panel) {
                window._dbgLogVerbose('[TOGGLE] 最终未找到panel节点 index=' + index + ' resolvedIndex=' + resolvedIndex + ' stockKey=' + stockKey);
                return;
            }

            const isOpen = panel.style.display !== 'none' && panel.innerHTML !== '';
            window._dbgLogVerbose('[TOGGLE] index=' + index + '→resolvedIndex=' + resolvedIndex + ' stockKey=' + stockKey + ' isOpen=' + isOpen);
            const _expSet = window._getExpandedStocksSet(_tp);
            if (isOpen) {
                panel.style.display = 'none';
                panel.innerHTML = '';
                if (stockKey) _expSet.delete(stockKey);
                window._syncExpandedStocksToStore(_tp);
                window._dbgLogVerbose('[TOGGLE] 收起 股票=' + stockKey + ' setSize=' + _expSet.size);
                return;
            }

            if (stockKey) {
                // 容量保护：手动点开的面板超过上限时，淘汰最早展开的那个（Set 按插入顺序迭代，第一个即最早）。
                // 原因：展开状态Set 只增不减（除非用户手动收起），早盘期间点得越多，
                // 每次后台数据刷新触发 restoreExpandedAuctionTrendPanels() 时要重新计算+重绘的面板就越多，
                // 是造成长时间使用后越来越卡的主因之一。这里限制同时"记忆"展开的股票数，
                // 不影响用户当前能展开的数量（仍可以点开任意多个，只是最早点的会在超限时被自动收起）。
                const _MAX_REMEMBERED_EXPANDED = 8;
                if (!_expSet.has(stockKey) && _expSet.size >= _MAX_REMEMBERED_EXPANDED) {
                    const _oldest = _expSet.values().next().value;
                    if (_oldest !== undefined) {
                        _expSet.delete(_oldest);
                        const _oldestIdx = auctionList.findIndex(it => it && it.stock && it.stock.trim() === _oldest);
                        if (_oldestIdx >= 0) {
                            const _oldestPanel = document.getElementById(_tp + 'TrendPanel-' + _oldestIdx);
                            if (_oldestPanel) { _oldestPanel.style.display = 'none'; _oldestPanel.innerHTML = ''; }
                        }
                    }
                }
                _expSet.add(stockKey);
            }
            window.expandAuctionTrendPanel(resolvedIndex, _tp);
            window._syncExpandedStocksToStore(_tp);
        }

        // 获取某只股票最近N个交易日（含当天）的竞价量/昨日成交量历史
        // 返回按时间正序排列的数组：[{date, volume, yestVolume}, ...]，没有记录的天 volume/yestVolume 为 null
        // 计算指定日期的"竞放量"股票（今日竞价量/昨日竞价量 >= 1.5）
        // 返回 { count, stockNames: Set }：数量，以及达标股票名称集合（用于行高亮）
        // 昨天断点/无记录/竞价量为0的股票不计入分子分母，也不算达标
