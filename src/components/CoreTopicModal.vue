<!-- CoreTopicModal.vue — 核心词管理（§4 不用原生 alert/confirm；§10 保存必须返回可见结果）
     2026-09-18 改造要点：
       ① 增 / 删 / 改 全部 await 云端结果 → 成功 showToast、失败 showWarningToast 并【回滚列表】。
          旧实现是 fire-and-forget：saveCoreTopics 不返回任何东西，界面靠本地内存看着像成功，
          云端失败（或被队列跳过）时用户完全无感 ⇒ 表现为「删了没反应 / 前台像成功」。
       ② 删除改为组件内确认弹层，去掉原生 confirm/alert（原生弹窗会阻塞主线程且样式割裂）。
       ③ 全程 saving 态：写云端期间按钮禁用并显示「保存中…」，避免连点产生并发写。
     2026-09-20 变更：【恢复默认】按钮与功能已移除 —— 题材分类已整理完毕，该操作会用默认词库
       整份覆盖自定义配置并同步云端（不可撤销），误触一次的修复成本远高于收益。
       其余功能（添加 / 编辑 / 删除 / 完成 / 云端写入与失败回滚）一行未动。 -->
<template>
  <div
    v-if="visible"
    class="modal active"
    @click.self="close"
  >
    <div
      class="modal-content"
      style="max-width: 500px; max-height: 80vh;"
    >
      <div
        class="modal-header"
        style="padding: 0 0 16px 0; margin-bottom: 0;"
      >
        <div style="font-weight:600;color:#1f2937">
          核心词管理
        </div>
        <button
          class="close-btn"
          @click="close"
        >
          ×
        </button>
      </div>
      <div style="margin-bottom: 16px;">
        <div style="font-size: 12px; color: #6b7280; margin-bottom: 8px;">
          添加新核心词：
        </div>
        <div style="display: flex; gap: 8px; flex-wrap: wrap;">
          <input
            v-model="newName"
            type="text"
            placeholder="核心词名称"
            style="flex: 1; min-width: 120px; padding: 8px; font-size: 13px; border: 1px solid #e2e8f0; border-radius: 4px;"
            @keyup.enter="addCoreTopic"
          >
          <input
            v-model="newSynonyms"
            type="text"
            placeholder="同义词（逗号分隔）"
            style="flex: 2; min-width: 150px; padding: 8px; font-size: 13px; border: 1px solid #e2e8f0; border-radius: 4px;"
            @keyup.enter="addCoreTopic"
          >
          <button
            type="button"
            :disabled="saving"
            style="padding: 8px 16px; font-size: 13px; background: linear-gradient(135deg, #8b5cf6, #7c3aed); color: #fff; border: none; border-radius: 4px; cursor: pointer;"
            @click="addCoreTopic"
          >
            {{ saving ? '保存中…' : '添加' }}
          </button>
        </div>
        <!-- [TEMP-CORE 2026-11-17] 临时题材：只归类、不强制禁选；生效 = 设置日起 3 个交易日 -->
        <div style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-top: 10px;">
          <label style="font-size: 12px; color: #7c3aed; cursor: pointer;">
            <input
              v-model="isTempTopic"
              type="checkbox"
              style="vertical-align: middle; margin-right: 4px;"
            >临时题材（仅生效 3 个交易日）
          </label>
          <template v-if="isTempTopic">
            <span style="font-size: 12px; color: #6b7280;">设置日</span>
            <input
              v-model="tempStartDate"
              type="date"
              style="padding: 5px 8px; font-size: 12px; border: 1px solid #e2e8f0; border-radius: 4px;"
            >
            <span style="font-size: 12px; color: #854f0b;">至 {{ tempEndDateText }}</span>
          </template>
        </div>
        <!-- §10：校验失败内联提示，替代原生 alert（不阻塞、不打断输入） -->
        <div
          v-if="formError"
          style="margin-top: 6px; font-size: 12px; color: #dc2626;"
        >
          {{ formError }}
        </div>
      </div>
      <!-- [TEMP-CORE-VISIBLE 2026-11-26 用户口径] 临时题材区块【上移 + 过期灰显常驻】：
           ① 原来它排在「核心词列表」下方，而 .modal-content 有 300px 底部内边距 ⇒
              核心词一多就要滚很久才看得到，用户会误判「临时题材没保存 / 消失了」；
           ② 过期 / 关停的行以前没有任何视觉区分 ⇒ 现在灰显 + 状态标签，且常驻不消失，
              复盘时能核对「那天到底有没有设过这个词」。 -->
      <div
        v-if="tempRows.length > 0 || tempLoadError"
        style="margin-bottom: 14px; padding: 10px; border: 1px dashed #e2e8f0; border-radius: 8px;"
      >
        <div style="font-size: 12px; color: #6b7280; margin-bottom: 8px;">
          临时题材（生效期按这些词归类；过期／关停后仍灰显保留在这里，方便核对）
        </div>
        <div
          v-if="tempLoadError"
          style="font-size: 12px; color: #dc2626; margin-bottom: 8px;"
        >
          {{ tempLoadError }}
        </div>
        <div
          v-for="t in tempRows"
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
          <div style="margin-top: 7px; display: flex; gap: 6px;">
            <button
              type="button"
              :disabled="saving"
              style="padding: 4px 8px; font-size: 12px; border: none; border-radius: 4px; cursor: pointer; background: #fee2e2; color: #dc2626;"
              @click="toggleTemp(t)"
            >
              {{ t.disabledFrom ? '恢复' : '关停' }}
            </button>
            <button
              type="button"
              :disabled="saving"
              style="padding: 4px 8px; font-size: 12px; border: none; border-radius: 4px; cursor: pointer; background: #f1f5f9; color: #475569;"
              @click="removeTemp(t)"
            >
              删除
            </button>
          </div>
        </div>
      </div>
      <div style="max-height: 400px; overflow-y: auto;">
        <div
          v-if="coreTopics.length === 0"
          style="text-align: center; color: #9ca3af; padding: 20px;"
        >
          暂无核心词，请添加
        </div>
        <div
          v-for="(core, index) in coreTopics"
          :key="core.name"
          style="display: flex; align-items: center; padding: 10px; border: 1px solid #e2e8f0; border-radius: 6px; margin-bottom: 8px; background: #fafafa;"
        >
          <div style="flex: 1;">
            <div style="font-weight: 600; color: #1f2937; font-size: 14px;">
              {{ core.name }}
            </div>
            <div style="font-size: 12px; color: #6b7280; margin-top: 4px;">
              同义词：{{ synonymsText(core) }}
            </div>
          </div>
          <button
            type="button"
            :disabled="saving || purging"
            style="padding: 4px 8px; font-size: 12px; background: #e0e7ff; color: #4f46e5; border: none; border-radius: 4px; cursor: pointer; margin-right: 4px;"
            @click="editCoreTopic(index)"
          >
            编辑
          </button>
          <button
            type="button"
            :disabled="saving || purging"
            style="padding: 4px 8px; font-size: 12px; background: #fee2e2; color: #dc2626; border: none; border-radius: 4px; cursor: pointer;"
            @click="deleteCoreTopic(index)"
          >
            删除
          </button>
        </div>
      </div>
      <!-- ⚠️ 2026-09-20 移除【恢复默认】按钮：题材分类已整理完毕，该按钮会用默认词库整份覆盖
           自定义配置并同步云端（不可撤销）→ 误触一次就要花很久修复，风险远大于收益。
           其余功能（添加 / 编辑 / 删除 / 完成）一个都未改动。 -->
      <div style="margin-top: 16px; display: flex; gap: 8px;">
        <button
          type="button"
          style="padding: 8px 16px; font-size: 13px; background: linear-gradient(135deg, #0ea5e9, #0284c7); color: #fff; border: none; border-radius: 4px; cursor: pointer;"
          @click="close"
        >
          完成
        </button>
      </div>
    </div>
  </div>
  <div
    v-if="editVisible"
    class="modal active"
    @click.self="closeEdit"
  >
    <div
      class="modal-content"
      style="max-width: 420px; padding-bottom: 20px;"
    >
      <div
        class="modal-header"
        style="padding: 0 0 16px 0; margin-bottom: 0;"
      >
        <div style="font-weight:600;color:#1f2937">
          编辑核心词
        </div>
        <button
          class="close-btn"
          @click="closeEdit"
        >
          ×
        </button>
      </div>
      <div style="margin-bottom: 16px;">
        <div style="font-size: 12px; color: #6b7280; margin-bottom: 8px;">
          核心词名称
        </div>
        <input
          v-model="editName"
          type="text"
          style="width: 100%; box-sizing: border-box; padding: 10px; font-size: 14px; border: 1px solid #e2e8f0; border-radius: 6px;"
        >
      </div>
      <div style="margin-bottom: 16px;">
        <div style="font-size: 12px; color: #6b7280; margin-bottom: 8px;">
          同义词（逗号分隔）
        </div>
        <textarea
          v-model="editSynonyms"
          rows="3"
          style="width: 100%; box-sizing: border-box; padding: 10px; font-size: 14px; border: 1px solid #e2e8f0; border-radius: 6px; resize: vertical; font-family: inherit;"
        />
      </div>
      <div style="display: flex; gap: 8px;">
        <button
          type="button"
          style="flex:1; padding: 10px 16px; font-size: 14px; background: #f1f5f9; color: #475569; border: none; border-radius: 6px; cursor: pointer;"
          @click="closeEdit"
        >
          取消
        </button>
        <button
          type="button"
          :disabled="saving"
          style="flex:1; padding: 10px 16px; font-size: 14px; background: linear-gradient(135deg, #8b5cf6, #7c3aed); color: #fff; border: none; border-radius: 6px; cursor: pointer;"
          @click="saveEdit"
        >
          {{ saving ? '保存中…' : '保存' }}
        </button>
      </div>
    </div>
  </div>

  <!-- 组件内确认弹层（替代原生 confirm，§4） -->
  <Teleport to="body">
    <div
      v-if="confirmState.visible"
      class="ctm-confirm-overlay"
      @click.self="confirmCancel"
    >
      <div class="ctm-confirm-panel">
        <div class="ctm-confirm-title">
          {{ confirmState.title }}
        </div>
        <div class="ctm-confirm-desc">
          {{ confirmState.desc }}
        </div>
        <div class="ctm-confirm-actions">
          <button
            type="button"
            class="ctm-btn-danger"
            :disabled="saving"
            @click="confirmOk"
          >
            {{ saving ? '处理中…' : confirmState.okText }}
          </button>
          <button
            type="button"
            class="ctm-btn-cancel"
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
import { ref, computed } from 'vue';
// [TOPIC-SEP 2026-10-02] splitTopicWords = 题材词拆分的【唯一实现】（§6 单一真相），
//   本组件的 synonyms 输入必须与股票侧标签用同一套分隔符（含顿号），⛔ 不许再自己写正则。
import { getCoreTopics, saveCoreTopics, splitTopicWords } from '../logic/topic/rules.js';
// ★★ [CORE-PURGE 2026-11-14 用户口径] 删除核心词必须【同时】把股票题材库里精确等于
//   该核心词 / 其同义词的细分题材一起摘掉，否则「羊字辈」这类临时题材删了还留在库里、
//   并且会自己变成一个题材分组（详见 logic/topic/core-word-purge.js 顶部说明）。
//   只删精确相等的段，⛔ 不动同一只股票的其它细分题材。
import { previewCoreWordPurge, purgeCoreWordFromLibrary } from '../logic/topic/core-word-purge.js';
// ⚠️ 原 `import { state } from '../logic/app-state.js'` 随「恢复默认」一起移除：
//    它是本文件里唯一用到 state.defaultCoreTopics 的地方，留下即 dead code（§42）。
//    ⛔ 不要删 logic/app-state.js 里的 defaultCoreTopics 本身 —— 它仍是 logic/topic/rules.js
//    在云端读不到核心词时的兜底默认词库，删了会让所有看板的题材分类直接失效。
import { _emit } from '../stores/eventBus.js';
import { showToast, showWarningToast } from '../composables/useToast.js';
import { useUiStore } from '../stores/uiStore.js';
// [TEMP-CORE 2026-11-17] 临时题材：UI 不直连 Supabase（架构 §3），全部走 Data 层具名函数
import {
  getTempCoreTopics, refreshTempCoreTopics, upsertTempCoreTopic, setTempCoreTopicDisabled, deleteTempCoreTopic
} from '../data/temp-core-topics.js';
import { endDateOf } from '../logic/topic/temp-core-topic.js';
import { getNextTradingDay } from '../logic/date/trading-day-helpers.js';

