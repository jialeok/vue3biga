<template>
  <div class="jiwang-board trading-day-element" @dblclick="openEdit">
    <!-- 看板展示区 -->
    <div class="jiwang-content">
      <div class="jiwang-item">
        <div class="jiwang-label">昨日跌涨</div>
        <div id="jw-diezhang" class="jiwang-value-highlight">{{ display.diezhang || '-' }}</div>
      </div>
      <div class="jiwang-item">
        <div class="jiwang-label">昨日情绪</div>
        <div id="jw-qingxu" class="jiwang-value">{{ display.qingxu || '-' }}</div>
      </div>
      <div class="jiwang-item">
        <div class="jiwang-label">今日聚焦</div>
        <div id="jw-jujiao" class="jiwang-value">
          <template v-if="display.jujiao === '谁增做谁' && display.whoIncrease">
            <span style="font-size:13px;color:#1f2937">谁增做谁</span>
            <span :style="whoIncreaseStyle">{{ display.whoIncrease }}</span>
          </template>
          <template v-else>{{ display.jujiao || '-' }}</template>
        </div>
      </div>
      <div class="jiwang-item">
        <div class="jiwang-label">昨多板K线</div>
        <div id="jw-kxian" class="jiwang-value">{{ kxianDisplay }}</div>
      </div>
      <div class="jiwang-item">
        <div class="jiwang-label">观察</div>
        <div id="jw-guancha" class="jiwang-value">{{ display.guancha || '-' }}</div>
      </div>
      <div class="jiwang-item">
        <div class="jiwang-label">过程结果</div>
        <div id="jw-guochengjieguo" class="jiwang-value">{{ display.guochengJieguo || '-' }}</div>
      </div>
      <div class="jiwang-item">
        <div class="jiwang-label">收股结果</div>
        <div id="jw-shougujieguo" class="jiwang-value">{{ display.shouguJieguo || '-' }}</div>
      </div>
      <div class="jiwang-item">
        <div class="jiwang-label">出手情况</div>
        <div id="jw-chushou" class="jiwang-value" :class="chushouClass">{{ display.chushou || '-' }}</div>
      </div>
      <div class="jiwang-item">
        <div class="jiwang-label">得出结论</div>
        <div id="jw-jielun" class="jiwang-value" :class="jielunClass">{{ display.jielun || '-' }}</div>
      </div>
      <div id="jiwangStamp" class="jiwang-stamp" :class="stampClass" :style="stampStyle">
        <div id="stampQuestion">
          <template v-if="display.jielun === '出手'">
            <div class="stamp-text">得出结论</div><div class="stamp-result">出手</div>
          </template>
          <template v-else-if="display.jielun === '空仓'">
            <div class="stamp-text">得出结论</div><div class="stamp-result">空仓</div>
          </template>
          <template v-else>?</template>
        </div>
      </div>

    </div>

    <!-- 编辑弹窗 -->
    <Teleport to="body">
      <div v-if="modalActive" id="jiwangModal" class="jiwang-modal active" @click.self="closeModal">
        <div class="jiwang-modal-panel">
          <div class="jiwang-modal-header">
            <span>编辑记忘看板</span>
            <button class="jiwang-modal-close" @click="closeModal">×</button>
          </div>
          <form @submit.prevent="save" class="jiwang-form">
            <div class="jiwang-form-grid">
              <div class="jiwang-form-item">
                <label class="jiwang-form-label">跌涨</label>
                <select v-model="form.diezhang" @change="onDiezhangChange" class="jiwang-form-select">
                  <option value="">请选择</option>
                  <option v-for="o in diezhangOptions" :key="o" :value="o">{{ o }}</option>
                  <option value="其它">其它</option>
                </select>
                <input v-if="form.diezhang === '其它'" v-model="form.diezhangOther" placeholder="自定义" class="jiwang-form-input" />
              </div>
              <div class="jiwang-form-item">
                <label class="jiwang-form-label">情绪</label>
                <input v-model="form.qingxu" class="jiwang-form-input" />
              </div>
              <div class="jiwang-form-item">
                <label class="jiwang-form-label">今日聚焦</label>
                <select v-model="form.jujiao" @change="onJujiaoChange" class="jiwang-form-select">
                  <option value="最近多板">最近多板</option>
                  <option value="板块ETF">板块ETF</option>
                  <option value="谁增做谁">谁增做谁</option>
                </select>
              </div>
              <div class="jiwang-form-item" v-if="form.jujiao === '谁增做谁'">
                <label class="jiwang-form-label">谁增做谁</label>
                <select v-model="form.whoIncrease" @change="onWhoIncreaseChange" class="jiwang-form-select">
                  <option value="">请选择</option>
                  <option value="龙头增">龙头增</option>
                  <option value="板块增">板块增</option>
                  <option value="谁都增">谁都增</option>
                  <option value="谁都减">谁都减</option>
                </select>
              </div>
              <div class="jiwang-form-item">
                <label class="jiwang-form-label">K线前缀</label>
                <input v-model="form.kxianPrefix" class="jiwang-form-input" />
              </div>
              <div class="jiwang-form-item">
                <label class="jiwang-form-label">昨多板K线</label>
                <input v-model="form.kxian" class="jiwang-form-input" />
              </div>
              <div class="jiwang-form-item">
                <label class="jiwang-form-label">观察</label>
                <select v-model="form.guancha" @change="onGuanchaChange" class="jiwang-form-select">
                  <option value="">请选择</option>
                  <option v-for="o in guanchaOptions" :key="o" :value="o">{{ o }}</option>
                </select>
              </div>
              <div class="jiwang-form-item">
                <label class="jiwang-form-label">过程结果</label>
                <select v-model="form.guochengJieguo" class="jiwang-form-select">
                  <option value="">请选择</option>
                  <option v-for="o in guochengOptions" :key="o" :value="o">{{ o }}</option>
                </select>
              </div>
              <div class="jiwang-form-item jiwang-form-two-col">
                <label class="jiwang-form-label">收股结果（跌:涨）</label>
                <div class="jiwang-two-inputs">
                  <input v-model="form.shouguDie" placeholder="跌" class="jiwang-form-input" />
                  <input v-model="form.shouguZhang" placeholder="涨" class="jiwang-form-input" />
                </div>
              </div>
              <div class="jiwang-form-item">
                <label class="jiwang-form-label">得出结论</label>
                <select v-model="form.jielun" @change="onJielunChange" class="jiwang-form-select">
                  <option value="">请选择</option>
                  <option value="出手">出手</option>
                  <option value="空仓">空仓</option>
                </select>
              </div>
              <div class="jiwang-form-item">
                <label class="jiwang-form-label">出手情况</label>
                <select v-model="form.chushou" class="jiwang-form-select">
                  <option value="">请选择</option>
                  <option v-for="o in chushouOptions" :key="o" :value="o">{{ o }}</option>
                </select>
              </div>
            </div>
            <div class="jiwang-form-actions">
              <button type="submit" class="jiwang-btn-save">保存</button>
              <button type="button" class="jiwang-btn-cancel" @click="closeModal">取消</button>
            </div>
          </form>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script setup>
