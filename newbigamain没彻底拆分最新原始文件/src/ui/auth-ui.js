        export function forceLogout() {
            window.stopSessionPoll();
            clearTimeout(window._pushDebounceTimer);
            window._sessionToken = null;
            localStorage.removeItem('unlocked');
            localStorage.removeItem('sessionToken');
            document.getElementById('kickedOverlay').style.display = 'flex';
        }

        export async function reloginFromKicked() {
            document.getElementById('kickedOverlay').style.display = 'none';
            const overlay = document.getElementById('passwordOverlay');
            overlay.style.opacity = '1';
            overlay.style.display = 'flex';
            document.getElementById('pwdInput').value = '';
            document.getElementById('pwdError').textContent = '';
            document.getElementById('syncStatus').innerHTML = '';
            setTimeout(() => { document.getElementById('pwdInput').focus(); }, 100);
        }

        export async function checkPassword() {
            const input = document.getElementById('pwdInput').value;
            const errEl = document.getElementById('pwdError');
            const statusEl = document.getElementById('syncStatus');
            if (!input) { errEl.textContent = '请输入密码'; return; }

            // 全程兜底：任何一步抛错都必须给出可见提示，杜绝"点了没反应"
            try {
                const hash = await window.sha256(input);
                if (hash !== window.PASSWORD_HASH) {
                    errEl.textContent = '❌ 密码错误，请重试';
                    document.getElementById('pwdInput').value = '';
                    return;
                }

                // 密码正确 — 生成新 token，覆盖云端，踢掉其他会话
                errEl.textContent = '';
                statusEl.innerHTML = '<span style="color:#60a5fa">🔄 正在登录并同步数据...</span>';
                window._sessionToken = window.generateToken();
                localStorage.setItem('unlocked', '1');
                localStorage.setItem('sessionToken', window._sessionToken);
                // 先写 token 踢掉旧会话（旧窗口收到后会停止推送）
                await window.writeSessionToken(window._sessionToken);
                // 等待旧窗口的防抖推送完成（防抖2秒 + 网络时间，留足余量）
                statusEl.innerHTML = '<span style="color:#60a5fa">🔄 等待数据同步完成...</span>';
                await new Promise(resolve => setTimeout(resolve, 3500));
                // 拉取云端数据
                await window.pullFromCloud();

                // 隐藏密码遮罩
                const overlay = document.getElementById('passwordOverlay');
                overlay.style.transition = 'opacity 0.4s';
                overlay.style.opacity = '0';
                setTimeout(() => { overlay.style.display = 'none'; }, 400);

                // 启动 session 轮询
                window.startSessionPoll();

                // 初始化应用
                window.initApp();
            } catch (e) {
                console.error('checkPassword 失败:', e);
                statusEl.innerHTML = '';
                errEl.textContent = '❌ 登录失败：' + (e && e.message ? e.message : String(e));
                return;
            }

            // 后台加载 daily_highlights 缓存（启用后 renderAuction 可推送高光到表，供刷新时秒级加载）
            window.pullDailyHighlights().then(function() { window.renderAuction(); }).catch(function(e) { window._dbgLog('[AUCTION-ERR] daily_highlights 加载失败 ' + (e && e.message || e)); });

            // 后台加载热门股票数据与高光缓存（Tab 切换前预拉取，避免切换瞬间等待）
            window.pullHotStocksHighlights().catch(function(e) { console.warn('hot_stocks_highlights 加载失败:', e.message); });
            // 后台加载热门股票：先迁移旧 hot_stocks 影子记录，再加载新表数据
            window.migrateHotStocksShadowToMetrics().then(function() {
                return window.loadHotStocksFromCloud();
            }).then(function() { if (typeof window.renderHotStocks === 'function') window.renderHotStocks(); }).catch(function(e) { console.warn('hot_stocks 加载失败:', e.message); });
            // 后台加载热门股票趋势图数据：先迁移旧表，再统一从 market_metrics(scope='hot') 加载
            window.migrateHotStocksToTrendsTable().then(function() {
                return window.migrateHotTrendsToMarketMetrics();
            }).then(function() {
                return window.loadHotTrendsFromCloud();
            }).then(function() { if (typeof window.renderHotStocks === 'function') window.renderHotStocks(); }).catch(function(e) { console.warn('hot trends 加载失败:', e.message); });

            // 预加载云端题材库（非阻塞，完成后重建缓存并刷新第二页）
            window.loadCloudTopics().then(function() { window.invalidateTopicCache(); window.buildTopicCache(); window.renderAuction(); }).catch(function() {});

            // 预加载云端股票代码映射（非阻塞，唯一真相源=stockcodemap 表）
            window.loadCloudStockCodeMap().then(function() { if (typeof window.renderAuction === 'function') window.renderAuction(); }).catch(function() {});
        }