const visible = ref(false);
const coreTopics = ref([]);
const newName = ref('');
const newSynonyms = ref('');
const formError = ref('');
const saving = ref(false);
// [CORE-PURGE 2026-11-14] 删除前的「影响面预览」是一次云端读（题材库全表），单独一个态：
//   期间禁用删除按钮，避免连点触发两次预览/两次删除。
const purging = ref(false);
const editVisible = ref(false);
const editIndex = ref(null);
const editName = ref('');
const editSynonyms = ref('');
const confirmState = ref({ visible: false, title: '', desc: '', okText: '确定', onOk: null });

const uiStore = useUiStore();
// [TEMP-CORE] 临时题材表单态：默认按当前展示的交易日作为设置日（可改成过去的日期 ⇒ 历史补录）
const isTempTopic = ref(false);
const tempStartDate = ref('');
const tempTopics = ref([]);
/** 临时题材读取失败提示（§10：失败必须可见，⛔ 不许伪装成「没有临时题材」） */
const tempLoadError = ref('');
const tempEndDateText = computed(function() {
  const e = endDateOf(tempStartDate.value, 3, getNextTradingDay);
  return e || '—';
});

/**
 * [TEMP-CORE-VISIBLE 2026-11-26] 临时题材【常驻 + 过期灰显】。
 * 状态按【当前展示的交易日】判定 —— ⛔ 不按真实今天：回看 11-19 时，
 * 当时仍在生效期的词不能被标成「已过期」。
 * @returns {{text:string, card:string, title:string, sub:string, badge:string}}
 */
