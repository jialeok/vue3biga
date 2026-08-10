<template>
  <div :class="kind + '-header'" @dblclick.stop="openEdit">
    <div>
      <div :class="kind + '-title'">{{ title }}</div>
      <div :class="kind + '-subtitle'"></div>
    </div>
  </div>
  <div :class="kind + '-content'" @dblclick.stop="openEdit">
    <div :class="kind + '-scroll-container'">
      <div :class="kind + '-header-row'">
        <div :class="kind + '-header-item ' + kind + '-header-shuliang'">总数量</div>
        <div :class="kind + '-header-item ' + kind + '-header-dieZhangbi'">跌涨比</div>
        <div :class="kind + '-header-item ' + kind + '-header-jingtu'">竞符合数</div>
        <div :class="kind + '-header-item ' + kind + '-header-tushi'">图示</div>
      </div>
      <div v-if="!hasData" :class="kind + '-empty'">暂无数据，点击添加...</div>
      <div v-else :class="kind + '-row'">
        <div :class="kind + '-item ' + kind + '-item-shuliang'">{{ data?.shuliang || '' }}</div>
        <div :class="kind + '-item ' + kind + '-item-dieZhangbi'">{{ data?.die_zhangbi || '' }}</div>
        <div :class="kind + '-item ' + kind + '-item-jingtu'">{{ data?.jingtu || '' }}</div>
        <div :class="kind + '-item ' + kind + '-item-tushi'">
          <a v-if="isTushiLink(data?.tushi)" :href="data.tushi" target="_blank" @click.stop>{{ tushiLinkText(data.tushi) }}</a>
          <template v-else>{{ data?.tushi || '' }}</template>
        </div>
      </div>
    </div>
  </div>
  <div :class="kind + '-comment-display'" @click.stop="openEdit">
    <span v-if="!data || !data.comment" :class="kind + '-comment-placeholder'">暂无评论，点击添加...</span>
    <span v-else>{{ data.comment }}</span>
  </div>

  <div v-if="showModal" class="board-modal-backdrop" @click.self="showModal = false">
    <div class="board-modal">
      <div class="board-modal-header">编辑 {{ title }}</div>
      <div class="board-modal-body">
        <div class="board-form-row">
          <span class="board-form-label">总数量</span>
          <input class="board-input" type="text" inputmode="numeric" v-model="form.shuliang" @input="updateFromTotal" placeholder="总数量">
        </div>
        <div class="board-form-row">
          <span class="board-form-label">跌 : 涨</span>
          <input class="board-input" type="text" inputmode="numeric" v-model="form.die" @input="updateFromDie" placeholder="跌" style="flex:1">
          <span style="color:#94a3b8">:</span>
          <input class="board-input" type="text" inputmode="numeric" v-model="form.zhang" @input="updateFromZhang" placeholder="涨" style="flex:1">
        </div>
        <div class="board-form-row">
          <span class="board-form-label">竞符合数</span>
          <input class="board-input" type="text" v-model="form.jingtu" placeholder="竞符合数">
        </div>
        <div class="board-form-row">
          <span class="board-form-label">图示</span>
          <input class="board-input" type="text" v-model="form.tushi" placeholder="石墨链接/图示" autocomplete="off" spellcheck="false">
        </div>
        <div class="board-form-row" style="flex-direction:column;align-items:flex-start;gap:4px">
          <span class="board-form-label" style="width:auto">评论</span>
          <textarea class="board-input" v-model="form.comment" rows="4" placeholder="输入评论..."></textarea>
        </div>
        <div class="board-hint">总数量默认 {{ defaultTotal }}，输入涨/跌或总数会自动计算另一方。</div>
      </div>
      <div class="board-modal-footer">
        <button class="board-btn board-btn-primary" :disabled="saving" @click="submit">{{ saving ? '保存中...' : '保存' }}</button>
        <button class="board-btn" style="background:#f1f5f9;color:#475569" @click="showModal = false">取消</button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed, watch } from 'vue';
import { useBoardData } from '../composables/useBoardData.js';
import { parseDieZhangbi, buildDieZhangbi } from '../logic/board-helpers.js';

const { boardState, loadRecentMulti, saveRecentMulti, toast, warnToast } = useBoardData();

const title = '最近多板';
const kind = 'duiban';
const defaultTotal = 56;

const showModal = ref(false);
const data = computed(() => boardState.recentMulti);
const loading = computed(() => boardState.loadingRecent || boardState.loadingEtf);
const saving = computed(() => boardState.savingRecent || boardState.loadingEtf);

const hasData = computed(() => data.value && (data.value.shuliang || data.value.die_zhangbi || data.value.jingtu || data.value.tushi));

