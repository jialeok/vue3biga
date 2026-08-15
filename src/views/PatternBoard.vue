<template>
  <div class="pattern-board trading-day-element" :class="{ minimized: !expanded }">
  <div class="pattern-header" @click="toggleExpand">
    <div class="pattern-title">模式
      <div class="pattern-tags">
        <div v-if="pattern.update" class="pattern-tag update">更新</div>
        <div v-if="pattern.keep" class="pattern-tag keep">坚守</div>
      </div>
    </div>
    <div class="pattern-toggle-btn">{{ expanded ? '▲' : '▼' }}</div>
  </div>
  <div class="pattern-content" @click="startEdit">
    <div v-if="pattern.content && pattern.content.trim()" style="white-space: pre-wrap;">{{ pattern.content }}</div>
    <div v-else class="pattern-placeholder">暂无模式心得，点击添加...</div>
  </div>
  </div>

  <EditModal v-model="editing" title="编辑模式" @save="save">
    <div style="font-size:12px;color:#64748b;margin-bottom:12px">记录当日模式完善心得</div>
    <textarea v-model="draftContent" placeholder="输入模式完善心得..." rows="6" style="width:100%;padding:12px;border:1px solid #e2e8f0;border-radius:12px;font-size:15px;box-sizing:border-box;resize:vertical"></textarea>
    <div style="display:flex;gap:8px;margin:14px 0;flex-wrap:wrap">
      <div style="flex:1;display:flex;align-items:center;gap:6px;padding:10px;border-radius:12px;background:rgba(59,130,246,0.05)">
        <input type="checkbox" v-model="draftUpdate" style="width:18px;height:18px">
        <span style="font-size:13px;color:#3b82f6;font-weight:600">更新</span>
      </div>
      <div style="flex:1;display:flex;align-items:center;gap:6px;padding:10px;border-radius:12px;background:rgba(16,185,129,0.05)">
        <input type="checkbox" v-model="draftKeep" style="width:18px;height:18px">
        <span style="font-size:13px;color:#059669;font-weight:600">坚守</span>
      </div>
    </div>
  </EditModal>
</template>

<script setup>
import { ref, computed, onMounted, watch } from 'vue';
import { getCurrentDate, getPatternData, saveData } from '../logic/app-core.js';
import { getPreviousTradingDay, getNextTradingDay } from '../logic/date/trading-day-helpers.js';
import { showToast } from '../composables/useToast.js';
import { useUiStore } from '../stores/uiStore.js';
import { getPatternStore, setPatternReactive, hydratePatternStore } from '../logic/pattern/pattern-store.js';
import { savePatternData } from '../logic/pattern/pattern.js';
import EditModal from '../components/EditModal.vue';

const uiStore = useUiStore();
const expanded = ref(false);
const editing = ref(false);
const draftContent = ref('');
const draftUpdate = ref(false);
const draftKeep = ref(false);

// §19/§31：pattern 经响应式 store 暴露，compute 依赖它（替换原本地 ref 拷贝，使 Realtime 写入能刷新 UI）。
const patternStore = getPatternStore();
const currentDate = computed(() => uiStore.currentDate || getCurrentDate());
const pattern = computed(() => patternStore.byDate[currentDate.value] || { content: '', update: false, keep: false });

// 加载当日模式：优先当日缓存；若当日为空且前一日带 update/keep，则预填并持久化（保留原 loadTodayPattern 语义）。
function ensureTodayPattern() {
  const date = currentDate.value;
  const patternData = getPatternData();
  if (patternData[date]) {
    setPatternReactive(date, patternData[date]);
    return;
  }
  const prevDate = getPreviousTradingDay(date);
  if (prevDate && patternData[prevDate]) {
    const prevPattern = patternData[prevDate];
    if (prevPattern.update || prevPattern.keep) {
      const newPattern = { content: prevPattern.content || '', update: false, keep: false };
      patternData[date] = newPattern;
      setPatternReactive(date, newPattern);
      saveData();
      return;
    }
  }
  // 当日无数据：compute 已回退到默认空值，无需写入缓存（避免伪造用户数据）。
}

function refresh() {
  editing.value = false;
  draftContent.value = '';
  draftUpdate.value = false;
  draftKeep.value = false;
}

function toggleExpand() {
  expanded.value = !expanded.value;
}

function startEdit() {
  draftContent.value = pattern.value.content || '';
  draftUpdate.value = !!pattern.value.update;
  draftKeep.value = !!pattern.value.keep;
  editing.value = true;
}

async function save() {
  const content = draftContent.value.trim();
  const update = draftUpdate.value;
  const keep = draftKeep.value;
  const date = currentDate.value;
  const patternData = getPatternData();
  patternData[date] = { content, update, keep };
  setPatternReactive(date, { content, update, keep }); // 乐观更新，立即刷新本页

  if (update || keep) {
    const nextDate = getNextTradingDay(date);
    if (nextDate) {
      const nextPattern = patternData[nextDate];
      if (nextPattern && (!nextPattern.content || nextPattern.content.trim() === '')) {
        nextPattern.content = content;
        nextPattern.update = false;
        nextPattern.keep = false;
        setPatternReactive(nextDate, nextPattern);
      }
    }
  }

  // 保留原 saveData() 行为：标记脏数据 + 触发其它模块云端异步推送（fire-and-forget）。
  saveData();

  // §10：直接落 Supabase 并 await 结果，按成功/失败提示，禁用静默成功。
  try {
    await savePatternData(date, { content, update, keep });
    showToast('✅ 模式数据已保存' + ((update || keep) ? '，已检查后一天数据' : ''));
  } catch (e) {
    console.error('[PatternBoard] 模式保存失败：', e && e.message);
    showToast('❌ 模式数据保存失败，请重试');
  }

  editing.value = false;
}

onMounted(() => {
  hydratePatternStore();
  ensureTodayPattern();
});
// 日期切换时重新加载当日模式（§17：响应式驱动，而非依赖重新挂载）。
watch(currentDate, ensureTodayPattern);

defineExpose({ refresh });
</script>
