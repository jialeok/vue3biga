        // 延迟初始化，提高页面加载速度
        // 原有初始化逻辑封装为 _appInit()，由密码验证成功后调用
        export function _appInit() {
            // 禁用全局右键菜单和选择提示
            document.addEventListener('contextmenu', function(e) {
                // 允许输入框弹出系统菜单
                if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') {
                    return true;
                }
                e.preventDefault();
            });
            document.addEventListener('selectstart', function(e) {
                // 允许输入框内选择
                if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') {
                    return true;
                }
                e.preventDefault();
            });
            
            // 先加载数据
            window.loadAllData();

            // 如果已配置 fuyao API key，启动时自动同步一次近一年交易日历
            if (window.getAicubesApiKey()) {
                setTimeout(function() {
                    window.syncTradingDaysFromAPI().catch(function(e) { console.warn('自动同步交易日历失败', e); });
                }, 2000);
            }

            // 迁移 auction 数据到独立表（拆表后新增，首次运行时自动执行）
            window.migrateAuctionToTable();
            // 从旧 auction_data 表迁移到 auction_watchlist + market_metrics（拆表后新增，首次运行时自动执行）
            window.migrateAuctionDataToNewTables();
            // 迁移 bidding 数据到独立表（拆表后新增，首次运行时自动执行）
            window.migrateBiddingToTable();
            // 迁移 jiwang 数据到独立表（拆表后新增，首次运行时自动执行）
            window.migrateJiwangToTable();
            // 迁移旧 note 到 changePct + topics 字段（note 拆字段后新增，首次运行时自动执行）
            window.migrateNoteToFields();
            // [BUG-FIX 2026-07-26] 一次性清理本地数据中的"题材N"编号条目和超 20% 异常涨幅
            try { window.cleanupInvalidTopicsAndChangePct(); } catch (e) { window._dbgLog('[CLEANUP-ERR] ' + e); }

            // 加载第四页数据
            window.loadCopiedStocks();

            // [ISSUE#1 修复] 启动默认今天：不再无条件跳回 lastEditedDate。
            // 仅当 lastEditedDate 恰为今天时才沿用；否则保持启动时已设好的"今天"，
            // 不跳回旧日期（避免打开后停在 8/5 并向前串数据）。
            const lastEditedDate = localStorage.getItem('lastEditedDate_' + window.DATA_VERSION);
            const _bt = (typeof window._computeBeijingToday === 'function')
                ? window._computeBeijingToday()
                : (function () { const n = new Date(); const y = n.getFullYear(); const m = String(n.getMonth() + 1).padStart(2, '0'); const d = String(n.getDate()).padStart(2, '0'); return `${y}-${m}-${d}`; })();
            window._dbgLog('_appInit: 启动时 window.currentDate=' + window.currentDate + ', localStorage 记录的 lastEditedDate=' + lastEditedDate + ', 今天(北京)=' + _bt);
            if (lastEditedDate && lastEditedDate === _bt) {
                if (lastEditedDate !== window.currentDate) {
                    window._dbgLog('_appInit: window.currentDate 从 ' + window.currentDate + ' 跳转为 lastEditedDate=' + lastEditedDate);
                }
                window.setCurrentDate(lastEditedDate);
            }

            // 延迟执行数据初始化和渲染
            setTimeout(function() {
                window.renderList();
                window.renderMarketStage();
                window.initStockListCollapse();
                window.initScoreSliderClick();
                window.autoCalculateConsecutiveDays();
                window.autoCalculateRecentMultiScore();
                window.renderConsecutiveUp();
                window.autoTagShunshiNishi(); // 根据竞价变化自动打标顺势/逆势
                window.renderAuctionPage4(); // 渲染第四页
                window.renderEmotionBoard(); // 渲染情绪看板（首次快速展示缓存/空状态）
            }, 50);
            
            // 监听页面可见性变化，当切换回页面时重新加载数据（避免多标签页数据不同步）
            document.addEventListener('visibilitychange', function() {
                if (document.visibilityState === 'visible') {
                    window._dbgLog('visibilitychange: 切回前台, window.currentDate=' + window.currentDate);
                    // 强制重新从localStorage加载数据
                    window.allData = null;
                    window.loadAllData();
                    // 重新渲染当前页面
                    window.renderList();
                    // 重新计算顺势/逆势标签
                    window.autoTagShunshiNishi();
                    // bidding 已是纯云端表：手机切到后台一段时间后，Realtime 的
                    // WebSocket 订阅常会断线且不一定自动重连，切回前台时主动
                    // 补拉一次当天数据，避免看到过期的内存缓存
                    window.pullBiddingForDate(window.currentDate).then(function() {
                        window.renderBidding();
                    }).catch(function(e) { console.warn('切回前台重新拉取 bidding 失败:', e.message); });
                    // 情绪看板：纯云端表，切回前台时补拉一次避免 WebSocket 断线导致过期
                    window._emotionDataCache = null;
                    window.loadEmotionData(window.currentDate).then(function() {
                        window.renderEmotionBoard();
                    }).catch(function(e) { console.warn('切回前台重新加载情绪看板失败:', e.message); });
                    // jiwang 同理：也是纯云端表 + Realtime 订阅，手机切后台一段时间
                    // WebSocket 断线后不一定自动重连，之前这里漏掉了 jiwang 的补拉，
                    // 导致"切回前台一段时间后再操作/翻页"看到的是过期的内存缓存
                    // （表现为"记忘看板"和"空仓行情"卡片数据像是丢失了）。
                    // 跳过本地有未推送完成编辑的日期，避免用云端旧值覆盖刚编辑的内容。
                    const jiwangPending = (window._jiwangDirtyDates && window._jiwangDirtyDates.has(window.currentDate)) ||
                        (window._jiwangPushTimers && window._jiwangPushTimers[window.currentDate]);
                    const _beforePull = JSON.stringify(window.getJiwangData()[window.currentDate] || null).slice(0, 200);
                    window._dbgLog('visibilitychange: jiwangPending=' + jiwangPending + ', 拉取前 ' + window.currentDate + ' 缓存=' + _beforePull);
                    if (!jiwangPending) {
                        window.pullJiwangForDate(window.currentDate).then(function() {
                            const _afterPull = JSON.stringify(window.getJiwangData()[window.currentDate] || null).slice(0, 200);
                            window._dbgLog('visibilitychange: 拉取完成, ' + window.currentDate + ' 拉取后缓存=' + _afterPull);
                            window.renderJiwang();
                            if (typeof window.renderMarketStage === 'function') window.renderMarketStage();
                        }).catch(function(e) {
                            console.warn('切回前台重新拉取 jiwang 失败:', e.message);
                            window._dbgLog('visibilitychange: 切回前台重新拉取 jiwang 失败: ' + (e && e.message));
                            window.showWarningToast('⚠️ 记忘看板拉取失败，当前显示的可能是过期数据。原因: ' + (e && e.message || e), 8000);
                        });
                    } else {
                        window._dbgLog('visibilitychange: ' + window.currentDate + ' 有本地待推送编辑，跳过拉取覆盖');
                    }
                }
            });
            
            // 阻止最近多板早盘竞价看板的浏览器翻页行为
            function preventSwipeNavigation() {
                const auctionBoard = document.getElementById('auctionBoard');
                if (!auctionBoard) return;
                
                let startX = 0;
                let startY = 0;
                let isHorizontalSwipe = false;
                
                auctionBoard.addEventListener('touchstart', function(e) {
                    startX = e.touches[0].clientX;
                    startY = e.touches[0].clientY;
                    isHorizontalSwipe = false;
                }, { passive: true });
                
                auctionBoard.addEventListener('touchmove', function(e) {
                    if (e.touches.length === 0) return;
                    
                    const currentX = e.touches[0].clientX;
                    const currentY = e.touches[0].clientY;
                    const deltaX = currentX - startX;
                    const deltaY = currentY - startY;
                    
                    // 判断是否为水平滑动
                    if (Math.abs(deltaX) > 10 && Math.abs(deltaX) > Math.abs(deltaY)) {
                        isHorizontalSwipe = true;
                        e.preventDefault();
                        e.stopPropagation();
                        return false;
                    }
                }, { passive: false });
                
                auctionBoard.addEventListener('touchend', function(e) {
                    if (isHorizontalSwipe) {
                        e.preventDefault();
                        e.stopPropagation();
                    }
                    isHorizontalSwipe = false;
                }, { passive: false });
            }
            window.preventSwipeNavigation = preventSwipeNavigation;
            
            // 延迟执行防止翻页绑定
            setTimeout(window.preventSwipeNavigation, 100);
            
            // 为本月统计按钮添加事件监听器
            const monthlyStatsBtn = document.getElementById('monthlyStatsBtn');
            if (monthlyStatsBtn) {
                monthlyStatsBtn.addEventListener('click', function(e) {
                    e.preventDefault();
                    e.stopPropagation();
                    window.showMonthlyStats();
                });
            }
            
            // 为第四页全部清除按钮添加事件监听器
            const auctionClearAllBtn = document.getElementById('auctionClearAllBtn');
            if (auctionClearAllBtn) {
                auctionClearAllBtn.addEventListener('click', function(e) {
                    e.preventDefault();
                    e.stopPropagation();
                    window.clearAllCopiedStocks();
                });
            }
            const hotClearAllBtn = document.getElementById('hotClearAllBtn');
            if (hotClearAllBtn) {
                hotClearAllBtn.addEventListener('click', function(e) {
                    e.preventDefault();
                    e.stopPropagation();
                    window.clearAllCopiedStocks();
                });
            }
            window._initEventBusSubscriptions();
        }  // end window._appInit

