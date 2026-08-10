        export function formatTrendDateLabel(dateStr) {
            const parts = dateStr.split('-');
            return parts[1] + '-' + parts[2];
        }

        // 生成单张迷你SVG折线图的HTML（含数值和日期标注）
        // points: [{date, value}, ...]  value 为 null 表示当天无记录，断开连线
        // color: 线条/数字颜色
        export function renderMiniTrendSvg(points, color, opts) {
            opts = opts || {};
            const isPercent = opts.percent === true; // 百分比模式：正负值、0基准线、%后缀
            const width = 320;   // viewBox 宽度，配合 svg 的 width:100% 自适应容器实际宽度
            const height = 56;   // 折线绘制区域高度
            const paddingX = 28; // 左右留白，防止数值文字被裁切
            const paddingTop = 16;
            const paddingBottom = 8;

            const validValues = points.filter(p => p.value !== null).map(p => p.value);
            // 百分比模式下强制把 0 纳入取值范围，保证0基准线始终落在可视区间内
            let maxV = validValues.length ? Math.max(...validValues) : 1;
            let minV = validValues.length ? Math.min(...validValues) : 0;
            if (isPercent) {
                maxV = Math.max(maxV, 0);
                minV = Math.min(minV, 0);
            }
            const range = (maxV - minV) || 1;

            const n = points.length;
            const stepX = (width - paddingX * 2) / (n - 1 || 1);

            const coords = points.map((p, i) => {
                const x = paddingX + stepX * i;
                if (p.value === null) return { x, y: null };
                const y = paddingTop + (height - paddingTop - paddingBottom) * (1 - (p.value - minV) / range);
                return { x, y };
            });

            // 百分比模式：画一条0基准虚线，涨跌一目了然
            let zeroLineHtml = '';
            if (isPercent && minV < 0 && maxV > 0) {
                const zeroY = paddingTop + (height - paddingTop - paddingBottom) * (1 - (0 - minV) / range);
                zeroLineHtml = `<line x1="${paddingX.toFixed(1)}" y1="${zeroY.toFixed(1)}" x2="${(width - paddingX).toFixed(1)}" y2="${zeroY.toFixed(1)}" stroke="#cbd5e1" stroke-width="1" stroke-dasharray="2,2"/>`;
            }

            // 生成折线路径：遇到 null 就断开，分段绘制
            let pathSegments = [];
            let currentSeg = [];
            coords.forEach(c => {
                if (c.y === null) {
                    if (currentSeg.length > 1) pathSegments.push(currentSeg);
                    currentSeg = [];
                } else {
                    currentSeg.push(c);
                }
            });
            if (currentSeg.length > 1) pathSegments.push(currentSeg);

            const pathsHtml = pathSegments.map(seg => {
                const d = seg.map((c, i) => (i === 0 ? 'M' : 'L') + c.x.toFixed(1) + ',' + c.y.toFixed(1)).join(' ');
                return `<path d="${d}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`;
            }).join('');

            const dotsHtml = coords.map((c, i) => {
                if (c.y === null) return '';
                let dotColor = color;
                if (isPercent) {
                    const v = points[i].value;
                    dotColor = v > 0 ? '#dc2626' : (v < 0 ? '#16a34a' : '#64748b');
                }
                return `<circle cx="${c.x.toFixed(1)}" cy="${c.y.toFixed(1)}" r="2.6" fill="${dotColor}"/>`;
            }).join('');

            const valueLabelsHtml = coords.map((c, i) => {
                const p = points[i];
                if (p.value === null) {
                    return `<text x="${c.x.toFixed(1)}" y="${paddingTop - 4}" font-size="9" fill="#cbd5e1" text-anchor="middle">--</text>`;
                }
                let displayVal, labelColor;
                if (isPercent) {
                    const v = p.value;
                    displayVal = (v > 0 ? '+' : '') + v.toFixed(1) + '%';
                    labelColor = v > 0 ? '#dc2626' : (v < 0 ? '#16a34a' : '#64748b'); // 红涨绿跌，符合A股习惯
                } else {
                    displayVal = Math.round(p.value);
                    labelColor = color;
                }
                return `<text x="${c.x.toFixed(1)}" y="${(c.y - 6).toFixed(1)}" font-size="9" fill="${labelColor}" text-anchor="middle" font-weight="600">${displayVal}</text>`;
            }).join('');

            const dateLabelsHtml = coords.map((c, i) => {
                return `<text x="${c.x.toFixed(1)}" y="${height + 2}" font-size="8.5" fill="#94a3b8" text-anchor="middle">${formatTrendDateLabel(points[i].date)}</text>`;
            }).join('');

            return `
                <svg viewBox="0 0 ${width} ${height + 12}" style="width:100%; height:auto; display:block;">
                    ${zeroLineHtml}
                    ${pathsHtml}
                    ${dotsHtml}
                    ${valueLabelsHtml}
                    ${dateLabelsHtml}
                </svg>
            `;
        }

        // 生成整个趋势面板的HTML：竞价量图在上，昨日成交量图在下
        export function renderAuctionTrendHtml(history) {
            const volumePoints = history.map(h => ({ date: h.date, value: h.volume }));
            const yestPoints = history.map(h => ({ date: h.date, value: h.yestVolume }));
            const changePctPoints = history.map(h => ({ date: h.date, value: h.changePct !== undefined ? h.changePct : null }));

            const volumeSvg = renderMiniTrendSvg(volumePoints, '#6366f1'); // 靛蓝色：竞价量
            const yestSvg = renderMiniTrendSvg(yestPoints, '#10b981');    // 绿色：昨日成交量
            // 涨幅图颜色按点位涨跌各自上色（红涨绿跌），这里传入的 color 仅作为无数据兜底色
            const hasChangePctData = changePctPoints.some(p => p.value !== null);
            const changePctSvg = hasChangePctData ? renderMiniTrendSvg(changePctPoints, '#64748b', { percent: true }) : '';

            // 计算"今日竞价量 / 昨日竞价量"比值：history最后一项是今天，倒数第二项是昨天
            // 若昨天是断点（无数据）或昨日竞价量为0，则不显示比值
            let ratioHtml = '';
            let jingRatioForDiff = null; // 供下方差值计算复用
            if (history.length >= 2) {
                const todayVal = history[history.length - 1].volume;
                const yestVal = history[history.length - 2].volume;
                if (todayVal !== null && yestVal !== null && yestVal !== 0) {
                    jingRatioForDiff = todayVal / yestVal;
                    const ratio = jingRatioForDiff.toFixed(1);
                    ratioHtml = `<span style="color:#6366f1; font-weight:600;">今/昨比 ${ratio}</span>`;
                }
            }

            // 计算"昨日成交量 / 前日成交量"比值：history最后一项(今天)的yestVolume是"昨日成交量"，
            // 倒数第二项(昨天)的yestVolume是"前日成交量"
            // 若前日是断点（无数据）或前日成交量为0，则不显示比值
            let yestRatioHtml = '';
            let yestRatioForDiff = null; // 供下方差值计算复用
            if (history.length >= 2) {
                const yestVolumeVal = history[history.length - 1].yestVolume;
                const prevVolumeVal = history[history.length - 2].yestVolume;
                if (yestVolumeVal !== null && prevVolumeVal !== null && prevVolumeVal !== 0) {
                    yestRatioForDiff = yestVolumeVal / prevVolumeVal;
                    const yestRatio = yestRatioForDiff.toFixed(1);
                    yestRatioHtml = `<span style="color:#10b981; font-weight:600;">昨/前比 ${yestRatio}</span>`;
                }
            }

            // 差值 = 今/昨比 - 昨/前比，两个比值都能算出来时才显示，居中放在"竞价量"标题行中间（与"今/昨比"同一行）
            let diffHtml = '';
            if (jingRatioForDiff !== null && yestRatioForDiff !== null) {
                const diff = (jingRatioForDiff - yestRatioForDiff).toFixed(1);
                diffHtml = `<span style="color:#2563eb; font-weight:600;">差值 ${diff}</span>`;
            }

            return `
                <div style="padding: 6px 8px 8px; background: #f8fafc;">
                    <div style="font-size:10px; color:#94a3b8; margin-bottom:2px; display:flex; justify-content:space-between; align-items:center;">
                        <span>竞价量(万) 近5日</span>${diffHtml ? `<span style="flex:1; text-align:center;">${diffHtml}</span>` : '<span style="flex:1;"></span>'}${ratioHtml}
                    </div>
                    ${volumeSvg}
                    <div style="font-size:10px; color:#94a3b8; margin: 4px 0 2px; display:flex; justify-content:space-between; align-items:center;">
                        <span>昨日成交量(万) 近5日</span>${yestRatioHtml}
                    </div>
                    ${yestSvg}
                    ${hasChangePctData ? `
                    <div style="font-size:10px; color:#94a3b8; margin: 4px 0 2px; display:flex; justify-content:space-between; align-items:center;">
                        <span>涨幅(%) 近5日</span>
                    </div>
                    ${changePctSvg}
                    ` : ''}
                </div>
            `;
        }