import { ref, computed, reactive } from 'vue';
import { useUiStore } from '../stores/uiStore.js';
import { _dbgLog } from '../data/debug-log.js';
import { saveData, getTodayJiwang, markJiwangDirty } from '../logic/app-core.js';
import { getBiddingData, getJiwangData } from '../data/supabase-client.js';
import { pushJiwangNow } from '../data/jiwang-data.js';
import { getStats, autoCalculateConsecutiveDays, renderCircleStats } from '../logic/jiwang-helpers.js';
import { getPreviousTradingDay } from '../logic/trading-day-helpers.js';
import { renderConsecutiveUp } from '../logic/tag-titles-helpers.js';
import { useScoreCalculation } from '../composables/useScoreCalculation.js';

const uiStore = useUiStore();
const { autoCalculateRecentMultiScore } = useScoreCalculation();
const display = ref({});
const modalActive = ref(false);

const diezhangOptions = ['1:2', '1:3', '1:4', '2:1', '1:1', '2:3', '3:1', '3:2', '4:1'];
const allGuanchaOptions = ['最近多板过程', '最近多板结果', '板块ETF过程', '两个过程'];
const allGuochengOptions = ['成功', '失败', '继续观察'];
const allChushouOptions = ['出手对了', '出手错了', '空仓对了', '空仓错了'];

