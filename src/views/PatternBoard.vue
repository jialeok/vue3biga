<template>
  <div class="pattern-board trading-day-element">
  <div class="pattern-header" @click="toggleExpand">
    <div class="pattern-title">模式
      <div class="pattern-tags">
        <div v-if="pattern.update" class="pattern-tag update">更新</div>
        <div v-if="pattern.keep" class="pattern-tag keep">坚守</div>
      </div>
    </div>
    <div class="pattern-toggle-btn">{{ expanded ? '▲' : '▼' }}</div>
  </div>
  <div v-show="expanded" class="pattern-content" @click="startEdit">
    <div v-if="pattern.content && pattern.content.trim()" style="white-space: pre-wrap;">{{ pattern.content }}</div>
    <div v-else class="pattern-placeholder">暂无模式心得，点击添加...</div>
  </div>
  <div v-if="editing" class="vue-edit-overlay" @click.self="cancel">
    <div class="vue-edit-modal">
      <div class="vue-edit-header"><span>编辑模式心得</span><button @click="cancel">×</button></div>
      <textarea v-model="draftContent" placeholder="输入模式完善心得..."></textarea>
      <div class="vue-edit-checkboxes">
        <label><input type="checkbox" v-model="draftUpdate"> 更新</label>
        <label><input type="checkbox" v-model="draftKeep"> 坚守</label>
      </div>
      <button class="vue-edit-save" @click="save">保存模式</button>
    </div>
  </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted } from 'vue';
import { getCurrentDate, getPatternData, saveData, getNextDate, getPreviousDate } from '../logic/app-core.js';
import { showToast } from '../composables/useToast.js';

const expanded = ref(false);
const editing = ref(false);
const draftContent = ref('');
const draftUpdate = ref(false);
const draftKeep = ref(false);
const pattern = ref({ content: '', update: false, keep: false });

function loadTodayPattern() {
  const date = getCurrentDate();
  const patternData = getPatternData();
  if (patternData[date]) {
    pattern.value = patternData[date];
    return;
  }
  const prevDate = getPreviousDate(date);
  if (patternData[prevDate]) {
    const prevPattern = patternData[prevDate];
    if (prevPattern.update || prevPattern.keep) {
      const newPattern = { content: prevPattern.content || '', update: false, keep: false };
      patternData[date] = newPattern;
      saveData();
      pattern.value = newPattern;
      return;
    }
  }
  pattern.value = { content: '', update: false, keep: false };
}

function refresh() {
  editing.value = false;
  draftContent.value = '';
  draftUpdate.value = false;
  draftKeep.value = false;
}

function toggleExpand() {
  expanded.value = !expanded.value;
  const el = document.getElementById('patternBoard');
  if (el) {
    if (expanded.value) el.classList.remove('minimized');
    else el.classList.add('minimized');
  }
}
function startEdit() {
  draftContent.value = pattern.value.content || '';
  draftUpdate.value = !!pattern.value.update;
  draftKeep.value = !!pattern.value.keep;
  editing.value = true;
}
function cancel() { editing.value = false; }
function save() {
  const content = draftContent.value.trim();
  const update = draftUpdate.value;
  const keep = draftKeep.value;
  const patternData = getPatternData();
  patternData[getCurrentDate()] = { content, update, keep };

  if (update || keep) {
    const nextDate = getNextDate(getCurrentDate());
    if (nextDate) {
      const nextPattern = patternData[nextDate];
      if (nextPattern && (!nextPattern.content || nextPattern.content.trim() === '')) {
        nextPattern.content = content;
        nextPattern.update = false;
        nextPattern.keep = false;
      }
    }
  }

  saveData();
  loadTodayPattern();
  editing.value = false;
  showToast('✅ 模式数据已保存' + ((update || keep) ? '，已检查后一天数据' : ''));
}

onMounted(() => loadTodayPattern());
let timer = setInterval(() => {}, 500);
onUnmounted(() => clearInterval(timer));

defineExpose({ refresh });
</script>

