<template>
  <div
    class="jiwang-board trading-day-element"
    @dblclick="openEdit"
  >
    <!-- 看板展示区（前台） -->
    <div class="jiwang-content">
      <div class="jiwang-item">
        <div class="jiwang-label">
          昨日跌涨
        </div>
        <div
          id="jw-diezhang"
          class="jiwang-value-highlight"
        >
          {{ display.diezhang || autoDisplay.diezhang || '-' }}
        </div>
      </div>
      <div class="jiwang-item">
        <div class="jiwang-label">
          昨日情绪
        </div>
        <div
          id="jw-qingxu"
          class="jiwang-value"
        >
          {{ display.qingxu || autoDisplay.qingxu || '-' }}
        </div>
      </div>
      <div class="jiwang-item">
        <div class="jiwang-label">
          今日聚焦
        </div>
        <div
          id="jw-jujiao"
          class="jiwang-value"
        >
          <template v-if="display.jujiao === '谁增做谁' && display.whoIncrease">
            <span style="font-size:13px;color:#1f2937">谁增做谁</span>
            <span :style="whoIncreaseStyle">{{ display.whoIncrease }}</span>
          </template>
          <template v-else>
            {{ display.jujiao || '最近多板' }}
          </template>
        </div>
      </div>
      <div class="jiwang-item">
        <div class="jiwang-label">
          昨收盘结果
        </div>
        <div
          id="jw-shougujieguo"
          class="jiwang-value"
        >
          {{ display.shouguJieguo || '-' }}
        </div>
      </div>
      <div class="jiwang-item">
        <div class="jiwang-label">
          昨多板K线
        </div>
        <div
          id="jw-kxian"
          class="jiwang-value"
        >
          {{ kxianDisplay }}
        </div>
      </div>
      <div class="jiwang-item">
        <div class="jiwang-label">
          观察
        </div>
        <div
          id="jw-guancha"
          class="jiwang-value"
        >
          {{ display.guancha || '-' }}
        </div>
      </div>
      <div class="jiwang-item">
        <div class="jiwang-label">
          过程结果
        </div>
        <div
          id="jw-guochengjieguo"
          class="jiwang-value"
        >
          {{ display.guochengJieguo || '-' }}
        </div>
      </div>
      <div class="jiwang-item">
        <div class="jiwang-label">
          得出结论
        </div>
        <div
          id="jw-jielun"
          class="jiwang-value"
          :class="jielunClass"
        >
          {{ display.jielun || '-' }}
        </div>
      </div>
      <div class="jiwang-item">
        <div class="jiwang-label">
          出手情况
        </div>
        <div
          id="jw-chushou"
          class="jiwang-value"
          :class="chushouClass"
        >
          {{ display.chushou || '-' }}
        </div>
      </div>
      <!-- 印章（得出结论处的半透明印章） -->
      <div
        id="jiwangStamp"
        class="jiwang-stamp"
        :class="stampClass"
        :style="stampStyle"
      >
        <div id="stampQuestion">
          <template v-if="display.jielun === '出手'">
            <div class="stamp-text">
              得出结论
            </div><div class="stamp-result">
              出手
            </div>
          </template>
          <template v-else-if="display.jielun === '空仓'">
            <div class="stamp-text">
              得出结论
            </div><div class="stamp-result">
              空仓
            </div>
          </template>
          <template v-else>
            ?
          </template>
        </div>
      </div>
    </div>

    <!-- 编辑弹窗（后台）：复刻旧版 #jiwangModal 底部抽屉 + 三列 form-row 布局 -->
    <Teleport to="body">
      <div
        v-if="modalActive"
        id="jiwangModal"
        class="modal active"
        @click.self="closeModal"
      >
        <div class="modal-content">
          <div class="modal-header">
            <div style="font-weight:600;color:#1f2937">
              编辑看板
            </div>
            <button
              type="button"
              class="close-btn"
              @click="closeModal"
            >
              ×
            </button>
          </div>
          <form @submit.prevent="save">
            <!-- 第一行：昨日跌涨、昨日情绪、今日聚焦 -->
            <div class="form-row">
              <div class="form-group">
                <label class="form-label">昨日跌涨</label>
                <select
                  v-model="form.diezhang"
                  class="form-input"
                  @change="onDiezhangChange"
                >
                  <option value="">
                    请选择
                  </option>
                  <option
                    v-for="o in diezhangOptions"
                    :key="o"
                    :value="o"
                  >
                    {{ o }}
                  </option>
                  <option value="其它">
                    其它
                  </option>
                </select>
                <input
                  v-if="form.diezhang === '其它'"
                  v-model="form.diezhangOther"
                  placeholder="请输入内容"
                  class="form-input"
                  style="margin-top:4px"
                >
              </div>
              <div class="form-group">
                <label class="form-label">昨日情绪</label>
                <select
                  v-model="form.qingxu"
                  class="form-input"
                >
                  <option value="">
                    请选择
                  </option>
                  <option value="节点">
                    节点
                  </option>
                  <option value="非节点">
                    非节点
                  </option>
                </select>
              </div>
              <div class="form-group">
                <label class="form-label">今日聚焦</label>
                <select
                  v-model="form.jujiao"
                  class="form-input"
                  @change="onJujiaoChange"
                >
                  <option value="最近多板">
                    最近多板
                  </option>
                  <option value="板块ETF">
                    板块ETF
                  </option>
                  <option value="谁增做谁">
                    谁增做谁
                  </option>
                </select>
                <select
                  v-if="form.jujiao === '谁增做谁'"
                  v-model="form.whoIncrease"
                  class="form-input"
                  style="margin-top:4px"
                  @change="onWhoIncreaseChange"
                >
                  <option value="">
                    请选择
                  </option>
                  <option value="龙头增">
                    龙头增
                  </option>
                  <option value="板块增">
                    板块增
                  </option>
                  <option value="谁都增">
                    谁都增
                  </option>
                  <option value="谁都减">
                    谁都减
                  </option>
                </select>
              </div>
            </div>
            <!-- 第二行：昨收盘结果、观察 -->
            <div class="form-row">
              <div
                class="form-group"
                style="flex:1;"
              >
                <label class="form-label">昨收盘结果</label>
                <div style="display:flex;align-items:center;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;background:#fff;height:40px;">
                  <input
                    v-model="form.shouguDie"
                    type="text"
                    placeholder="跌"
                    style="flex:1;border:none;padding:10px 8px;text-align:right;outline:none;font-size:14px;min-width:0;height:40px;box-sizing:border-box;"
                    @input="onShouguChange"
                  >
                  <span style="padding:10px 2px;font-weight:700;color:#374151;background:#fff;flex-shrink:0;height:40px;display:flex;align-items:center;">:</span>
                  <input
                    v-model="form.shouguZhang"
                    type="text"
                    placeholder="涨"
                    style="flex:1;border:none;padding:10px 8px;text-align:left;outline:none;font-size:14px;min-width:0;height:40px;box-sizing:border-box;"
                    @input="onShouguChange"
                  >
                </div>
              </div>
              <div
                class="form-group"
                style="flex:1;"
              >
                <label class="form-label">观察</label>
                <select
                  v-model="form.guancha"
                  class="form-input"
                  @change="onGuanchaChange"
                >
                  <option value="">
                    请选择
                  </option>
                  <option
                    v-for="o in guanchaOptions"
                    :key="o"
                    :value="o"
                  >
                    {{ o }}
                  </option>
                </select>
              </div>
            </div>
            <!-- 第三行：昨多板K线前缀、昨多板K线 -->
            <div class="form-row">
              <div
                class="form-group"
                style="flex:1;"
              >
                <label class="form-label">昨多板K线前缀</label>
                <input
                  v-model="form.kxianPrefix"
                  type="text"
                  class="form-input"
                  placeholder="如：三连阳"
                >
              </div>
              <div
                class="form-group"
                style="flex:1;"
              >
                <label class="form-label">昨多板K线</label>
                <input
                  v-model="form.kxian"
                  type="text"
                  class="form-input"
                  placeholder="大阳线"
                >
              </div>
            </div>
            <!-- 第四行：过程结果、得出结论、出手情况 -->
            <div class="form-row">
              <div class="form-group">
                <label class="form-label">过程结果</label>
                <select
                  v-model="form.guochengJieguo"
                  class="form-input"
                >
                  <option value="">
                    请选择
                  </option>
                  <option
                    v-for="o in guochengOptions"
                    :key="o"
                    :value="o"
                  >
                    {{ o }}
                  </option>
                </select>
              </div>
              <div class="form-group">
                <label class="form-label">得出结论</label>
                <select
                  v-model="form.jielun"
                  class="form-input"
                  @change="onJielunChange"
                >
                  <option value="">
                    请选择
                  </option>
                  <option value="出手">
                    出手
                  </option>
                  <option value="空仓">
                    空仓
                  </option>
                </select>
              </div>
              <div class="form-group">
                <label class="form-label">出手情况</label>
                <select
                  v-model="form.chushou"
                  class="form-input"
                >
                  <option value="">
                    请选择
                  </option>
                  <option
                    v-for="o in chushouOptions"
                    :key="o"
                    :value="o"
                  >
                    {{ o }}
                  </option>
                </select>
              </div>
            </div>
            <button
              type="submit"
              class="submit-btn"
            >
              保存看板
            </button>
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
import { getTodayJiwang } from '../logic/app-core.js';
import { getBiddingData } from '../data/supabase-client.js';
import { pushJiwangNow } from '../data/jiwang-data.js';
import { getStats, autoCalculateConsecutiveDays, renderCircleStats, getKxianTypeByClose } from '../logic/jiwang/helpers.js';
// [JIWANG 2026-10-23] 「昨收盘结果 → 昨日跌涨简化比 / 昨日情绪节点」纯逻辑下沉到 Logic 层（§3/§4）
import { deriveFromShougu, parseShouguRatio, ratioToDiezhang, ratioToQingxu, SHOUGU_RATIO_LABELS } from '../logic/jiwang/ratio-nodes.js';
import { getPreviousTradingDay } from '../logic/date/trading-day-helpers.js';
import { renderConsecutiveUp } from '../logic/tagTitles/helpers.js';
// [A7-01] 修正导入源：autoCalculateRecentMultiScore 在 bidding-helpers.js 中已 re-export，
// 不要从 useScoreCalculation() 解构（其返回值不含该函数，会得到 undefined 而抛 TypeError）。
import { autoCalculateRecentMultiScore } from '../logic/bidding/helpers.js';
// [A7-02] 经 Logic 层受控写入，UI 不再原地改 getJiwangData() 返回值
import { saveJiwangData } from '../logic/jiwang/jiwang.js';

