<template>
  <div class="tag-titles-wrap">
    <template v-for="t in types" :key="t.key">
      <div class="tag-title-board trading-day-element" @click="openEdit(t.key)">
        <div class="tag-title-content">
          <div class="tag-title-left">
            <div class="tag-title-text">{{ t.name }}</div>
            <div :id="t.key + 'TitleTags'" class="tag-title-tags">
              <template v-if="activeTags(t.key).length">
                <span
                  v-for="tag in activeTags(t.key)"
                  :key="tag"
                  class="tag-title-tag"
                  :class="t.cls + ' frontend-active'"
                  :style="tagStyle(t.key, tag)"
                >{{ tag }}</span>
              </template>
              <span v-else class="tag-empty-hint">点击标题添加标签</span>
            </div>
          </div>
        </div>
      </div>
      <div class="score-stars-container trading-day-element" :id="t.key + 'ScoreContainer'">
        <div class="stars-wrapper" :id="t.key + 'Stars'">
          <span v-for="n in 10" :key="n" class="star" :class="starClass(t.key, n)">★</span>
        </div>
        <input type="hidden" :id="t.key + 'Score'" :value="scoreOf(t.key)" />
        <div class="score-simple-value">
          <span>评分:</span>
          <span :id="t.key + 'ScoreValue'" :style="{ color: scoreColor(t.key) }">{{ scoreOf(t.key) }}</span>
        </div>
      </div>
    </template>

    <!-- 编辑弹窗 -->
    <Teleport to="body">
      <div v-if="modalActive" id="tagTitleEditModal" class="tag-title-modal active" @click.self="closeModal">
        <div class="tag-title-modal-panel">
          <div class="tag-title-modal-header">
            <span id="tagTitleEditHeader">编辑{{ currentTypeName }}标签</span>
            <button class="modal-close-btn" @click="closeModal">×</button>
          </div>
          <div id="tagTitleEditContainer" class="tag-title-edit-container">
            <template v-if="editTags.length">
              <div v-for="tag in editTags" :key="tag" class="edit-tag-item">
                <span
                  class="tag-title-tag"
                  :class="[currentTypeClass, { active: editActive(tag) }]"
                  :style="tagStyle(currentEditingType, tag)"
                  @click="toggleEditTag(tag)"
                >{{ tag }}</span>
                <span class="delete-tag-btn" @click="deleteTag(tag)">×</span>
              </div>
            </template>
            <div v-else class="edit-empty-hint">暂无标签，请添加新标签</div>
          </div>
          <div class="new-tag-row">
            <input id="newTagInput" v-model="newTag" placeholder="新标签名称" />
            <button class="add-tag-btn" @click="addNewTag">添加</button>
          </div>
          <div v-if="colorSelectorVisible" id="colorSelector" class="color-selector">
            <span class="color-selector-label">颜色：<span id="selectedTagName">{{ selectedTagForColor }}</span></span>
            <div class="color-options">
              <span id="color-red" class="color-option color-red" :style="{ border: colorBorder('red') }" @click="selectTagColor('red')"></span>
              <span id="color-green" class="color-option color-green" :style="{ border: colorBorder('green') }" @click="selectTagColor('green')"></span>
              <span id="color-blue" class="color-option color-blue" :style="{ border: colorBorder('blue') }" @click="selectTagColor('blue')"></span>
            </div>
          </div>
          <div class="modal-actions">
            <button class="btn-clear-all" @click="clearAllTags">清除全部</button>
            <button class="btn-save" @click="saveTagTitles">保存</button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue';
import { useUiStore } from '../stores/uiStore.js';
import { saveData, getTagTitlesData, getMultiData, getHotspotData } from '../logic/app-core.js';
import { showToast } from '../composables/useToast.js';

const uiStore = useUiStore();

const types = [
  { key: 'recentMulti', name: '最近多板', cls: 'recentmulti' },
  { key: 'sectorEtf', name: '板块ETF', cls: 'sectoretf' },
  { key: 'topicDirection', name: '题材方向', cls: 'topicdirection' }
];

const modalActive = ref(false);
const currentEditingType = ref('');
const newTag = ref('');
const selectedTagForColor = ref('');
const colorSelectorVisible = ref(false);
const selectedColor = ref('');
const refreshTick = ref(0);

const currentTypeName = computed(() => {
  const t = types.find(t => t.key === currentEditingType.value);
  return t ? t.name : '';
});
const currentTypeClass = computed(() => {
  const t = types.find(t => t.key === currentEditingType.value);
  return t ? t.cls : '';
});