function tempVisual(t, viewDate) {
  const end = tempEndDateOf(t);
  const d = String(viewDate || '').trim();
  let text = '生效中';
  let dim = false;
  if (t.disabledFrom) { text = '已关停'; dim = true; }
  else if (d && end && d !== '—' && d > end) { text = '已过期'; dim = true; }
  else if (d && t.startDate && d < t.startDate) { text = '未生效'; }
  if (dim) {
    return {
      text: text,
      card: 'padding: 10px; border: 1px solid #e5e7eb; border-radius: 6px; margin-bottom: 8px; background: #f3f4f6;',
      title: 'font-weight: 600; font-size: 13px; color: #9ca3af;',
      sub: 'font-size: 12px; color: #9ca3af; margin-top: 3px;',
      badge: 'font-size: 11px; margin-left: 6px; padding: 1px 6px; border-radius: 8px; background: #e5e7eb; color: #6b7280;'
    };
  }
  if (text === '未生效') {
    return {
      text: text,
      card: 'padding: 10px; border: 1px dashed #fde68a; border-radius: 6px; margin-bottom: 8px; background: #fffbeb;',
      title: 'font-weight: 600; font-size: 13px; color: #78350f;',
      sub: 'font-size: 12px; color: #92400e; margin-top: 3px;',
      badge: 'font-size: 11px; margin-left: 6px; padding: 1px 6px; border-radius: 8px; background: #fef3c7; color: #b45309;'
    };
  }
  return {
    text: text,
    card: 'padding: 10px; border: 1px solid #fde68a; border-radius: 6px; margin-bottom: 8px; background: #fffbeb;',
    title: 'font-weight: 600; font-size: 13px; color: #78350f;',
    sub: 'font-size: 12px; color: #92400e; margin-top: 3px;',
    badge: 'font-size: 11px; margin-left: 6px; padding: 1px 6px; border-radius: 8px; background: #ecfdf5; color: #047857;'
  };
}