const form = reactive({
  diezhang: '', diezhangOther: '', qingxu: '', jujiao: '最近多板', whoIncrease: '',
  kxianPrefix: '', kxian: '', guancha: '', guochengJieguo: '',
  shouguDie: '', shouguZhang: '', jielun: '', chushou: '', sectorEtf: false
});

const guanchaOptions = ref(allGuanchaOptions);
const guochengOptions = ref(allGuochengOptions);
const chushouOptions = ref(allChushouOptions);

const kxianDisplay = computed(() => {
  const d = display.value;
  if (d.kxianPrefix && d.kxian) return d.kxianPrefix + '+' + d.kxian;
  return d.kxian || '-';
});

const whoIncreaseStyle = computed(() => {
  const v = display.value.whoIncrease;
  if (v === '龙头增' || v === '板块增' || v === '谁都增') return 'font-size:13px;color:#dc2626';
  if (v === '谁都减') return 'font-size:13px;color:#059669';
  return '';
});

const chushouClass = computed(() => {
  const v = display.value.chushou;
  if (v === '出手对了' || v === '空仓对了') return 'red-highlight-small';
  if (v === '出手错了' || v === '空仓错了') return 'gray-highlight-small';
  return '';
});

const jielunClass = computed(() => {
  const v = display.value.jielun;
  if (v === '出手') return 'red-highlight';
  if (v === '空仓') return 'gray-highlight';
  return '';
});

const stampClass = computed(() => {
  const v = display.value.jielun;
  if (v === '出手') return 'red';
  if (v === '空仓') return 'gray';
  return 'yellow';
});

const stampStyle = computed(() => {
  const v = display.value.jielun;
  if (v === '出手') return { border: '3px solid rgba(248, 113, 113, 0.5)', background: 'rgba(248, 113, 113, 0.15)', color: 'rgba(248, 113, 113, 0.6)' };
  if (v === '空仓') return { border: '3px solid rgba(156, 163, 175, 0.5)', background: 'rgba(156, 163, 175, 0.15)', color: 'rgba(156, 163, 175, 0.6)' };
  return { border: '3px solid rgba(253, 224, 71, 0.25)', background: 'rgba(253, 224, 71, 0.08)', color: 'rgba(253, 224, 71, 0.35)' };
});

function formatAmount(value) {
  if (value === undefined || value === '' || isNaN(parseFloat(value))) return '-';
  const num = parseFloat(value);
  if (Math.abs(num) >= 1000000) return Math.round(num / 10000) + 'w';
  return num.toLocaleString('zh-CN');
}

function getNthPreviousTradingDay(dateStr, n) {
  let result = dateStr;
  for (let i = 0; i < n; i++) {
    result = getPreviousTradingDay(result);
    if (!result) return null;
  }
  return result;
}

function getKxianTypeByClose(closeValue) {
  if (!closeValue) return '';
  const value = parseFloat(closeValue);
  if (isNaN(value)) return '';
  if (value >= 3.6) return `大阳${value}%`;
  else if (value >= 2.6) return `中阳${value}%`;
  else if (value >= 1.0) return `小阳${value}%`;
  else if (value > -1.0) return `十字星${value}%`;
  else if (value >= -2.5) return `小阴${value}%`;
  else if (value >= -3.5) return `中阴${value}%`;
  else return `大阴${value}%`;
}

function getPrevDayMultiBoardClose() {
  const prevDate = getPreviousTradingDay(uiStore.currentDate);
  if (!prevDate) return null;
  const biddingData = getBiddingData();
  const prevDayData = biddingData[prevDate];
  if (!prevDayData || !Array.isArray(prevDayData)) return null;
  const multiBoardRow = prevDayData.find(row => row.name === '最近多板%');
  if (!multiBoardRow) return null;
  return multiBoardRow.close || null;
}

