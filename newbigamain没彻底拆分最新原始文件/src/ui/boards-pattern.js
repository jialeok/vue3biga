// boards-pattern.js — 从 boards-render.js 拆分（看板域: boards-pattern.js）

        // 获取当日模式数据（带自动延续和恢复功能）
        export function getTodayPattern() {
            // 如果今天已经有数据，直接返回
            if (window.getPatternData()[window.currentDate]) {
                const todayPattern = window.getPatternData()[window.currentDate];
                return todayPattern;
            }
            
            // 获取前一天日期
            const prevDate = window.getPreviousDate(window.currentDate);
            
            // 检查前一天是否有数据且打上了标签
            if (window.getPatternData()[prevDate]) {
                const prevPattern = window.getPatternData()[prevDate];
                
                // 检查前一天是否打上了"更新"或"坚守"标签
                if (prevPattern.update || prevPattern.keep) {
                    // 复制前一天的内容，但不复制标签状态
                    const newPattern = {
                        content: prevPattern.content || '',
                        update: false,
                        keep: false
                    };
                    
                    // 保存到今天的模式数据
                    window.getPatternData()[window.currentDate] = newPattern;
                    window.saveData();
                    
                    return newPattern;
                }
            }
            
            // 如果前一天没有数据或没有打标签，返回空数据
            return { content: '', update: false, keep: false };
        }


        // 渲染模式看板
        export function renderPattern() {
            const pattern = window.getTodayPattern();
            const boardEl = document.getElementById('patternBoard');
            const contentEl = document.getElementById('patternContent');
            const placeholderEl = document.getElementById('patternPlaceholder');
            const tagsEl = document.getElementById('patternTags');
            const toggleBtn = document.getElementById('patternToggleBtn');
            
            // 清空标签显示
            tagsEl.innerHTML = '';
            
            // 显示标签
            if (pattern.update) {
                tagsEl.innerHTML += '<div class="pattern-tag update">更新</div>';
            }
            if (pattern.keep) {
                tagsEl.innerHTML += '<div class="pattern-tag keep">坚守</div>';
            }
            
            // 显示内容
            if (pattern.content && pattern.content.trim() !== '') {
                if (placeholderEl) placeholderEl.style.display = 'none';
                contentEl.innerHTML = `<div style="white-space: pre-wrap;">${pattern.content}</div>`;
            } else {
                if (placeholderEl) placeholderEl.style.display = 'block';
                contentEl.innerHTML = '<div class="pattern-placeholder" id="patternPlaceholder">暂无模式心得，点击添加...</div>';
            }
            
            // 始终显示展开/收起按钮；保持当前折叠/展开状态（HTML 默认 minimized=收起，用户可点击切换）
            toggleBtn.style.display = 'flex';
            toggleBtn.textContent = boardEl.classList.contains('minimized') ? '▼' : '▲';
        }

        // 切换模式看板展开/收起

        // 打开默认模板设置
        export function openTemplateSettings() {
            const template = window.getDefaultBiddingTemplate();
            const container = document.getElementById('biddingTemplateContainer');
            
            let html = '<div style="display:flex;flex-direction:column;gap:8px">';
            template.forEach((item, index) => {
                html += `
                    <div style="display:flex;align-items:center;gap:8px">
                        <span style="font-size:11px;color:#9ca3af;width:20px">${index + 1}.</span>
                        <input type="text" class="form-input" id="template-name-${index}" value="${item.name || ''}" placeholder="输入项目名称" style="flex:1;font-size:13px;padding:8px">
                        <button type="button" onclick="window.removeTemplateRow(${index})" style="font-size:11px;padding:4px 8px;border:1px solid #ef4444;color:#ef4444;background:#fef2f2;border-radius:4px;cursor:pointer">删除</button>
                    </div>
                `;
            });
            html += '</div>';
            
            container.innerHTML = html;
            document.getElementById('biddingTemplateModal').classList.add('active');
        }

        // 关闭默认模板设置

        // 关闭默认模板设置
        export function closeBiddingTemplateModal() {
            document.getElementById('biddingTemplateModal').classList.remove('active');
        }

        // 添加模板行

        // 添加模板行
        export function addTemplateRow() {
            const container = document.getElementById('biddingTemplateContainer');
            const inputs = container.querySelectorAll('[id^="template-name-"]');
            const newIndex = inputs.length;
            
            const newRow = document.createElement('div');
            newRow.style.cssText = 'display:flex;align-items:center;gap:8px;margin-top:8px';
            newRow.innerHTML = `
                <span style="font-size:11px;color:#9ca3af;width:20px">${newIndex + 1}.</span>
                <input type="text" class="form-input" id="template-name-${newIndex}" value="" placeholder="输入项目名称" style="flex:1;font-size:13px;padding:8px">
                <button type="button" onclick="window.removeTemplateRow(${newIndex})" style="font-size:11px;padding:4px 8px;border:1px solid #ef4444;color:#ef4444;background:#fef2f2;border-radius:4px;cursor:pointer">删除</button>
            `;
            
            container.querySelector('div').appendChild(newRow);
            
            // 重新编号
            window.reindexTemplateRows();
        }

        // 删除模板行

        // 删除模板行
        export function removeTemplateRow(index) {
            const container = document.getElementById('biddingTemplateContainer');
            const rows = container.querySelectorAll('[id^="template-name-"]');
            
            if (rows.length <= 1) {
                window.showToast('至少保留一个项目');
                return;
            }
            
            // 移除对应的输入框所在行
            const targetInput = document.getElementById(`template-name-${index}`);
            if (targetInput) {
                targetInput.parentElement.remove();
            }
            
            window.reindexTemplateRows();
        }

        // 重新编号模板行

        // 重新编号模板行
        export function reindexTemplateRows() {
            const container = document.getElementById('biddingTemplateContainer');
            const inputs = container.querySelectorAll('[id^="template-name-"]');
            const deleteBtns = container.querySelectorAll('button');
            
            inputs.forEach((input, i) => {
                input.id = `template-name-${i}`;
                const span = input.parentElement.querySelector('span');
                if (span) span.textContent = `${i + 1}.`;
            });
            
            deleteBtns.forEach((btn, i) => {
                btn.onclick = function() { window.removeTemplateRow(i); };
            });
        }

        // 保存默认模板设置

        // 保存默认模板设置
        export function saveTemplateSettings() {
            const container = document.getElementById('biddingTemplateContainer');
            const inputs = container.querySelectorAll('[id^="template-name-"]');
            const template = [];
            
            inputs.forEach(input => {
                const name = input.value.trim();
                if (name) {
                    template.push({ name });
                }
            });
            
            if (template.length === 0) {
                window.showToast('至少保留一个项目');
                return;
            }
            
            window.saveDefaultBiddingTemplate(template);
            window.closeBiddingTemplateModal();
            window.showToast('✅ 默认模板已保存！');
        }

        // 打开模式编辑

        // 打开模式编辑
        export function openPatternEdit() {
            const pattern = window.getTodayPattern();
            document.getElementById('patternInput').value = pattern.content || '';
            document.getElementById('patternUpdate').checked = pattern.update || false;
            document.getElementById('patternKeep').checked = pattern.keep || false;
            document.getElementById('patternModal').classList.add('active');
        }

        // 关闭模式编辑

        // 关闭模式编辑
        export function closePatternModal() {
            document.getElementById('patternModal').classList.remove('active');
        }

        // 保存模式数据（修复：支持恢复被清空的内容）

        // 保存模式数据（修复：支持恢复被清空的内容）
        export function savePattern() {
            const content = document.getElementById('patternInput').value.trim();
            const update = document.getElementById('patternUpdate').checked;
            const keep = document.getElementById('patternKeep').checked;
            
            // 保存当天数据
            window.getPatternData()[window.currentDate] = {
                content,
                update,
                keep
            };
            
            // 如果当天有打标（更新或坚守），检查后一天的数据
            if (update || keep) {
                const nextDate = window.getNextDate(window.currentDate);
                const nextPattern = window.getPatternData()[nextDate];
                
                // 如果后一天模式数据存在但内容为空，则用当前内容恢复
                if (nextPattern && (!nextPattern.content || nextPattern.content.trim() === '')) {
                    nextPattern.content = content;
                    // 确保后一天的标签状态为false（因为这是自动恢复，不是手动打标）
                    nextPattern.update = false;
                    nextPattern.keep = false;
                }
                
                // 如果后一天模式数据不存在，也创建它（但这不是必须的，因为getTodayPattern会自动创建）
            }
            
            // 保存当前展开状态
            const boardEl = document.getElementById('patternBoard');
            const isExpanded = !boardEl.classList.contains('minimized');
            
            window.saveData();
            window.renderPattern();
            
            // 恢复展开状态
            if (isExpanded) {
                const newBoardEl = document.getElementById('patternBoard');
                const toggleBtn = document.getElementById('patternToggleBtn');
                newBoardEl.classList.remove('minimized');
                toggleBtn.textContent = '▲';
            }
            
            // 如果正在查看后一天，并且后一天的内容被恢复了，也需要重新渲染
            const nextDate = window.getNextDate(window.currentDate);
            if (nextDate === window.currentDate) {
                // 如果当前日期就是后一天（不可能的情况，但为了安全）
                window.renderPattern();
            }
            
            window.closePatternModal();
            window.showToast('✅ 模式数据已保存' + ((update || keep) ? '，已检查后一天数据' : ''));
        }

        // 复制模式到指定日期（一年范围内）

        // 复制模式到指定日期（一年范围内）
        export function copyPatternToDate() {
            // 获取当前模式数据
            const patternData = window.getTodayPattern();
            if (!patternData || (!patternData.content || patternData.content.trim() === '')) {
                window.showToast('❌ 当前日期没有模式数据');
                return;
            }

            // 计算日期范围（当前日期到一年后）
            const today = new Date(window.currentDate);
            const maxDate = new Date(today);
            maxDate.setFullYear(today.getFullYear() + 1);
            
            const todayStr = today.toISOString().split('T')[0];
            const maxDateStr = maxDate.toISOString().split('T')[0];

            // 弹出日期选择对话框
            const selectedDate = prompt('请选择复制日期（' + todayStr + ' 至 ' + maxDateStr + '）：', todayStr);
            
            // 用户取消选择
            if (!selectedDate) {
                return;
            }

            // 验证日期格式和范围
            const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
            if (!dateRegex.test(selectedDate)) {
                window.showToast('❌ 日期格式不正确，请使用 YYYY-MM-DD 格式');
                return;
            }

            const selectedDateObj = new Date(selectedDate);
            if (selectedDateObj < today || selectedDateObj > maxDate) {
                window.showToast('❌ 只能选择一年范围内的日期');
                return;
            }

            // 深拷贝模式数据（全部复制）
            const newPatternData = JSON.parse(JSON.stringify(patternData));
            
            // 检查目标日期是否已有模式数据
            const existingPattern = window.getPatternData()[selectedDate];
            if (existingPattern && existingPattern.content && existingPattern.content.trim() !== '') {
                if (!confirm(selectedDate + '已有模式数据，是否覆盖？')) {
                    return;
                }
            }

            // 覆盖目标日期的模式数据
            window.getPatternData()[selectedDate] = newPatternData;
            
            // 保存数据
            window.saveData();
            
            // 提示成功
            window.showToast('✅ 已复制模式数据到' + selectedDate);
            
            // 如果当前查看的是目标日期，则重新渲染
            if (window.currentDate === selectedDate) {
                window.renderPattern();
            }
        }

        // 渲染圆形统计

