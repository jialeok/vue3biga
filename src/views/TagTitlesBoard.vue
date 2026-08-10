<template>
  <div class="tag-titles-board">
    <!-- 涓変釜鏍囩绫诲瀷灞曠ず鍖?-->
    <div v-for="t in types" :key="t.key" class="tag-title-section">
      <div class="tag-title-header">
        <span class="tag-title-name">{{ t.name }}</span>
        <span class="score-simple-value" :style="{ color: scoreColor(t.key) }">
          璇勫垎 <span :id="t.key + 'ScoreValue'" :style="{ color: scoreColor(t.key) }">{{ scoreOf(t.key) }}</span>
        </span>
      </div>
      <div :id="t.key + 'TitleTags'" class="tag-title-tags" @click="openEdit(t.key)">
        <template v-if="activeTags(t.key).length">
          <span
            v-for="tag in activeTags(t.key)"
            :key="tag"
            class="tag-title-tag"
            :class="t.cls + ' frontend-active'"
            :style="tagStyle(t.key, tag)"
          >{{ tag }}</span>
        </template>
        <span v-else class="tag-empty-hint">鐐瑰嚮鏍囬娣诲姞鏍囩</span>
      </div>
      <div class="score-row">
        <input
          :id="t.key + 'Score'"
          type="range"
          min="-20"
          max="20"
          step="1"
          :value="scoreOf(t.key)"
          @input="updateScore(t.key, $event.target.value)"
          @touchstart="handleSliderTouch"
        />
        <div :id="t.key + 'Stars'" class="stars-container">
          <span v-for="n in 10" :key="n" class="star" :class="starClass(t.key, n)"></span>
        </div>
      </div>
    </div>

    <!-- 缂栬緫寮圭獥 -->
    <Teleport to="body">
      <div v-if="modalActive" id="tagTitleEditModal" class="tag-title-modal active" @click.self="closeModal">
        <div class="tag-title-modal-panel">
          <div class="tag-title-modal-header">
            <span id="tagTitleEditHeader">缂栬緫{{ currentTypeName }}鏍囩</span>
            <button class="modal-close-btn" @click="closeModal">脳</button>
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
                <span class="delete-tag-btn" @click="deleteTag(tag)">脳</span>
              </div>
            </template>
            <div v-else class="edit-empty-hint">鏆傛棤鏍囩锛岃娣诲姞鏂版爣绛?/div>
          </div>
          <div class="new-tag-row">
            <input id="newTagInput" v-model="newTag" placeholder="鏂版爣绛惧悕绉? />
            <button class="add-tag-btn" @click="addNewTag">娣诲姞</button>
          </div>
          <div v-if="colorSelectorVisible" id="colorSelector" class="color-selector">
            <span class="color-selector-label">棰滆壊锛?span id="selectedTagName">{{ selectedTagForColor }}</span></span>
            <div class="color-options">
              <span id="color-red" class="color-option color-red" :style="{ border: colorBorder('red') }" @click="selectTagColor('red')"></span>
              <span id="color-green" class="color-option color-green" :style="{ border: colorBorder('green') }" @click="selectTagColor('green')"></span>
              <span id="color-blue" class="color-option color-blue" :style="{ border: colorBorder('blue') }" @click="selectTagColor('blue')"></span>
            </div>
          </div>
          <div class="modal-actions">
            <button class="btn-clear-all" @click="clearAllTags">娓呴櫎鍏ㄩ儴</button>
            <button class="btn-save" @click="saveTagTitles">淇濆瓨</button>
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
  { key: 'recentMulti', name: '鏈€杩戝鏉?, cls: 'recentmulti' },
  { key: 'sectorEtf', name: '鏉垮潡ETF', cls: 'sectoretf' },
  { key: 'topicDirection', name: '棰樻潗鏂瑰悜', cls: 'topicdirection' }
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
  // Vue 妯℃澘宸查€氳繃 starClass 鍝嶅簲寮忔覆鏌擄紝姝ゅ嚱鏁颁繚鐣欎緵澶栭儴璋冪敤
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
  if (!tagName) { alert('璇疯緭鍏ユ爣绛惧悕绉?); return; }
  const d = getTodayTagTitles();
  if (d[currentEditingType.value].tags.includes(tagName)) { alert('鏍囩宸插瓨鍦?); return; }
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
  if (!confirm('纭畾瑕佸垹闄ゆ爣绛?' + tag + '"鍚楋紵')) return;
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
  showToast('鉁?鏍囩宸蹭繚瀛橈紒');
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
  if (!confirm('纭畾瑕佹竻闄?' + currentTypeName.value + '"鐨勫叏閮ㄦ爣绛惧悧锛熸鎿嶄綔涓嶅彲鎭㈠銆?)) return;
  const d = getTodayTagTitles();
  d[currentEditingType.value].tags = [];
  d[currentEditingType.value].active = {};
  d._lastModified = Date.now();
  saveData();
  refreshTick.value++;
  showToast('鉁?鏍囩宸叉竻闄わ紒');
}

function render() { refreshTick.value++; }

defineExpose({
  render, getTodayMulti, getTodayHotspot, getPreviousTagDate, syncTagsToFutureDates,
  toggleTagTitle, openEdit, closeModal, updateStarsDisplay, updateScore,
  toggleEditTag, selectTagColor, addNewTag, deleteTag, saveTagTitles, clearAllTags
});
</script>

<style>
.tag-titles-board {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.tag-title-section {
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  padding: 10px 14px;
  background: #fff;
}
.tag-title-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
}
.tag-title-name {
  font-weight: 600;
  color: #1f2937;
  font-size: 14px;
}
.score-simple-value {
  font-size: 12px;
  color: #6b7280;
}
.tag-title-tags {
  min-height: 28px;
  cursor: pointer;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
}
.tag-title-tag {
  display: inline-block;
  padding: 2px 10px;
  border-radius: 12px;
  font-size: 12px;
  background: #f3f4f6;
  color: #374151;
  border: 1px solid #e5e7eb;
}
.tag-empty-hint {
  color: #94a3b8;
  font-size: 13px;
}
.score-row {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 8px;
}
.score-row input[type="range"] {
  flex: 1;
}
.stars-container {
  display: flex;
  gap: 2px;
}
.star {
  width: 12px;
  height: 12px;
  background: #e5e7eb;
  border-radius: 50%;
  display: inline-block;
}
.star.active-positive {
  background: #fbbf24;
}
.star.active-negative {
  background: #10b981;
}
.tag-title-modal {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  z-index: 9999;
  display: flex;
  align-items: center;
  justify-content: center;
}
.tag-title-modal-panel {
  background: #fff;
  border-radius: 12px;
  padding: 20px;
  min-width: 480px;
  max-height: 90vh;
  overflow: auto;
}
.tag-title-modal-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
  font-size: 16px;
  font-weight: 600;
}
.modal-close-btn {
  border: none;
  background: none;
  font-size: 20px;
  cursor: pointer;
  color: #9ca3af;
}
.tag-title-edit-container {
  min-height: 60px;
  margin-bottom: 12px;
}
.edit-tag-item {
  display: inline-flex;
  align-items: center;
  margin: 4px 8px 4px 0;
}
.tag-title-tag.active {
  opacity: 1;
}
.delete-tag-btn {
  margin-left: 4px;
  cursor: pointer;
  color: #ef4444;
  font-size: 16px;
  font-weight: bold;
}
.edit-empty-hint {
  color: #64748b;
  font-size: 14px;
}
.new-tag-row {
  display: flex;
  gap: 8px;
  margin-bottom: 12px;
}
.new-tag-row input {
  flex: 1;
  padding: 6px 8px;
  border: 1px solid #d1d5db;
  border-radius: 6px;
}
.add-tag-btn {
  padding: 6px 16px;
  border: none;
  border-radius: 6px;
  background: #2563eb;
  color: #fff;
  cursor: pointer;
}
.color-selector {
  margin-bottom: 12px;
  padding: 8px;
  background: #f9fafb;
  border-radius: 6px;
}
.color-selector-label {
  font-size: 13px;
  color: #374151;
}
.color-options {
  display: flex;
  gap: 8px;
  margin-top: 6px;
}
.color-option {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  cursor: pointer;
  border: 1px solid transparent;
}
.color-option.color-red { background: #dc2626; }
.color-option.color-green { background: #16a34a; }
.color-option.color-blue { background: #2563eb; }
.modal-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}
.btn-clear-all, .btn-save {
  padding: 8px 16px;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  font-size: 14px;
}
.btn-clear-all { background: #fee2e2; color: #dc2626; }
.btn-save { background: #2563eb; color: #fff; }
</style>