/** 渲染用行（带状态标签与配色）：过期 / 关停灰显，但【始终保留】在列表里 */
const tempRows = computed(function() {
  const viewDate = String(uiStore.currentDate || '').trim();
  return tempTopics.value.map(function(t) {
    return Object.assign({}, t, { endDate: tempEndDateOf(t), visual: tempVisual(t, viewDate) });
  });
});

function refreshList() {
  coreTopics.value = getCoreTopics();
  tempTopics.value = getTempCoreTopics().slice();
}
function open() {
  refreshList();
  formError.value = '';
  isTempTopic.value = false;
  tempStartDate.value = String(uiStore.currentDate || '').trim();
  visible.value = true;
  // [TEMP-CORE-VISIBLE 2026-11-26] bootstrap 的 ensure 是异步的：冷启动后立刻点开弹窗时
  //   临时词可能还没到货 ⇒ 这里补一次。
  //   ★ 用 refresh（强制重读）而不是 ensure：启动那次若已失败（手机网络每个请求停 12~64s，
  //     很容易超时），ensure 会因 30s 失败冷却直接抛错 ⇒ 弹窗永远是空列表、
  //     用户看到的就是「临时题材根本没保存」。用户主动打开 = 必须真的去读一次。
  //   失败必须可见（§10），⛔ 不许让「读取失败」看起来像「没有临时题材」。
  tempLoadError.value = '';
  refreshTempCoreTopics().then(refreshList).catch(function(e) {
    tempLoadError.value = '临时题材读取失败：' + (e && e.message ? e.message : '未知错误');
  });
}
function close() {
  visible.value = false;
  _emit('auction-refresh');
}

