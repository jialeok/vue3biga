<template>
  <div class="jiwang-board trading-day-element" @dblclick="openEdit">
    <!-- 看板展示区（前台） -->
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
        <div class="jiwang-label">昨收盘结果</div>
        <div id="jw-shougujieguo" class="jiwang-value">{{ display.shouguJieguo || '-' }}</div>
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
        <div class="jiwang-label">得出结论</div>
        <div id="jw-jielun" class="jiwang-value" :class="jielunClass">{{ display.jielun || '-' }}</div>
      </div>
      <div class="jiwang-item">
        <div class="jiwang-label">出手情况</div>
        <div id="jw-chushou" class="jiwang-value" :class="chushouClass">{{ display.chushou || '-' }}</div>
      </div>
      <!-- 印章（得出结论处的半透明印章） -->
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

    <!-- 编辑弹窗（后台）：复刻旧版 #jiwangModal 底部抽屉 + 三列 form-row 布局 -->
    <Teleport to="body">
      <div v-if="modalActive" id="jiwangModal" class="modal active" @click.self="closeModal">
        <div class="modal-content">
          <div class="modal-header">
            <div style="font-weight:600;color:#1f2937">编辑看板</div>
            <button type="button" class="close-btn" @click="closeModal">×</button>
          </div>
          <form @submit.prevent="save">
            <!-- 第一行：昨日跌涨、昨日情绪、今日聚焦 -->
            <div class="form-row">
              <div class="form-group">
                <label class="form-label">昨日跌涨</label>
                <select class="form-input" v-model="form.diezhang" @change="onDiezhangChange">
                  <option value="">请选择</option>
                  <option v-for="o in diezhangOptions" :key="o" :value="o">{{ o }}</option>
                  <option value="其它">其它</option>
                </select>
                <input v-if="form.diezhang === '其它'" v-model="form.diezhangOther" placeholder="请输入内容" class="form-input" style="margin-top:4px" />
              </div>
              <div class="form-group">
                <label class="form-label">昨日情绪</label>
                <select class="form-input" v-model="form.qingxu">
                  <option value="">请选择</option>
                  <option value="节点">节点</option>
                  <option value="非节点">非节点</option>
                </select>
              </div>
              <div class="form-group">
                <label class="form-label">今日聚焦</label>
                <select class="form-input" v-model="form.jujiao" @change="onJujiaoChange">
                  <option value="最近多板">最近多板</option>
                  <option value="板块ETF">板块ETF</option>
                  <option value="谁增做谁">谁增做谁</option>
                </select>
                <select v-if="form.jujiao === '谁增做谁'" class="form-input" v-model="form.whoIncrease" @change="onWhoIncreaseChange" style="margin-top:4px">
                  <option value="">请选择</option>
                  <option value="龙头增">龙头增</option>
                  <option value="板块增">板块增</option>
                  <option value="谁都增">谁都增</option>
                  <option value="谁都减">谁都减</option>
                </select>
              </div>
            </div>
            <!-- 第二行：昨收盘结果、观察 -->
            <div class="form-row">
              <div class="form-group" style="flex:1;">
                <label class="form-label">昨收盘结果</label>
                <div style="display:flex;align-items:center;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;background:#fff;height:40px;">
                  <input type="text" v-model="form.shouguDie" placeholder="跌" style="flex:1;border:none;padding:10px 8px;text-align:right;outline:none;font-size:14px;min-width:0;height:40px;box-sizing:border-box;">
                  <span style="padding:10px 2px;font-weight:700;color:#374151;background:#fff;flex-shrink:0;height:40px;display:flex;align-items:center;">:</span>
                  <input type="text" v-model="form.shouguZhang" placeholder="涨" style="flex:1;border:none;padding:10px 8px;text-align:left;outline:none;font-size:14px;min-width:0;height:40px;box-sizing:border-box;">
                </div>
              </div>
              <div class="form-group" style="flex:1;">
                <label class="form-label">观察</label>
                <select class="form-input" v-model="form.guancha" @change="onGuanchaChange">
                  <option value="">请选择</option>
                  <option v-for="o in guanchaOptions" :key="o" :value="o">{{ o }}</option>
                </select>
              </div>
            </div>
            <!-- 第三行：昨多板K线前缀、昨多板K线 -->
            <div class="form-row">
              <div class="form-group" style="flex:1;">
                <label class="form-label">昨多板K线前缀</label>
                <input type="text" class="form-input" v-model="form.kxianPrefix" placeholder="如：三连阳">
              </div>
              <div class="form-group" style="flex:1;">
                <label class="form-label">昨多板K线</label>
                <input type="text" class="form-input" v-model="form.kxian" placeholder="大阳线">
              </div>
            </div>
            <!-- 第四行：过程结果、得出结论、出手情况 -->
            <div class="form-row">
              <div class="form-group">
                <label class="form-label">过程结果</label>
                <select class="form-input" v-model="form.guochengJieguo">
                  <option value="">请选择</option>
                  <option v-for="o in guochengOptions" :key="o" :value="o">{{ o }}</option>
                </select>
              </div>
              <div class="form-group">
                <label class="form-label">得出结论</label>
                <select class="form-input" v-model="form.jielun" @change="onJielunChange">
                  <option value="">请选择</option>
                  <option value="出手">出手</option>
                  <option value="空仓">空仓</option>
                </select>
              </div>
              <div class="form-group">
                <label class="form-label">出手情况</label>
                <select class="form-input" v-model="form.chushou">
                  <option value="">请选择</option>
                  <option v-for="o in chushouOptions" :key="o" :value="o">{{ o }}</option>
                </select>
              </div>
            </div>
            <button type="submit" class="submit-btn">保存看板</button>
          </form>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script setup>
import { ref, computed, reactive, onMounted, onUnmounted, watch } from 'vue';
import { useUiStore } from '../stores/uiStore.js';
import { _dbgLog } from '../data/debug-log.js';
import { _on, _off } from '../stores/eventBus.js';
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
// 旧版过程结果为固定四项（结果为正/负/过程递增/递减）
const allGuochengOptions = ['结果为正', '结果为负', '过程递增', '过程递减'];
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

// 印章配色：半透明 rgba，与旧 boards-jiwang.js 的 stamp.style 一致（红/灰/黄）
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

// 记忘看板显示依赖一次性快照（display 为 ref，非 reactive），必须显式触发刷新：
// 1) 挂载时先渲染一次（此时云端可能尚未拉回，渲染后会由下方 jiwang-refresh 再次刷新）
// 2) 监听云端拉取 / Realtime 完成后的 jiwang-refresh 事件重新渲染
// 3) 切换日期时重新读取当日数据
onMounted(() => { render(); });
_on('jiwang-refresh', render);
watch(() => uiStore.currentDate, () => render());
onUnmounted(() => { _off('jiwang-refresh', render); });

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
  // 旧版过程结果为固定选项，不随观察联动变化
  guochengOptions.value = allGuochengOptions;
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
  // 旧版过程结果固定四项，不随观察变化
  guochengOptions.value = allGuochengOptions;
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
