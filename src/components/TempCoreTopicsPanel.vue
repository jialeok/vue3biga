<!-- TempCoreTopicsPanel.vue — 临时题材【独立组件】（2026-11-27 用户口径）
     ══════════════════════════════════════════════════════════════════════════════════
     为什么要独立出来：
       ① 临时题材与主流核心词是【两张表、两套语义】（core_topic_temp / core_topics），
          混在核心词管理弹窗里改一处很容易碰到另一处；
       ② 用户口径：「临时题材只在有效期那里生效，历史日期 / 未来日期都不能用，只有指定的时间可以」
          ⇒ 临时题材需要自己的增删改 + 生效状态可视化，主流词库一行都不该被这段逻辑牵动。
     分层（架构 §2）：本组件是 UI，⛔ 不直连 Supabase —— 全部走 data/temp-core-topics.js
       与 logic/topic/*（core-word-purge 的影响面预览）。
     契约：对外只暴露 refresh()（父弹窗打开时调一次，强制重读，绕过启动失败冷却）。
       ⛔ 无 props / 无 v-model：临时题材的真相只在云端 + Data 层缓存，组件内不留第二份（§6）。
     ══════════════════════════════════════════════════════════════════════════════════ -->
<template>
  <div class="tct-panel">
    <div class="tct-title">
      临时题材（只归类、不禁选；<b>仅生效 3 个交易日</b>，其余日期一律按主流题材）
    </div>

    <!-- 追加表单 -->
    <div class="tct-form">
      <input
        v-model="newName"
        type="text"
        placeholder="临时题材名称"
        class="tct-input tct-name"
        @keyup.enter="addTemp"
      >
      <input
        v-model="newSynonyms"
        type="text"
        placeholder="同义词（逗号分隔）"
        class="tct-input tct-syn"
        @keyup.enter="addTemp"
      >
    </div>
    <div class="tct-form">
      <span class="tct-hint">设置日</span>
      <input
        v-model="startDate"
        type="date"
        class="tct-input tct-date"
      >
      <span class="tct-end">至 {{ endDateText }}</span>
      <button
        type="button"
        class="tct-btn tct-btn-add"
        :disabled="saving"
        @click="addTemp"
      >
        {{ saving ? '保存中…' : '添加临时题材' }}
      </button>
    </div>
    <div
      v-if="error"
      class="tct-error"
    >
      {{ error }}
    </div>

    <!-- 列表：过期 / 关停灰显常驻，方便复盘核对「那天到底有没有设过这个词」 -->
    <div
      v-if="viewRows.length > 0 || loadError"
      class="tct-list"
    >
      <div
        v-if="loadError"
        class="tct-error"
      >
        {{ loadError }}
      </div>
      <div
        v-for="t in viewRows"
        :key="t.id"
        :style="t.visual.card"
      >
        <div :style="t.visual.title">
          {{ t.name }}
          <span :style="t.visual.badge">{{ t.visual.text }}</span>
        </div>
        <div :style="t.visual.sub">
          同义词：{{ t.synonyms.length > 0 ? t.synonyms.join('、') : '无' }}
        </div>
        <div :style="t.visual.sub">
          生效：{{ t.startDate }} ~ {{ t.endDate || '—' }}
          <span v-if="t.disabledFrom">（{{ t.disabledFrom }} 起关停）</span>
        </div>
        <div class="tct-actions">
          <button
            v-if="t.visual.stopLabel"
            type="button"
            class="tct-btn tct-btn-stop"
            :disabled="saving || purging"
            @click="toggleTemp(t)"
          >
            {{ t.visual.stopLabel }}
          </button>
          <button
            type="button"
            class="tct-btn tct-btn-del"
            :disabled="saving || purging"
            @click="removeTemp(t)"
          >
            删除
          </button>
        </div>
      </div>
    </div>
    <div
      v-else
      class="tct-empty"
    >
      暂无临时题材（添加后只在设置日起 3 个交易日内生效）
    </div>
  </div>

  <!-- 组件内确认弹层（§4 不用原生 alert/confirm） -->
  <Teleport to="body">
    <div
      v-if="confirm.visible"
      class="tct-confirm-overlay"
      @click.self="confirmCancel"
    >
      <div class="tct-confirm-panel">
        <div class="tct-confirm-title">
          {{ confirm.title }}
        </div>
        <div class="tct-confirm-desc">
          {{ confirm.desc }}
        </div>
        <div class="tct-confirm-actions">
          <button
            type="button"
            class="tct-btn-del tct-confirm-ok"
            :disabled="saving"
            @click="confirmOk"
          >
            {{ saving ? '处理中…' : confirm.okText }}
          </button>
          <button
            type="button"
            class="tct-btn-cancel"
            @click="confirmCancel"
          >
            取消
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
// §6 单一真相：题材词拆分只认 Logic 层唯一实现（含顿号），⛔ 不在组件里写正则
import { splitTopicWords } from '../logic/topic/rules.js';
import { endDateOf } from '../logic/topic/temp-core-topic.js';
import { getNextTradingDay } from '../logic/date/trading-day-helpers.js';
// §3 UI 不直连 Supabase：临时题材全部走 Data 层具名函数
import {
  getTempCoreTopics, refreshTempCoreTopics, upsertTempCoreTopic,
  setTempCoreTopicDisabled, deleteTempCoreTopic
} from '../data/temp-core-topics.js';
// §11 删除护栏：先读影响面再让用户确认（题材库 + 竞价名单题材串两处）
import { previewCoreWordPurge, purgeCoreWordFromLibrary } from '../logic/topic/core-word-purge.js';
import { showToast, showWarningToast } from '../composables/useToast.js';
import { _emit } from '../stores/eventBus.js';
import { useUiStore } from '../stores/uiStore.js';

const uiStore = useUiStore();
const rows = ref([]);
const newName = ref('');
const newSynonyms = ref('');
const startDate = ref('');
const error = ref('');
const loadError = ref('');
const saving = ref(false);
// 预览清理影响面是一次云端读（题材库全表），单独一个态：期间禁用按钮，避免连点
const purging = ref(false);
const confirm = ref({ visible: false, title: '', desc: '', okText: '确定', onOk: null });

const endDateText = computed(function() {
  return endDateOf(startDate.value, 3, getNextTradingDay) || '—';
});

/**
 * 状态按【当前展示的交易日】判定（⛔ 不按真实今天）：
 * 回看 11-19 时，当时仍在生效期的词不能被标成「已过期」。
 */
