// boards-multi.js — 从 boards-render.js 拆分（看板域: boards-multi.js）

        // 判断第一列是否需要特殊样式
        export function needsSpecialStyle(str) {
            if (!str || str.trim() === '') return false;
            
            // 判断是否包含数字（包括括号内的数字）
            // 匹配如：常山北明（6）、中毅达7、ai应用0等
            const hasNumberOrParentheses = /\d|\(|\)/.test(str);
            
            return hasNumberOrParentheses;
        }

        // 渲染题材分类看板 - 修改为一行四列

        // 渲染题材分类看板 - 修改为一行四列
        export function renderMulti() {
            const multiList = window.getTodayMulti();
            const multiContent = document.getElementById('multiContent');
            
            if (multiList.length === 0) {
                multiContent.innerHTML = '<div style="text-align:center;padding:20px;color:#9ca3af;font-size:13px">暂无归类数据</div>';
                return;
            }
            
            // 保存当前选择状态（如果是选择模式）
            const wasSelectMode = multiContent.classList.contains('select-mode');
            const savedSelections = wasSelectMode && window.selectedCopyRows ? new Set(window.selectedCopyRows) : null;
            
            let html = '';
            
            multiList.forEach((item, index) => {
                // 处理空行
                if (item.isEmpty) {
                    const bgColor = item.isWhite === false ? '#f1f5f9' : '#ffffff';
                    html += `<div class="multi-row" data-row-index="${index}" style="height:15px;background:${bgColor};margin-bottom:0;"></div>`;
                    return;
                }
                
                // 处理标题行
                if (item.isTitle) {
                    const stocks = item.stocks || ['', '', '', ''];
                    html += `<div class="multi-row multi-title-row" data-row-index="${index}" style="background:#eff6ff;border-bottom:1px solid #bfdbfe;">
                        <div class="multi-stocks">
                            <div class="multi-stock-item" style="font-weight:600;color:#2563eb;">${stocks[0] || ''}</div>
                            <div class="multi-stock-item" style="font-weight:600;color:#1f2937;font-size:12px;">${stocks[1] || ''}</div>
                            <div class="multi-stock-item"></div>
                            <div class="multi-stock-item"></div>
                        </div>
                    </div>`;
                    return;
                }
                
                const stocks = item.stocks || ['', '', '', '']; // 修改为4个元素
                
                // 判断第一列是否需要整行特殊样式
                const firstStock = stocks[0] || '';
                const needsRowSpecialStyle = window.needsSpecialStyle(firstStock);
                const rowClass = needsRowSpecialStyle ? 'multi-row-special' : '';
                
                // 如果是选择模式且该行已被选中，添加 selected 类
                const isSelected = savedSelections && savedSelections.has(index);
                const selectedClass = isSelected ? 'selected' : '';
                
                html += `
                    <div class="multi-row ${rowClass} ${selectedClass}" data-row-index="${index}">
                        <div class="multi-stocks">
                `;
                
                // 遍历每个股票（一行四个）
                stocks.forEach((stock, colIndex) => {
                    if (stock && stock.trim() !== '') {
                        html += `<div class="multi-stock-item" title="${stock}">${stock}</div>`;
                    } else {
                        // 空项也占位
                        html += `<div class="multi-stock-item"></div>`;
                    }
                });
                
                html += `
                        </div>
                    </div>
                `;
            });
            
            multiContent.innerHTML = html;
            
            // 如果是选择模式，只添加样式和属性，不绑定单独的onclick事件
            // 因为 startSelectCopyToDate 已经通过事件委托处理了点击
            if (multiContent.classList.contains('select-mode')) {
                const rows = multiContent.querySelectorAll('.multi-row');
                rows.forEach((row, index) => {
                    row.classList.add('selectable');
                    row.dataset.rowIndex = index;
                });
            }
        }

        // 打开多板个股归类编辑 - 修改为一行四个输入框

        // 打开多板个股归类编辑 - 修改为一行四个输入框
        export function openMultiEdit() {
            const multiList = window.getTodayMulti();
            const formContainer = document.getElementById('multiFormContainer');
            
            let html = '';
            if (multiList.length === 0) {
                html = `
                    <div class="multi-form-row" id="multi-row-0">
                        <div class="form-group multi-form-stock">
                            <input type="text" class="form-input" name="stock1-0" placeholder="股票1/分类">
                        </div>
                        <div class="form-group multi-form-stock">
                            <input type="text" class="form-input" name="stock2-0" placeholder="股票2">
                        </div>
                        <div class="form-group multi-form-stock">
                            <input type="text" class="form-input" name="stock3-0" placeholder="股票3">
                        </div>
                        <div class="form-group multi-form-stock">
                            <input type="text" class="form-input" name="stock4-0" placeholder="股票4">
                        </div>
                        <button type="button" class="remove-rank-btn" onclick="window.removeMultiRow(0)">×</button>
                    </div>
                `;
            } else {
                multiList.forEach((item, index) => {
                    // 处理空行
                    if (item.isEmpty) {
                        const bgColor = item.isWhite === false ? '#f1f5f9' : '#ffffff';
                        const isWhiteAttr = item.isWhite !== false ? 'data-is-white="true"' : '';
                        html += `
                            <div class="multi-form-row multi-empty-row" id="multi-row-${index}" style="height:20px;background:${bgColor};border:none;" ${isWhiteAttr}>
                                <div class="form-group multi-form-stock" style="visibility:hidden;">
                                    <input type="text" class="form-input" name="stock1-${index}">
                                </div>
                                <div class="form-group multi-form-stock" style="visibility:hidden;">
                                    <input type="text" class="form-input" name="stock2-${index}">
                                </div>
                                <div class="form-group multi-form-stock" style="visibility:hidden;">
                                    <input type="text" class="form-input" name="stock3-${index}">
                                </div>
                                <div class="form-group multi-form-stock" style="visibility:hidden;">
                                    <input type="text" class="form-input" name="stock4-${index}">
                                </div>
                                <button type="button" class="remove-rank-btn" onclick="window.removeMultiRow(${index})">×</button>
                            </div>
                        `;
                        return;
                    }
                    
                    // 处理标题行
                    if (item.isTitle) {
                        const stocks = item.stocks || ['', '', '', ''];
                        html += `
                            <div class="multi-form-row multi-title-row" id="multi-row-${index}" style="background:#eff6ff;border-bottom:1px solid #bfdbfe;" onclick="window.selectFormRow(${index})">
                                <div class="form-group multi-form-stock">
                                    <input type="text" class="form-input" name="stock1-${index}" value="${stocks[0] || ''}" placeholder="标题" style="font-weight:600;color:#2563eb;">
                                </div>
                                <div class="form-group multi-form-stock">
                                    <input type="text" class="form-input" name="stock2-${index}" value="${stocks[1] || ''}" placeholder="时间" style="font-weight:600;color:#1f2937;">
                                </div>
                                <div class="form-group multi-form-stock">
                                    <input type="text" class="form-input" name="stock3-${index}" value="${stocks[2] || ''}" placeholder="股票3">
                                </div>
                                <div class="form-group multi-form-stock">
                                    <input type="text" class="form-input" name="stock4-${index}" value="${stocks[3] || ''}" placeholder="股票4">
                                </div>
                                <button type="button" class="remove-rank-btn" onclick="window.removeMultiRow(${index})">×</button>
                            </div>
                        `;
                        return;
                    }
                    
                    const stocks = item.stocks || ['', '', '', ''];
                    html += `
                        <div class="multi-form-row" id="multi-row-${index}" onclick="window.selectFormRow(${index})">
                            <div class="form-group multi-form-stock">
                                <input type="text" class="form-input" name="stock1-${index}" value="${stocks[0] || ''}" placeholder="股票1/分类">
                            </div>
                            <div class="form-group multi-form-stock">
                                <input type="text" class="form-input" name="stock2-${index}" value="${stocks[1] || ''}" placeholder="股票2">
                            </div>
                            <div class="form-group multi-form-stock">
                                <input type="text" class="form-input" name="stock3-${index}" value="${stocks[2] || ''}" placeholder="股票3">
                            </div>
                            <div class="form-group multi-form-stock">
                                <input type="text" class="form-input" name="stock4-${index}" value="${stocks[3] || ''}" placeholder="股票4">
                            </div>
                            <button type="button" class="remove-rank-btn" onclick="window.removeMultiRow(${index})">×</button>
                        </div>
                    `;
                });
            }
            
            formContainer.innerHTML = html;
            document.getElementById('multiModal').classList.add('active');
        }

        // 在表单中选择一行

        // 在表单中选择一行
        export function selectFormRow(index) {
            const rows = document.querySelectorAll('.multi-form-row');
            rows.forEach(row => row.classList.remove('selected'));
            const selectedRow = document.getElementById(`multi-row-${index}`);
            if (selectedRow) {
                selectedRow.classList.add('selected');
            }
        }

        // 关闭多板个股归类编辑

        // 关闭多板个股归类编辑
        export function closeMultiModal() {
            document.getElementById('multiModal').classList.remove('active');
        }

        // 添加多板个股归类行 - 修改为一行四个输入框

        // 添加多板个股归类行 - 修改为一行四个输入框
        export function addMultiRow() {
            const formContainer = document.getElementById('multiFormContainer');
            const rowCount = formContainer.children.length;
            const newRow = document.createElement('div');
            newRow.className = 'multi-form-row';
            newRow.id = `multi-row-${rowCount}`;
            
            newRow.innerHTML = `
                <div class="form-group multi-form-stock">
                    <input type="text" class="form-input" name="stock1-${rowCount}" placeholder="股票1/分类">
                </div>
                <div class="form-group multi-form-stock">
                    <input type="text" class="form-input" name="stock2-${rowCount}" placeholder="股票2">
                </div>
                <div class="form-group multi-form-stock">
                    <input type="text" class="form-input" name="stock3-${rowCount}" placeholder="股票3">
                </div>
                <div class="form-group multi-form-stock">
                    <input type="text" class="form-input" name="stock4-${rowCount}" placeholder="股票4">
                </div>
                <button type="button" class="remove-rank-btn" onclick="window.removeMultiRow(${rowCount})">×</button>
            `;
            
            formContainer.appendChild(newRow);
        }

        // 移除多板个股归类行

        // 移除多板个股归类行
        export function removeMultiRow(index) {
            const row = document.getElementById(`multi-row-${index}`);
            if (row) {
                row.remove();
                // 重新编号所有行
                const rows = document.querySelectorAll('.multi-form-row');
                rows.forEach((row, i) => {
                    row.id = `multi-row-${i}`;
                    
                    // 更新输入框的name属性
                    const stock1Input = row.querySelector('[name^="stock1-"]');
                    const stock2Input = row.querySelector('[name^="stock2-"]');
                    const stock3Input = row.querySelector('[name^="stock3-"]');
                    const stock4Input = row.querySelector('[name^="stock4-"]');
                    const removeBtn = row.querySelector('.remove-rank-btn');
                    
                    if (stock1Input) stock1Input.name = `stock1-${i}`;
                    if (stock2Input) stock2Input.name = `stock2-${i}`;
                    if (stock3Input) stock3Input.name = `stock3-${i}`;
                    if (stock4Input) stock4Input.name = `stock4-${i}`;
                    if (removeBtn) removeBtn.setAttribute('onclick', `window.removeMultiRow(${i})`);
                });
            }
        }

        // 保存多板个股归类数据 - 修改为保存4个股票

        // 保存多板个股归类数据 - 修改为保存4个股票
        export function saveMulti(e) {
            e.preventDefault();
            const formContainer = document.getElementById('multiFormContainer');
            const rows = formContainer.querySelectorAll('.multi-form-row');
            const multiList = [];
            
            rows.forEach((row, index) => {
                const stock1Input = row.querySelector(`[name="stock1-${index}"]`);
                const stock2Input = row.querySelector(`[name="stock2-${index}"]`);
                const stock3Input = row.querySelector(`[name="stock3-${index}"]`);
                const stock4Input = row.querySelector(`[name="stock4-${index}"]`);
                
                const stock1 = stock1Input ? stock1Input.value.trim() : '';
                const stock2 = stock2Input ? stock2Input.value.trim() : '';
                const stock3 = stock3Input ? stock3Input.value.trim() : '';
                const stock4 = stock4Input ? stock4Input.value.trim() : '';
                
                // 检查是否是空行
                if (row.classList.contains('multi-empty-row')) {
                    multiList.push({
                        category: '',
                        stocks: ['', '', '', ''],
                        isEmpty: true,
                        isWhite: row.dataset.isWhite !== 'false'
                    });
                    return;
                }
                
                // 检查是否是标题行
                if (row.classList.contains('multi-title-row')) {
                    multiList.push({
                        category: stock1,
                        stocks: [stock1, stock2, stock3, stock4],
                        isTitle: true
                    });
                    return;
                }
                
                // 只有至少一个股票名称不为空才保存
                if (stock1 || stock2 || stock3 || stock4) {
                    multiList.push({
                        stocks: [stock1, stock2, stock3, stock4]
                    });
                }
            });
            
            window.getMultiData()[window.currentDate] = multiList;
            window.saveData();
            window.renderMulti();
            window.closeMultiModal();
        }

        // 导入题材分类数据（从剪贴板粘贴，新增不覆盖）

        // 导入题材分类数据（从剪贴板粘贴，新增不覆盖）
        export async function importMultiData() {
            let text = '';
            let usedPrompt = false;
            
            // 尝试从剪贴板读取
            if (navigator.clipboard && navigator.clipboard.readText) {
                try {
                    text = await navigator.clipboard.readText();
                } catch (err) {
                    // 剪贴板读取失败，将使用输入框
                }
            }
            
            // 如果剪贴板读取失败或为空，使用 prompt
            if (!text || text.trim() === '') {
                text = prompt('请粘贴要导入的题材分类数据：\n格式：分类名:个股1,个股2,个股3\n每行一条');
                usedPrompt = true;
                if (!text) return;
            }
            
            if (!text || text.trim() === '') {
                window.showToast('❌ 没有要导入的数据');
                return;
            }
            
            // 解析数据
            const lines = text.trim().split('\n').filter(line => line.trim() !== '');
            const newItems = [];
            
            lines.forEach(line => {
                const colonIndex = line.indexOf(':');
                if (colonIndex > 0) {
                    const category = line.substring(0, colonIndex).trim();
                    const stocksStr = line.substring(colonIndex + 1).trim();
                    const stocks = stocksStr.split(',').map(s => s.trim()).filter(s => s !== '');
                    
                    if (category && stocks.length > 0) {
                        newItems.push({
                            category: category,
                            stocks: stocks
                        });
                    }
                }
            });
            
            if (newItems.length === 0) {
                window.showToast('❌ 未找到有效的题材分类数据，请检查格式');
                return;
            }
            
            // 获取现有数据
            const multiData = window.getMultiData();
            if (!multiData[window.currentDate]) {
                multiData[window.currentDate] = [];
            }
            
            // 添加空行（白色背景）
            multiData[window.currentDate].push({
                category: '',
                stocks: ['', '', '', ''],
                isEmpty: true,
                isWhite: true
            });
            
            // 添加标题行：新增题材 + 时间
            const now = new Date();
            const month = String(now.getMonth() + 1).padStart(2, '0');
            const day = String(now.getDate()).padStart(2, '0');
            const timeStr = `${month}${day}`;
            multiData[window.currentDate].push({
                category: '新增题材',
                stocks: ['新增题材', timeStr, '', ''],
                isTitle: true
            });
            
            // 新增导入的数据
            multiData[window.currentDate] = [...multiData[window.currentDate], ...newItems];
            
            // 保存数据
            window.saveData();
            
            // 重新渲染表单和看板
            window.openMultiEdit();
            window.renderMulti();
            
            window.showToast('✅ 成功导入 ' + newItems.length + ' 条分类，现有 ' + multiData[window.currentDate].length + ' 条');
        }

        // 打开题材分类导入模态框

        // 打开题材分类导入模态框
        export function importMultiDataNew() {
            document.getElementById('multiImportInputNew').value = '';
            document.getElementById('multiImportModalNew').classList.add('active');
        }

        // 关闭题材分类导入模态框

        // 关闭题材分类导入模态框
        export function closeMultiImportModalNew() {
            document.getElementById('multiImportModalNew').classList.remove('active');
        }

        // 确认导入题材分类数据

        // 确认导入题材分类数据
        export function confirmImportMultiDataNew() {
            const text = document.getElementById('multiImportInputNew').value;
            
            if (!text || text.trim() === '') {
                window.showToast('❌ 请输入数据');
                return;
            }
            
            // 解析数据
            const lines = text.trim().split('\n').filter(line => line.trim() !== '');
            const newItems = [];
            
            lines.forEach(line => {
                // 支持制表符分隔的表格格式
                let parts;
                if (line.includes('\t')) {
                    parts = line.split('\t').map(s => s.trim()).filter(s => s !== '');
                } else {
                    // 支持冒号格式
                    const colonIndex = line.indexOf(':');
                    if (colonIndex > 0) {
                        const category = line.substring(0, colonIndex).trim();
                        const stocksStr = line.substring(colonIndex + 1).trim();
                        const stocks = stocksStr.split(',').map(s => s.trim()).filter(s => s !== '');
                        
                        if (category && stocks.length > 0) {
                            newItems.push({
                                category: category,
                                stocks: stocks
                            });
                        }
                        return;
                    }
                    // 支持空格分隔
                    parts = line.split(/\s+/).map(s => s.trim()).filter(s => s !== '');
                }
                
                if (parts && parts.length > 0) {
                    newItems.push({
                        category: parts[0] || '',
                        stocks: parts
                    });
                }
            });
            
            if (newItems.length === 0) {
                window.showToast('❌ 未找到有效数据');
                return;
            }
            
            // 获取现有数据
            const multiData = window.getMultiData();
            if (!multiData[window.currentDate]) {
                multiData[window.currentDate] = [];
            }
            
            // 添加空行（白色背景）
            multiData[window.currentDate].push({
                category: '',
                stocks: ['', '', '', ''],
                isEmpty: true,
                isWhite: true
            });
            
            // 添加标题行：新增题材 + 时间
            const now = new Date();
            const month = String(now.getMonth() + 1).padStart(2, '0');
            const day = String(now.getDate()).padStart(2, '0');
            const timeStr = `${month}${day}`;
            multiData[window.currentDate].push({
                category: '新增题材',
                stocks: ['新增题材', timeStr, '', ''],
                isTitle: true
            });
            
            // 新增导入的数据
            multiData[window.currentDate] = [...multiData[window.currentDate], ...newItems];
            
            // 保存数据
            window.saveData();
            
            // 关闭模态框
            window.closeMultiImportModalNew();
            
            // 重新渲染表单和看板
            window.openMultiEdit();
            window.renderMulti();
            
            window.showToast('✅ 成功导入 ' + newItems.length + ' 条分类');
        }

        // 打开题材分类导入粘贴框

        // 打开题材分类导入粘贴框
        export function openMultiImportModal() {
            document.getElementById('multiImportInput').value = '';
            document.getElementById('multiImportModal').classList.add('active');
        }

        // 关闭题材分类导入粘贴框

        // 关闭题材分类导入粘贴框
        export function closeMultiImportModal() {
            document.getElementById('multiImportModal').classList.remove('active');
        }

        // 确认导入题材分类数据

        // 确认导入题材分类数据
        export function confirmImportMultiData() {
            const text = document.getElementById('multiImportInput').value;
            
            if (!text || text.trim() === '') {
                window.showToast('❌ 请输入要导入的数据');
                return;
            }
            
            // 解析数据
            const lines = text.trim().split('\n').filter(line => line.trim() !== '');
            const newItems = [];
            
            lines.forEach(line => {
                const colonIndex = line.indexOf(':');
                if (colonIndex > 0) {
                    const category = line.substring(0, colonIndex).trim();
                    const stocksStr = line.substring(colonIndex + 1).trim();
                    const stocks = stocksStr.split(',').map(s => s.trim()).filter(s => s !== '');
                    
                    if (category && stocks.length > 0) {
                        newItems.push({
                            category: category,
                            stocks: stocks
                        });
                    }
                }
            });
            
            if (newItems.length === 0) {
                window.showToast('❌ 未找到有效的题材分类数据，请检查格式');
                return;
            }
            
            // 获取现有数据
            const multiData = window.getMultiData();
            if (!multiData[window.currentDate]) {
                multiData[window.currentDate] = [];
            }
            
            // 添加空行（白色背景）
            multiData[window.currentDate].push({
                category: '',
                stocks: ['', '', '', ''],
                isEmpty: true,
                isWhite: true
            });
            
            // 添加标题行：新增题材 + 时间
            const now = new Date();
            const month = String(now.getMonth() + 1).padStart(2, '0');
            const day = String(now.getDate()).padStart(2, '0');
            const timeStr = `${month}${day}`;
            multiData[window.currentDate].push({
                category: '新增题材',
                stocks: ['新增题材', timeStr, '', ''],
                isTitle: true
            });
            
            // 新增导入的数据
            multiData[window.currentDate] = [...multiData[window.currentDate], ...newItems];
            
            // 保存数据
            window.saveData();
            
            // 关闭粘贴框
            window.closeMultiImportModal();
            
            // 重新渲染表单和看板
            window.openMultiEdit();
            window.renderMulti();
            
            window.showToast('✅ 成功导入 ' + newItems.length + ' 条分类，现有 ' + multiData[window.currentDate].length + ' 条');
        }

        // 复制题材分类数据（保持横排格式）

        // 复制题材分类数据（保持横排格式）
        export function copyMultiForImport() {
            const formContainer = document.getElementById('multiFormContainer');
            if (!formContainer || formContainer.innerText.trim() === '') {
                window.showToast('❌ 当前没有数据可复制');
                return;
            }
            
            // 按行获取数据，每行4个值（横排格式）
            const rows = formContainer.querySelectorAll('.multi-form-row');
            const lines = [];
            
            rows.forEach(row => {
                const inputs = row.querySelectorAll('input[type="text"]');
                const rowValues = [];
                inputs.forEach(input => {
                    const value = input.value.trim();
                    if (value) {
                        rowValues.push(value);
                    }
                });
                // 只添加非空行
                if (rowValues.length > 0) {
                    lines.push(rowValues.join(' ')); // 用空格分隔，保持横排
                }
            });
        }

        // 导入题材分类数据（保持横排格式）

        // 导入题材分类数据（保持横排格式）
        export function importMultiInline() {
            const text = document.getElementById('multiImportInlineInput').value;
            
            if (!text || text.trim() === '') {
                window.showToast('❌ 请输入要导入的数据');
                return;
            }
            
            // 按行解析，每行用空格分隔
            const lines = text.trim().split('\n').map(l => l.trim()).filter(l => l !== '');
            const newItems = [];
            
            lines.forEach(line => {
                // 用空格分隔每行的值
                const values = line.split(/\s+/).filter(v => v.trim() !== '');
                
                if (values.length > 0) {
                    newItems.push({ stocks: values });
                }
            });
            
            if (newItems.length === 0) {
                window.showToast('❌ 未找到有效数据');
                return;
            }
            
            // 获取现有数据
            const multiData = window.getMultiData();
            if (!multiData[window.currentDate]) {
                multiData[window.currentDate] = [];
            }
            
            // 添加空行（白色背景）
            multiData[window.currentDate].push({
                category: '',
                stocks: ['', '', '', ''],
                isEmpty: true,
                isWhite: true
            });
            
            // 添加标题行：新增题材 + 时间
            const now = new Date();
            const month = String(now.getMonth() + 1).padStart(2, '0');
            const day = String(now.getDate()).padStart(2, '0');
            const timeStr = `${month}${day}`;
            multiData[window.currentDate].push({
                category: '新增题材',
                stocks: ['新增题材', timeStr, '', ''],
                isTitle: true
            });
            
            // 新增导入的数据
            multiData[window.currentDate] = [...multiData[window.currentDate], ...newItems];
            
            // 保存数据
            window.saveData();
            
            // 清空输入框
            document.getElementById('multiImportInlineInput').value = '';
            
            // 重新渲染表单和看板
            window.openMultiEdit();
            window.renderMulti();
            
            window.showToast('✅ 成功导入 ' + newItems.length + ' 行数据');
        }

        // 开始选择复制到日期

        // 开始选择复制到日期
        export function startSelectCopyToDate() {
            const multiList = window.getTodayMulti();
            if (!multiList || multiList.length === 0) {
                window.showToast('❌ 当前没有数据');
                return;
            }
            
            // 关闭编辑表单（如果打开）
            window.closeMultiModal();
            
            // 重新渲染看板以确保显示的是看板而不是表单
            window.renderMulti();
            
            // 初始化选中的行索引集合
            window.selectedCopyRows = new Set();
            
            // 为看板添加选择模式
            const multiContent = document.getElementById('multiContent');
            multiContent.classList.add('select-mode');
            
            // 先移除旧的事件监听器（如果存在）
            if (multiContent._clickHandler) {
                multiContent.removeEventListener('click', multiContent._clickHandler);
                multiContent._clickHandler = null;
            }
            
            // 为现有行添加 data-row-index 属性和 selectable 类
            const rows = multiContent.querySelectorAll('.multi-row');
            rows.forEach((row, index) => {
                row.classList.add('selectable');
                row.dataset.rowIndex = index;
            });
            
            // 添加点击遮罩层来取消选择
            let overlay = document.getElementById('selectCopyOverlay');
            if (!overlay) {
                overlay = document.createElement('div');
                overlay.id = 'selectCopyOverlay';
                overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.3);z-index:9998;pointer-events:none';
                overlay.onclick = window.clearAllSelections;
                document.body.appendChild(overlay);
            }
            
            // 使用事件委托：将点击事件绑定到容器上
            const clickHandler = function(e) {
                const row = e.target.closest('.multi-row');
                if (row && row.dataset.rowIndex !== undefined) {
                    const rowIndex = parseInt(row.dataset.rowIndex);
                    e.stopPropagation();
                    window.toggleRowSelection(rowIndex);
                }
            };
            multiContent.addEventListener('click', clickHandler);
            multiContent._clickHandler = clickHandler;
            
            // 添加日期选择和确认按钮
            const selectPanel = document.createElement('div');
            selectPanel.id = 'selectCopyPanel';
            selectPanel.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:#fff;padding:15px 20px;border-radius:12px;box-shadow:0 4px 20px rgba(0,0,0,0.15);z-index:10000';
            selectPanel.innerHTML = `
                <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">
                    <input type="date" id="copyToDateInput" style="padding:8px;border:1px solid #e2e8f0;border-radius:6px;font-size:14px">
                    <button onclick="window.confirmMultiSelectCopyToDate()" style="padding:8px 16px;background:linear-gradient(135deg, #10b981, #059669);color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:14px">确认</button>
                    <button onclick="window.cancelSelectCopy()" style="padding:8px 16px;background:#6b7280;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:14px">取消</button>
                </div>
                <div style="font-size:12px;color:#64748b;text-align:center">点击可多选，第一列有数字时复制整个分类，否则只复制一行</div>
            `;
            document.body.appendChild(selectPanel);
            
            // 默认显示今天日期
            document.getElementById('copyToDateInput').value = window.currentDate;
            
            window.showToast('点击可多选，第一列有数字时复制整个分类，否则只复制一行');
        }
        
        // 切换行的选中状态（多选模式）

        // 切换行的选中状态（多选模式）
        export function toggleRowSelection(rowIndex) {
            const multiContent = document.getElementById('multiContent');
            const row = multiContent.querySelector(`.multi-row[data-row-index="${rowIndex}"]`);
            
            if (!row) {
                return;
            }
            
            if (window.selectedCopyRows.has(rowIndex)) {
                window.selectedCopyRows.delete(rowIndex);
                row.classList.remove('selected');
            } else {
                window.selectedCopyRows.add(rowIndex);
                row.classList.add('selected');
            }
            
            const count = window.selectedCopyRows.size;
            const panel = document.getElementById('selectCopyPanel');
            if (panel) {
                const hintDiv = panel.querySelector('div[style*="font-size:12px"]');
                if (hintDiv) {
                    hintDiv.textContent = count > 0 ? `已选择 ${count} 个分类` : '点击可多选，第一列有数字时复制整个分类，否则只复制一行';
                }
            }
        }
        
        // 清除所有选择

        // 清除所有选择
        export function clearAllSelections() {
            window.selectedCopyRows.forEach(index => {
                const row = document.querySelector(`.multi-row[data-row-index="${index}"]`);
                if (row) row.classList.remove('selected');
            });
            window.selectedCopyRows.clear();
            
            const panel = document.getElementById('selectCopyPanel');
            if (panel) {
                const hintDiv = panel.querySelector('div[style*="font-size:12px"]');
                if (hintDiv) {
                    hintDiv.textContent = '点击可多选，第一列有数字时复制整个分类，否则只复制一行';
                }
            }
        }
        
        // 确认多选复制到指定日期

        // 确认多选复制到指定日期
        export function confirmMultiSelectCopyToDate() {
            const selectedIndices = Array.from(window.selectedCopyRows).sort((a, b) => a - b);
            
            if (selectedIndices.length === 0) {
                window.showToast('❌ 请先选择要复制的分类');
                return;
            }
            
            // 获取目标日期
            const targetDate = document.getElementById('copyToDateInput').value;
            if (!targetDate) {
                window.showToast('❌ 请选择目标日期');
                return;
            }
            
            // 获取要复制的数据
            const multiList = window.getTodayMulti();
            const newItems = [];
            
            selectedIndices.forEach(startIndex => {
                if (multiList[startIndex]) {
                    const firstRow = multiList[startIndex];
                    const firstCol = firstRow.stocks[0] || '';
                    
                    // 添加选中的行
                    newItems.push({ stocks: firstRow.stocks });
                    
                    // 只有当第一列包含数字时，才收集后续行
                    if (/\d/.test(firstCol)) {
                        for (let i = startIndex + 1; i < multiList.length; i++) {
                            const row = multiList[i];
                            if (row && row.stocks && row.stocks.length > 0) {
                                const rowFirstCol = row.stocks[0] || '';
                                // 如果第1列包含数字，说明是新的分类名，停止
                                if (/\d/.test(rowFirstCol)) {
                                    break;
                                }
                                newItems.push({ stocks: row.stocks });
                            } else {
                                break;
                            }
                        }
                    }
                }
            });
            
            if (newItems.length === 0) {
                window.showToast('❌ 未找到有效数据');
                return;
            }
            
            // 保存到目标日期
            const multiData = window.getMultiData();
            if (!multiData[targetDate]) {
                multiData[targetDate] = [];
            }
            multiData[targetDate] = [...multiData[targetDate], ...newItems];
            window.saveData();
            
            // 清理选择模式
            window.cleanupSelectMode();
            
            window.showToast('✅ 已复制 ' + selectedIndices.length + ' 个分类到 ' + targetDate);
        }

        // 取消选择复制

        // 取消选择复制
        export function cancelSelectCopy() {
            window.cleanupSelectMode();
            window.showToast('已取消');
        }

        // 清理选择模式

        // 清理选择模式
        export function cleanupSelectMode() {
            const multiContent = document.getElementById('multiContent');
            multiContent.classList.remove('select-mode');
            
            // 移除事件委托
            if (multiContent._clickHandler) {
                multiContent.removeEventListener('click', multiContent._clickHandler);
                multiContent._clickHandler = null;
            }
            
            // 清除行的选中样式
            const rows = multiContent.querySelectorAll('.multi-row');
            rows.forEach(row => {
                row.classList.remove('selected');
                row.classList.remove('selectable');
                delete row.dataset.rowIndex;
            });
            
            const overlay = document.getElementById('selectCopyOverlay');
            if (overlay) overlay.remove();
            
            const panel = document.getElementById('selectCopyPanel');
            if (panel) panel.remove();
            
            // 清除选中的行索引集合
            if (window.selectedCopyRows) {
                window.selectedCopyRows.clear();
            }
        }

        // 渲染题材思路看板

        // 渲染题材思路看板
        export function renderHotspot() {
            const hotspot = window.getTodayHotspot();
            const contentEl = document.getElementById('hotspotContent');
            const placeholderEl = document.getElementById('hotspotPlaceholder');
            
            if (hotspot && hotspot.trim() !== '') {
                if (placeholderEl) placeholderEl.style.display = 'none';
                contentEl.innerHTML = `<div style="white-space: pre-wrap;">${hotspot}</div>`;
            } else {
                if (placeholderEl) placeholderEl.style.display = 'block';
                contentEl.innerHTML = '<div class="hotspot-placeholder" id="hotspotPlaceholder">暂无题材思路，点击添加...</div>';
            }
        }

        // 打开热点选择编辑

        // 打开热点选择编辑
        export function openHotspotEdit() {
            const hotspot = window.getTodayHotspot();
            document.getElementById('hotspotInput').value = hotspot || '';
            document.getElementById('hotspotModal').classList.add('active');
        }

        // 关闭热点选择编辑

