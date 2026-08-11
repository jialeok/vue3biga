// boards-tag-titles.js — 从 boards-render.js 拆分（看板域: boards-tag-titles.js）

        export function getTodayMulti() {
            return window.getMultiData()[window.currentDate] || [];
        }

        // 获取当日题材思路数据

        // 获取当日题材思路数据
        export function getTodayHotspot() {
            return window.getHotspotData()[window.currentDate] || '';
        }

        // 默认标签配置（空数组，不再预设默认标签）
        const DEFAULT_TAGS = [];
        
        // 获取上一个有数据的日期（找小于当前日期的任何日期）

        // 获取上一个有数据的日期（找小于当前日期的任何日期）
        export function getPreviousTagDate(date) {
            const tagTitlesData = window.getTagTitlesData();
            const dates = Object.keys(tagTitlesData)
                .filter(d => d && d.length === 10) // 过滤无效日期
                .sort((a, b) => new Date(a) - new Date(b));
            const currentDateObj = new Date(date);
            
            for (let i = dates.length - 1; i >= 0; i--) {
                const d = dates[i];
                if (new Date(d) < currentDateObj) {
                    return d;
                }
            }
            return null;
        }
        
        // 同步标签列表到未来日期

        // 同步标签列表到未来日期
        export function syncTagsToFutureDates(type, tags) {
            const tagTitlesData = window.getTagTitlesData();
            const dates = Object.keys(tagTitlesData).sort((a, b) => new Date(a) - new Date(b));
            const currentDateObj = new Date(window.currentDate);
            
            dates.forEach(date => {
                const dateObj = new Date(date);
                // 只同步到未来日期
                if (dateObj > currentDateObj && tagTitlesData[date] && tagTitlesData[date][type]) {
                    const oldTags = tagTitlesData[date][type].tags || [];
                    const oldActive = tagTitlesData[date][type].active || {};
                    
                    // 更新标签列表
                    tagTitlesData[date][type].tags = [...tags];
                    
                    // 更新active状态：保留旧标签的选中状态，新标签设为未选中
                    tagTitlesData[date][type].active = {};
                    tags.forEach(tag => {
                        tagTitlesData[date][type].active[tag] = oldActive[tag] || false;
                    });
                }
            });
            
            window.saveData();
        }

        // 获取当日标签标题数据

        // 获取当日标签标题数据
        export function getTodayTagTitles() {
            const tagTitlesData = window.getTagTitlesData();
            
            // 检查是否有空key的数据需要迁移
            if (tagTitlesData[''] && !tagTitlesData[window.currentDate]) {
                tagTitlesData[window.currentDate] = tagTitlesData[''];
                delete tagTitlesData[''];
                window.saveData();
            } else if (tagTitlesData[''] && tagTitlesData[window.currentDate]) {
                // 合并空key数据到当前日期
                const emptyKeyData = tagTitlesData[''];
                ['recentMulti', 'sectorEtf', 'topicDirection'].forEach(type => {
                    if (emptyKeyData[type]) {
                        if (!tagTitlesData[window.currentDate][type]) {
                            tagTitlesData[window.currentDate][type] = emptyKeyData[type];
                        } else {
                            // 合并tags数组（去重）
                            const existingTags = tagTitlesData[window.currentDate][type].tags || [];
                            const newTags = emptyKeyData[type].tags || [];
                            const mergedTags = [...new Set([...existingTags, ...newTags])];
                            tagTitlesData[window.currentDate][type].tags = mergedTags;
                            
                            // 合并active状态
                            if (emptyKeyData[type].active) {
                                if (!tagTitlesData[window.currentDate][type].active) {
                                    tagTitlesData[window.currentDate][type].active = {};
                                }
                                Object.assign(tagTitlesData[window.currentDate][type].active, emptyKeyData[type].active);
                            }
                        }
                    }
                });
                delete tagTitlesData[''];
                window.saveData();
            }
            
            // 如果日期不存在，创建空结构并继承上一个日期的标签
            if (!tagTitlesData[window.currentDate]) {
                tagTitlesData[window.currentDate] = {
                    recentMulti: { tags: [], active: {}, score: 0 },
                    sectorEtf: { tags: [], active: {}, score: 0 },
                    topicDirection: { tags: [], active: {}, score: 0 },
                    consecutiveUp: { duoban: 0, bankuai: 0, ticai: 0 }
                };
                
                // 从上一个日期继承标签列表（不继承选中状态）
                const prevDate = window.getPreviousTagDate(window.currentDate);
                
                if (prevDate && tagTitlesData[prevDate]) {
                    const prevData = tagTitlesData[prevDate];
                    
                    ['recentMulti', 'sectorEtf', 'topicDirection'].forEach(type => {
                        const prevTags = prevData[type]?.tags || [];
                        
                        if (prevTags.length > 0) {
                            tagTitlesData[window.currentDate][type].tags = [...prevTags];
                            // 继承标签列表，但所有标签都设为未选中状态
                            tagTitlesData[window.currentDate][type].active = {};
                            prevTags.forEach(tag => {
                                tagTitlesData[window.currentDate][type].active[tag] = false;
                            });
                        }
                    });
                    
                    // 继承连涨连跌天数
                    if (prevData.consecutiveUp) {
                        tagTitlesData[window.currentDate].consecutiveUp = { ...prevData.consecutiveUp };
                    }
                    
                    window.saveData();
                }
            }
            
            const currentData = tagTitlesData[window.currentDate];
            
            // 确保结构完整
            ['recentMulti', 'sectorEtf', 'topicDirection'].forEach(type => {
                if (!currentData[type]) {
                    currentData[type] = { tags: [], active: {}, score: 0 };
                }
                if (!currentData[type].tags) {
                    currentData[type].tags = [];
                }
                if (!currentData[type].active) {
                    currentData[type].active = {};
                }
                if (currentData[type].score === undefined) {
                    currentData[type].score = 0;
                }
            });
            
            if (!currentData.consecutiveUp) {
                currentData.consecutiveUp = { duoban: 0, bankuai: 0, ticai: 0 };
            }
            
            return currentData;
        }

        // 渲染标签标题看板

        // 渲染标签标题看板
        export function renderTagTitles() {
            const data = window.getTodayTagTitles();
            
            const colorMap = {
                red: { background: '#fee2e2', color: '#dc2626', border: '#fecaca' },
                green: { background: '#dcfce7', color: '#16a34a', border: '#bbf7d0' },
                blue: { background: '#dbeafe', color: '#2563eb', border: '#bfdbfe' }
            };
            
            // 渲染最近多板 - 只显示选中的标签（标签不可点击）
            const recentMultiContainer = document.getElementById('recentMultiTitleTags');
            if (recentMultiContainer) {
                const activeTags = data.recentMulti.tags.filter(tag => data.recentMulti.active[tag]);
                recentMultiContainer.innerHTML = activeTags.length > 0 
                    ? activeTags.map(tag => {
                        const color = data.recentMulti.colors && data.recentMulti.colors[tag] ? colorMap[data.recentMulti.colors[tag]] : null;
                        const colorStyle = color ? `background:${color.background};color:${color.color};border:1px solid ${color.border};` : '';
                        return `<span class="tag-title-tag recentmulti frontend-active" data-tag="${tag}" style="${colorStyle}">${tag}</span>`;
                    }).join('')
                    : '<span style="color:#94a3b8;font-size:13px;">点击标题添加标签</span>';
            }
            
            // 渲染最近多板评分
            const recentMultiScoreSlider = document.getElementById('recentMultiScore');
            const recentMultiScoreValue = document.getElementById('recentMultiScoreValue');
            if (recentMultiScoreSlider) {
                const score = data.recentMulti.score || 0;
                recentMultiScoreSlider.value = score;
                // 更新星星显示
                window.updateStarsDisplay('recentMultiStars', score);
                if (recentMultiScoreValue) {
                    recentMultiScoreValue.textContent = score;
                    // 根据分数设置颜色：>=5红色，<5绿色
                    if (score >= 5) {
                        recentMultiScoreValue.style.color = '#ef4444'; // 红色
                    } else {
                        recentMultiScoreValue.style.color = '#10b981'; // 绿色
                    }
                }
                // 同时更新"评分"文字的颜色
                const scoreSimpleValue = recentMultiScoreValue ? recentMultiScoreValue.closest('.score-simple-value') : null;
                if (scoreSimpleValue) {
                    scoreSimpleValue.style.color = score >= 5 ? '#ef4444' : '#10b981';
                }
            }
            
            // 渲染板块ETF - 只显示选中的标签（标签不可点击）
            const sectorEtfContainer = document.getElementById('sectorEtfTitleTags');
            if (sectorEtfContainer) {
                const activeTags = data.sectorEtf.tags.filter(tag => data.sectorEtf.active[tag]);
                sectorEtfContainer.innerHTML = activeTags.length > 0 
                    ? activeTags.map(tag => {
                        const color = data.sectorEtf.colors && data.sectorEtf.colors[tag] ? colorMap[data.sectorEtf.colors[tag]] : null;
                        const colorStyle = color ? `background:${color.background};color:${color.color};border:1px solid ${color.border};` : '';
                        return `<span class="tag-title-tag sectoretf frontend-active" data-tag="${tag}" style="${colorStyle}">${tag}</span>`;
                    }).join('')
                    : '<span style="color:#94a3b8;font-size:13px;">点击标题添加标签</span>';
            }
            
            // 渲染板块ETF评分
            const sectorEtfScoreSlider = document.getElementById('sectorEtfScore');
            const sectorEtfScoreValue = document.getElementById('sectorEtfScoreValue');
            if (sectorEtfScoreSlider) {
                const score = data.sectorEtf.score || 0;
                sectorEtfScoreSlider.value = score;
                // 更新星星显示
                window.updateStarsDisplay('sectorEtfStars', score);
                if (sectorEtfScoreValue) {
                    sectorEtfScoreValue.textContent = score;
                    // 根据分数设置颜色：>=5红色，<5绿色
                    if (score >= 5) {
                        sectorEtfScoreValue.style.color = '#ef4444'; // 红色
                    } else {
                        sectorEtfScoreValue.style.color = '#10b981'; // 绿色
                    }
                }
                // 同时更新"评分"文字的颜色
                const scoreSimpleValue = sectorEtfScoreValue ? sectorEtfScoreValue.closest('.score-simple-value') : null;
                if (scoreSimpleValue) {
                    scoreSimpleValue.style.color = score >= 5 ? '#ef4444' : '#10b981';
                }
            }
            
            // 渲染题材方向 - 只显示选中的标签（标签不可点击）
            const topicDirectionContainer = document.getElementById('topicDirectionTitleTags');
            if (topicDirectionContainer) {
                const activeTags = data.topicDirection.tags.filter(tag => data.topicDirection.active[tag]);
                topicDirectionContainer.innerHTML = activeTags.length > 0 
                    ? activeTags.map(tag => {
                        const color = data.topicDirection.colors && data.topicDirection.colors[tag] ? colorMap[data.topicDirection.colors[tag]] : null;
                        const colorStyle = color ? `background:${color.background};color:${color.color};border:1px solid ${color.border};` : '';
                        return `<span class="tag-title-tag topicdirection frontend-active" data-tag="${tag}" style="${colorStyle}">${tag}</span>`;
                    }).join('')
                    : '<span style="color:#94a3b8;font-size:13px;">点击标题添加标签</span>';
            }
            
            // 渲染题材方向评分
            const topicDirectionScoreSlider = document.getElementById('topicDirectionScore');
            const topicDirectionScoreValue = document.getElementById('topicDirectionScoreValue');
            if (topicDirectionScoreSlider) {
                const score = data.topicDirection.score || 0;
                topicDirectionScoreSlider.value = score;
                // 更新星星显示
                window.updateStarsDisplay('topicDirectionStars', score);
                if (topicDirectionScoreValue) {
                    topicDirectionScoreValue.textContent = score;
                    // 根据分数设置颜色：>=5红色，<5绿色
                    if (score >= 5) {
                        topicDirectionScoreValue.style.color = '#ef4444'; // 红色
                    } else {
                        topicDirectionScoreValue.style.color = '#10b981'; // 绿色
                    }
                }
                // 同时更新"评分"文字的颜色
                const scoreSimpleValue = topicDirectionScoreValue ? topicDirectionScoreValue.closest('.score-simple-value') : null;
                if (scoreSimpleValue) {
                    scoreSimpleValue.style.color = score >= 5 ? '#ef4444' : '#10b981';
                }
            }
            
            // 渲染连涨天数柱状图
            window.renderConsecutiveUp();
        }

        // 切换标签标题状态

        // 切换标签标题状态
        export function toggleTagTitle(event, type, tag) {
            event.stopPropagation();
            const data = window.getTodayTagTitles();
            data[type].active[tag] = !data[type].active[tag];
            window.saveData();
            window.renderTagTitles();
        }

        // 当前编辑的标签类型
        let currentEditingTagType = '';
        let selectedTagForColor = '';

        // 打开标签标题编辑（点击看板时）

        // 打开标签标题编辑（点击看板时）
        export function openTagTitleEdit(type) {
            currentEditingTagType = type;
            const data = window.getTodayTagTitles();
            const typeNames = {
                recentMulti: '最近多板',
                sectorEtf: '板块ETF',
                topicDirection: '题材方向'
            };
            
            document.getElementById('tagTitleEditHeader').textContent = '编辑' + typeNames[type] + '标签';
            window.renderTagTitleEditContainer();
            document.getElementById('tagTitleEditModal').classList.add('active');
            document.getElementById('newTagInput').value = '';
        }

        // 关闭标签标题编辑模态框

        // 关闭标签标题编辑模态框
        export function closeTagTitleEditModal() {
            document.getElementById('tagTitleEditModal').classList.remove('active');
            currentEditingTagType = '';
            window.hideColorSelector();
        }

        // 处理评分杆触摸事件 - 阻止页面滚动

        // 处理评分杆触摸事件 - 阻止页面滚动
        export function handleSliderTouch(event) {
            event.preventDefault();
            event.stopPropagation();
        }

        // 初始化星星评分功能

        // 初始化星星评分功能
        export function initScoreSliderClick() {
            // 已禁用手动点击星星评分功能，评分由系统自动计算
            return;
        }

        // 更新星星显示状态
        // 每颗星代表2分，范围-20到20分
        // 负分点亮绿色星星，正分点亮黄色星星

        // 更新星星显示状态
        // 每颗星代表2分，范围-20到20分
        // 负分点亮绿色星星，正分点亮黄色星星
        export function updateStarsDisplay(containerId, value) {
            const container = document.getElementById(containerId);
            if (!container) return;
            const stars = container.querySelectorAll('.star');
            
            // 计算需要点亮的星星数量（每颗星2分）
            const starCount = Math.abs(value) / 2;
            
            stars.forEach((star, index) => {
                // 移除所有激活状态
                star.classList.remove('active-positive', 'active-negative');
                
                if (index < starCount) {
                    if (value > 0) {
                        star.classList.add('active-positive'); // 正分黄色
                    } else if (value < 0) {
                        star.classList.add('active-negative'); // 负分绿色
                    }
                }
            });
        }

        // 更新评分

        // 更新评分
        export function updateScore(type, value) {
            const data = window.getTodayTagTitles();
            if (data[type]) {
                data[type].score = parseInt(value);
                window.saveData();

                // 更新input值
                const inputEl = document.getElementById(type + 'Score');
                if (inputEl) {
                    inputEl.value = value;
                }

                // 更新星星显示
                const starsMap = {
                    'recentMulti': 'recentMultiStars',
                    'sectorEtf': 'sectorEtfStars',
                    'topicDirection': 'topicDirectionStars'
                };
                window.updateStarsDisplay(starsMap[type], parseInt(value));

                // 更新显示值
                const scoreValueElement = document.getElementById(type + 'ScoreValue');
                if (scoreValueElement) {
                    scoreValueElement.textContent = value;

                    // 根据分数改变颜色：>=5红色，<5绿色
                    const scoreNum = parseInt(value);
                    if (scoreNum >= 5) {
                        scoreValueElement.style.color = '#ef4444'; // 红色
                    } else {
                        scoreValueElement.style.color = '#10b981'; // 绿色
                    }
                }

                // 同时更新"评分"文字的颜色
                const scoreSimpleValue = scoreValueElement ? scoreValueElement.closest('.score-simple-value') : null;
                if (scoreSimpleValue) {
                    const scoreNum = parseInt(value);
                    scoreSimpleValue.style.color = scoreNum >= 5 ? '#ef4444' : '#10b981';
                }
            }
        }

        // 渲染标签编辑容器

        // 渲染标签编辑容器
        export function renderTagTitleEditContainer() {
            const data = window.getTodayTagTitles();
            const container = document.getElementById('tagTitleEditContainer');
            const typeData = data[currentEditingTagType];
            
            if (!typeData || !typeData.tags || typeData.tags.length === 0) {
                container.innerHTML = '<div style="color:#64748b;font-size:14px;">暂无标签，请添加新标签</div>';
                return;
            }
            
            const typeClass = currentEditingTagType === 'recentMulti' ? 'recentmulti' : 
                             currentEditingTagType === 'sectorEtf' ? 'sectoretf' : 'topicdirection';
            
            const colorMap = {
                red: { background: '#fee2e2', color: '#dc2626', border: '#fecaca' },
                green: { background: '#dcfce7', color: '#16a34a', border: '#bbf7d0' },
                blue: { background: '#dbeafe', color: '#2563eb', border: '#bfdbfe' }
            };
            
            container.innerHTML = typeData.tags.map(tag => {
                const color = typeData.colors && typeData.colors[tag] ? colorMap[typeData.colors[tag]] : null;
                const activeStyle = typeData.active[tag] ? 'active' : '';
                const colorStyle = color ? `background:${color.background};color:${color.color};border:1px solid ${color.border};` : '';
                
                return `
                    <div style="display:inline-flex;align-items:center;margin:4px 8px 4px 0;">
                        <span class="tag-title-tag ${typeClass} ${activeStyle}" 
                              onclick="window.toggleEditTag('${tag}')"
                              style="cursor:pointer;${colorStyle}">${tag}</span>
                        <span onclick="window.deleteTag('${tag}')" 
                              style="margin-left:4px;cursor:pointer;color:#ef4444;font-size:16px;font-weight:bold;">×</span>
                    </div>
                `;
            }).join('');
        }

        // 切换编辑状态下的标签

        // 切换编辑状态下的标签
        export function toggleEditTag(tag) {
            const data = window.getTodayTagTitles();
            const wasActive = data[currentEditingTagType].active[tag];
            data[currentEditingTagType].active[tag] = !wasActive;
            data._lastModified = Date.now();
            window.saveData();
            
            // 如果选中了标签，显示颜色选择器
            if (!wasActive) {
                selectedTagForColor = tag;
                window.showColorSelector(tag);
            } else {
                window.hideColorSelector();
            }
            
            window.renderTagTitleEditContainer();
            window.renderTagTitles();
        }

        // 显示颜色选择器

        // 显示颜色选择器
        export function showColorSelector(tag) {
            const colorSelector = document.getElementById('colorSelector');
            const selectedTagName = document.getElementById('selectedTagName');
            colorSelector.style.display = 'block';
            selectedTagName.textContent = tag;
            
            // 重置颜色选择器的选中状态
            ['red', 'green', 'blue'].forEach(color => {
                document.getElementById('color-' + color).style.border = '1px solid transparent';
            });
        }

        // 隐藏颜色选择器

        // 隐藏颜色选择器
        export function hideColorSelector() {
            document.getElementById('colorSelector').style.display = 'none';
            selectedTagForColor = '';
        }

        // 选择标签颜色

        // 选择标签颜色
        export function selectTagColor(color) {
            if (!selectedTagForColor) return;
            
            const data = window.getTodayTagTitles();
            if (!data[currentEditingTagType].colors) {
                data[currentEditingTagType].colors = {};
            }
            data[currentEditingTagType].colors[selectedTagForColor] = color;
            data._lastModified = Date.now();
            window.saveData();
            
            // 更新颜色选择器的选中状态
            const colorBorders = {
                red: '2px solid #dc2626',
                green: '2px solid #16a34a',
                blue: '2px solid #2563eb'
            };
            ['red', 'green', 'blue'].forEach(c => {
                document.getElementById('color-' + c).style.border = c === color ? colorBorders[c] : '1px solid transparent';
            });
            
            window.renderTagTitleEditContainer();
            window.renderTagTitles();
        }

        // 添加新标签
        // 添加标签到未来日期

        // 添加新标签
        // 添加标签到未来日期
        export function addTagToFutureDates(type, tag) {
            const tagTitlesData = window.getTagTitlesData();
            const dates = Object.keys(tagTitlesData).sort((a, b) => new Date(a) - new Date(b));
            const currentDateObj = new Date(window.currentDate);
            
            dates.forEach(date => {
                const dateObj = new Date(date);
                // 只添加到未来日期
                if (dateObj > currentDateObj && tagTitlesData[date] && tagTitlesData[date][type]) {
                    // 如果标签不存在，则添加
                    if (!tagTitlesData[date][type].tags.includes(tag)) {
                        tagTitlesData[date][type].tags.push(tag);
                        tagTitlesData[date][type].active[tag] = false;
                    }
                }
            });
            
            window.saveData();
        }


        export function addNewTag() {
            const input = document.getElementById('newTagInput');
            const tagName = input.value.trim();
            
            if (!tagName) {
                alert('请输入标签名称');
                return;
            }
            
            const data = window.getTodayTagTitles();
            
            if (data[currentEditingTagType].tags.includes(tagName)) {
                alert('标签已存在');
                return;
            }
            
            data[currentEditingTagType].tags.unshift(tagName);
            data[currentEditingTagType].active[tagName] = false;
            data._lastModified = Date.now();
            input.value = '';
            
            // 添加标签到未来日期
            window.addTagToFutureDates(currentEditingTagType, tagName);
            
            window.renderTagTitleEditContainer();
            window.renderTagTitles();
        }

        // 删除标签
        // 从未来日期删除指定标签

        // 删除标签
        // 从未来日期删除指定标签
        export function deleteTagFromFutureDates(type, tag) {
            const tagTitlesData = window.getTagTitlesData();
            const dates = Object.keys(tagTitlesData).sort((a, b) => new Date(a) - new Date(b));
            const currentDateObj = new Date(window.currentDate);
            
            dates.forEach(date => {
                const dateObj = new Date(date);
                // 只从未来日期删除
                if (dateObj > currentDateObj && tagTitlesData[date] && tagTitlesData[date][type]) {
                    tagTitlesData[date][type].tags = tagTitlesData[date][type].tags.filter(t => t !== tag);
                    delete tagTitlesData[date][type].active[tag];
                }
            });
            
            window.saveData();
        }


        export function deleteTag(tag) {
            if (!confirm('确定要删除标签"' + tag + '"吗？')) {
                return;
            }
            
            const data = window.getTodayTagTitles();
            data[currentEditingTagType].tags = data[currentEditingTagType].tags.filter(t => t !== tag);
            delete data[currentEditingTagType].active[tag];
            data._lastModified = Date.now();
            
            // 从未来日期删除指定标签
            window.deleteTagFromFutureDates(currentEditingTagType, tag);
            
            window.renderTagTitleEditContainer();
            window.renderTagTitles();
        }

        // 保存标签标题

        // 保存标签标题
        export function saveTagTitles() {
            window.saveData();
            window.closeTagTitleEditModal();
            window.showToast('✅ 标签已保存！');
        }
        
        // 清除当前类型的所有标签
        // 清空未来日期的所有标签

        // 清除当前类型的所有标签
        // 清空未来日期的所有标签
        export function clearAllTagsFromFutureDates(type) {
            const tagTitlesData = window.getTagTitlesData();
            const dates = Object.keys(tagTitlesData).sort((a, b) => new Date(a) - new Date(b));
            const currentDateObj = new Date(window.currentDate);
            
            dates.forEach(date => {
                const dateObj = new Date(date);
                // 只清空未来日期
                if (dateObj > currentDateObj && tagTitlesData[date] && tagTitlesData[date][type]) {
                    tagTitlesData[date][type].tags = [];
                    tagTitlesData[date][type].active = {};
                }
            });
            
            window.saveData();
        }


        export function clearAllTags() {
            if (!confirm('确定要清除"' + 
                (currentEditingTagType === 'recentMulti' ? '最近多板' : 
                 currentEditingTagType === 'sectorEtf' ? '板块ETF' : '题材方向') + 
                '"的全部标签吗？此操作不可恢复。')) {
                return;
            }
            
            const data = window.getTodayTagTitles();
            data[currentEditingTagType].tags = [];
            data[currentEditingTagType].active = {};
            data._lastModified = Date.now();
            window.saveData();
            
            window.renderTagTitleEditContainer();
            window.renderTagTitles();
            window.showToast('✅ 标签已清除！');
        }

        // 获取当日模式数据（带自动延续和恢复功能）