function todayData() {
  refreshTick.value;
  return getTagTitlesData()[uiStore.currentDate] || {};
}

function getTodayTagTitles() {
  return getTagTitlesData()[uiStore.currentDate] || {};
}

function getTodayMulti() {
  return getMultiData()[uiStore.currentDate] || [];
}
function getTodayHotspot() {
  return getHotspotData()[uiStore.currentDate] || '';
}

function getPreviousTagDate(date) {
  const tagTitlesData = getTagTitlesData();
  const dates = Object.keys(tagTitlesData)
    .filter(d => d && d.length === 10)
    .sort((a, b) => new Date(a) - new Date(b));
  const currentDateObj = new Date(date);
  for (let i = dates.length - 1; i >= 0; i--) {
    if (new Date(dates[i]) < currentDateObj) return dates[i];
  }
  return null;
}

function syncTagsToFutureDates(type, tags) {
  const tagTitlesData = getTagTitlesData();
  const dates = Object.keys(tagTitlesData).sort((a, b) => new Date(a) - new Date(b));
  const currentDateObj = new Date(uiStore.currentDate);
  dates.forEach(date => {
    const dateObj = new Date(date);
    if (dateObj > currentDateObj && tagTitlesData[date] && tagTitlesData[date][type]) {
      const oldActive = tagTitlesData[date][type].active || {};
      tagTitlesData[date][type].tags = [...tags];
      tagTitlesData[date][type].active = {};
      tags.forEach(tag => { tagTitlesData[date][type].active[tag] = oldActive[tag] || false; });
    }
  });
  saveData();
}

function activeTags(key) {
  const d = todayData();
  if (!d || !d[key]) return [];
  return (d[key].tags || []).filter(tag => d[key].active[tag]);
}
function scoreOf(key) {
  const d = todayData();
  return (d && d[key] && d[key].score) || 0;
}
function scoreColor(key) {
  return scoreOf(key) >= 5 ? '#ef4444' : '#10b981';
}
function tagStyle(key, tag) {
  const d = todayData();
  if (!d || !d[key]) return '';
  const colorMap = {
    red: { background: '#fee2e2', color: '#dc2626', border: '#fecaca' },
    green: { background: '#dcfce7', color: '#16a34a', border: '#bbf7d0' },
    blue: { background: '#dbeafe', color: '#2563eb', border: '#bfdbfe' }
  };
  const colorKey = d[key].colors && d[key].colors[tag];
  const c = colorKey ? colorMap[colorKey] : null;
  return c ? `background:${c.background};color:${c.color};border:1px solid ${c.border};` : '';
}
function starClass(key, n) {
  const v = scoreOf(key);
  const starCount = Math.abs(v) / 2;
  if (n > starCount) return '';
  return v > 0 ? 'active-positive' : (v < 0 ? 'active-negative' : '');
}

function updateStarsDisplay(containerId, value) {
  // Vue 模板已通过 starClass 响应式渲染，此函数保留供外部调用
  refreshTick.value++;
}

function updateScore(key, value) {
  const d = getTodayTagTitles();
  if (d[key]) {
    d[key].score = parseInt(value);
    saveData();
    refreshTick.value++;
  }
}

function toggleTagTitle(event, type, tag) {
  event.stopPropagation();
  const d = getTodayTagTitles();
  d[type].active[tag] = !d[type].active[tag];
  saveData();
  refreshTick.value++;
}

function openEdit(key) {
  currentEditingType.value = key;
  newTag.value = '';
  modalActive.value = true;
}
function closeModal() {
  modalActive.value = false;
  currentEditingType.value = '';
  colorSelectorVisible.value = false;
}

function handleSliderTouch(event) {
  event.preventDefault();
  event.stopPropagation();
}

function editTags() {
  const d = todayData();
  if (!d || !d[currentEditingType.value]) return [];
  return d[currentEditingType.value].tags || [];
}
function editActive(tag) {
  const d = todayData();
  return d && d[currentEditingType.value] && d[currentEditingType.value].active[tag];
}

function toggleEditTag(tag) {
  const d = getTodayTagTitles();
  const wasActive = d[currentEditingType.value].active[tag];
  d[currentEditingType.value].active[tag] = !wasActive;
  d._lastModified = Date.now();
  saveData();
  if (!wasActive) {
    selectedTagForColor.value = tag;
    colorSelectorVisible.value = true;
  } else {
    colorSelectorVisible.value = false;
  }
  refreshTick.value++;
}