function visualOf(t, viewDate) {
  const end = endDateOf(t.startDate, 3, getNextTradingDay) || '—';
  const d = String(viewDate || '').trim();
  const expired = !!(d && end !== '—' && d > end);
  if (t.disabledFrom) {
    return {
      text: '已关停',
      card: 'padding:10px;border:1px solid #e5e7eb;border-radius:6px;margin-bottom:8px;background:#f3f4f6;',
      title: 'font-weight:600;font-size:13px;color:#9ca3af;',
      sub: 'font-size:12px;color:#9ca3af;margin-top:3px;',
      badge: 'font-size:11px;margin-left:6px;padding:1px 6px;border-radius:8px;background:#e5e7eb;color:#6b7280;',
      stopLabel: expired ? '' : '恢复'
    };
  }
  if (expired) {
    return {
      text: '已过期',
      card: 'padding:10px;border:1px solid #e5e7eb;border-radius:6px;margin-bottom:8px;background:#f3f4f6;',
      title: 'font-weight:600;font-size:13px;color:#9ca3af;',
      sub: 'font-size:12px;color:#9ca3af;margin-top:3px;',
      badge: 'font-size:11px;margin-left:6px;padding:1px 6px;border-radius:8px;background:#e5e7eb;color:#6b7280;',
      stopLabel: ''                       // 窗口已结束 ⇒ 关停/恢复没有意义，只留删除
    };
  }
  if (d && t.startDate && d < t.startDate) {
    return {
      text: '未生效',
      card: 'padding:10px;border:1px dashed #fde68a;border-radius:6px;margin-bottom:8px;background:#fffbeb;',
      title: 'font-weight:600;font-size:13px;color:#78350f;',
      sub: 'font-size:12px;color:#92400e;margin-top:3px;',
      badge: 'font-size:11px;margin-left:6px;padding:1px 6px;border-radius:8px;background:#fef3c7;color:#b45309;',
      stopLabel: '关停'
    };
  }
  return {
    text: '生效中',
    card: 'padding:10px;border:1px solid #fde68a;border-radius:6px;margin-bottom:8px;background:#fffbeb;',
    title: 'font-weight:600;font-size:13px;color:#78350f;',
    sub: 'font-size:12px;color:#92400e;margin-top:3px;',
    badge: 'font-size:11px;margin-left:6px;padding:1px 6px;border-radius:8px;background:#ecfdf5;color:#047857;',
    stopLabel: '关停'
  };
}