/**
 * 把编辑框里的一段文本拆成 synonyms 数组。
 *
 * 🔴 [TOPIC-SEP 2026-10-02] ⛔ 这里曾经自己写死 `/[,，]/`（只认两种逗号、不认【顿号】），
 *    而股票侧标签拆分用的是 `/[,，、;；]/`（含顿号）—— 两侧口径不一致 ⇒
 *    用户粘贴「工业互联网、智能制造、工业软件…」时被当成【一个整体】存进 synonyms，
 *    而匹配是子串匹配，整串永远匹配不上 ⇒ 这些词静默失效（实测「工业4.0」正是这样坏的）。
 *    现在统一复用 Logic 层唯一的 splitTopicWords（§6 单一真相），⛔ 别再在本组件里写正则。
 */
function splitSynonyms(text) {
  return splitTopicWords(text);
}

/**
 * 统一保存入口：把「写云端 + 成败反馈 + 失败回滚」收在一处（§10 禁止静默失败）。
 * 乐观更新列表（分组立即按新核心词重算），云端失败则连内存缓存一起回滚到上一版，
 * 保证界面与云端不会长期各说各话（§6 不留两个真相）。
 * @param {Array<{name:string, synonyms:string[]}>} nextList 目标核心词列表（不可变更新后的新数组）
 * @param {string} okMsg 成功提示文案
 * @returns {Promise<boolean>} 是否保存成功
 */
async function commit(nextList, okMsg) {
  const prevList = coreTopics.value.slice();
  saving.value = true;
  coreTopics.value = nextList.slice();
  try {
    const res = await saveCoreTopics(nextList);
    if (res && res.ok === false) throw new Error('云端写入未生效');
    refreshList();
    showToast(okMsg);
    return true;
  } catch (e) {
    coreTopics.value = prevList;
    // 内存缓存也回滚（saveCoreTopics 会更新 _coreTopicsMemCache）。不 await：
    // 失败已由下面的 toast 反馈，这里只是让缓存与界面一致；若这次反而写成功，结果也与界面一致。
    saveCoreTopics(prevList);
    console.error('[CORE-TOPICS] 保存失败:', e);
    showWarningToast('❌ 同步云端失败，已还原上一版：' + (e && e.message ? e.message : '未知错误'), 8000);
    return false;
  } finally {
    saving.value = false;
  }
}

async function addCoreTopic() {
  const name = newName.value.trim();
  if (!name) { formError.value = '请输入核心词名称'; return; }
  const syns = splitSynonyms(newSynonyms.value);

  // ★★ [TEMP-CORE] 临时题材单独写 core_topic_temp：⛔ 绝不写 core_topics（那张表是主流词库，
  //   它的 saveCoreTopics 按 name 差集删除 + 全量 upsert，混进去会把用户的正式配置覆盖掉）。
  if (isTempTopic.value) {
    const sd = String(tempStartDate.value || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(sd)) { formError.value = '请选择临时题材的设置日'; return; }
    formError.value = '';
    saving.value = true;
    try {
      await upsertTempCoreTopic({ name: name, synonyms: syns, startDate: sd });
      refreshList();
      showToast('✅ 已添加临时题材「' + name + '」：' + sd + ' 起 3 个交易日有效');
      newName.value = '';
      newSynonyms.value = '';
      isTempTopic.value = false;
      _emit('auction-refresh');
    } catch (e) {
      console.error('[TEMP-CORE] 保存失败:', e);
      showWarningToast('❌ 临时题材保存失败：' + (e && e.message ? e.message : '未知错误'), 8000);
    } finally {
      saving.value = false;
    }
    return;
  }

  if (coreTopics.value.find(c => c.name === name)) { formError.value = '该核心词已存在'; return; }
  formError.value = '';
  const next = coreTopics.value.concat([{ name, synonyms: syns }]);
  const ok = await commit(next, '✅ 已添加核心词「' + name + '」');
  if (ok) {
    newName.value = '';
    newSynonyms.value = '';
  }
}
function editCoreTopic(index) {
  const core = coreTopics.value[index];
  if (!core) return;
  editIndex.value = index;
  editName.value = core.name || '';
  editSynonyms.value = core.synonyms ? core.synonyms.join(',') : '';
  editVisible.value = true;
}
function closeEdit() {
  editVisible.value = false;
  editIndex.value = null;
}