const uiStore = useUiStore();
const display = ref({});
const modalActive = ref(false);

/**
 * [JIWANG 2026-10-23] 前台「自动补全」的展示态。
 *
 * 用户口径：「昨日多板K线…点击编辑看板时，有数值，但是前台却没有显示出来，默认它应该是显示出来的，
 *   这个是自动获取计算的，然后默认显示在前台」「昨日跌涨…自动填入显示」「今日聚焦，默认选最近多板显示」。
 *
 * ⚠️ 只做**展示派生**：⛔ 不写回 display、⛔ 不落库、⛔ 不标脏（§6 单一真相 + §10 不静默写入）。
 *   真正的落库仍然只在用户点「保存看板」时发生（见 save()）。
 */
const autoDisplay = ref({ diezhang: '', qingxu: '', kxian: '' });

const form = reactive({
  diezhang: '', diezhangOther: '', qingxu: '', jujiao: '最近多板', whoIncrease: '',
  kxianPrefix: '', kxian: '', guancha: '', guochengJieguo: '',
  shouguDie: '', shouguZhang: '', jielun: '', chushou: '', sectorEtf: false
});

// [JIWANG 2026-10-23] 选项来源改为 Logic 层节点表（⛔ 不在 UI 再抄一份，§6）。
// 「昨日跌涨」允许出现节点表以外的延伸值（如自动算出的 9:1 / 1:6），所以用 computed 动态并入当前值，
// 否则 select 的 v-model 值不在 option 里会显示空白。
const diezhangOptions = computed(() => {
  const cur = form.diezhang;
  // 只有「数字:数字」形式的延伸节点（自动算出的 9:1 / 1:6）才动态并入；
  // 历史脏值（如「普涨」）不并入，让它落到「其它」分支，避免污染标准选项。
  // ⚠️ 冒号要同时认半角「:」和全角「：」：2026-10-15 存的「5：1」、10-16 的「10：1」都是全角，
  //    不认全角会让这两天的历史值掉进「其它」，下拉里就看不到原值了。
  if (cur && cur !== '其它' && /^\d+[：:]\d+$/.test(cur) && SHOUGU_RATIO_LABELS.indexOf(cur) < 0) {
    return SHOUGU_RATIO_LABELS.concat([cur]);
  }
  return SHOUGU_RATIO_LABELS;
});
const allGuanchaOptions = ['最近多板过程', '最近多板结果', '板块ETF过程', '两个过程'];
// 旧版过程结果为固定四项（结果为正/负/过程递增/递减）
const allGuochengOptions = ['结果为正', '结果为负', '过程递增', '过程递减'];
// [JIWANG 2026-09-01] 过程结果选项按观察语义拆分：结果类观察只给正/负，过程类观察只给递增/递减
const resultGuochengOptions = ['结果为正', '结果为负'];
const processGuochengOptions = ['过程递增', '过程递减'];
const allChushouOptions = ['出手对了', '出手错了', '空仓对了', '空仓错了'];