function render() {
  const d = getTodayJiwang() || {};
  display.value = d;
  renderCircleStats();
}

function openEdit() {
  const d = getTodayJiwang() || {};
  const diezhangValue = d.diezhang || '';
  if (diezhangOptions.includes(diezhangValue)) {
    form.diezhang = diezhangValue;
  } else if (diezhangValue) {
    form.diezhang = '其它';
    form.diezhangOther = diezhangValue;
  } else {
    form.diezhang = '';
  }
  form.qingxu = d.qingxu || '';
  form.jujiao = d.jujiao || '最近多板';
  form.kxianPrefix = d.kxianPrefix || '';

  let kxianValue = d.kxian || '';
  let autoGeneratedKxian = false;
  if (!kxianValue) {
    const prevClose = getPrevDayMultiBoardClose();
    if (prevClose) {
      kxianValue = getKxianTypeByClose(prevClose);
      autoGeneratedKxian = true;
    }
  }
  form.kxian = kxianValue;

  if (autoGeneratedKxian && kxianValue) {
    const jiwangData = getJiwangData();
    if (!jiwangData[uiStore.currentDate]) jiwangData[uiStore.currentDate] = {};
    jiwangData[uiStore.currentDate].kxian = kxianValue;
    markJiwangDirty(uiStore.currentDate);
    pushJiwangNow(uiStore.currentDate);
    render();
  }

  form.whoIncrease = (d.jujiao === '谁增做谁' && d.whoIncrease) ? d.whoIncrease : '';
  const jujiaoValue = d.jujiao || '最近多板';
  const whoIncreaseValue = d.whoIncrease || '';
  if (jujiaoValue === '最近多板') updateGuanchaOptions('duoban');
  else if (jujiaoValue === '板块ETF') updateGuanchaOptions('etf');
  else if (jujiaoValue === '谁增做谁') {
    if (whoIncreaseValue === '龙头增') updateGuanchaOptions('duoban');
    else if (whoIncreaseValue === '板块增') updateGuanchaOptions('etf');
    else updateGuanchaOptions('all');
  } else updateGuanchaOptions('all');

  form.guancha = d.guancha || '';
  onGuanchaChange();
  form.guochengJieguo = d.guochengJieguo || '';

  const shouguJieguo = d.shouguJieguo || '';
  if (shouguJieguo.includes(':')) {
    const parts = shouguJieguo.split(':');
    form.shouguDie = parts[0] || '';
    form.shouguZhang = parts[1] || '';
  } else {
    form.shouguDie = '';
    form.shouguZhang = '';
  }

  form.jielun = d.jielun || '';
  onJielunChange();
  form.chushou = d.chushou || '';

  const stats = getStats();
  form.sectorEtf = stats.sectorEtf || false;

  modalActive.value = true;
}

function onDiezhangChange() {}
function onJujiaoChange() {
  if (form.jujiao === '谁增做谁') updateGuanchaOptions('all');
  else if (form.jujiao === '最近多板') { form.whoIncrease = ''; updateGuanchaOptions('duoban'); }
  else if (form.jujiao === '板块ETF') { form.whoIncrease = ''; updateGuanchaOptions('etf'); }
}
function onWhoIncreaseChange() {
  const v = form.whoIncrease;
  if (v === '龙头增') updateGuanchaOptions('duoban');
  else if (v === '板块增') updateGuanchaOptions('etf');
  else if (v === '谁都增' || v === '谁都减') { updateGuanchaOptions('all'); form.guancha = '两个过程'; }
  else updateGuanchaOptions('all');
  onGuanchaChange();
}
function updateGuanchaOptions(type) {
  if (type === 'duoban') guanchaOptions.value = ['最近多板过程', '最近多板结果'];
  else if (type === 'etf') guanchaOptions.value = ['板块ETF过程'];
  else guanchaOptions.value = allGuanchaOptions;
}
function onGuanchaChange() {
  const v = form.guancha;
  if (v === '最近多板过程' || v === '最近多板结果') guochengOptions.value = ['成功', '失败', '继续观察'];
  else if (v === '板块ETF过程') guochengOptions.value = ['成功', '失败', '继续观察'];
  else guochengOptions.value = allGuochengOptions;
}
function onJielunChange() {
  const v = form.jielun;
  if (v === '出手') chushouOptions.value = ['出手对了', '出手错了'];
  else if (v === '空仓') chushouOptions.value = ['空仓对了', '空仓错了'];
  else chushouOptions.value = allChushouOptions;
}

