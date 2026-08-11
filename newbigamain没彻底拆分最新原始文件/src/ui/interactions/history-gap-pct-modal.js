    // 弹窗上下文：记录哪个 tab、哪个按钮触发了模式选择
    let _historyGapPctCtx = { btn: null, tab: 'auction' };
    let _historyGapPctModalOpen = false; // [BUG-FIX] 防重复弹出标志
    export function openHistoryGapPctModeModal(btn, tab) {
        if (_historyGapPctModalOpen) return; // 防重复触发（事件冒泡/键盘Enter导致弹两次）
        _historyGapPctModalOpen = true;
        _historyGapPctCtx = { btn: btn, tab: tab || 'auction' };
        const modal = document.getElementById('historyGapPctModeModal');
        if (modal) modal.classList.add('active');
        // 悬停提示
        const fillBtn = document.getElementById('historyGapPctFillBtn');
        const owBtn = document.getElementById('historyGapPctOverwriteBtn');
        const desc = document.getElementById('historyGapPctModeDesc');
        if (fillBtn) fillBtn.onmouseenter = function(){ if(desc) desc.textContent = '补全模式：从起点日起，只对涨幅为空（断点）的交易日拉取K线并写入。已有涨幅的日期保持不变。'; };
        if (owBtn) owBtn.onmouseenter = function(){ if(desc) desc.textContent = '覆盖模式：从起点日起，对所有交易日（含已有涨幅的日期）重新拉取K线、重算涨幅并覆盖写入。用于修正之前不正确或不完整的涨幅数据。'; };
    }
    export function closeHistoryGapPctModeModal() {
        _historyGapPctModalOpen = false; // [BUG-FIX] 重置防重复标志（点击遮罩关闭时也要重置）
        const modal = document.getElementById('historyGapPctModeModal');
        if (modal) modal.classList.remove('active');
    }
    export function confirmHistoryGapPctMode(mode) {
        if (!_historyGapPctModalOpen) return; // 防重复确认
        _historyGapPctModalOpen = false;
        const ctx = _historyGapPctCtx;
        window.closeHistoryGapPctModeModal();
        if (ctx.tab === 'hot') {
            window.fillHotHistoryGapPctFromThs(ctx.btn, mode);
        } else {
            window.fillAuctionHistoryGapPctFromThs(ctx.btn, mode);
        }
    }