const guanchaOptions = ref(allGuanchaOptions);
const guochengOptions = ref(allGuochengOptions);
const chushouOptions = ref(allChushouOptions);

const kxianDisplay = computed(() => {
  const d = display.value;
  // [JIWANG 2026-10-23] 缺值时用前一交易日「最近多板%」收盘涨幅推算的 K 线型态补上（只展示、不落库）
  const k = d.kxian || autoDisplay.value.kxian;
  if (!k) return '-';
  if (d.kxianPrefix) return d.kxianPrefix + '+' + k;
  return k;
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

// [JIWANG 2026-10-23] 本地 getKxianTypeByClose 已删：与 logic/jiwang/helpers.js 逐字重复（§6 同一实现），
// 统一从 Logic 层 import，避免两处阈值（3.6/2.6/1.0/-1.0/-2.5/-3.5）各改各的。

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

/**
 * 计算前台「自动补全」的三个值（缺值时才补，已有真值一律以数据库为准）。
 *
 * ① 昨日跌涨 / 昨日情绪 ← 昨收盘结果（跌:涨）经 Logic 层 ratio-nodes 换算：
 *      4999:535 ⇒ 9:1；3364:1918 ⇒ 3:2（用户 2026-10-23 两个原始例子）
 * ② 昨多板K线 ← 前一交易日「最近多板%」的收盘涨幅 → 大阳/中阳/小阳/十字星/小阴/中阴/大阴
 *
 * ⛔ 任何一项取不到就留空（前台显示 '-'），绝不用默认值冒充真实数据（§10）。
 * ⛔ 只读不写：本函数不触碰 jiwangData，不 markDirty。
 */
function computeAutoDisplay(d) {
  const out = { diezhang: '', qingxu: '', kxian: '' };

  // ① 昨收盘结果 → 跌涨简化比 + 情绪节点
  const derived = deriveFromShougu(d.shouguJieguo);
  if (derived) {
    out.diezhang = derived.diezhang;
    out.qingxu = derived.qingxu;
  }

  // ② 昨多板 K 线（只在数据里没有时才推算）
  if (!d.kxian) {
    const prevClose = getPrevDayMultiBoardClose();
    if (prevClose) out.kxian = getKxianTypeByClose(prevClose);
  }

  return out;
}

function render() {
  const d = getTodayJiwang() || {};
  display.value = d;
  autoDisplay.value = computeAutoDisplay(d);
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
  // [JIWANG 2026-10-23] 编辑态复用前台同一套自动补全（computeAutoDisplay），
  // 避免出现「前台看到 9:1、点进编辑却是空」的错位。
  const auto = computeAutoDisplay(d);

  const diezhangValue = d.diezhang || auto.diezhang || '';
  // 先赋值再问选项：让 diezhangOptions（依赖 form.diezhang）能把「9:1」这类延伸节点识别出来
  form.diezhang = diezhangValue;
  if (!diezhangValue) {
    form.diezhangOther = '';
  } else if (diezhangOptions.value.indexOf(diezhangValue) < 0) {
    form.diezhang = '其它';
    form.diezhangOther = diezhangValue;
  } else {
    form.diezhangOther = '';
  }

  form.qingxu = d.qingxu || auto.qingxu || '';
  form.jujiao = d.jujiao || '最近多板';
  form.kxianPrefix = d.kxianPrefix || '';
  // [A7-03] K 线推算结果仅作为表单默认值填入编辑态，不在此处写缓存 / 不推云端。
  // 真正的落库只在用户点「保存」(save) 时执行，避免打开编辑即静默落库（违反 §2/§10）。
  form.kxian = d.kxian || auto.kxian || '';

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
  // [JIWANG 2026-09-01] 若已存过程结果与当前观察语义不符（旧数据串档），清空以免下拉显示无效项
  if (form.guochengJieguo && guochengOptions.value.indexOf(form.guochengJieguo) < 0) {
    form.guochengJieguo = '';
  }

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

/**
 * [JIWANG 2026-10-23] 编辑态里改「昨收盘结果」时，实时把「昨日跌涨 / 昨日情绪」重算出来。
 * ⚠️ 只在两个数都填全时才动手（parseShouguRatio 返回 null 就 return）：
 *    否则用户刚敲下第 1 位数字就把下拉刷成别的值，反而干扰输入。
 * ⚠️ 用户仍可在下拉里手动改成别的节点 —— 手动改动不会被这里覆盖，除非他再次编辑跌/涨数。
 */
function onShouguChange() {
  const ratio = parseShouguRatio(form.shouguDie, form.shouguZhang);
  if (ratio === null) return;
  const label = ratioToDiezhang(ratio);
  if (!label) return;
  form.diezhang = label;
  const qingxu = ratioToQingxu(ratio);
  if (qingxu) form.qingxu = qingxu;
}

function onJujiaoChange() {
  // [JIWANG 2026-09-01] 过程结果选项由「观察」联动决定（见 onGuanchaChange），不在此固定为四项
  if (form.jujiao === '谁增做谁') updateGuanchaOptions('all');
  else if (form.jujiao === '最近多板') { form.whoIncrease = ''; updateGuanchaOptions('duoban'); }
  else if (form.jujiao === '板块ETF') { form.whoIncrease = ''; updateGuanchaOptions('etf'); }
  onGuanchaChange(); // 重新按当前观察同步过程结果可选项
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
function getGuochengOptionsByGuancha(guancha) {
  // [JIWANG 2026-09-01] 过程结果选项随「观察」联动：
  //   观察名含「结果」→ 仅 结果为正/结果为负；含「过程」→ 仅 过程递增/过程递减；其它（含未选）回退全部四项。
  if (guancha && guancha.includes('结果')) return resultGuochengOptions;
  if (guancha && guancha.includes('过程')) return processGuochengOptions;
  return allGuochengOptions;
}
function onGuanchaChange() {
  // [JIWANG 2026-09-01] 过程结果随观察联动：结果类观察只给正/负，过程类观察只给递增/递减
  guochengOptions.value = getGuochengOptionsByGuancha(form.guancha);
  // 切换观察后，若已选过程结果不在新选项内则清空，避免串档保存
  if (form.guochengJieguo && guochengOptions.value.indexOf(form.guochengJieguo) < 0) {
    form.guochengJieguo = '';
  }
}
function onJielunChange() {
  const v = form.jielun;
  if (v === '出手') chushouOptions.value = ['出手对了', '出手错了'];
  else if (v === '空仓') chushouOptions.value = ['空仓对了', '空仓错了'];
  else chushouOptions.value = allChushouOptions;
}

function closeModal() { modalActive.value = false; }

async function save() {
  const diezhangValue = form.diezhang === '其它' ? form.diezhangOther : form.diezhang;
  const whoIncreaseValue = form.jujiao === '谁增做谁' ? form.whoIncrease : '';
  const stats = getStats();
  // [A7-04/A7-05] 不原地改 getJiwangData() 内部 stats 对象，改用副本组装
  const newStats = { ...stats, sectorEtf: form.sectorEtf };

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
    stats: newStats
  };
  // [A7-02] 经 Logic 层受控写入（内部完成 markJiwangDirty），UI 不再直写 Data 对象
  saveJiwangData(uiStore.currentDate, d);
  _dbgLog('saveJiwang: 保存 ' + uiStore.currentDate + ' 到内存, data=' + JSON.stringify(d).slice(0, 300));
  // [A7-06] 只保存 jiwang 模块：pushJiwangNow 仅推送 jiwang 且自带成功/失败 toast，
  // 不再调用全应用级 saveData()（粗粒度全应用同步）。
  await pushJiwangNow(uiStore.currentDate, '✅ 记忘看板已保存并同步到云端');
  render();
  closeModal();

  autoCalculateRecentMultiScore();
  autoCalculateConsecutiveDays();
  renderConsecutiveUp();
}

defineExpose({ render, openEdit, closeModal, save, formatAmount, getNthPreviousTradingDay, getKxianTypeByClose, getPrevDayMultiBoardClose });
</script>