function closeModal() { modalActive.value = false; }

function save() {
  const diezhangValue = form.diezhang === '其它' ? form.diezhangOther : form.diezhang;
  const whoIncreaseValue = form.jujiao === '谁增做谁' ? form.whoIncrease : '';
  const stats = getStats();
  stats.sectorEtf = form.sectorEtf;

  const d = {
    diezhang: diezhangValue,
    qingxu: form.qingxu,
    jujiao: form.jujiao,
    whoIncrease: whoIncreaseValue,
    kxianPrefix: form.kxianPrefix,
    kxian: form.kxian,
    guancha: form.guancha,
    guochengJieguo: form.guochengJieguo,
    shouguJieguo: (form.shouguDie || '') + ':' + (form.shouguZhang || ''),
    jielun: form.jielun,
    chushou: form.chushou,
    stats: stats
  };
  getJiwangData()[uiStore.currentDate] = d;
  markJiwangDirty(uiStore.currentDate);
  _dbgLog('saveJiwang: 保存 ' + uiStore.currentDate + ' 到内存, data=' + JSON.stringify(d).slice(0, 300));
  saveData();
  pushJiwangNow(uiStore.currentDate, '✅ 记忘看板已保存并同步到云端');
  render();
  closeModal();

  autoCalculateRecentMultiScore();
  autoCalculateConsecutiveDays();
  renderConsecutiveUp();
}

defineExpose({ render, openEdit, closeModal, save, formatAmount, getNthPreviousTradingDay, getKxianTypeByClose, getPrevDayMultiBoardClose });
</script>

<style>
.jiwang-modal {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  z-index: 9999;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 10px;
}
.jiwang-modal-panel {
  background: #fff;
  border-radius: 16px;
  padding: 20px;
  width: 100%;
  max-width: 360px;
  max-height: 90vh;
  overflow-y: auto;
  box-shadow: 0 10px 40px rgba(0, 0, 0, 0.15);
}
.jiwang-modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 16px;
  font-weight: 600;
  margin-bottom: 16px;
  color: #1f2937;
}
.jiwang-modal-close {
  background: none;
  border: none;
  font-size: 22px;
  color: #9ca3af;
  cursor: pointer;
  padding: 0 4px;
  line-height: 1;
}
.jiwang-modal-close:hover { color: #ef4444; }
.jiwang-form { display: flex; flex-direction: column; gap: 12px; }
.jiwang-form-grid { display: flex; flex-direction: column; gap: 10px; }
.jiwang-form-item { display: flex; flex-direction: column; gap: 4px; }
.jiwang-form-label {
  font-size: 12px;
  color: #6b7280;
  font-weight: 500;
}
.jiwang-form-input,
.jiwang-form-select {
  padding: 8px 10px;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  font-size: 13px;
  color: #1f2937;
  background: #f9fafb;
  outline: none;
  transition: border-color 0.2s, background 0.2s;
}
.jiwang-form-input:focus,
.jiwang-form-select:focus {
  border-color: #6366f1;
  background: #fff;
}
.jiwang-form-two-col .jiwang-two-inputs {
  display: flex;
  gap: 8px;
}
.jiwang-form-two-col .jiwang-two-inputs input {
  flex: 1;
}
.jiwang-form-actions {
  display: flex;
  gap: 8px;
  margin-top: 8px;
}
.jiwang-btn-save, .jiwang-btn-cancel {
  flex: 1;
  padding: 10px;
  border: none;
  border-radius: 8px;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: background 0.2s;
}
.jiwang-btn-save { background: #6366f1; color: #fff; }
.jiwang-btn-save:hover { background: #4f46e5; }
.jiwang-btn-cancel { background: #f3f4f6; color: #374151; }
.jiwang-btn-cancel:hover { background: #e5e7eb; }
</style>