const viewRows = computed(function() {
  const viewDate = String(uiStore.currentDate || '').trim();
  return rows.value.map(function(t) {
    return Object.assign({}, t, {
      endDate: endDateOf(t.startDate, 3, getNextTradingDay) || '—',
      visual: visualOf(t, viewDate)
    });
  });
});

function readLocal() {
  rows.value = getTempCoreTopics().slice();
}

/**
 * 供父弹窗调用：强制重读一次云端临时题材。
 * ⛔ 不能用 ensure：启动那次若已失败，ensure 会因失败冷却直接抛错 ⇒ 列表永远空、
 *    用户看到的就是「临时题材根本没保存」。失败必须可见（§10）。
 * @returns {Promise<void>}
 */
async function refresh() {
  loadError.value = '';
  try {
    await refreshTempCoreTopics();
    readLocal();
  } catch (e) {
    loadError.value = '临时题材读取失败：' + (e && e.message ? e.message : '未知错误');
  }
}

async function addTemp() {
  const name = newName.value.trim();
  if (!name) { error.value = '请输入临时题材名称'; return; }
  const sd = String(startDate.value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(sd)) { error.value = '请选择临时题材的设置日'; return; }
  error.value = '';
  saving.value = true;
  try {
    await upsertTempCoreTopic({ name: name, synonyms: splitTopicWords(newSynonyms.value), startDate: sd });
    readLocal();
    showToast('✅ 已添加临时题材「' + name + '」：' + sd + ' 起 3 个交易日有效');
    newName.value = '';
    newSynonyms.value = '';
    _emit('auction-refresh');
  } catch (e) {
    console.error('[TEMP-CORE] 保存失败:', e);
    showWarningToast('❌ 临时题材保存失败：' + (e && e.message ? e.message : '未知错误'), 8000);
  } finally {
    saving.value = false;
  }
}

async function toggleTemp(t) {
  const off = t.disabledFrom ? null : String(uiStore.currentDate || '').trim();
  if (!off && !t.disabledFrom) { showWarningToast('当前未选中交易日，无法确定关停日'); return; }
  saving.value = true;
  try {
    await setTempCoreTopicDisabled(t.id, off);
    readLocal();
    showToast(off
      ? '✅ 临时题材「' + t.name + '」已从 ' + off + ' 起关停，之后恢复主流题材'
      : '✅ 临时题材「' + t.name + '」已恢复');
    _emit('auction-refresh');
  } catch (e) {
    console.error('[TEMP-CORE] 关停/恢复失败:', e);
    showWarningToast('❌ ' + (t.disabledFrom ? '恢复' : '关停') + '失败：' +
      (e && e.message ? e.message : '未知错误'), 8000);
  } finally {
    saving.value = false;
  }
}

