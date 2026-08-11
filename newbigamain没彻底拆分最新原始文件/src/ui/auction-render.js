        export function renderAuctionForm() {
            const auctionList = window.getTodayGroupList(window.currentGroup);
            const formContainer = document.getElementById('auctionFormContainer');

            if (auctionList.length === 0) {
                formContainer.innerHTML = `
                    <div class="auction-form-row" id="auction-row-0">
                        <div class="rank-form-number">1</div>
                        <input type="text" class="form-input auction-form-stock-input" name="auction-stock-0" placeholder="股票名称">
                        <input type="text" class="form-input auction-form-volume-input" name="auction-volume-0" placeholder="竞价量(万股)">
                        <input type="text" class="form-input auction-form-yest-input" name="auction-yest-0" placeholder="昨日成交量(万股)">
                        <button type="button" class="remove-rank-btn" onclick="window.removeAuctionRow(0)">×</button>
                    </div>
                `;
                return;
            }

            let html = '';
            auctionList.forEach((item, index) => {
                html += `
                    <div class="auction-form-row" id="auction-row-${index}">
                        <div class="rank-form-number">${index + 1}</div>
                        <input type="text" class="form-input auction-form-stock-input" name="auction-stock-${index}" value="${item.stock || ''}" placeholder="股票名称">
                        <input type="text" class="form-input auction-form-volume-input" name="auction-volume-${index}" value="${item.volume || ''}" placeholder="竞价量(万股)">
                        <input type="text" class="form-input auction-form-yest-input" name="auction-yest-${index}" value="${item.yestVolume || ''}" placeholder="昨日成交量(万股)">
                        <button type="button" class="remove-rank-btn" onclick="window.removeAuctionRow(${index})">×</button>
                    </div>
                `;
            });

            formContainer.innerHTML = html;
        }

        // 保存早盘竞价数据
        export async function saveAuction(e) {
            e.preventDefault();

            const targetDate = window.auctionStore ? window.auctionStore.currentDate : window.currentDate;
            const sysToday = (typeof window._getLocalTodayStr === 'function') ? window._getLocalTodayStr() : '';
            if (sysToday && targetDate > sysToday) {
                window._dbgLog('[DATE-WARN] window.saveAuction 写入未来日期 targetDate=' + targetDate + ' sysToday=' + sysToday + '，请确认这是预期行为');
            }
            window._dbgLog('[AUCTION-WRITE] window.saveAuction targetDate=' + targetDate + ' group=' + window.currentGroup);

            // 保存前备份（用于撤回）
            window.backupAuctionData('window.save');

            // 预建题材缓存：避免下面循环里对每只无注释的股票单独扫描最近66天历史数据（股票多时会明显卡顿）
            window.buildTopicCache();

            const formContainer = document.getElementById('auctionFormContainer');
            const rows = formContainer.querySelectorAll('.auction-form-row');
            const existingList = window.getTodayGroupList(window.currentGroup);
            const auctionList = [];
            
            rows.forEach((row, index) => {
                const stockInput = row.querySelector(`[name="auction-stock-${index}"]`);
                const volumeInput = row.querySelector(`[name="auction-volume-${index}"]`);
                const yestInput = row.querySelector(`[name="auction-yest-${index}"]`);
                
                const stock = stockInput ? stockInput.value.trim() : '';
                const volume = volumeInput ? volumeInput.value.trim() : '';
                const yestVolume = yestInput ? yestInput.value.trim() : '';
                
                if (stock) {
                    const existingItem = existingList.find(item => item.stock && item.stock.trim() === stock);
                    var note = existingItem ? (existingItem.note || '') : '';
                    var changePct = existingItem ? (existingItem.changePct || '') : '';
                    var topics = existingItem ? (existingItem.topics || '') : '';
                    
                    // 如果没有注释，自动填充历史题材
                    if (!note && !changePct && !topics) {
                        note = window.getStockHistoryTopics(stock);
                        var parsed = window.parseNoteToFields(note);
                        changePct = parsed.changePct;
                        topics = parsed.topics;
                    }
                    
                    auctionList.push({
                        stock,
                        volume,
                        yestVolume,
                        note: note,
                        changePct: changePct,
                        topics: topics,
                        selected: existingItem ? existingItem.selected : false,
                        bought: existingItem ? existingItem.bought : false,
                        sold: existingItem ? existingItem.sold : false,
                        fixed: existingItem ? existingItem.fixed : false
                    });
                }
            });

            auctionList.sort((a, b) => {
                const ratioA = parseFloat(a.volume) / parseFloat(a.yestVolume) || 0;
                const ratioB = parseFloat(b.volume) / parseFloat(b.yestVolume) || 0;
                return ratioB - ratioA;
            });

            // [GHOST-DATA-FIX] 如果保存后正式列表为空，先直接删除云端该日期全部行。
            // 否则 syncAuctionListForDate 看到“本地空/云端 37 条”会触发>60%安全护栏，
            // 一行不删，刷新后数据从云端复活。
            if (window.currentGroup !== 'hot' && auctionList.length === 0) {
                try {
                    await window.deleteAuctionFromCloud(targetDate);
                    window._dbgLog('[AUCTION-WRITE] window.saveAuction 正式列表为空，已删除云端 ' + targetDate + ' 全部行');
                } catch (e) {
                    window._dbgLog('[AUCTION-ERR] window.saveAuction 删除云端失败 ' + targetDate + ' ' + (e && e.message || e));
                }
            }

            // 方案2：保留现有影子记录（不在正式成员索引里的行，供趋势图历史查询），
            // 只替换正式成员。直接整组替换会丢掉影子记录。
            // 阶段六 日期隔离修复：auction 分组通过 guard API 写入，避免误清其它日期。
            const _existingRows = window.getGroupData(window.currentGroup)[targetDate] || [];
            const _existingWset = window._getAuctionWatchlistSet(targetDate);
            const _shadowRows = _existingRows.filter(function(r) { return r && r.stock && !_existingWset.has(r.stock.trim()); });
            const _newAuctionList = auctionList.concat(_shadowRows);
            if (window.currentGroup === 'hot') {
                window.getGroupData(window.currentGroup)[targetDate] = _newAuctionList;
            } else {
                window.setAuctionDateData(targetDate, _newAuctionList, 'window.saveAuction');
                // 方案2：表单保存后，auctionList 即为新的正式列表，整日期替换索引
                window._setAuctionWatchlistForDate(targetDate, auctionList.map(function(r) { return r && r.stock; }));
            }

            // 早盘竞价：原有逻辑
            window.saveData();
            window.invalidateTopicCache();
            window.renderAuction();

            // 同步更新股票列表中的题材，统一保存
            window.syncStockTopicsFromAuction();
            window.saveModule('stocks');
            window.renderList();

            // 涨跌幅数据可能已变化，重新统计"最近多板"的总数量和跌涨比
            window.recalcDuibanFromAuction();

            const board = document.getElementById('auctionBoard');
            if (board) {
                board.classList.remove('collapsed');
            }

            // 标记当前日期为脏，触发 syncAuctionListForDate 全量增删同步
            // （处理股票名称修改：删除云端旧名称行，插入新名称行）
            // 注意：本函数 saveAuction 是早盘竞价表单的保存按钮；热门股票表单的保存按钮调用 saveHotStocks
            window.markAuctionDirty(targetDate);
            window.scheduleCloudPush();

            window.closeAuctionModal();
        }

        // 展开收起早盘竞价看板
        export function toggleAuctionBoard() {
            const board = document.getElementById('auctionBoard');
            const btn = document.getElementById('auctionToggleBtn');
            if (board) {
                board.classList.toggle('collapsed');
                if (btn) {
                    btn.textContent = board.classList.contains('collapsed') ? '▼' : '▲';
                }
            }
        }

        // 切换强度排序
        export function toggleStrengthSort() {
            window.isStrengthSortEnabled = !window.isStrengthSortEnabled;
            if (typeof window.auctionStore !== 'undefined' && window.auctionStore) window.auctionStore.strengthSortEnabled = window.isStrengthSortEnabled; // Vue 化：同步到 store，触发响应式重算
            window.renderAuctionPage2(window.currentGroup);
            window.renderAuctionPage3(window.currentGroup);
            window.renderAuctionStatsBoard(window.currentGroup);
        }

        // 渲染早盘竞价看板
        // 记录上一次渲染早盘竞价看板时的日期，用于判断"是否切换了日期"从而重置展开/排序开关
        let _lastAuctionRenderDate = null;
        // 热门股票分组对应的上次渲染日期（与 _lastAuctionRenderDate 独立，互不影响）
        let _lastHotRenderDate = null;

        export function renderAuction(dataSource='auction') {
            try {
                var _rows = (typeof window.getAuctionData === 'function' && window.getAuctionData()[window.currentDate]) || (window.auctionStore && window.auctionStore.auctionData && window.auctionStore.auctionData[window.currentDate]) || [];
                var _sample = _rows.slice(0,3).map(function(r){return r&&r.stock||'?';}).join(',');
                var _flag = (window.auctionStore && window.currentDate !== window.auctionStore.currentDate) ? ' ⚠️' : '';
                window._dbgLog('[AUCTION-RENDER] window.currentDate=' + window.currentDate + ' window.auctionStore.currentDate=' + (window.auctionStore&&window.auctionStore.currentDate) + ' rows=' + _rows.length + ' sample=' + _sample + _flag);
            } catch(e){}
            // [PERF-DEBUG] 记录 renderAuction 的调用来源和频率，用于确认每次交互
            // 是否都触发了 stocksDataVersion++（进而让四块看板 computed 全部失效）
            window._logRenderAuctionCall((new Error()).stack ? (new Error()).stack.split('\n')[2] || 'unknown' : 'unknown');
            const _p = dataSource === 'hot' ? 'hot' : 'auction';
            // 同步第一页排序开关到 store（Vue 路径读 store；innerHTML 路径仍读 DOM）
            window._syncSortStateToStore(dataSource, 1);
            // 同步开关状态到内容容器，控制左侧标记 CSS 显示/隐藏
            window._updateAuctionHighlightContainerState(dataSource);
            // 日期发生变化时，所有排序/展开开关重置为默认关闭状态（不记忆）；按分组各自记录上次渲染日期
            // 此处提前到路由之前执行，确保 Vue 路径也能在切换日期时重置开关并同步到 store
            const _lastRenderDate = dataSource === 'hot' ? _lastHotRenderDate : _lastAuctionRenderDate;
            if (_lastRenderDate !== null && _lastRenderDate !== window.currentDate) {
                const expandToggle = document.getElementById(_p + 'ExpandAllToggle');
                const sortToggle = document.getElementById(_p + 'SortByDataToggle');
                const ratioToggle = document.getElementById(_p + 'SortByRatioToggle');
                const parallelToggle = document.getElementById(_p + 'SortByParallelToggle');
                const jingYestToggle = document.getElementById(_p + 'SortByJingYestToggle');
                const jingYestRatioToggle = document.getElementById(_p + 'SortByJingYestRatioToggle');
                const expandToggle2 = document.getElementById(_p + 'ExpandAllToggle2');
                const ratioToggle2 = document.getElementById(_p + 'SortByRatioToggle2');
                const parallelToggle2 = document.getElementById(_p + 'SortByParallelToggle2');
                const jingYestToggle2 = document.getElementById(_p + 'SortByJingYestToggle2');
                const jingYestRatioToggle2 = document.getElementById(_p + 'SortByJingYestRatioToggle2');
                if (expandToggle) expandToggle.checked = false;
                if (sortToggle) sortToggle.checked = false;
                if (ratioToggle) ratioToggle.checked = false;
                if (parallelToggle) parallelToggle.checked = false;
                if (jingYestToggle) jingYestToggle.checked = false;
                if (jingYestRatioToggle) jingYestRatioToggle.checked = false;
                if (expandToggle2) expandToggle2.checked = false;
                if (ratioToggle2) ratioToggle2.checked = false;
                if (parallelToggle2) parallelToggle2.checked = false;
                if (jingYestToggle2) jingYestToggle2.checked = false;
                if (jingYestRatioToggle2) jingYestRatioToggle2.checked = false;
                // 重置后重新同步到 store（覆盖开头的旧值）
                window._syncSortStateToStore(dataSource, 1);
                window._syncSortStateToStore(dataSource, 2);
                // [TOGGLE-PERSIST] 切日期重置后持久化全 false，避免刷新恢复旧状态
                if (typeof window._persistSortToggles === 'function') window._persistSortToggles();
            }
            if (dataSource === 'hot') _lastHotRenderDate = window.currentDate; else _lastAuctionRenderDate = window.currentDate;
            // 日期重置后再次同步容器状态，确保切日期后旧标记容器类也被清掉
            window._updateAuctionHighlightContainerState(dataSource);
            // 保存滚动位置，防止 Realtime 等回调触发重新渲染时跳回顶部
            var _savedScrollY = window.scrollY;
            // 确保题材历史缓存可用（内部有幂等保护，重复调用不会重复扫描）
            window.buildTopicCache();
            // 以下两项为早盘竞价专属副作用：观察组继承 / 最近多板统计，热门股票分组不执行
            // [PERF] 延迟到渲染完成后异步执行，避免阻塞 tab 切换的首帧绘制
            if (dataSource === 'auction') {
                const _sideEffectDate = window.currentDate;
                const _runAuctionSideEffects = function() {
                    // 防御：异步回调触发时用户可能已切到其它 tab/日期
                    if (window.currentGroup !== 'auction') return;
                    if (window.currentDate !== _sideEffectDate) return;
                    // 观察组自动继承已移除（用户手动打标替代）
                    // 买/卖/持标签继承已改为独立存储（auctionBoardTags），不再调 ensureBoughtStocksForDate
                    // 每次渲染早盘竞价看板时，顺带重新计算一次"最近多板"统计，保证两个看板实时同步
                    window.recalcDuibanFromAuction();
                };
                if (typeof window.requestIdleCallback === 'function') {
                    window.requestIdleCallback(_runAuctionSideEffects, { timeout: 200 });
                } else {
                    setTimeout(_runAuctionSideEffects, 0);
                }
            }

            // ===== Vue 路径副作用补全（全量切换后 Vue 路径提前 return，需把 innerHTML 路径
            // 尾部的关键副作用前移，否则标签/高光/警示会丢失）=====
            // (1) 标签派生信号（方案 B）：bump 按数据源隔离的 dataVersions，让 computeAuctionViewData
            //     的 Vue computed 在 stocksData 变化时重算。enrichAuctionItem 内部调
            //     deriveAuctionTagState 实时派生 bought/sold/selected，不再需要
            //     applyDerivedTagToRow 预先写入 auctionData 行。
            // 性能修复：切换日期等场景里，renderList() 等入口在同一次交互中会连续多次
            // 调用 renderAuction('auction')（比如 renderList 本身 + 内部各 render* 副作用
            // 链路重入），如果这多次 bump 之间恰好穿插了一次 Vue 组件访问（读取）computed，
            // 就会导致 Page2/Page3/Stats 这些重计算被触发不止一次，实测可达同一批看板
            // 重算 2 遍、单帧阻塞近 16 秒。这里把 bump 合并到同一个微任务周期：连续多次
            // 调用只会在本轮同步代码执行完毕后统一 +1 一次，不影响"数据变了要让 computed
            // 失效"这个语义，只是把多次冗余的"失效信号"合并成一次。
            if (window.auctionStore && window.auctionStore.dataVersions && dataSource in window.auctionStore.dataVersions) {
                window._pendingDataVersionBumps = window._pendingDataVersionBumps || {};
                window._pendingDataVersionBumps[dataSource] = true;
                if (!window._dataVersionBumpScheduled) {
                    window._dataVersionBumpScheduled = true;
                    Promise.resolve().then(function() {
                        window._dataVersionBumpScheduled = false;
                        const pending = window._pendingDataVersionBumps || {};
                        window._pendingDataVersionBumps = {};
                        Object.keys(pending).forEach(function(ds) {
                            if (window.auctionStore.dataVersions[ds] != null) {
                                window.auctionStore.dataVersions[ds] = (window.auctionStore.dataVersions[ds] || 0) + 1;
                                window._dbgLog('[PERF] dataVersions.' + ds + ' → ' + window.auctionStore.dataVersions[ds] + '（已合并同微任务周期内的重复 bump）');
                            }
                        });
                        // 保留旧的 stocksDataVersion 递增，供 index.html 中未迁移的日志/诊断使用
                        window.auctionStore.stocksDataVersion = (window.auctionStore.stocksDataVersion || 0) + 1;
                    });
                }
            }
            // (2) 高光推送 + 竞/昨空集警示（与 innerHTML 路径 18308-18316 同口径）
            {
                const _jingYestHL = window.getJingYestHighlightSetForDate(window.currentDate, dataSource);
                const _fullCache = dataSource === 'hot' ? window._hotFullRowCache : window._auctionMemCache;
                if (_jingYestHL && Object.keys(_fullCache).length > 0) {
                    window.schedulePushDailyHighlights(window.currentDate, _jingYestHL, dataSource);
                }
                const _ss0 = window.auctionStore ? window.auctionStore.sortState[dataSource === 'hot' ? 'hot' : 'auction'] : null;
                if (_ss0 && (_ss0.byJingYest || _ss0.byJingYestRatio) && _jingYestHL && _jingYestHL.size === 0) {
                    window.maybeShowJingYestEmptyToast();
                }
            }

            // ===== Vue 化展示层（全量切换：默认走 Vue，不再依赖特性开关）=====
            // 两个 tab 各自挂载独立 Vue 实例（per-tab app），均由 store 响应式驱动。
            // 不再按 currentGroup 区分——背景 tab 也用 Vue 渲染，避免 innerHTML 回退路径
            // clobber 已挂载的 Vue DOM。子页面（Page2/3/Stats）同步触发；Stats 内部仍按
            // currentGroup 守卫（单块看板，仅当前 tab 更新）。挂载失败时回退 innerHTML。
            if (typeof window.mountAuctionBoardSandbox === 'function') {
                const _vueEl = document.getElementById(_p + 'Content');
                if (_vueEl) {
                    if (!window._auctionVueApps) window._auctionVueApps = {};
                    let _vueMounted = !!(window._auctionVueApps[_p] && _vueEl.querySelector('.auction-board-vue'));
                    if (!_vueMounted) {
                        try { window._auctionVueApps[_p] = window.mountAuctionBoardSandbox(dataSource, _p + 'Content'); _vueMounted = !!(window._auctionVueApps[_p]); }
                        catch (e) { window._dbgLog('[AUCTION-VUE] 挂载失败，回退 innerHTML：' + e.message); }
                    }
                    if (_vueMounted) {
                        // store 响应式会自动更新主列表；子页面同步渲染
                        window.renderAuctionPage2(dataSource);
                        window.renderAuctionPage3(dataSource);
                        window.renderAuctionStatsBoard(dataSource);
                        window.initAuctionSwipe();
                        window.scrollTo(0, _savedScrollY);
                        if (window.auctionStore) { window.auctionStore.currentDate = window.currentDate; window.auctionStore.currentGroup = window.currentGroup; }
                        return;
                    }
                    // 挂载失败：落到下方 innerHTML 回退路径
                }
            }

            const auctionList = window.getTodayGroupList(dataSource);

            // 调试：打印 auctionData 原始 vs 过滤后长度，以及 holdingNames 里被过滤掉的股票
            if (dataSource === 'auction') {
                try {
                    const _rawLen = (window.getGroupData(dataSource)[window.currentDate] || []).length;
                    const _obsBought = JSON.parse(localStorage.getItem('obsBought_' + window.currentDate) || '[]');
                    const _filteredList = _obsBought.filter(function(n) {
                        return !auctionList.some(function(it) { return it.stock && it.stock.trim() === n; });
                    });
                    window._dbgLogVerbose('[RENDER-FILTER] ' + window.currentDate + ' auctionData 原始 ' + _rawLen + ' 只 → 过滤后 auctionList ' + auctionList.length + ' 只；obsBought 股票未进 auctionList 共 ' + _filteredList.length + ' 只' + (_filteredList.length > 0 ? '：' + _filteredList.join('、') : ''));
                } catch (e) {
                    window._dbgLogVerbose('[RENDER-FILTER] 异常：' + e.message);
                }
            }

            // 方案 B：标签不再写入 auctionData 行，渲染时由 deriveAuctionTagState 实时派生。
            // innerHTML 路径也无需预同步标签（_renderAuctionItem 内部调 deriveAuctionTagState）。

            const auctionContent = document.getElementById(_p + 'Content');
            
            const duibanList = window.getTodayDuiban();
            let duibanTushiLink = '';
            if (duibanList.length > 0) {
                for (let i = 0; i < duibanList.length; i++) {
                    const tushi = duibanList[i].tushi || '';
                    if (tushi && (tushi.startsWith('http://') || tushi.startsWith('https://'))) {
                        duibanTushiLink = tushi;
                        break;
                    }
                }
            }
            
            if (auctionList.length === 0) {
                auctionContent.innerHTML = `
                    <div class="auction-search-container" id="${_p}SearchContainer">
                        <input type="text" class="auction-search-input" id="${_p}SearchInput" placeholder="输入股票名称搜索...">
                    </div>
                    <div class="auction-header-row">
                        <div class="auction-header-item auction-header-stock">股票名称</div>
                        <div class="auction-header-item auction-header-volume">竞价量(万股)</div>
                        <div class="auction-header-item auction-header-yest">昨日成交量(万股)</div>
                        <div class="auction-header-item auction-header-ratio">占比</div>
                    </div>
                    <div class="auction-placeholder">暂无数据，双击导入</div>
                `;
                // 没有数据时显示 -
                // 注：强度显示（auctionStrengthValue/auctionStrengthArrow）是"早盘竞价"和"热门股票"两个 tab 共用的同一套 DOM
                // （标题栏文字本身就会随 switchGroup 切换），因此这里固定写这一套，而不是按 _p 拼接（HTML 里并不存在 hotStrengthValue）
                // 分组守卫：只有当前渲染分组等于用户正在查看的 tab，才允许写入这套共用 DOM，
                // 避免另一个 tab 的后台异步渲染（Realtime 推送等）把当前可见 tab 的强度覆盖掉
                if (dataSource === window.currentGroup) {
                    const strengthValueEl = document.getElementById('auctionStrengthValue');
                    const strengthArrowEl = document.getElementById('auctionStrengthArrow');
                    if (strengthValueEl) strengthValueEl.textContent = '-';
                    if (strengthArrowEl) strengthArrowEl.textContent = '-';
                }
                // 没有数据时，"竞放量数"、"竞/昨数"也要重置为 -，避免残留上一个有数据日期的数值
                const highRatioCountElEmpty = document.getElementById(_p + 'HighRatioCount');
                const highRatioArrowElEmpty = document.getElementById(_p + 'HighRatioArrow');
                const jingYestCountElEmpty = document.getElementById(_p + 'JingYestCount');
                if (highRatioCountElEmpty) highRatioCountElEmpty.textContent = '-';
                if (jingYestCountElEmpty) jingYestCountElEmpty.textContent = '-';
                if (highRatioArrowElEmpty) {
                    highRatioArrowElEmpty.textContent = '';
                    highRatioArrowElEmpty.style.color = '';
                }
                window.renderAuctionPage2(dataSource);
                window.renderAuctionPage3(dataSource);
                window.renderAuctionStatsBoard(dataSource);
                window.initAuctionSwipe();
                // 恢复滚动位置
                window.scrollTo(0, _savedScrollY);
                return;
            }
            
            let html = `
                <div class="auction-search-container" id="${_p}SearchContainer">
                    <input type="text" class="auction-search-input" id="${_p}SearchInput" placeholder="输入股票名称搜索...">
                </div>
                <div class="auction-header-row" id="${_p}HeaderRow" style="cursor: pointer;">
                    <div class="auction-header-item auction-header-number">序号</div>
                    <div class="auction-header-item auction-header-stock">股票名称</div>
                    <div class="auction-header-item auction-header-volume">竞价量(万股)</div>
                    <div class="auction-header-item auction-header-yest">昨日成交量(万股)</div>
                    <div class="auction-header-item auction-header-ratio">占比</div>
                </div>
            `;
            
            // 获取上一个交易日的数据用于对比
            const prevDate = window.getPreviousTradingDay(window.currentDate);
            const auctionData = window.getGroupData(dataSource);
            const prevAuctionList = prevDate ? (auctionData[prevDate] || []) : [];
            
            // 计算第一页总强度和箭头
            if (auctionList.length > 0) {
                let strongCount = 0;
                
                auctionList.forEach(item => {
                    // 计算强度：今天量比 >= 昨天量比 为强势
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
                    if (!hasDown) {
                        strongCount++;
                    }
                });
                
                const totalCount = auctionList.length;
                const todayStrength = Math.round((strongCount / totalCount) * 100);
                
                // 计算昨天的强度 - 优化：将重复调用移到循环外
                let yesterdayStrongCount = 0;
                let yesterdayTotalCount = prevAuctionList.length;
                const prevPrevDate = window.getPreviousTradingDay(prevDate);
                const prevPrevAuctionList = prevPrevDate ? (auctionData[prevPrevDate] || []) : [];
                
                if (yesterdayTotalCount > 0) {
                    prevAuctionList.forEach(item => {
                        let hasDown = false;
                        if (prevPrevAuctionList.length > 0 && item.stock) {
                            const prevPrevItem = prevPrevAuctionList.find(p => p.stock && p.stock.trim() === item.stock.trim());
                            if (prevPrevItem && prevPrevItem.yestVolume) {
                                const prevPrevVolume = parseFloat(prevPrevItem.volume) || 0;
                                const prevPrevYestVolume = parseFloat(prevPrevItem.yestVolume) || 0;
                                if (prevPrevYestVolume > 0) {
                                    const prevPrevRatioValue = (prevPrevVolume / prevPrevYestVolume) * 100;
                                    const prevRatioValue = (parseFloat(item.volume) || 0) / (parseFloat(item.yestVolume) || 1) * 100;
                                    if (prevRatioValue < prevPrevRatioValue) {
                                        hasDown = true;
                                    }
                                }
                            }
                        }
                        if (!hasDown) {
                            yesterdayStrongCount++;
                        }
                    });
                }
                
                const yesterdayStrength = yesterdayTotalCount > 0 ? Math.round((yesterdayStrongCount / yesterdayTotalCount) * 100) : null;
                
                // 同上：强度显示是两个 tab 共用的同一套 DOM，固定读写 auctionStrengthValue/auctionStrengthArrow
                // 分组守卫：只有当前渲染分组等于用户正在查看的 tab，才允许写入
                if (dataSource === window.currentGroup) {
                    const strengthValueEl = document.getElementById('auctionStrengthValue');
                    const strengthArrowEl = document.getElementById('auctionStrengthArrow');
                    
                    if (strengthValueEl) {
                        strengthValueEl.textContent = todayStrength + '% ';
                    }
                    if (strengthArrowEl) {
                        if (yesterdayStrength !== null) {
                            if (todayStrength > yesterdayStrength) {
                                strengthArrowEl.textContent = '⬆';
                            } else if (todayStrength < yesterdayStrength) {
                                strengthArrowEl.textContent = '⬇';
                            } else {
                                strengthArrowEl.textContent = '-';
                            }
                        } else {
                            strengthArrowEl.textContent = '-';
                        }
                    }
                }
            } else {
                if (dataSource === window.currentGroup) {
                    const strengthValueEl = document.getElementById('auctionStrengthValue');
                    const strengthArrowEl = document.getElementById('auctionStrengthArrow');
                    if (strengthValueEl) strengthValueEl.textContent = '-';
                    if (strengthArrowEl) strengthArrowEl.textContent = '-';
                }
            }

            // 计算"竞放量数"（今日竞价量/昨日竞价量 >= 1.5 的股票数量）及与昨天的对比箭头
            const highRatioToday = window.getHighRatioStocksForDate(window.currentDate, dataSource);
            // 计算"平行"达标股票集合（今日竞价量>T-1竞价量 且 T-1成交量>T-2成交量），供高光判断复用
            const parallelStocksToday = window.getParallelStocksForDate(window.currentDate, dataSource);
            // "竞/昨"高光：统一通过 getJingYestHighlightSetForDate 获取（含 digitGap≤1 过滤），
            // 高光显示与排序 tier0 用同一份返回结果，杜绝分叉。
            const jingYestToggleChecked = document.getElementById(_p + 'SortByJingYestToggle')?.checked || document.getElementById(_p + 'SortByJingYestRatioToggle')?.checked;
            const jingYestHighlightSet = window.getJingYestHighlightSetForDate(window.currentDate, dataSource);
            // 若全量快照缓存有数据（说明函数内部走了实时计算路径），推送高光到 highlights 表
            const _fullCache = dataSource === 'hot' ? window._hotFullRowCache : window._auctionMemCache;
            if (jingYestHighlightSet && Object.keys(_fullCache).length > 0) {
                window.schedulePushDailyHighlights(window.currentDate, jingYestHighlightSet, dataSource);
            }
            // 若"竞/昨"开启，且计算结果里一个高光都没有（Tier0本就为空，或Tier0里全部位数差≥2），则弹一次黄色警示Toast，提示"全部没有，谨慎出手"
            if (jingYestToggleChecked && jingYestHighlightSet && jingYestHighlightSet.size === 0) {
                window.maybeShowJingYestEmptyToast();
            }
            // "竞/昨数"：常驻显示实际允许高光的达标股票数量，不带箭头
            const jingYestCountEl = document.getElementById(_p + 'JingYestCount');
            if (jingYestCountEl) {
                jingYestCountEl.textContent = jingYestHighlightSet ? jingYestHighlightSet.size : '-';
            }
            const highRatioCountEl = document.getElementById(_p + 'HighRatioCount');
            const highRatioArrowEl = document.getElementById(_p + 'HighRatioArrow');
            if (highRatioCountEl) {
                highRatioCountEl.textContent = highRatioToday.count;
            }
            if (highRatioArrowEl) {
                const prevDateForRatio = window.getPreviousTradingDay(window.currentDate);
                if (prevDateForRatio) {
                    const highRatioYesterday = window.getHighRatioStocksForDate(prevDateForRatio, dataSource);
                    if (highRatioToday.count > highRatioYesterday.count) {
                        highRatioArrowEl.textContent = ' ⬆';
                        highRatioArrowEl.style.color = '#dc2626';
                    } else if (highRatioToday.count < highRatioYesterday.count) {
                        highRatioArrowEl.textContent = ' ⬇';
                        highRatioArrowEl.style.color = '#16a34a';
                    } else {
                        highRatioArrowEl.textContent = ' -';
                        highRatioArrowEl.style.color = '#92400e';
                    }
                } else {
                    highRatioArrowEl.textContent = '';
                }
            }
            
            // 构建渲染顺序：默认按原始顺序；
            // 若开启"数据"，按近5日有效数据天数从多到少排列；
            // 若开启"环比"，按 今日竞价量/昨日竞价量 从高到低排列（无昨日数据的排最后）；
            // 若开启"平行"，今日竞价量>T-1竞价量 且 T-1成交量>T-2成交量 的股票排最前面（不满足的排后面）
            // 注意：无论如何排序，每行显示的"序号"始终是该股票的原始序号（不重新编号）
            let renderOrder = auctionList.map((item, idx) => idx);

            const sortByDataEnabled = document.getElementById(_p + 'SortByDataToggle')?.checked;
            const sortByRatioEnabled = document.getElementById(_p + 'SortByRatioToggle')?.checked;
            const sortByParallelEnabled = document.getElementById(_p + 'SortByParallelToggle')?.checked;
            const sortByJingYestEnabled = document.getElementById(_p + 'SortByJingYestToggle')?.checked;
            const sortByJingYestRatioEnabled = document.getElementById(_p + 'SortByJingYestRatioToggle')?.checked;
            const sortByThreeDayJingDieEnabled = document.getElementById(_p + 'SortByThreeDayJingDieToggle')?.checked;
            const threeDayJingDieSet = sortByThreeDayJingDieEnabled ? window.getThreeDayJingDieSet(window.currentDate, dataSource) : null;

            if (sortByDataEnabled) {
                const dataCountCache = renderOrder.map(idx => {
                    const it = auctionList[idx];
                    if (!it || !it.stock) return 0;
                    const history = window.getAuctionStockHistory(it.stock.trim(), window.currentDate, 5, dataSource);
                    return history.filter(h => h.volume !== null || h.yestVolume !== null).length;
                });
                renderOrder = renderOrder
                    .map((idx, pos) => ({ idx, count: dataCountCache[pos] }))
                    .sort((a, b) => b.count - a.count)
                    .map(x => x.idx);
            } else if (sortByRatioEnabled) {
                // "环比"排序需三层，与"平行"/"竞/昨"保持同一套模式：
                //   1. 达标（今日竞价量/昨日竞价量 四舍五入到一位小数 >= 1.5，与竞放量高光口径一致）：
                //      按"位数差"(|竞价量位数-昨日成交量位数|)从小到大排，位数差相同再按比值从高到低排
                //   2. 不达标但比值能算出来：同样按位数差从小到大、比值从高到低排
                //   3. 比值无法计算（昨日无记录/竞价量为0/断点）：保持原相对顺序，垫底
                const highRatioStocksForSort = window.getHighRatioStocksForDate(window.currentDate, dataSource);
                const prevDate = window.getPreviousTradingDay(window.currentDate);
                const prevDayList = prevDate ? (window.getGroupData(dataSource)[prevDate] || []) : [];
                renderOrder = renderOrder
                    .map((idx, pos) => {
                        const it = auctionList[idx];
                        const stockName = it && it.stock ? it.stock.trim() : '';
                        const todayVolume = it ? window.getNumericVolume(it.volume) : null;
                        const yestVolume = it ? window.getNumericVolume(it.yestVolume) : null;
                        let ratio = null;
                        if (todayVolume !== null && todayVolume !== 0) {
                            const prevItem = prevDayList.find(p => p.stock && p.stock.trim() === stockName);
                            const prevVolume = prevItem ? window.getNumericVolume(prevItem.volume) : null;
                            if (prevVolume !== null && prevVolume !== 0) {
                                ratio = todayVolume / prevVolume;
                            }
                        }
                        const digitGap = (todayVolume !== null && yestVolume !== null) ? Math.abs(window.getDigitCount(todayVolume) - window.getDigitCount(yestVolume)) : null;
                        // tier: 0 = 达标（竞放量高光），1 = 不达标但比值可算，2 = 比值无法计算
                        const isHighRatio = stockName && highRatioStocksForSort.stockNames.has(stockName);
                        const tier = isHighRatio ? 0 : (ratio !== null ? 1 : 2);
                        return { idx, pos, ratio, digitGap, tier };
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
                    .map(x => x.idx);
            } else if (sortByJingYestRatioEnabled) {
                // "竞/昨占比"排序：按 UI 显示的占比(volume/yestVolume)从高到低；符合竞昨条件(高光)的排前面，其余排后面；占比无法计算的垫底
                renderOrder = renderOrder
                    .map((idx, pos) => {
                        const stockName = auctionList[idx] && auctionList[idx].stock ? auctionList[idx].stock.trim() : '';
                        const isHighlight = stockName && jingYestHighlightSet.has(stockName);
                        const tier = isHighlight ? 0 : 1;
                        const vol = auctionList[idx] ? (parseFloat(auctionList[idx].volume) || 0) : 0;
                        const yvol = auctionList[idx] ? (parseFloat(auctionList[idx].yestVolume) || 0) : 0;
                        const jr = (vol > 0 && yvol > 0) ? (vol / yvol) : null;
                        return { idx, pos, jr, tier };
                    })
                    .sort((a, b) => {
                        if (a.tier !== b.tier) return a.tier - b.tier;
                        if (a.jr === null && b.jr === null) return a.pos - b.pos;
                        if (a.jr === null) return 1;
                        if (b.jr === null) return -1;
                        return b.jr - a.jr;
                    })
                    .map(x => x.idx);
            } else if (sortByThreeDayJingDieEnabled) {
                // "连续竞跌"排序：按下跌天数从多到少排，天数相同按占比(volume/yestVolume)从低到高排
                renderOrder = renderOrder
                    .map((idx, pos) => {
                        const stockName = auctionList[idx] && auctionList[idx].stock ? auctionList[idx].stock.trim() : '';
                        const dd = stockName && threeDayJingDieSet ? (threeDayJingDieSet.get(stockName) || 0) : 0;
                        const vol = auctionList[idx] ? (parseFloat(auctionList[idx].volume) || 0) : 0;
                        const yvol = auctionList[idx] ? (parseFloat(auctionList[idx].yestVolume) || 0) : 0;
                        const jr = (vol > 0 && yvol > 0) ? (vol / yvol) : null;
                        return { idx, pos, dd, jr };
                    })
                    .sort((a, b) => {
                        if (a.dd !== b.dd) return b.dd - a.dd;
                        if (a.jr === null && b.jr === null) return a.pos - b.pos;
                        if (a.jr === null) return 1;
                        if (b.jr === null) return -1;
                        return a.jr - b.jr;
                    })
                    .map(x => x.idx);
            } else if (sortByParallelEnabled) {
                if (sortByJingYestEnabled) {
                    // "竞/昨"是"平行"的加强筛选，排序需三层：
                    //   1. 竞/昨真正达标（高光条件：平行 + 差值>0 + 位数差<=1）：按"位数差"从小到大排，位数差相同再按"差值"从高到低排
                    //   2. 平行达标但不满足高光条件（差值<=0，或差值>0但位数差>1）：同样按"位数差"从小到大、"差值"从高到低排（差值不要求>0，能算出来就参与）
                    //   3. 平行也不达标：保持原相对顺序，垫底
                    // tier0 复用上方已计算的 jingYestHighlightSet（同一份返回结果，杜绝分叉）
                    const parallelStockNamesForSort = window.getParallelStocksForDate(window.currentDate, dataSource);
                    const allRatioDiffInfo = window.getRatioDiffInfoForDate(window.currentDate, dataSource);
                    renderOrder = renderOrder
                        .map((idx, pos) => {
                            const stockName = auctionList[idx] && auctionList[idx].stock ? auctionList[idx].stock.trim() : '';
                            const isParallel = parallelStockNamesForSort.has(stockName);
                            const isHighlight = stockName && jingYestHighlightSet.has(stockName);
                            // tier: 0 = 竞/昨真正达标（高光），1 = 仅平行达标（含差值>0但位数差>1的情况），2 = 都不达标
                            const tier = isHighlight ? 0 : (isParallel ? 1 : 2);
                            // tier0/tier1 都从"全量差值/位数差信息"里取该股票的数据（不要求diff>0）
                            const fallbackInfo = (tier === 0 || tier === 1) ? allRatioDiffInfo.get(stockName) : null;
                            const diff = fallbackInfo ? fallbackInfo.diff : null;
                            const digitGap = fallbackInfo ? fallbackInfo.digitGap : null;
                            return { idx, pos, diff, digitGap, tier };
                        })
                        .sort((a, b) => {
                            if (a.tier !== b.tier) return a.tier - b.tier;
                            if (a.tier === 0 || a.tier === 1) {
                                // 无法算出diff/digitGap的，排在同档位内能算出来的后面，仍保持原相对顺序
                                if (a.digitGap === null && b.digitGap === null) return a.pos - b.pos;
                                if (a.digitGap === null) return 1;
                                if (b.digitGap === null) return -1;
                                if (a.digitGap !== b.digitGap) return a.digitGap - b.digitGap; // 位数差从小到大
                                return b.diff - a.diff; // 位数差相同时，差值从高到低
                            }
                            return a.pos - b.pos; // tier2：保持原相对顺序
                        })
                        .map(x => x.idx);
                } else {
                    // 纯"平行"（"竞/昨"未开启）：与其它排序保持同一套三层模式：
                    //   1. 平行达标：按位数差从小到大排，位数差相同按差值(今/昨比-昨/前比)从高到低排（差值不要求>0）
                    //   2. 不达标：保持原相对顺序，垫底
                    const parallelStockNames = window.getParallelStocksForDate(window.currentDate, dataSource);
                    const allRatioDiffInfoForParallel = window.getRatioDiffInfoForDate(window.currentDate, dataSource);
                    renderOrder = renderOrder
                        .map((idx, pos) => {
                            const stockName = auctionList[idx] && auctionList[idx].stock ? auctionList[idx].stock.trim() : '';
                            const qualifies = stockName && parallelStockNames.has(stockName);
                            const info = qualifies ? allRatioDiffInfoForParallel.get(stockName) : null;
                            return { idx, pos, qualifies, diff: info ? info.diff : null, digitGap: info ? info.digitGap : null };
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
                        .map(x => x.idx);
                }
            }

            // 观察组：上一交易日"竞/昨"实际高光（蓝色高光）达标股票，口径与"竞/昨数"统计保持一致
            const _obsStocks = window.getJingYestHighlightSetForDate(window.getPreviousTradingDay(window.currentDate), dataSource);
            const _autoAddedSet = new Set(JSON.parse(localStorage.getItem('obsAutoAdded_' + window.currentDate) || '[]'));
            // [BUG-FIX 2026-07-27] 昨日买/持/卖股票集合（ensureBoughtStocksForDate 写入）。
            // 卖出标签现在也进入观察组，因此不再剔除已确认卖出的股票。
            const _obsBoughtSet = new Set(JSON.parse(localStorage.getItem('obsBought_' + window.currentDate) || '[]'));

            // 兜底修正集合：以"股票列表"页（getStocksData，权威来源）里每只股票【最近一次】
            // 出现的记录为准，找出"最近状态其实是已卖出"的股票名单。
            const _confirmedSoldSet = (function() {
                const result = new Set();
                const stocksData = window.getStocksData();
                const allDates = Object.keys(stocksData).filter(function(d) { return d <= window.currentDate; }).sort();
                const namesToCheck = new Set(auctionList.map(function(it) { return it.stock ? it.stock.trim() : ''; }).filter(Boolean));
                if (namesToCheck.size === 0) return result;
                const latestTagByName = {};
                allDates.forEach(function(d) {
                    (stocksData[d] || []).forEach(function(s) {
                        if (!s || !s.name) return;
                        const n = s.name.trim();
                        if (namesToCheck.has(n)) latestTagByName[n] = s;
                    });
                });
                Object.keys(latestTagByName).forEach(function(n) {
                    if (latestTagByName[n].sold === true) result.add(n);
                });
                return result;
            })();

            // [BUG-FIX 2026-07-27] 观察组成员 = 上一交易日"竞/昨"达标 ∪ "昨日买/持/卖"继承集合。
            // 午出标签同样进入观察组，不再剔除。
            const _obsBoughtVisibleSet = new Set(_obsBoughtSet);
            // [BUG-FIX] 已在前一日打标签（买入/卖出/持有）的股票进常规组，不进观察组
            // 防止被动继承的前日观察组股票被打标后仍留在观察组（如大晟文化 8/6 观察组 → 8/7 打持有 → 8/10 应进常规组）
            const _taggedPrevDaySet = new Set();
            auctionList.forEach(function(item) {
                if (item && item.stock) {
                    var ts = window.getAuctionTagState(item.stock.trim(), window.currentDate);
                    if (ts.source === 'inherited') _taggedPrevDaySet.add(item.stock.trim());
                }
            });
            const _isObsMember = function(name) {
                if (_taggedPrevDaySet.has(name)) return false;
                return (_obsStocks && _obsStocks.has(name)) || _obsBoughtVisibleSet.has(name);
            };
            const _obsIndicesRaw = renderOrder.filter(i => auctionList[i] && auctionList[i].stock && _isObsMember(auctionList[i].stock.trim()));

            let _obsIndices, _regularIndices, _hiddenObsIndices;
            if (jingYestToggleChecked) {
                _hiddenObsIndices = [];
                const _mergedRegular = [];
                _obsIndicesRaw.forEach(i => {
                    const stockName = auctionList[i].stock.trim();
                    const _isAutoAdded = _autoAddedSet.has(stockName);
                    const _matchesToday = jingYestHighlightSet && jingYestHighlightSet.has(stockName);
                    const _isBoughtInherited = _obsBoughtVisibleSet.has(stockName);
                    if (_isAutoAdded && !_matchesToday && !_isBoughtInherited) {
                        _hiddenObsIndices.push(i); // 纯自动补入且今天未达标（非买入继承）→ 隐藏（仅隐藏展示，数据不受影响）
                    } else {
                        _mergedRegular.push(i); // 用户自己导入的 / 今天重新达标的 / 昨日买入继承的 → 并入常规组正常显示
                    }
                });
                _obsIndices = [];
                _regularIndices = renderOrder.filter(i => _hiddenObsIndices.indexOf(i) < 0);
                if (_hiddenObsIndices.length > 0) {
                    window._dbgLog('[RENDER-OBS] 竞/昨开：隐藏纯自动补入未达标 ' + _hiddenObsIndices.length + ' 只：' + _hiddenObsIndices.map(function(i) { return auctionList[i].stock; }).join('、'));
                }
            } else {
                _obsIndices = _obsIndicesRaw;
                _regularIndices = renderOrder.filter(i => _obsIndices.indexOf(i) < 0);
            }

            // 渲染单只股票的 HTML（闭包，复用外层变量）
            function _renderAuctionItem(index, displayNum) {
                const item = auctionList[index];
                const volume = parseFloat(item.volume) || 0;
                const yestVolume = parseFloat(item.yestVolume) || 0;
                let ratio = '-';
                let ratioValue = 0;
                if (yestVolume > 0) {
                    ratioValue = (volume / yestVolume) * 100;
                    ratio = Math.round(ratioValue) + '%';
                }
                
                // 与昨天对比占比
                let ratioArrow = '';
                if (prevAuctionList.length > 0 && item.stock) {
                    const prevItem = prevAuctionList.find(p => p.stock && p.stock.trim() === item.stock.trim());
                    if (prevItem && prevItem.yestVolume) {
                        const prevVolume = parseFloat(prevItem.volume) || 0;
                        const prevYestVolume = parseFloat(prevItem.yestVolume) || 0;
                        if (prevYestVolume > 0) {
                            const prevRatioValue = (prevVolume / prevYestVolume) * 100;
                            const prevRatio = Math.round(prevRatioValue);
                            const currRatio = Math.round(ratioValue);
                            if (currRatio > prevRatio) {
                                ratioArrow = '<span style="color:#ef4444;">⬆</span>';
                            } else if (currRatio < prevRatio) {
                                ratioArrow = '<span style="color:#10b981;">⬇</span>';
                            }
                        }
                    }
                }
                
                const isHighlight = ratioValue >= 10;
                const isHighlightLight = ratioValue >= 4.5 && ratioValue < 10;
                // 标签从独立存储读取（getAuctionTagState），与股票卡片列表解耦
                const _iname = item.stock ? item.stock.trim() : '';
                const _itagState = window.getAuctionTagState(_iname, window.currentDate);
                const isSold = _itagState.sold;
                const isBought = _itagState.bought;
                const isSelected = _itagState.selected;
                const isFixed = isSold || isBought || isSelected;
                const isGray = !isSelected && !isBought && !isSold && ratioValue < 4.5;
                // 优先级：已卖出 > 已买入 > 持有
                let itemClass = 'auction-item';
                if (isSold) {
                    itemClass = 'auction-item sold';
                } else if (isBought) {
                    itemClass = 'auction-item bought';
                } else if (isSelected) {
                    itemClass = 'auction-item selected';
                }
                // 竞放量高光（今日竞价量/昨日竞价量 >= 1.5）：仅在"环比"开关打开时才显示
                // 平行高光（今日竞价量>T-1竞价量 且 T-1成交量>T-2成交量）：仅在"平行"开关打开且"竞/昨"未开启时才显示，优先于竞放量高光
                // 竞/昨高光（平行基础上，今/昨比 > 昨/前比）：仅在"竞/昨"开关打开时才显示，优先于平行高光；开启后不再叠加平行高光，避免混淆
                const isJingYestMatch = jingYestToggleChecked && jingYestHighlightSet && item.stock && jingYestHighlightSet.has(item.stock.trim());
                const isParallelMatch = sortByParallelEnabled && !jingYestToggleChecked && item.stock && parallelStocksToday.has(item.stock.trim());
                const isHighRatioMatch = sortByRatioEnabled && item.stock && highRatioToday.stockNames.has(item.stock.trim());
                const isThreeDayJingDieMatch = sortByThreeDayJingDieEnabled && threeDayJingDieSet && item.stock && (threeDayJingDieSet.get(item.stock.trim()) || 0) >= 2;
                if (isJingYestMatch) {
                    itemClass += ' jing-yest-match';
                } else if (isParallelMatch) {
                    itemClass += ' parallel-match';
                } else if (isThreeDayJingDieMatch) {
                    itemClass += ' three-day-jing-die';
                } else if (isHighRatioMatch) {
                    itemClass += ' high-ratio';
                }
                let ratioClass = 'auction-ratio auction-ratio-clickable';
                if (isHighlight) {
                    ratioClass = 'auction-ratio highlight auction-ratio-clickable';
                } else if (isHighlightLight) {
                    ratioClass = 'auction-ratio highlight-light auction-ratio-clickable';
                }
                
                const displayNote = window.getDisplayNoteWithHistory(item);
                const noteAttr = displayNote ? ` data-note="${displayNote.replace(/"/g, '&quot;')}"` : '';
                
                const volumeDisplay = item.volume ? Math.round(parseFloat(item.volume)) : '-';
                const yestVolumeDisplay = item.yestVolume ? Math.round(parseFloat(item.yestVolume)) : '-';
                
                let yestColorClass = '';
                if (displayNote) {
                    if (displayNote.includes('涨停')) {
                        yestColorClass = ' auction-yest-red';
                    } else if (displayNote.includes('跌停')) {
                        yestColorClass = ' auction-yest-green';
                    } else {
                        const numMatches = displayNote.match(/-?\d+\.?\d*/g);
                        if (numMatches && numMatches.length > 0) {
                            const lastNum = parseFloat(numMatches[numMatches.length - 1]);
                            if (lastNum > 0) {
                                yestColorClass = ' auction-yest-red';
                            } else if (lastNum < 0) {
                                yestColorClass = ' auction-yest-green';
                            }
                        }
                    }
                }
                
                const numberClass = isGray ? 'auction-number gray-text auction-trend-trigger' : 'auction-number auction-trend-trigger';
                const stockClass = isGray ? 'auction-stock-name gray-text' : 'auction-stock-name';
                
                let volumeHtml = volumeDisplay;
                if (duibanTushiLink && volumeDisplay !== '-') {
                    volumeHtml = `<a href="${duibanTushiLink}" target="_blank" style="color:inherit;text-decoration:none;" onclick="event.stopPropagation()">${volumeDisplay}</a>`;
                }

                // 股票名保持干净，标签放到独立角标区域
                const _isObs = _obsStocks && item.stock && _obsStocks.has(item.stock.trim());
                const _isAutoAdded = item.stock && _autoAddedSet.has(item.stock.trim());
                const _matchesTodayForTag = jingYestToggleChecked && jingYestHighlightSet && item.stock && jingYestHighlightSet.has(item.stock.trim());
                let _stockNameDisplay = item.stock || '-';
                if (!jingYestToggleChecked && _isObs && !_isAutoAdded) {
                    _stockNameDisplay += '*';
                }
                // 构建角标 HTML（买/卖/持），独立于股票名
                let _badgeHtml = '';
                if (item.monitorWarning) {
                    _badgeHtml += '<span class="auction-badge badge-warn" title="严重异常波动">⚠</span>';
                }
                if (isSold) {
                    _badgeHtml += '<span class="auction-badge badge-sell">卖</span>';
                } else if (isBought) {
                    _badgeHtml += '<span class="auction-badge badge-buy">买</span>';
                } else if (isSelected) {
                    _badgeHtml += '<span class="auction-badge badge-hold">持</span>';
                }
                // 当天选择（虚线角标）：buy/sell/hold 带→箭头表示将影响D+1，cancel 显示×
                const _todayChoice = window.getAuctionTagChoice(_iname, window.currentDate);
                if (_todayChoice === 'buy') {
                    _badgeHtml += '<span class="auction-badge badge-today-buy" title="今天选：买入→明天继承">买→</span>';
                } else if (_todayChoice === 'sell') {
                    _badgeHtml += '<span class="auction-badge badge-today-sell" title="今天选：卖出→明天继承">卖→</span>';
                } else if (_todayChoice === 'hold') {
                    _badgeHtml += '<span class="auction-badge badge-today-hold" title="今天选：持有→明天继承">持→</span>';
                } else if (_todayChoice === 'cancel') {
                    _badgeHtml += '<span class="auction-badge badge-today-cancel" title="今天选：取消次日观察">×</span>';
                }
                
                return `
                    <div class="${itemClass}" data-index="${index}" data-stock="${item.stock || ''}">
                        <div class="auction-badges">${_badgeHtml}</div>
                        <div class="${numberClass}" data-index="${index}">${displayNum}</div>
                        <div class="${stockClass} auction-note-trigger"${noteAttr}>${_stockNameDisplay}</div>
                        <div class="auction-volume">${volumeHtml}</div>
                        <div class="auction-yest auction-yest-note${yestColorClass}" data-index="${index}"${noteAttr}>${yestVolumeDisplay}</div>
                        <div class="${ratioClass}" data-index="${index}">${ratio}${ratioArrow}</div>
                    </div>
                    <div class="auction-trend-panel" id="${_p}TrendPanel-${index}" data-index="${index}" style="display:none;"></div>
                `;
            }
            window._renderAuctionItem = _renderAuctionItem;

            // 先渲染观察组，再渲染常规组，中间留小空隙（虚线分隔）；"竞/昨"打开时 _obsIndices 为空，直接只渲染合并后的 _regularIndices
            let _displayNum = 1;
            _obsIndices.forEach((i) => { html += window._renderAuctionItem(i, _displayNum++); });
            if (_obsIndices.length > 0 && _regularIndices.length > 0) {
                html += '<div style="margin:10px 12px;border-top:1.5px dashed #cbd5e1;"></div>';
            }
            _regularIndices.forEach((i) => { html += window._renderAuctionItem(i, _displayNum++); });
            
            // ===== 增量更新判断 =====
            // 背景：早盘竞价期间后台数据每隔1~2秒就可能刷新一次（Realtime推送），若每次都用
            // innerHTML 整体重建 DOM，会导致：① 所有节点重新创建、事件重新绑定，用户点击
            // 展开的面板要靠 restoreExpandedAuctionTrendPanels() 重新展开，视觉上有明显闪烁/
            // 卡顿感；② 若点击恰好落在重建的时间窗口，体验上感知不到点击生效，用户会误以为
            // 没点中而再点一次，反而把刚展开的面板收起。
            // 大多数刷新场景下，股票列表的"成员和顺序"并没有变化，只是竞价量/成交量/占比等
            // 数字变了——这种情况下没必要重建整个容器，只需要逐行替换单行内容即可：
            // 复用同一个 _renderAuctionItem 生成该行最新 HTML，用 outerHTML 局部替换，
            // 不影响其他行的 DOM 节点、事件监听器；若该行原本展开着趋势面板，替换后立即
            // 用原逻辑把面板内容重新填回（对用户来说只是同一张图重绘一次，无感知差异），
            // 不需要经过"重新展开"的整体流程。
            // 签名 = 观察组+常规组的展示顺序拼接股票名，能反映"这次渲染和上次相比，成员和顺序是否一致"。
            const _fullOrder = _obsIndices.concat(_regularIndices);
            const _renderSignature = _fullOrder
                .map(i => (auctionList[i] && auctionList[i].stock) ? auctionList[i].stock.trim() : '')
                .join('|');
            const _prevSignature = auctionContent.dataset.rowSignature;
            // 全部展开开关打开时不走增量路径：增量逻辑只负责保留"已展开"的行，不会主动展开
            // 因开关状态变化而应该展开的新行，直接整体重建更简单可靠
            const _expandAllOn = document.getElementById(_p + 'ExpandAllToggle')?.checked;
            const _canPatchInPlace = !_expandAllOn && (_prevSignature === _renderSignature) && auctionContent.querySelector('.auction-item');

            if (_canPatchInPlace) {
                let _di = 1;
                _fullOrder.forEach((i) => {
                    const rowEl = auctionContent.querySelector('.auction-item[data-index="' + i + '"]');
                    const panelEl = document.getElementById(_p + 'TrendPanel-' + i);
                    const _wasOpen = panelEl && panelEl.style.display !== 'none' && panelEl.innerHTML !== '';
                    const _itemHtml = window._renderAuctionItem(i, _di++);
                    if (rowEl) {
                        // _renderAuctionItem 返回"行 + 紧跟的面板占位"两段，用一个临时容器解析后只取第一个元素（行本身）
                        // 替换，面板节点保持原样不动，避免打断可能存在的展开内容
                        const _tmp = document.createElement('div');
                        _tmp.innerHTML = _itemHtml;
                        const _newRowEl = _tmp.querySelector('.auction-item');
                        if (_newRowEl) {
                            rowEl.replaceWith(_newRowEl);
                            // 复用统一的事件绑定函数（占比/成交量长按/序号/股票名），
                            // 只对这一行新节点绑定，不影响其他未被替换的行
                            window._bindAuctionRowEvents(_newRowEl);
                        }
                    }
                    if (_wasOpen) {
                        // 该行原本展开着，行节点已被替换，其后的面板节点本身没变，只需要
                        // 重新填回面板内容（不走"点击/toggle"逻辑，用户不会感知到差异）
                        window.expandAuctionTrendPanel(i, _p);
                    }
                });
                window._dbgLog('[PATCH] 命中增量更新路径，跳过整体重建，逐行局部替换（' + _fullOrder.length + '行）');
                window.renderAuctionPage2(dataSource);
                window.renderAuctionPage3(dataSource);
                window.renderAuctionStatsBoard(dataSource);
                window.initAuctionSwipe();
                window.scrollTo(0, _savedScrollY);
                return;
            }
            auctionContent.dataset.rowSignature = _renderSignature;

            auctionContent.innerHTML = html;
            
            // ===== 逐行事件绑定：占比点击 / 成交量长按 / 序号点击展开 / 股票名点击跳转 =====
            // 抽成独立函数是为了让"整体重建路径"和"增量更新路径"（见下方 _canPatchInPlace 分支）
            // 都能复用同一套绑定逻辑，避免维护两份容易导致遗漏或不一致。
            // scopeEl：绑定范围，整体重建时传整个 auctionContent 容器；增量更新时传被替换的单行节点。
            function _bindAuctionRowEvents(scopeEl) {
                // 绑定点击占比事件
                scopeEl.querySelectorAll('.auction-ratio-clickable').forEach(el => {
                    if (el.dataset.boundRatio === '1') return;
                    el.dataset.boundRatio = '1';
                    el.addEventListener('click', function(e) {
                        e.stopPropagation();
                        const idx = parseInt(this.dataset.index);
                        window.toggleAuctionRowSelect(idx);
                    });
                });

                // 绑定长按昨日成交量事件
                scopeEl.querySelectorAll('.auction-yest-note').forEach(el => {
                    if (el.dataset.boundYest === '1') return;
                    el.dataset.boundYest = '1';
                    (function(element) {
                        let pressTimer;
                        let isLongPress = false;
                        let isMoved = false;
                        let lastTapTime = 0;

                        const startHandler = function(e) {
                            // 多指触摸（如三指下滑截图手势）不触发长按，直接跳过
                            if (e.touches && e.touches.length > 1) {
                                clearTimeout(pressTimer);
                                return;
                            }
                            // 右键按下不启动长按计时器，避免和右键单击打开编辑弹窗冲突
                            if (e.button === 2) {
                                return;
                            }
                            isLongPress = false;
                            isMoved = false;
                            pressTimer = setTimeout(() => {
                                isLongPress = true;
                                const idx = parseInt(element.dataset.index);
                                window.showAuctionNoteInput(idx, element);
                            }, 500);
                        };

                        const moveHandler = function(e) {
                            isMoved = true;
                            clearTimeout(pressTimer);
                        };

                        const endHandler = function(e) {
                            clearTimeout(pressTimer);
                        };

                        const cancelHandler = function(e) {
                            clearTimeout(pressTimer);
                        };

                        element.addEventListener('mousedown', startHandler);
                        element.addEventListener('mouseup', endHandler);
                        element.addEventListener('mouseleave', cancelHandler);
                        element.addEventListener('touchstart', startHandler, { passive: true });
                        element.addEventListener('touchmove', moveHandler, { passive: true });
                        element.addEventListener('touchend', endHandler);
                        element.addEventListener('touchcancel', cancelHandler);
                        element.addEventListener('click', function(e) {
                            e.preventDefault();
                            e.stopPropagation();
                            if (isLongPress || isMoved) return;
                            const now = Date.now();
                            if (now - lastTapTime < 300) return;
                            lastTapTime = now;
                            const note = element.dataset.note;
                            if (note) {
                                window.showAuctionNotePopup(element, note);
                            }
                        });
                        // 右键单击打开编辑弹窗（电脑端鼠标操作）：contextmenu 是独立事件，
                        // 不会和上面的 click 处理器冲突，比双击更可靠
                        element.addEventListener('contextmenu', function(e) {
                            e.preventDefault();
                            clearTimeout(pressTimer);
                            if (dataSource === 'hot') { window.openHotEdit(); } else { window.openAuctionEdit(); }
                        });
                    })(el);
                });

                // 绑定点击序号展开/收起趋势图
                // （已删除 [BIND] 逐批日志：增量更新路径下每行都会触发一次，每次渲染刷几十条，纯属噪音）
                const _bindStartTs = performance.now();
                const _triggerNodes = scopeEl.querySelectorAll('.auction-trend-trigger');
                _triggerNodes.forEach(el => {
                    if (el.dataset.boundTrigger === '1') return;
                    el.dataset.boundTrigger = '1';
                    el.style.cursor = 'pointer';
                    el.addEventListener('click', function(e) {
                        e.stopPropagation();
                        const idx = parseInt(this.dataset.index);
                        const _clickTs = performance.now();
                        const _stockName = this.closest('.auction-item') ? this.closest('.auction-item').dataset.stock : '?';
                        window._dbgLog('[CLICK] 点击序号 index=' + idx + ' 股票=' + _stockName + ' | 节点isConnected=' + this.isConnected + ' | 距本节点绑定耗时点=' + Math.round(_clickTs - _bindStartTs) + 'ms | 距上次renderAuction=' + (window._lastRenderAuctionAt ? Math.round(_clickTs - window._lastRenderAuctionAt) : -1) + 'ms');
                        window.toggleAuctionTrendPanel(idx);
                    });
                });

                // 绑定股票名称点击弹出注释 + 长按显示买入提示 + 单击跳转到第二页
                scopeEl.querySelectorAll('.auction-stock-name').forEach(el => {
                    if (el.dataset.boundName === '1') return;
                    el.dataset.boundName = '1';
                    (function(element) {
                        let pressTimer;
                        let isMoved = false;
                        let isLongPress = false;

                        element.style.cursor = 'pointer';

                        element.addEventListener('click', function(e) {
                            if (!isLongPress && !isMoved) {
                                // 单击跳转到第二页
                                const stockName = element.textContent.trim();
                                if (stockName && stockName !== '-') {
                                    e.stopPropagation();
                                    window.jumpToAuctionPage2(stockName);
                                }
                            }
                        });

                        // 双击显示注释
                        element.addEventListener('dblclick', function(e) {
                            e.stopPropagation();
                            const note = element.dataset.note;
                            if (note) {
                                const row = element.closest('.auction-item');
                                const yestEl = row ? row.querySelector('.auction-yest-note') : null;
                                if (yestEl) {
                                    window.showAuctionNotePopup(yestEl, note);
                                }
                            }
                        });

                        const startHandler = function(e) {
                            // 多指触摸（如三指下滑截图手势）不触发长按，直接跳过
                            if (e.touches && e.touches.length > 1) {
                                clearTimeout(pressTimer);
                                return;
                            }
                            isMoved = false;
                            isLongPress = false;
                            pressTimer = setTimeout(() => {
                                isLongPress = true;
                                const stockName = element.textContent.trim();
                                if (stockName && stockName !== '-') {
                                    window.showAuctionBuyPrompt(stockName);
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

                        const cancelHandler = function(e) {
                            clearTimeout(pressTimer);
                        };

                        element.addEventListener('mousedown', startHandler);
                        element.addEventListener('mouseup', endHandler);
                        element.addEventListener('mouseleave', cancelHandler);
                        element.addEventListener('touchstart', startHandler, { passive: true });
                        element.addEventListener('touchmove', moveHandler, { passive: true });
                        element.addEventListener('touchend', endHandler);
                        element.addEventListener('touchcancel', cancelHandler);
                        element.addEventListener('contextmenu', function(e) {
                            e.preventDefault();
                        });
                    })(el);
                });
            }
            window._bindAuctionRowEvents = _bindAuctionRowEvents;

            window._bindAuctionRowEvents(auctionContent);

            // 若"全部展开"开关已打开，渲染完成后自动展开所有趋势面板
            // 注意：必须用 _p 前缀动态取对应分组的开关（auctionExpandAllToggle / hotExpandAllToggle），
            // 不能硬编码写死 auctionExpandAllToggle —— 否则热门股票tap渲染时会错误地读取
            // 早盘竞价那个开关的状态，导致"数据"开关联动打开"全部展开"后，热门股票列表
            // 实际并不会展开（因为读到的是早盘竞价开关的 checked 值，而不是热门股票自己的）。
            if (document.getElementById(_p + 'ExpandAllToggle')?.checked) {
                window.expandAllAuctionTrendPanels(_p);
            } else {
                // 否则恢复用户此前手动展开过的个别股票的趋势面板（避免刷新/轮询导致展开状态丢失）
                window.restoreExpandedAuctionTrendPanels(_p);
            }
            
            // 绑定表头点击事件（显示/隐藏搜索框）- 使用事件委托避免累积
            const headerRow = document.getElementById(_p + 'HeaderRow');
            if (headerRow && !headerRow._clickBound) {
                headerRow._clickBound = true;
                headerRow.addEventListener('click', function() {
                    const searchContainer = document.getElementById(_p + 'SearchContainer');
                    const searchInput = document.getElementById(_p + 'SearchInput');
                    if (searchContainer) {
                        searchContainer.classList.toggle('active');
                        if (searchContainer.classList.contains('active') && searchInput) {
                            searchInput.focus();
                        }
                    }
                });
            }
            
            // 绑定搜索输入事件 - 使用标记避免累积
            const searchInput = document.getElementById(_p + 'SearchInput');
            if (searchInput && !searchInput._inputBound) {
                searchInput._inputBound = true;
                searchInput.addEventListener('input', function() {
                    const keyword = this.value.trim().toLowerCase();
                    window.highlightAuctionSearch(keyword);
                });
            }
            
            window.renderAuctionPage2(dataSource);
            window.renderAuctionPage3(dataSource);
            window.renderAuctionStatsBoard(dataSource);
            window.initAuctionSwipe();
            // 恢复滚动位置，防止 Realtime 等回调触发重新渲染时跳回顶部
            window.scrollTo(0, _savedScrollY);
            requestAnimationFrame(function() { window.scrollTo(0, _savedScrollY); });
        }

        // 高亮搜索结果
        export function highlightAuctionSearch(keyword) {
            const items = document.querySelectorAll('.auction-item');
            items.forEach(item => {
                const stockName = item.querySelector('.auction-stock-name');
                if (stockName) {
                    const name = stockName.textContent.trim().toLowerCase();
                    if (keyword && name.includes(keyword)) {
                        item.classList.add('highlight-search');
                    } else {
                        item.classList.remove('highlight-search');
                    }
                }
            });
        }

        // 提取题材（从括号中提取，支持逗号和顿号分隔，支持中英文括号）
        export function extractTopics(note) {
            if (!note) return [];
            const matches = note.match(/[(（]([^)）]+)[)）]/g) || [];
            let topics = [];
            matches.forEach(m => {
                const content = m.replace(/[()（）]/g, '');
                const splitTopics = content.split(/[+，、,;；]/).map(t => t.trim()).filter(t => t);
                topics = topics.concat(splitTopics);
            });
            // [BUG-FIX 2026-07-26] 过滤掉开盘啦 API 返回的 "题材35/题材36/题材38" 等
            // 无具体含义的编号条目（正则 /^题材\d+$/ 匹配"题材35""题材36"等）。
            // 同时过滤纯数字、过短（单字符）以及明显占位符。
            topics = topics.filter(function(t) {
                if (!t) return false;
                if (/^题材\d+$/.test(t)) return false;        // 题材35 / 题材36
                if (/^\d+$/.test(t)) return false;          // 纯数字
                if (t.length < 2) return false;             // 单字符无意义
                if (t === '---' || t === '其它' || t === '其他') return false;
                return true;
            });
            // [BUG-FIX] 规范化去重：去所有空格+转小写作比较 key，保留首次出现的原始值
            // 防止 "AI芯片" 与 "AI 芯片" 等变体重复显示
            var _seen = new Set();
            var _deduped = [];
            topics.forEach(function(t) {
                var key = t.replace(/\s+/g, '').toLowerCase();
                if (!_seen.has(key)) { _seen.add(key); _deduped.push(t); }
            });
            return _deduped;
        }

        // 默认核心词库（与主程序数据备份_20260709_1031.json 同步，共 34 个）
        // [BUG-FIX 2026-07-26] 之前默认核心词只有 10 个且同义词不全，导致大量题材
        // 匹配不上核心词而全部落入"其它"。现按备份文件恢复完整核心词库。
        window.defaultCoreTopics = [
            { name: 'AI应用', synonyms: ['人工智能', 'AI', 'AI算力', '空间计算'] },
            { name: '机器人', synonyms: ['人形机器人', '工业机器人', '电机电控', '智元机器人', '机器视觉'] },
            { name: '商业航天', synonyms: ['航天', '卫星', '导航', '燃气轮机', '军工', '无人机', '航空发动机', '航天科技', '低空经济'] },
            { name: '液冷算力', synonyms: ['算力', '智算中心', '液冷', '服务器', '东数西算', '算力租赁'] },
            { name: '半导体', synonyms: ['芯片', '光刻机', '光刻胶', '洁净室', '存储', '光模块', 'RWA', 'GPU', '英伟达概念', '先进封装', '玻璃基板', '面板', '电子气体', 'OCS', 'MPO', 'CPO', '覆铜板', 'CCL', '电子树脂', '离子交换', 'OLED', '印制电路板', 'PCB', 'LED'] },
            { name: '新能源汽车', synonyms: ['新能源汽车', '新能源车', '电动车', '汽车零部件', '智能驾驶', '车载', '宁德时代', '混动', '插电混动', '增程式', '汽车整车', '智能座舱'] },
            { name: '医药', synonyms: ['创新药', '医疗器械', '中药', '疫苗', '生物制品', 'CXO', '医药商业', '医疗服务', '药店', '医药外包', '原料药', '血液制品', '减肥药', 'GLP-1', '细胞治疗', '基因治疗'] },
            { name: '军工', synonyms: ['国防', '武器', '兵器', '船舶', '航空', '航天军工', '军工电子', '军民融合', '大飞机', '国产航母'] },
            { name: '黄金', synonyms: ['贵金属'] },
            { name: '白酒', synonyms: ['酒类'] },
            { name: '锂电池', synonyms: ['锂矿', '碳酸锂', '电池', '固态电池', '电解液', '隔膜', '正极材料', '负极材料', '铜箔', '铝箔', '磷酸铁锂', '三元材料', '动力电池', '储能电池'] },
            { name: 'CPO', synonyms: ['光模块', '光连接', '硅光'] },
            { name: '零售', synonyms: ['商业百货'] },
            { name: '电力', synonyms: ['火电', '水电', '核电', '风电', '光伏', '储能', '特高压', '智能电网', '虚拟电厂', '充电桩', '电力设备', '电网', '输配电', '光伏设备', '风电设备', '核电设备', '火力发电', '水力发电', '核能', '太阳能', '新能源'] },
            { name: '并购重组', synonyms: ['重组', '借壳', '并购', '资产注入', '股权转让', '国资入股', '要约收购', '吸收合并', '分拆', '重组预案'] },
            { name: '化工', synonyms: ['化学', '化工原料', '塑料', '橡胶', '纤维', '涂料', '粘胶', '氟化工', '磷化工', '钛白粉', '维生素', '农药', '化纤'] },
            { name: '房地产', synonyms: ['地产'] },
            // [BUG-FIX 2026-07-26] 原备份里"新能源汽车"重复 2 次（第二条同义词偏向无人驾驶），
            // 之前被改名为"新能源汽车2"语义混乱。现独立成"智能驾驶"分类，并补全同义词。
            { name: '智能驾驶', synonyms: ['无人驾驶', '自动驾驶', '无人车', '车联网', '激光雷达', '毫米波雷达', 'HUD', '线控底盘', '车路协同'] },
            { name: '影视院线', synonyms: ['影视', '电影', '院线', '传媒', '游戏', '动漫', '短视频', '直播'] },
            { name: '小金属', synonyms: ['稀土', '钨', '钼', '锡', '锑', '锗', '镓', '铟', '钛', '锂', '钴', '镍'] },
            { name: '通信', synonyms: ['5G', '6G', '通信设备', '光通信', '物联网'] },
            { name: '一带一路', synonyms: ['基建', '建筑', '海外工程', '国际工程', '交通基建', '水利', '港口', '铁路', '公路', '桥梁', '隧道', '钢结构', '装饰', '园林', '建材', '工程机械', '工程咨询'] },
            { name: '电子元件', synonyms: ['电阻', '电容', '电感', '连接器', '继电器', '传感器'] },
            { name: '稳定币', synonyms: ['数字货币', '加密货币', '区块链', 'Web3', '跨境支付', '数字人民币', '央行数字货币', '比特币', '以太坊'] },
            { name: '脑机接口', synonyms: ['脑机', '神经接口'] },
            { name: '环保', synonyms: ['节能', '环保', '水处理', '固废处理', '大气治理', '土壤修复', '环境监测'] },
            { name: '华为概念', synonyms: ['华为', '鸿蒙', '欧拉'] },
            { name: '海峡两岸', synonyms: ['福建', '两岸', '台海'] },
            { name: '消费电子', synonyms: ['手机', '可穿戴', 'AR', 'VR'] },
            { name: '煤炭', synonyms: ['煤化工', '焦煤'] },
            { name: '农业', synonyms: ['种业', '化肥', '养殖', '饲料', '猪肉'] },
            { name: '足球概念', synonyms: ['足球'] },
            { name: '工业4.0', synonyms: ['工业互联网', '智能制造', '工业软件', '数控机床', '机器人'] },
            { name: '大消费', synonyms: ['食品', '饮料', '服装', '家电', '家居', '旅游', '酒店', '餐饮', '免税', '跨境电商', '零售'] }
        ];

        // ===== 核心词库云端同步（core_topics 表）=====
        // [BUG-FIX 2026-07-26] 核心词库之前只存 localStorage，换设备/清缓存就丢失，
        // 导致第二页题材分类全部落入"其它"。现新增 core_topics 表做云端持久化。
        window._coreTopicsCloudLoaded = false; // 云端核心词是否已加载完成
        window._coreTopicsPushingToCloud = false; // 正在推送核心词到云端（避免循环）

        // 从 core_topics 表全量读取核心词库
        export async function pullCoreTopicsFromCloud() {
            const sb = window.getSupabase();
            const { data, error } = await sb.from('core_topics')
                .select('name,synonyms,updated_at')
                .order('name', { ascending: true });
            if (error) throw error;
            if (!data || data.length === 0) return null; // 表为空
            return data.map(function(row) {
                let syns = row.synonyms;
                if (typeof syns === 'string') {
                    try { syns = JSON.parse(syns); } catch (e) { syns = syns.split(','); }
                }
                return { name: row.name, synonyms: Array.isArray(syns) ? syns : [] };
            });
        }

        // 把核心词库全量推送到 core_topics 表（先清空再插入，保持一致性）
        export async function pushCoreTopicsToCloud(topics) {
            const sb = window.getSupabase();
            // 先删除所有旧数据，再插入新数据（core_topics 表数据量小，全量替换最简单）
            const { error: delErr } = await sb.from('core_topics').delete().neq('name', '___never___');
            if (delErr) throw delErr;
            if (!topics || topics.length === 0) return;
            const rows = topics.map(function(t) {
                return {
                    name: t.name,
                    synonyms: JSON.stringify(t.synonyms || []),
                    updated_at: new Date().toISOString()
                };
            });
            const { error: insErr } = await sb.from('core_topics').insert(rows);
            if (insErr) throw insErr;
        }

        // 从云端加载核心词到 localStorage（仅当云端有数据且本地为空/不一致时）
        // [BUG-FIX 2026-07-26] 之前云端返回空数组或异常时也会覆盖本地，导致核心词全丢。
        // 现在严格校验：云端必须返回非空且每个元素都有 name 字段才覆盖本地。
