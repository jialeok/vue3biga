        // ============================================================
        // 页面启动入口：检查登录状态，决定是否跳过密码
        // 存储改为 localStorage（原为 sessionStorage，导致部分手机浏览器"刷新"等同于
        // 关标签页重开，sessionStorage 被清空，每次都要重新输密码）。
        // 为避免"被踢下线后刷新绕过踢人逻辑"，恢复登录前会先向云端校验 token 是否仍然有效。
        window.addEventListener('DOMContentLoaded', async function() {
            // 一次性迁移：老用户 localStorage 里还没有登录态，但 sessionStorage 里有（同一次会话内），直接迁移，不用重新输密码
            if (localStorage.getItem('unlocked') !== '1' && sessionStorage.getItem('unlocked') === '1') {
                localStorage.setItem('unlocked', '1');
                const oldToken = sessionStorage.getItem('sessionToken');
                if (oldToken) localStorage.setItem('sessionToken', oldToken);
            }

            if (localStorage.getItem('unlocked') === '1') {
                // 已解锁：直接恢复 session token 并重启轮询。
                // 注：不在此处向云端主动校验 token 是否被顶替——那样做会形成自我放大的问题
                // （只要有一次因任何原因重新登录生成新 token，本地保留旧 token 的会话就会被
                // 误判为"已被踢"而强制重新登录，越用越容易弹密码框）。
                // "被其他设备登录后本会话被踢出"这件事，已经由 startSessionPoll() 里的
                // Realtime 订阅实时处理（对方一登录，这边会立刻收到通知并登出），
                // 不需要在每次刷新时再做一次主动网络校验。
                const savedToken = localStorage.getItem('sessionToken');
                if (!savedToken) {
                    localStorage.removeItem('unlocked');
                    document.getElementById('passwordOverlay').style.display = 'flex';
                    setTimeout(function() { document.getElementById('pwdInput').focus(); }, 300);
                    return;
                }

                window._sessionToken = savedToken;
                window.startSessionPoll();
                document.getElementById('passwordOverlay').style.display = 'none';
                window._appInit();
                // [TOGGLE-PERSIST] 恢复排序开关勾选状态（在任何 renderAuction 之前），
                // 使刷新后开启的 toggle 立即生效（排序/高光）。后续 renderAuction 会读到恢复后的 DOM checkbox。
                if (typeof window._restoreAndApplySortToggles === 'function') {
                    window._restoreAndApplySortToggles();
                }
                // 刷新场景：先快速加载 highlights 缓存（小表，秒开），立即刷新竞/昨显示
                window.pullDailyHighlights().then(function() {
                    window.renderAuction();
                }).catch(function(e) { window._dbgLog('[AUCTION-ERR] daily_highlights 加载失败 ' + (e && e.message || e)); });
                // 快速加载当天竞价变化数据（单日查询，秒开），不必等 pullFromCloud 全量拉取
                if (typeof window.pullBiddingForDate === 'function') {
                    window.pullBiddingForDate(window.currentDate).then(function() {
                        if (typeof window.renderBidding === 'function') window.renderBidding();
                    }).catch(function(e) { window._dbgLog('[BIDDING] 首屏快速加载失败 ' + (e && e.message || e)); });
                }
                // 热门股票数据存在独立的 hot_stocks 表中，不在 pullFromCloud() 拉取的 user_data blob 里，
                // 必须单独加载，否则刷新页面后"热门股票"分组会一直显示为空（数据其实还在云端）
                // （Realtime 订阅已在上面的 startSessionPoll() 里启动，这里只需要补上遗漏的初始数据加载）
                window.pullHotStocksHighlights().catch(function(e) { console.warn('hot_stocks_highlights 加载失败:', e.message); });
                window.loadHotStocksFromCloud().then(function() {
                    if (typeof window.renderHotStocks === 'function') window.renderHotStocks();
                }).catch(function(e) { console.warn('hot_stocks 加载失败:', e.message); });
                // [BUG-FIX 2026-07-26] 从 core_topics 表加载/同步核心词库（之前从未调用，
                // 导致核心词管理数据只存 localStorage，换设备/清缓存后全部丢失）
                if (typeof window.loadCoreTopicsFromCloud === 'function') {
                    window.loadCoreTopicsFromCloud().then(function() {
                        if (typeof window.renderCoreTopicList === 'function') window.renderCoreTopicList();
                        if (typeof window.renderAuction === 'function') window.renderAuction();
                    }).catch(function(e) { console.warn('core_topics 加载失败:', e && e.message || e); });
                }
                // 后台拉取全量数据（慢），完成后刷新所有页面
                window.pullFromCloud().then(function() {
                    window.allData = null; window.loadAllData();
                    // [PERF-AUCTION] 避免 pullDailyHighlights 已渲染过一次后，pullFromCloud
                    // 再触发第二次完全相同的 renderAuction 导致同帧内 computed 重算两次。
                    // 通过当前日期列表指纹判断 auctionData 是否真的变化；无变化则跳过 renderAuction。
                    const __auctionFpBefore = (function() {
                        const list = window.getAuctionData()[window.currentDate] || [];
                        const names = list.map(function(s) { return s && s.stock ? s.stock.trim() : ''; }).filter(Boolean).sort().join(',');
                        return window.currentDate + ':' + list.length + ':' + names;
                    })();
                    window.renderList(false, true); window.renderJiwang(); window.renderRank();
                    const __auctionFpAfter = (function() {
                        const list = window.getAuctionData()[window.currentDate] || [];
                        const names = list.map(function(s) { return s && s.stock ? s.stock.trim() : ''; }).filter(Boolean).sort().join(',');
                        return window.currentDate + ':' + list.length + ':' + names;
                    })();
                    if (__auctionFpAfter !== __auctionFpBefore) {
                        window.renderAuction();
                        window._dbgLog('[PERF-AUCTION] window.pullFromCloud 后 auctionData 变化，执行 window.renderAuction');
                    } else {
                        window._dbgLog('[PERF-AUCTION] window.pullFromCloud 后 auctionData 未变化，跳过重复 window.renderAuction');
                    }
                    // [RESILIENT-RENDER] 初始加载链路：各看板渲染互相隔离，单一看板抛错
                    // 不再中断后续（尤其竞价变化看板 renderBidding，必须一定能渲染）。
                    const _safeInit = (label, fn) => { try { fn(); } catch (e) { if (window._dbgLog) window._dbgLog('[INIT-RENDER] ' + label + ' 失败（已隔离）: ' + (e && e.message)); } };
                    _safeInit('renderMulti', () => window.renderMulti && window.renderMulti());
                    _safeInit('renderHotspot', () => window.renderHotspot && window.renderHotspot());
                    _safeInit('renderPattern', () => window.renderPattern && window.renderPattern());
                    _safeInit('renderBidding', () => window.renderBidding && window.renderBidding());
                    window.renderDuiban();
                    window.renderEmotionBoard();
                    if (typeof window.renderEtf === 'function') window.renderEtf();
                }).catch(function(e) { window._dbgLog('[AUCTION-ERR] background window.pullFromCloud ' + (e && e.message || e)); });
            } else {
                // 未解锁：显示密码框，自动聚焦
                setTimeout(function() {
                    const pwdInput = document.getElementById('pwdInput');
                    if (pwdInput) pwdInput.focus();
                }, 300);
            }
        });