// ============================================================
// 事件总线订阅 — UI 层监听 data/logic 层事件
// ============================================================
export function _initEventBusSubscriptions() {
    // data 层 Realtime 更新 → UI 层重渲染
    window._on('data:realtime-update', function(data) {
        if (!data || !data.boards || data.boards === 'all') {
            // [RESILIENT-RENDER] 事件总线全量刷新：各看板隔离渲染，单一看板抛错不再中断其它
            const _safeAll = (label, fn) => { try { fn(); } catch (e) { if (window._dbgLog) window._dbgLog('[ALL-RENDER] ' + label + ' 失败（已隔离）: ' + (e && e.message)); } };
            _safeAll('renderList', () => window.renderList && window.renderList());
            _safeAll('renderJiwang', () => window.renderJiwang && window.renderJiwang());
            _safeAll('renderRank', () => window.renderRank && window.renderRank());
            _safeAll('renderAuction', () => window.renderAuction && window.renderAuction());
            _safeAll('renderMulti', () => window.renderMulti && window.renderMulti());
            _safeAll('renderHotspot', () => window.renderHotspot && window.renderHotspot());
            _safeAll('renderPattern', () => window.renderPattern && window.renderPattern());
            _safeAll('renderBidding', () => window.renderBidding && window.renderBidding());
            _safeAll('renderDuiban', () => window.renderDuiban && window.renderDuiban());
            _safeAll('renderEmotionBoard', () => window.renderEmotionBoard && window.renderEmotionBoard());
            if (typeof window.renderEtf === 'function') { try { window.renderEtf(); } catch (e) { if (window._dbgLog) window._dbgLog('[ALL-RENDER] renderEtf 失败（已隔离）: ' + (e && e.message)); } }
            return;
        }
        var b = data.boards;
        if (b === 'auction') window.renderAuction();
        else if (b === 'jiwang') window.renderJiwang();
        else if (b === 'bidding') window.renderBidding();
        else if (b === 'hot' && typeof window.renderHotStocks === 'function') window.renderHotStocks();
        else if (b === 'marketStage' && typeof window.renderMarketStage === 'function') window.renderMarketStage();
    });

    // toast 通知
    window._on('ui:toast', function(data) {
        if (data && data.type === 'warning' && typeof window.showWarningToast === 'function') {
            window.showWarningToast(data.msg, data.duration || 3000);
        } else if (data && data.type === 'success' && typeof window.showToast === 'function') {
            window.showToast(data.msg);
        }
    });

    // 强制登出
    window._on('auth:force-logout', function() {
        if (typeof window.forceLogout === 'function') window.forceLogout();
    });

    // data 层检测到云端变化 → logic 层拉取云端数据 → 重新加载并通知 UI
    window._on('data:cloud-changed', function() {
        if (typeof window.pullFromCloud !== 'function') return;
        window.pullFromCloud().then(function() {
            window.allData = null; window.loadAllData();
            window._emit('data:realtime-update', { boards: 'all' });
            window._dbgLog('Realtime: pullFromCloud 完成并已重新渲染');
        }).catch(function(e) { window._dbgLog('Realtime: pullFromCloud 失败: ' + (e && e.message)); });
    });
}
