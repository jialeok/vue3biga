<template>
  <div class="jiwang-board">
    <!-- 鐪嬫澘灞曠ず鍖?-->
    <div class="jiwang-display">
      <div class="jiwang-row">
        <span class="jiwang-label">璺屾定</span>
        <span id="jw-diezhang" class="jiwang-value">{{ display.diezhang || '-' }}</span>
      </div>
      <div class="jiwang-row">
        <span class="jiwang-label">鎯呯华</span>
        <span id="jw-qingxu" class="jiwang-value">{{ display.qingxu || '-' }}</span>
      </div>
      <div class="jiwang-row">
        <span class="jiwang-label">浠婃棩鑱氱劍</span>
        <span id="jw-jujiao" class="jiwang-value">
          <template v-if="display.jujiao === '璋佸鍋氳皝' && display.whoIncrease">
            <span style="font-size:13px;color:#1f2937">璋佸鍋氳皝</span>
            <span :style="whoIncreaseStyle">{{ display.whoIncrease }}</span>
          </template>
          <template v-else>{{ display.jujiao || '-' }}</template>
        </span>
      </div>
      <div class="jiwang-row">
        <span class="jiwang-label">鏄ㄥ鏉縆绾?/span>
        <span id="jw-kxian" class="jiwang-value">{{ kxianDisplay }}</span>
      </div>
      <div class="jiwang-row">
        <span class="jiwang-label">瑙傚療</span>
        <span id="jw-guancha" class="jiwang-value">{{ display.guancha || '-' }}</span>
      </div>
      <div class="jiwang-row">
        <span class="jiwang-label">杩囩▼缁撴灉</span>
        <span id="jw-guochengjieguo" class="jiwang-value">{{ display.guochengJieguo || '-' }}</span>
      </div>
      <div class="jiwang-row">
        <span class="jiwang-label">鏀惰偂缁撴灉</span>
        <span id="jw-shougujieguo" class="jiwang-value">{{ display.shouguJieguo || '-' }}</span>
      </div>
      <div class="jiwang-row">
        <span class="jiwang-label">鍑烘墜鎯呭喌</span>
        <span id="jw-chushou" class="jiwang-value" :class="chushouClass">{{ display.chushou || '-' }}</span>
      </div>
      <div class="jiwang-row">
        <span class="jiwang-label">寰楀嚭缁撹</span>
        <span id="jw-jielun" class="jiwang-value" :class="jielunClass">{{ display.jielun || '-' }}</span>
      </div>
      <div id="jiwangStamp" class="jiwang-stamp" :class="stampClass" :style="stampStyle">
        <div id="stampQuestion">
          <template v-if="display.jielun === '鍑烘墜'">
            <div class="stamp-text">寰楀嚭缁撹</div><div class="stamp-result">鍑烘墜</div>
          </template>
          <template v-else-if="display.jielun === '绌轰粨'">
            <div class="stamp-text">寰楀嚭缁撹</div><div class="stamp-result">绌轰粨</div>
          </template>
          <template v-else>?</template>
        </div>
      </div>
      <button class="jiwang-edit-btn" @click="openEdit">缂栬緫</button>
    </div>

    <!-- 缂栬緫寮圭獥 -->
    <Teleport to="body">
      <div v-if="modalActive" id="jiwangModal" class="jiwang-modal active" @click.self="closeModal">
        <div class="jiwang-modal-panel">
          <div class="jiwang-modal-header">缂栬緫璁板繕鐪嬫澘</div>
          <form @submit.prevent="save">
            <div class="form-row">
              <label>璺屾定</label>
              <select id="jwEditDiezhang" v-model="form.diezhang" @change="onDiezhangChange">
                <option value="">璇烽€夋嫨</option>
                <option v-for="o in diezhangOptions" :key="o" :value="o">{{ o }}</option>
                <option value="鍏跺畠">鍏跺畠</option>
              </select>
              <input id="jwEditDiezhangOther" v-if="form.diezhang === '鍏跺畠'" v-model="form.diezhangOther" placeholder="鑷畾涔? />
            </div>
            <div class="form-row">
              <label>鎯呯华</label>
              <input id="jwEditQingxu" v-model="form.qingxu" />
            </div>
            <div class="form-row">
              <label>浠婃棩鑱氱劍</label>
              <select id="jwEditJujiao" v-model="form.jujiao" @change="onJujiaoChange">
                <option value="鏈€杩戝鏉?>鏈€杩戝鏉?/option>
                <option value="鏉垮潡ETF">鏉垮潡ETF</option>
                <option value="璋佸鍋氳皝">璋佸鍋氳皝</option>
              </select>
            </div>
            <div class="form-row" v-if="form.jujiao === '璋佸鍋氳皝'">
              <label>璋佸鍋氳皝</label>
              <select id="jwEditWhoIncrease" v-model="form.whoIncrease" @change="onWhoIncreaseChange">
                <option value="">璇烽€夋嫨</option>
                <option value="榫欏ご澧?>榫欏ご澧?/option>
                <option value="鏉垮潡澧?>鏉垮潡澧?/option>
                <option value="璋侀兘澧?>璋侀兘澧?/option>
                <option value="璋侀兘鍑?>璋侀兘鍑?/option>
              </select>
            </div>
            <div class="form-row">
              <label>K绾垮墠缂€</label>
              <input id="jwEditKxianPrefix" v-model="form.kxianPrefix" />
            </div>
            <div class="form-row">
              <label>鏄ㄥ鏉縆绾?/label>
              <input id="jwEditKxian" v-model="form.kxian" />
            </div>
            <div class="form-row">
              <label>瑙傚療</label>
              <select id="jwEditGuancha" v-model="form.guancha" @change="onGuanchaChange">
                <option value="">璇烽€夋嫨</option>
                <option v-for="o in guanchaOptions" :key="o" :value="o">{{ o }}</option>
              </select>
            </div>
            <div class="form-row">
              <label>杩囩▼缁撴灉</label>
              <select id="jwEditGuochengJieguo" v-model="form.guochengJieguo">
                <option value="">璇烽€夋嫨</option>
                <option v-for="o in guochengOptions" :key="o" :value="o">{{ o }}</option>
              </select>
            </div>
            <div class="form-row">
              <label>鏀惰偂缁撴灉锛堣穼:娑級</label>
              <input id="jwEditShouguJieguoDie" v-model="form.shouguDie" placeholder="璺? />
              <input id="jwEditShouguJieguoZhang" v-model="form.shouguZhang" placeholder="娑? />
            </div>
            <div class="form-row">
              <label>寰楀嚭缁撹</label>
              <select id="jwEditJielun" v-model="form.jielun" @change="onJielunChange">
                <option value="">璇烽€夋嫨</option>
                <option value="鍑烘墜">鍑烘墜</option>
                <option value="绌轰粨">绌轰粨</option>
              </select>
            </div>
            <div class="form-row">
              <label>鍑烘墜鎯呭喌</label>
              <select id="jwEditChushou" v-model="form.chushou">
                <option value="">璇烽€夋嫨</option>
                <option v-for="o in chushouOptions" :key="o" :value="o">{{ o }}</option>
              </select>
            </div>
            <div class="form-row">
              <label>鏉垮潡ETF</label>
              <span id="editSectorEtfCheck" class="checkbox-option" :class="form.sectorEtf ? 'checked' : 'unchecked'" @click="form.sectorEtf = !form.sectorEtf">{{ form.sectorEtf ? '鉁? : '脳' }}</span>
            </div>
            <div class="form-actions">
              <button type="submit" class="btn-save">淇濆瓨</button>
              <button type="button" class="btn-cancel" @click="closeModal">鍙栨秷</button>
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
const allGuanchaOptions = ['鏈€杩戝鏉胯繃绋?, '鏈€杩戝鏉跨粨鏋?, '鏉垮潡ETF杩囩▼', '涓や釜杩囩▼'];
const allGuochengOptions = ['鎴愬姛', '澶辫触', '缁х画瑙傚療'];
const allChushouOptions = ['鍑烘墜瀵逛簡', '鍑烘墜閿欎簡', '绌轰粨瀵逛簡', '绌轰粨閿欎簡'];

const form = reactive({
  diezhang: '', diezhangOther: '', qingxu: '', jujiao: '鏈€杩戝鏉?, whoIncrease: '',
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
  if (v === '榫欏ご澧? || v === '鏉垮潡澧? || v === '璋侀兘澧?) return 'font-size:13px;color:#dc2626';
  if (v === '璋侀兘鍑?) return 'font-size:13px;color:#059669';
  return '';
});

const chushouClass = computed(() => {
  const v = display.value.chushou;
  if (v === '鍑烘墜瀵逛簡' || v === '绌轰粨瀵逛簡') return 'red-highlight-small';
  if (v === '鍑烘墜閿欎簡' || v === '绌轰粨閿欎簡') return 'gray-highlight-small';
  return '';
});

const jielunClass = computed(() => {
  const v = display.value.jielun;
  if (v === '鍑烘墜') return 'red-highlight';
  if (v === '绌轰粨') return 'gray-highlight';
  return '';
});

const stampClass = computed(() => {
  const v = display.value.jielun;
  if (v === '鍑烘墜') return 'red';
  if (v === '绌轰粨') return 'gray';
  return 'yellow';
});

const stampStyle = computed(() => {
  const v = display.value.jielun;
  if (v === '鍑烘墜') return { border: '3px solid rgba(248, 113, 113, 0.5)', background: 'rgba(248, 113, 113, 0.15)', color: 'rgba(248, 113, 113, 0.6)' };
  if (v === '绌轰粨') return { border: '3px solid rgba(156, 163, 175, 0.5)', background: 'rgba(156, 163, 175, 0.15)', color: 'rgba(156, 163, 175, 0.6)' };
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
  if (value >= 3.6) return `澶ч槼${value}%`;
  else if (value >= 2.6) return `涓槼${value}%`;
  else if (value >= 1.0) return `灏忛槼${value}%`;
  else if (value > -1.0) return `鍗佸瓧鏄?{value}%`;
  else if (value >= -2.5) return `灏忛槾${value}%`;
  else if (value >= -3.5) return `涓槾${value}%`;
  else return `澶ч槾${value}%`;
}

function getPrevDayMultiBoardClose() {
  const prevDate = getPreviousTradingDay(uiStore.currentDate);
  if (!prevDate) return null;
  const biddingData = getBiddingData();
  const prevDayData = biddingData[prevDate];
  if (!prevDayData || !Array.isArray(prevDayData)) return null;
  const multiBoardRow = prevDayData.find(row => row.name === '鏈€杩戝鏉?');
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
    form.diezhang = '鍏跺畠';
    form.diezhangOther = diezhangValue;
  } else {
    form.diezhang = '';
  }
  form.qingxu = d.qingxu || '';
  form.jujiao = d.jujiao || '鏈€杩戝鏉?;
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

  form.whoIncrease = (d.jujiao === '璋佸鍋氳皝' && d.whoIncrease) ? d.whoIncrease : '';
  const jujiaoValue = d.jujiao || '鏈€杩戝鏉?;
  const whoIncreaseValue = d.whoIncrease || '';
  if (jujiaoValue === '鏈€杩戝鏉?) updateGuanchaOptions('duoban');
  else if (jujiaoValue === '鏉垮潡ETF') updateGuanchaOptions('etf');
  else if (jujiaoValue === '璋佸鍋氳皝') {
    if (whoIncreaseValue === '榫欏ご澧?) updateGuanchaOptions('duoban');
    else if (whoIncreaseValue === '鏉垮潡澧?) updateGuanchaOptions('etf');
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
  if (form.jujiao === '璋佸鍋氳皝') updateGuanchaOptions('all');
  else if (form.jujiao === '鏈€杩戝鏉?) { form.whoIncrease = ''; updateGuanchaOptions('duoban'); }
  else if (form.jujiao === '鏉垮潡ETF') { form.whoIncrease = ''; updateGuanchaOptions('etf'); }
}
function onWhoIncreaseChange() {
  const v = form.whoIncrease;
  if (v === '榫欏ご澧?) updateGuanchaOptions('duoban');
  else if (v === '鏉垮潡澧?) updateGuanchaOptions('etf');
  else if (v === '璋侀兘澧? || v === '璋侀兘鍑?) { updateGuanchaOptions('all'); form.guancha = '涓や釜杩囩▼'; }
  else updateGuanchaOptions('all');
  onGuanchaChange();
}
function updateGuanchaOptions(type) {
  if (type === 'duoban') guanchaOptions.value = ['鏈€杩戝鏉胯繃绋?, '鏈€杩戝鏉跨粨鏋?];
  else if (type === 'etf') guanchaOptions.value = ['鏉垮潡ETF杩囩▼'];
  else guanchaOptions.value = allGuanchaOptions;
}
function onGuanchaChange() {
  const v = form.guancha;
  if (v === '鏈€杩戝鏉胯繃绋? || v === '鏈€杩戝鏉跨粨鏋?) guochengOptions.value = ['鎴愬姛', '澶辫触', '缁х画瑙傚療'];
  else if (v === '鏉垮潡ETF杩囩▼') guochengOptions.value = ['鎴愬姛', '澶辫触', '缁х画瑙傚療'];
  else guochengOptions.value = allGuochengOptions;
}
function onJielunChange() {
  const v = form.jielun;
  if (v === '鍑烘墜') chushouOptions.value = ['鍑烘墜瀵逛簡', '鍑烘墜閿欎簡'];
  else if (v === '绌轰粨') chushouOptions.value = ['绌轰粨瀵逛簡', '绌轰粨閿欎簡'];
  else chushouOptions.value = allChushouOptions;
}

function closeModal() { modalActive.value = false; }

function save() {
  const diezhangValue = form.diezhang === '鍏跺畠' ? form.diezhangOther : form.diezhang;
  const whoIncreaseValue = form.jujiao === '璋佸鍋氳皝' ? form.whoIncrease : '';
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
  _dbgLog('saveJiwang: 淇濆瓨 ' + uiStore.currentDate + ' 鍒板唴瀛? data=' + JSON.stringify(d).slice(0, 300));
  saveData();
  pushJiwangNow(uiStore.currentDate, '鉁?璁板繕鐪嬫澘宸蹭繚瀛樺苟鍚屾鍒颁簯绔?);
  render();
  closeModal();

  autoCalculateRecentMultiScore();
  autoCalculateConsecutiveDays();
  renderConsecutiveUp();
}

defineExpose({ render, openEdit, closeModal, save, formatAmount, getNthPreviousTradingDay, getKxianTypeByClose, getPrevDayMultiBoardClose });
</script>

<style>
.jiwang-board {
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  padding: 12px;
  margin: 8px 0;
  background: #fff;
  position: relative;
}
.jiwang-row {
  display: flex;
  align-items: center;
  padding: 4px 0;
  font-size: 13px;
}
.jiwang-label {
  width: 90px;
  color: #6b7280;
}
.jiwang-value {
  color: #1f2937;
  font-weight: 500;
}
.red-highlight-small { color: #dc2626; }
.gray-highlight-small { color: #9ca3af; }
.red-highlight { color: #dc2626; font-weight: 600; }
.gray-highlight { color: #9ca3af; font-weight: 600; }
.jiwang-stamp {
  position: absolute;
  right: 16px;
  top: 16px;
  width: 80px;
  height: 80px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 32px;
  font-weight: 700;
}
.jiwang-stamp .stamp-text {
  font-size: 10px;
  text-align: center;
}
.jiwang-stamp .stamp-result {
  font-size: 16px;
  text-align: center;
  font-weight: 700;
}
.jiwang-edit-btn {
  margin-top: 8px;
  padding: 6px 16px;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  background: #fff;
  color: #374151;
  font-size: 13px;
  cursor: pointer;
}
.jiwang-modal {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  z-index: 9999;
  display: flex;
  align-items: center;
  justify-content: center;
}
.jiwang-modal-panel {
  background: #fff;
  border-radius: 12px;
  padding: 20px;
  min-width: 420px;
  max-height: 90vh;
  overflow: auto;
}
.jiwang-modal-header {
  font-size: 16px;
  font-weight: 600;
  margin-bottom: 16px;
  color: #1f2937;
}
.form-row {
  display: flex;
  align-items: center;
  margin-bottom: 10px;
  gap: 8px;
}
.form-row label {
  width: 100px;
  color: #6b7280;
  font-size: 13px;
}
.form-row input,
.form-row select {
  flex: 1;
  padding: 6px 8px;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  font-size: 13px;
}
.checkbox-option {
  width: 24px;
  height: 24px;
  border: 1px solid #d1d5db;
  border-radius: 4px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  font-size: 14px;
}
.checkbox-option.checked { background: #dc2626; color: #fff; border-color: #dc2626; }
.checkbox-option.unchecked { background: #fff; color: #9ca3af; }
.form-actions {
  display: flex;
  gap: 8px;
  margin-top: 16px;
}
.btn-save, .btn-cancel {
  flex: 1;
  padding: 8px;
  border: none;
  border-radius: 6px;
  font-size: 14px;
  cursor: pointer;
}
.btn-save { background: #2563eb; color: #fff; }
.btn-cancel { background: #e5e7eb; color: #374151; }
</style>