function selectTagColor(color) {
  if (!selectedTagForColor.value) return;
  const d = getTodayTagTitles();
  if (!d[currentEditingType.value].colors) d[currentEditingType.value].colors = {};
  d[currentEditingType.value].colors[selectedTagForColor.value] = color;
  d._lastModified = Date.now();
  saveData();
  selectedColor.value = color;
  refreshTick.value++;
}
function colorBorder(c) {
  const borders = { red: '2px solid #dc2626', green: '2px solid #16a34a', blue: '2px solid #2563eb' };
  return selectedColor.value === c ? borders[c] : '1px solid transparent';
}

function addTagToFutureDates(type, tag) {
  const tagTitlesData = getTagTitlesData();
  const dates = Object.keys(tagTitlesData).sort((a, b) => new Date(a) - new Date(b));
  const currentDateObj = new Date(uiStore.currentDate);
  dates.forEach(date => {
    const dateObj = new Date(date);
    if (dateObj > currentDateObj && tagTitlesData[date] && tagTitlesData[date][type]) {
      if (!tagTitlesData[date][type].tags.includes(tag)) {
        tagTitlesData[date][type].tags.push(tag);
        tagTitlesData[date][type].active[tag] = false;
      }
    }
  });
  saveData();
}

function addNewTag() {
  const tagName = newTag.value.trim();
  if (!tagName) { alert('请输入标签名称'); return; }
  const d = getTodayTagTitles();
  if (d[currentEditingType.value].tags.includes(tagName)) { alert('标签已存在'); return; }
  d[currentEditingType.value].tags.unshift(tagName);
  d[currentEditingType.value].active[tagName] = false;
  d._lastModified = Date.now();
  newTag.value = '';
  addTagToFutureDates(currentEditingType.value, tagName);
  refreshTick.value++;
}

function deleteTagFromFutureDates(type, tag) {
  const tagTitlesData = getTagTitlesData();
  const dates = Object.keys(tagTitlesData).sort((a, b) => new Date(a) - new Date(b));
  const currentDateObj = new Date(uiStore.currentDate);
  dates.forEach(date => {
    const dateObj = new Date(date);
    if (dateObj > currentDateObj && tagTitlesData[date] && tagTitlesData[date][type]) {
      tagTitlesData[date][type].tags = tagTitlesData[date][type].tags.filter(t => t !== tag);
      delete tagTitlesData[date][type].active[tag];
    }
  });
  saveData();
}

function deleteTag(tag) {
  if (!confirm('确定要删除标签"' + tag + '"吗？')) return;
  const d = getTodayTagTitles();
  d[currentEditingType.value].tags = d[currentEditingType.value].tags.filter(t => t !== tag);
  delete d[currentEditingType.value].active[tag];
  d._lastModified = Date.now();
  deleteTagFromFutureDates(currentEditingType.value, tag);
  refreshTick.value++;
}

function saveTagTitles() {
  saveData();
  closeModal();
  showToast('✅ 标签已保存！');
}

function clearAllTagsFromFutureDates(type) {
  const tagTitlesData = getTagTitlesData();
  const dates = Object.keys(tagTitlesData).sort((a, b) => new Date(a) - new Date(b));
  const currentDateObj = new Date(uiStore.currentDate);
  dates.forEach(date => {
    const dateObj = new Date(date);
    if (dateObj > currentDateObj && tagTitlesData[date] && tagTitlesData[date][type]) {
      tagTitlesData[date][type].tags = [];
      tagTitlesData[date][type].active = {};
    }
  });
  saveData();
}

function clearAllTags() {
  if (!confirm('确定要清除"' + currentTypeName.value + '"的全部标签吗？此操作不可恢复。')) return;
  const d = getTodayTagTitles();
  d[currentEditingType.value].tags = [];
  d[currentEditingType.value].active = {};
  d._lastModified = Date.now();
  saveData();
  refreshTick.value++;
  showToast('✅ 标签已清除！');
}

function render() { refreshTick.value++; }

defineExpose({
  render, getTodayMulti, getTodayHotspot, getPreviousTagDate, syncTagsToFutureDates,
  toggleTagTitle, openEdit, closeModal, updateStarsDisplay, updateScore,
  toggleEditTag, selectTagColor, addNewTag, deleteTag, saveTagTitles, clearAllTags
});
</script>