/** 影响面写成一句人话（§10/§11：⛔ 不许让用户盲删） */
function purgeDesc(t, plan) {
  const base = '删除会同步到云端，三个看板的题材分组都会立即按新规则重算。';
  if (!plan) return base;
  const words = plan.words && plan.words.length > 0 ? '「' + plan.words.join('、') + '」' : '这些词';
  const sp = plan.stringPlan || null;
  const stringLine = (sp && sp.affectedRows > 0)
    ? '\n同时会从竞价名单的 ' + sp.affectedRows + ' 行里移除这些词（跨 ' + sp.dateCount +
      ' 个交易日）—— 双击竞价量弹出的备注、单击昨日成交量的提示会同步变。'
    : '';
  if (plan.affectedStocks === 0) {
    return base + stringLine +
      (sp && sp.affectedRows > 0 ? '' : '\n题材库里没有与' + words + '完全相同的题材，因此不会改动任何股票。');
  }
  const names = plan.rows.slice(0, 8).map(function(r) { return r.stock; }).join('、');
  const more = plan.affectedStocks > 8 ? ' 等' : '';
  return base + '\n同时会从 ' + plan.affectedStocks + ' 只股票的题材里移除' + words +
    '（共 ' + plan.removedWords + ' 个词）：' + names + more + '。' + stringLine +
    '\n⚠️ 只删与这些词【完全相同】的细分题材，同一只股票的其它题材原样保留。';
}

/** 删除临时题材 = 删词 + 清理题材库 / 竞价名单题材串（与正式核心词同一套） */
function removeTemp(t) {
  void doRemoveTemp(t);
}
async function doRemoveTemp(t) {
  purging.value = true;
  let plan = null;
  try {
    plan = await previewCoreWordPurge(t);   // 只读，不写
  } catch (e) {
    console.error('[TEMP-CORE] 预览清理影响面失败:', e);
    showWarningToast('❌ 读取题材库失败，已取消删除（未做任何改动）：' +
      (e && e.message ? e.message : '未知错误'), 9000);
    return;
  } finally {
    purging.value = false;
  }
  askConfirm('确定删除临时题材「' + t.name + '」？',
    purgeDesc(t, plan) + '\n\n删除后它在所有日期都不再生效，且不可撤销。若只是想提前结束，请用【关停】。',
    '确定删除',
    async function() {
      saving.value = true;
      try {
        await deleteTempCoreTopic(t.id);
        readLocal();
        showToast('✅ 已删除临时题材「' + t.name + '」');
      } catch (e) {
        console.error('[TEMP-CORE] 删除失败:', e);
        showWarningToast('❌ 删除失败：' + (e && e.message ? e.message : '未知错误'), 8000);
        saving.value = false;
        return;
      }
      saving.value = false;
      // 词删掉之后再清题材库 / 题材串（顺序同正式核心词：失败只剩残留，可幂等重试）
      const needPurge = plan && (plan.affectedStocks > 0 || (plan.stringPlan && plan.stringPlan.affectedRows > 0));
      if (needPurge) await runPurge(t);
      else _emit('auction-refresh');
    });
}

/** 清理失败自动重试一次；仍失败如实报残留范围（§10 不静默） */
async function runPurge(t) {
  saving.value = true;
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await purgeCoreWordFromLibrary(t);
      const libDone = res.written;
      const strDone = res.stringWritten || 0;
      const libClean = res.verified || res.written === 0;
      const strClean = res.stringVerified !== false && (res.stringStillBad || []).length === 0;
      if (libDone === 0 && strDone === 0) {
        showToast('✅ 已删除临时题材「' + t.name + '」（题材库与竞价名单都不需要清理）');
      } else if (libClean && strClean) {
        const bits = [];
        if (libDone > 0) bits.push('共享题材库 ' + libDone + ' 只股票');
        if (strDone > 0) bits.push('竞价名单 ' + strDone + ' 行');
        showToast('🧹 已同步清理 ' + bits.join('、') + ' 的题材');
      } else {
        showWarningToast('⚠️ 临时题材已删除，但题材库 / 竞价名单未清理干净。' +
          '刷新后若仍在，请再删一次该临时题材重试（幂等）。', 12000);
      }
      _emit('auction-refresh');
      saving.value = false;
      return;
    } catch (e) {
      lastErr = e;
      console.error('[TEMP-CORE] 题材库清理失败（第 ' + (attempt + 1) + ' 次）:', e);
    }
  }
  saving.value = false;
  showWarningToast('⚠️ 临时题材已删除，但【题材库清理失败】：' +
    (lastErr && lastErr.message ? lastErr.message : '未知错误') + '。下次删除同一题材可重试。', 12000);
}