const form = reactive({
  shuliang: '',
  die: '',
  zhang: '',
  die_zhangbi: '',
  jingtu: '',
  tushi: '',
  comment: ''
});

watch(showModal, (visible) => {
  if (visible) {
    const d = data.value || {};
    const parsed = parseDieZhangbi(d.die_zhangbi);
    form.shuliang = d.shuliang || '';
    form.die = parsed.die !== null ? String(parsed.die) : '';
    form.zhang = parsed.zhang !== null ? String(parsed.zhang) : '';
    form.die_zhangbi = d.die_zhangbi || '';
    form.jingtu = d.jingtu || '';
    form.tushi = d.tushi || '';
    form.comment = d.comment || '';
    if (!form.shuliang && defaultTotal) {
      form.shuliang = String(defaultTotal);
    }
  }
});

function updateFromDie() {
  const total = parseInt(form.shuliang, 10) || defaultTotal;
  const die = parseInt(form.die, 10);
  if (!isNaN(die) && total) {
    const zhang = Math.max(0, total - die);
    form.zhang = String(zhang);
  }
}
function updateFromZhang() {
  const total = parseInt(form.shuliang, 10) || defaultTotal;
  const zhang = parseInt(form.zhang, 10);
  if (!isNaN(zhang) && total) {
    const die = Math.max(0, total - zhang);
    form.die = String(die);
  }
}
function updateFromTotal() {
  const total = parseInt(form.shuliang, 10);
  if (!total) return;
  const die = form.die !== '' ? parseInt(form.die, 10) : NaN;
  const zhang = form.zhang !== '' ? parseInt(form.zhang, 10) : NaN;
  if (!isNaN(die) && isNaN(zhang)) {
    form.zhang = String(Math.max(0, total - die));
  } else if (isNaN(die) && !isNaN(zhang)) {
    form.die = String(Math.max(0, total - zhang));
  }
}

function isTushiLink(tushi) {
  return !!tushi && (tushi.startsWith('http://') || tushi.startsWith('https://'));
}
function tushiLinkText(tushi) {
  return tushi && tushi.includes('shimo.im') ? '📄 查看石墨' : '打开链接';
}

async function submit() {
  const total = parseInt(form.shuliang, 10) || defaultTotal;
  const die = parseInt(form.die, 10) || 0;
  const zhang = parseInt(form.zhang, 10) || 0;
  const payload = {
    shuliang: String(total),
    die_count: die,
    zhang_count: zhang,
    // window.buildDieZhangbi 待后续批次迁移
    die_zhangbi: buildDieZhangbi(die, zhang),
    jingtu: form.jingtu.trim(),
    tushi: form.tushi.trim(),
    comment: form.comment.trim()
  };
  const { error } = await saveRecentMulti(payload);
  if (error) {
    warnToast('保存失败: ' + (error.message || error));
  } else {
    toast('✅ 已保存');
    showModal.value = false;
  }
}

function openEdit() { showModal.value = true; }
function refresh() {
  if (boardState.currentDate) loadRecentMulti(boardState.currentDate);
}

defineExpose({ openEdit, refresh });
</script>

<style>
.board-modal-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.45); z-index: 1010; display: flex; align-items: center; justify-content: center; padding: 16px; }
.board-modal { background: #fff; border-radius: 16px; width: 100%; max-width: 400px; max-height: 85vh; display: flex; flex-direction: column; box-shadow: 0 10px 40px rgba(0,0,0,0.15); }
.board-modal-header { padding: 16px; border-bottom: 1px solid #f1f5f9; font-weight: 600; font-size: 15px; }
.board-modal-body { padding: 16px; overflow-y: auto; }
.board-modal-footer { padding: 12px 16px 16px; display: flex; gap: 10px; }
.board-input { width: 100%; padding: 8px 10px; border: 1px solid #e2e8f0; border-radius: 8px; font-size: 13px; box-sizing: border-box; -webkit-touch-callout: default; touch-action: auto; }
.board-input:focus { outline: none; border-color: #3b82f6; }
.board-form-row { display: flex; gap: 8px; margin-bottom: 10px; align-items: center; }
.board-form-label { font-size: 12px; color: #64748b; width: 60px; flex-shrink: 0; }
.board-btn { flex: 1; padding: 12px; border-radius: 10px; border: none; font-size: 14px; font-weight: 600; cursor: pointer; }
.board-btn-primary { background: #3b82f6; color: #fff; }
.board-btn-danger { background: #ef4444; color: #fff; }
.board-btn:disabled { opacity: 0.6; cursor: not-allowed; }
.board-hint { font-size: 11px; color: #94a3b8; margin-top: 4px; }
</style>