// ===== [TEMP-CORE] 临时题材的关停 / 恢复 / 删除（§10：每一步都有可见结果） =====
function tempEndDateOf(t) {
  return endDateOf(t.startDate, 3, getNextTradingDay) || '—';
}
function isTempStopped(t) {
  return !!t.disabledFrom;
}
async function toggleTemp(t) {
  const off = isTempStopped(t) ? null : String(uiStore.currentDate || '').trim();
  if (!off && !isTempStopped(t)) { showWarningToast('当前未选中交易日，无法确定关停日'); return; }
  saving.value = true;
  try {
    await setTempCoreTopicDisabled(t.id, off);
    refreshList();
    showToast(off
      ? '✅ 临时题材「' + t.name + '」已从 ' + off + ' 起关停，之后恢复主流题材'
      : '✅ 临时题材「' + t.name + '」已恢复');
    _emit('auction-refresh');
  } catch (e) {
    console.error('[TEMP-CORE] 关停/恢复失败:', e);
    showWarningToast('❌ ' + (isTempStopped(t) ? '恢复' : '关停') + '失败：' +
      (e && e.message ? e.message : '未知错误'), 8000);
  } finally {
    saving.value = false;
  }
}
// ★★ [CORE-PURGE-STRING 2026-11-17 用户口径] 删除临时题材 = 删词 + 清理题材串（与正式核心词同一套）。
//
// 用户原话：「我删除核心词东方后，变成只显示东方海洋(水产品,农业,羊字辈)」——
//   「东方」正是【临时题材】（core_topic_temp），所以删除入口也必须走清理，
//   否则删完临时词，双击竞价量弹出来的 note 里照样是 `(水产品,农业,东方,羊字辈)`。
//
// §11：先读出影响面再让用户确认，读失败就什么都不做（⛔ 不静默、不盲删）。
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
    purgeConfirmDesc(t, plan) + '\n\n删除后它在所有日期都不再生效，且不可撤销。若只是想提前结束，请用【关停】。',
    '确定删除',
    async () => {
      saving.value = true;
      try {
        await deleteTempCoreTopic(t.id);
        refreshList();
        showToast('✅ 已删除临时题材「' + t.name + '」');
      } catch (e) {
        console.error('[TEMP-CORE] 删除失败:', e);
        showWarningToast('❌ 删除失败：' + (e && e.message ? e.message : '未知错误'), 8000);
        saving.value = false;
        return;
      }
      saving.value = false;
      // 词删掉之后再清题材库 / 题材串（顺序同正式核心词：先删词，失败只剩残留，可幂等重试）
      const needPurge = plan && (plan.affectedStocks > 0 ||
        (plan.stringPlan && plan.stringPlan.affectedRows > 0));
      if (needPurge) await runPurge(t);
      else _emit('auction-refresh');
    });
}
async function saveEdit() {
  const idx = editIndex.value;
  if (idx === null) return;
  const cur = coreTopics.value[idx];
  if (!cur) { closeEdit(); return; }
  const finalName = editName.value.trim() || cur.name;
  const next = coreTopics.value.map((c, i) => (
    i === idx ? { name: finalName, synonyms: splitSynonyms(editSynonyms.value) } : c
  ));
  const ok = await commit(next, '✅ 已保存核心词「' + finalName + '」');
  if (ok) closeEdit();
}
function deleteCoreTopic(index) {
  const core = coreTopics.value[index];
  if (!core) return;
  void doDeleteCoreTopic(index, core);
}

/**
 * ★★ [CORE-PURGE 2026-11-14 用户口径] 删除核心词 = 删核心词 + 清理股票题材库（两步）。
 *
 * 顺序为什么是「先删核心词、再清题材库」：
 *   反过来（先清库、后删词）一旦第二步失败，股票标签已经没了、核心词还挂着 ⇒ 变成空组，
 *   且不可逆；而「先删词、后清库」失败时只是残留，用户再删一次（幂等）就能补上。
 *
 * §10/§11：影响面是【先读出来给用户看】再执行的，读失败就什么都不做。
 */