function askConfirm(title, desc, okText, onOk) {
  confirm.value = { visible: true, title: title, desc: desc, okText: okText, onOk: onOk };
}
function confirmCancel() {
  confirm.value.visible = false;
}
async function confirmOk() {
  const fn = confirm.value.onOk;
  confirm.value.visible = false;
  if (typeof fn === 'function') await fn();
}

onMounted(function() {
  readLocal();
  // 启动时 bootstrap 可能还没到货 ⇒ 自己去要一次（不带冷却，失败可见）
  refresh();
});

defineExpose({ refresh });
</script>

<style scoped>
.tct-panel {
  margin-bottom: 14px;
  padding: 10px;
  border: 1px dashed #c4b5fd;
  border-radius: 8px;
  background: #faf5ff;
}
.tct-title {
  font-size: 12px;
  color: #6d28d9;
  margin-bottom: 8px;
}
.tct-form {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  align-items: center;
  margin-bottom: 6px;
}
.tct-input {
  padding: 6px 8px;
  font-size: 12px;
  border: 1px solid #e2e8f0;
  border-radius: 4px;
  box-sizing: border-box;
}
.tct-name { flex: 1; min-width: 110px; }
.tct-syn { flex: 2; min-width: 140px; }
.tct-date { min-width: 130px; }
.tct-hint { font-size: 12px; color: #6b7280; }
.tct-end { font-size: 12px; color: #854f0b; }
.tct-error {
  margin-top: 4px;
  font-size: 12px;
  color: #dc2626;
}
.tct-list {
  margin-top: 8px;
}
.tct-empty {
  margin-top: 8px;
  font-size: 12px;
  color: #9ca3af;
}
.tct-actions {
  margin-top: 7px;
  display: flex;
  gap: 6px;
}
.tct-btn {
  border: none;
  border-radius: 4px;
  cursor: pointer;
  font-size: 12px;
  padding: 4px 8px;
}
.tct-btn-add {
  padding: 6px 12px;
  background: linear-gradient(135deg, #8b5cf6, #7c3aed);
  color: #fff;
}
.tct-btn-stop { background: #fee2e2; color: #dc2626; }
.tct-btn-del { background: #f1f5f9; color: #dc2626; }
.tct-btn-cancel { padding: 8px 12px; background: #f1f5f9; color: #475569; border-radius: 6px; border: none; cursor: pointer; font-size: 13px; }
.tct-confirm-overlay {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 42, 0.45);
  z-index: 10000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  box-sizing: border-box;
}
.tct-confirm-panel {
  background: #fff;
  border-radius: 12px;
  max-width: 380px;
  width: 100%;
  padding: 18px;
  box-shadow: 0 10px 30px rgba(15, 23, 42, 0.2);
}
.tct-confirm-title {
  font-size: 14px;
  font-weight: 600;
  color: #1f2937;
  margin-bottom: 8px;
}
.tct-confirm-desc {
  font-size: 12px;
  color: #475569;
  line-height: 1.6;
  white-space: pre-wrap;
  margin-bottom: 14px;
  max-height: 45vh;
  overflow-y: auto;
}
.tct-confirm-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}
.tct-confirm-ok { padding: 8px 12px; border-radius: 6px; font-size: 13px; }
</style>
