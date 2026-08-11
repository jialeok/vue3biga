        export function toggleAuctionRowSelect(index) {
            const auctionList = window.getTodayGroupList(window.currentGroup);
            if (auctionList[index]) {
                // 方案 B：用 deriveAuctionTagState 判断是否有标签（买/卖/持=锁定，不能手动取消）
                const _stockName = auctionList[index].stock ? auctionList[index].stock.trim() : '';
                const _ts = window.deriveAuctionTagState(_stockName, window.currentDate);
                if (_ts.sold || _ts.bought || _ts.selected) {
                    return;
                }
                // 无标签的行：切换手动点选状态
                auctionList[index].selected = !auctionList[index].selected;
                window.saveData();
                window.renderAuction();
            }
        }

        // 清除指定股票的固定状态（当股票从列表中删除时调用）
        export function clearAuctionFixedState(stockName) {
            // 方案 B：bought/sold/fixed 不再存储在 auctionData 上，无需清除。
            // 仅清 selected（手动点选），让该行回到无标记状态。
            const auctionList = window.getTodayAuction();
            const auctionItem = auctionList.find(item => item.stock && item.stock.trim() === stockName.trim());
            if (auctionItem && auctionItem.selected === true) {
                auctionItem.selected = false;
                window.saveData();
                window.renderAuction();
            }
        }

        // 清除所有行的选中状态
        export function clearAllAuctionSelections() {
            // 清除数据中的 selected 状态
            const auctionList = window.getTodayGroupList(window.currentGroup);
            let hasSelection = false;
            auctionList.forEach(item => {
                if (item.selected) {
                    item.selected = false;
                    hasSelection = true;
                }
            });
            
            // 清除页面上的 highlight-search 类（跳转高亮）
            document.querySelectorAll('.auction-item.highlight-search').forEach(el => {
                el.classList.remove('highlight-search');
            });
            
            // 清除第二页的 highlight-search 类
            document.querySelectorAll('.auction-topic-row.highlight-search').forEach(el => {
                el.classList.remove('highlight-search');
            });
            
            // 只要有选中状态或高亮，就保存并重新渲染
            if (hasSelection) {
                window.saveData();
                window.renderAuction();
            }
        }

        // 显示注释输入框
        export function showAuctionNoteInput(index, element) {
            const auctionList = window.getTodayGroupList(window.currentGroup);
            const currentNote = window.getDisplayNote(auctionList[index]);
            const note = prompt('请输入注释（如涨幅）：', currentNote);
            if (note !== null) {
                // 将中文标点转换为英文逗号（节省空间）
                const normalizedNote = note.replace(/[，、;；]/g, ',');
                auctionList[index].note = normalizedNote;
                // 重新解析 note → changePct + topics，保持三字段同步
                var parsed = window.parseNoteToFields(normalizedNote);
                auctionList[index].changePct = parsed.changePct;
                auctionList[index].topics = parsed.topics;
                window.saveData();
                window.renderAuction();

                // 按 currentGroup 分支推送到对应的云表（hot_stocks / auction_watchlist），避免错误写入
                if (window.currentGroup === 'hot') {
                    // 字段级 PATCH：本次改了 note/changePct/topics 三个字段（对齐同函数 auction 分支的处理方式）
                    window.patchHotField(window.currentDate, auctionList[index].stock, {
                        note: normalizedNote,
                        change_pct: parsed.changePct,
                        topics: parsed.topics
                    }).catch(function(e) {
                        console.warn('window.patchHotField note 失败（window.showAuctionNoteInput）:', e);
                    });
                } else {
                    // 阶段二 C：改为字段级 patch，只更新 note/change_pct/topics 三字段
                    window.patchAuctionField(window.currentDate, auctionList[index].stock, {
                        note: normalizedNote,
                        change_pct: parsed.changePct,
                        topics: parsed.topics
                    }).catch(function(e) {
                        console.warn('window.patchAuctionField note 失败（window.showAuctionNoteInput）:', e);
                    });
                }

                // 同步更新已添加股票的收盘涨幅
                const stockName = auctionList[index].stock;
                window.syncStockCloseFromAuction(stockName, normalizedNote);

                // 同步推送到 stock_topics 表（按 stock 维度，跨日期共享），避免下次打开时题材丢失
                const topicsArr = window.extractTopics(normalizedNote);
                const scMap = window._scMapCache || {};
                const stockCode = scMap[stockName.trim()] || auctionList[index].code || '';
                window.pushStockTopicsToCloud(stockName, topicsArr, stockCode).catch(function(e) {
                    console.warn('window.pushStockTopicsToCloud 失败（window.showAuctionNoteInput）:', e);
                });

                // 同步更新股票列表中的题材，统一保存一次
                window.syncStockTopicsFromAuction();
                window.saveModule('stocks');

                window.renderList();
            }
        }
        
        // 显示注释弹窗
        export function showAuctionNotePopup(element, note) {
            // 检查是否已有弹窗显示同一个元素的注释
            const existingPopup = document.querySelector('.auction-note-popup[data-element]');
            if (existingPopup && existingPopup.dataset.element === element.dataset.index) {
                existingPopup.remove();
                return;
            }
            
            // 移除其他已有的弹窗
            document.querySelectorAll('.auction-note-popup').forEach(p => p.remove());
            
            const popup = document.createElement('div');
            popup.className = 'auction-note-popup';
            // 将中文标点转换为英文逗号（节省空间）
            const normalizedNote = note.replace(/[，、;；]/g, ',');
            popup.textContent = normalizedNote;
            popup.dataset.element = element.dataset.index || '';
            
            // 始终添加到 body 中，使用 fixed 定位，避免被其他看板覆盖
            // 先设为不可见再插入，使浏览器完成布局后才计算宽度
            popup.style.visibility = 'hidden';
            document.body.appendChild(popup);
            popup.style.position = 'fixed';
            const rect = element.getBoundingClientRect();
            // 此时 popup 已在文档中，offsetWidth 有正确值
            const popupW = popup.offsetWidth;
            let left = rect.left + rect.width / 2 - popupW / 2;
            // 防止超出屏幕左右边界
            left = Math.max(4, Math.min(left, window.innerWidth - popupW - 4));
            popup.style.left = left + 'px';
            popup.style.top = (rect.bottom + 4) + 'px';
            popup.style.visibility = '';
            
            // 滚动时关闭弹窗
            const scrollHandler = function() {
                popup.remove();
                document.removeEventListener('scroll', scrollHandler, true);
            };
            document.addEventListener('scroll', scrollHandler, true);
            
            // 点击弹窗关闭
            popup.addEventListener('click', function(e) {
                e.stopPropagation();
                e.preventDefault();
                popup.remove();
                document.removeEventListener('scroll', scrollHandler, true);
            });
            
            // 延迟绑定点击其他地方关闭，防止立即触发
            setTimeout(() => {
                document.addEventListener('click', function closePopup(e) {
                    if (!popup.contains(e.target)) {
                        popup.remove();
                        document.removeEventListener('click', closePopup);
                        document.removeEventListener('scroll', scrollHandler, true);
                    }
                });
            }, 100);
        }

        // 获取当日多板归类数据