async function doDeleteCoreTopic(index, core) {
  purging.value = true;
  let plan = null;
  try {
    plan = await previewCoreWordPurge(core);   // 只读，不写
  } catch (e) {
    console.error('[CORE-TOPICS] 预览清理影响面失败:', e);
    showWarningToast('❌ 读取题材库失败，已取消删除（未做任何改动）：' +
      (e && e.message ? e.message : '未知错误'), 9000);
    return;
  } finally {
    purging.value = false;
  }
  askConfirm(
    '确定删除核心词「' + core.name + '」？',
    purgeConfirmDesc(core, plan),
    '确定删除',
    async () => {
      // ① 删核心词
      const next = coreTopics.value.filter((_, i) => i !== index);
      const ok = await commit(next, '✅ 已删除核心词「' + core.name + '」');
      if (!ok) return;
      // ② 清题材库 / 题材串（两处都 0 命中 ⇒ 直接结束，不发写请求）
      const stringRows = plan && plan.stringPlan ? plan.stringPlan.affectedRows : 0;
      if (!plan || (plan.affectedStocks === 0 && stringRows === 0)) {
        if (plan && plan.substringOnly.length > 0) {
          showWarningToast('ℹ️ 另有 ' + plan.substringOnly.length +
            ' 只股票的题材只是【包含】这些词（不是完全相同），按规则未删除。', 8000);
        }
        return;
      }
      await runPurge(core);
    }
  );
}

/** 清理失败自动重试一次（题材库写入偶发网络失败），仍失败则如实报错并说明残留范围 */
async function runPurge(core) {
  saving.value = true;
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await purgeCoreWordFromLibrary(core);
      // ★ [CORE-PURGE-STRING 2026-11-17] 一处成功一处失败时，必须分别说清：
      //   两处（共享题材库 / 竞价名单题材串）都干净才给 ✅，否则用 ⚠️ 报残留范围（§10）。
      const libDone = res.written;
      const strDone = res.stringWritten || 0;
      const strBad = (res.stringStillBad || []).length;
      const libClean = res.verified || res.written === 0;
      const strClean = res.stringVerified !== false && strBad === 0;

      if (libDone === 0 && strDone === 0) {
        showToast('✅ 已删除核心词「' + core.name + '」（题材库与竞价名单都不需要清理）');
      } else if (libClean && strClean) {
        const bits = [];
        if (libDone > 0) bits.push('共享题材库 ' + libDone + ' 只股票');
        if (strDone > 0) bits.push('竞价名单 ' + strDone + ' 行（' + (res.stringPlan ? res.stringPlan.dateCount : 0) + ' 个交易日）');
        showToast('🧹 已同步清理 ' + bits.join('、') + ' 的题材');
        if (res.blocked && res.blocked.length > 0) {
          showWarningToast('ℹ️ 有 ' + res.blocked.length + ' 只股票的题材只有这个词，' +
            '为避免整只股票被清空已跳过：' + res.blocked.slice(0, 6).map(function(b) { return b.stock; }).join('、'), 9000);
        }
      } else {
        // 分别列出两处的残留，⛔ 不合并成一句「部分失败」（用户要能判断该再删哪一处）
        const parts = [];
        if (!libClean) parts.push('共享题材库（' + (res.stillBad || []).length + ' 只仍有残留）');
        if (!strClean) {
          const n = strBad || (res.stringError ? 1 : 0);
          parts.push('竞价名单题材串（' + (res.stringError ? '写入失败：' + (res.stringError.message || '未知错误') : n + ' 行仍有残留') + '）');
        }
        showWarningToast('⚠️ 核心词已删除，但' + parts.join('、') +
          '未清理干净。刷新后若仍在，请再删一次该核心词重试（幂等）。', 12000);
      }
      _emit('auction-refresh');
      saving.value = false;
      return;
    } catch (e) {
      lastErr = e;
      console.error('[CORE-TOPICS] 题材库清理失败（第 ' + (attempt + 1) + ' 次）:', e);
    }
  }
  saving.value = false;
  showWarningToast('⚠️ 核心词已删除，但【股票题材库清理失败】：' +
    (lastErr && lastErr.message ? lastErr.message : '未知错误') +
    '。这些股票的旧题材词还在（下次删除同一核心词可重试）。', 12000);
}

