        // "连续竞跌天数"：从 T 日开始往回看，连续 volume 递减（允许相等）的天数。
        // 最多看 5 天（T..T-5 共 6 个数据点）。
        // 若序列全等（无严格递减），天数为 0。
        // 返回 Map<股票名称, 下跌天数>。
        export function getThreeDayJingDieSet(dateStr, dataSource='auction') {
            const __k = 'tdjd|' + (dataSource || 'auction') + '|' + dateStr;
            const __sc = window._signalCache;
            let __fp = null;
            if (__sc && window._signalFpFor) {
                __fp = window._signalFpFor(dateStr, dataSource);
                const __e = __sc[__k];
                if (__e && __e.fp === __fp) return __e.value;
            }
            const MAX_DAYS = 5;
            const auctionData = window.getGroupData(dataSource);
            const todayList = auctionData[dateStr] || [];
            const result = new Map();
            todayList.forEach(item => {
                if (!item || !item.stock) return;
                const name = item.stock.trim();
                const vol0 = window.getNumericVolume(item.volume);
                if (vol0 === null || vol0 <= 0) return;
                let curDate = dateStr;
                let curVol = vol0;
                let declineDays = 0;
                let hasStrictDecline = false;
                for (let i = 0; i < MAX_DAYS; i++) {
                    const prevDate = window.getPreviousTradingDay(curDate);
                    if (!prevDate) break;
                    const prevVol = window.getStockHistoryValue(prevDate, name, 'volume', dataSource);
                    if (prevVol === null || prevVol <= 0) break;
                    if (curVol <= prevVol) {
                        declineDays++;
                        if (curVol < prevVol) hasStrictDecline = true;
                        curDate = prevDate;
                        curVol = prevVol;
                    } else {
                        break;
                    }
                }
                if (declineDays > 0 && hasStrictDecline) {
                    result.set(name, declineDays);
                }
            });
            if (__sc && __fp !== null) __sc[__k] = { fp: __fp, value: result };
            return result;
        }