/** 把影响面写成一句人话（§10 不许让用户「盲删」） */
function purgeConfirmDesc(core, plan) {
  const base = '删除会同步到云端，三个看板（涨跌停 / 竞价一字 / 早盘竞价）的题材分组都会立即按新核心词重算。';
  if (!plan) return base;
  const words = plan.words && plan.words.length > 0 ? '「' + plan.words.join('、') + '」' : '这些词';
  // ★ [CORE-PURGE-STRING 2026-11-17] 竞价名单的 note / topics 也要一起清 —— 这里必须写清楚，
  //   否则用户会以为「只动了题材库」，看到「双击竞价量弹窗里的题材也变了」时觉得是误删。
  const sp = plan.stringPlan || null;
  const stringLine = (sp && sp.affectedRows > 0)
    ? '\n\n同时会从竞价名单（早盘竞价看板）的 ' + sp.affectedRows + ' 行里移除这些词，跨 ' +
      sp.dateCount + ' 个交易日 —— 双击竞价量弹出的备注、单击昨日成交量的黑色提示都会同步变。'
    : '';
  if (plan.affectedStocks === 0) {
    let s = base + stringLine +
      (sp && sp.affectedRows > 0 ? '' : '\n题材库里没有与' + words + '完全相同的题材，因此不会改动任何股票。');
    if (plan.substringOnly.length > 0) {
      s += '\n另有 ' + plan.substringOnly.length + ' 只股票的题材只是包含这些词，按「精确相同才删」的规则不会删除。';
    }
    return s;
  }
  const names = plan.rows.slice(0, 8).map(function(r) { return r.stock; }).join('、');
  const more = plan.affectedStocks > 8 ? ' 等' : '';
  let s = base + '\n\n同时会从 ' + plan.affectedStocks + ' 只股票的题材里移除' + words +
    '（共 ' + plan.removedWords + ' 个词）：' + names + more + '。' + stringLine +
    '\n⚠️ 只删与这些词【完全相同】的细分题材，同一只股票的其它题材原样保留。';
  if (plan.blocked && plan.blocked.length > 0) {
    s += '\nℹ️ 有 ' + plan.blocked.length + ' 只股票的题材只有这个词（' +
      plan.blocked.slice(0, 6).map(function(b) { return b.stock; }).join('、') +
      '），为避免整只股票被清空，这些跳过不改。';
  }
  if (sp && sp.blocked && sp.blocked.length > 0) {
    // 竞价名单侧单独统计：同一只票在不同日期，可能只有某一天「整行都是这个词」
    s += '\nℹ️ 竞价名单里有 ' + sp.blocked.length + ' 行（同一只票按天计）题材只有这个词，' +
      '为避免整行清空已跳过：' + sp.blocked.slice(0, 6).map(function(b) { return b.stock + '(' + b.date + ')'; }).join('、');
  }
  if (plan.substringOnly.length > 0) {
    s += '\nℹ️ 另有 ' + plan.substringOnly.length + ' 只股票的题材只是包含这些词，不会删除。';
  }
  return s;
}
function askConfirm(title, desc, okText, onOk) {
  confirmState.value = { visible: true, title, desc, okText, onOk };
}
function confirmCancel() {
  confirmState.value.visible = false;
}
async function confirmOk() {
  const fn = confirmState.value.onOk;
  confirmState.value.visible = false;
  if (typeof fn === 'function') await fn();
}

// 同义词展示：原为模板内联「&& + .join() + 三元」逻辑，抽取后渲染不变
function synonymsText(core) {
  return core.synonyms && core.synonyms.length > 0 ? core.synonyms.join('、') : '无';
}

defineExpose({ open, close });
</script>

<style scoped>
.ctm-confirm-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  z-index: 10001; /* 必须盖在「核心词管理」弹层之上 */
  display: flex;
  align-items: center;
  justify-content: center;
}
.ctm-confirm-panel {
  background: #fff;
  border-radius: 12px;
  padding: 24px;
  min-width: 320px;
  max-width: 420px;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.18);
}
.ctm-confirm-title {
  font-size: 16px;
  font-weight: 600;
  color: #1f2937;
  margin-bottom: 8px;
}
.ctm-confirm-desc {
  font-size: 13px;
  color: #6b7280;
  line-height: 1.6;
  margin-bottom: 18px;
  /* [CORE-PURGE 2026-11-14] 影响面描述是多行文本（「将从 N 只股票移除…」逐条列出），
     必须 pre-line 才会换行；否则挤成一整段看不清删的是什么。 */
  white-space: pre-line;
  max-height: 42vh;
  overflow-y: auto;
}
.ctm-confirm-actions {
  display: flex;
  gap: 8px;
}
.ctm-btn-danger {
  flex: 1;
  padding: 9px 16px;
  border: none;
  border-radius: 6px;
  background: #dc2626;
  color: #fff;
  font-size: 13px;
  cursor: pointer;
}
.ctm-btn-danger:disabled {
  opacity: 0.6;
  cursor: default;
}
.ctm-btn-cancel {
  flex: 1;
  padding: 9px 16px;
  border: none;
  border-radius: 6px;
  background: #e5e7eb;
  color: #374151;
  font-size: 13px;
  cursor: pointer;
}
</style>
