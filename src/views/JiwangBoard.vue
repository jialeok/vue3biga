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
          {{ display.guancha || autoDisplay.guancha || '-' }}
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
          {{ display.guochengJieguo || autoDisplay.guochengJieguo || '-' }}
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
          {{ effJielun || '-' }}
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
          <template v-if="effJielun === '出手'">
            <div class="stamp-text">
              得出结论
            </div><div class="stamp-result">
              出手
            </div>
          </template>
          <template v-else-if="effJielun === '空仓'">
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
// [JIWANG 2026-10-23] 「昨多板K线 → 观察」「9:25/9:20 → 过程结果 + 得出结论」纯逻辑下沉到 Logic 层
import { KXIAN_LOOKBACK_DAYS, GUANCHA_PROCESS, GUANCHA_RESULT, deriveGuanchaByKxian, formatKxianWithPrefix } from '../logic/jiwang/kxian-trend.js';
import { deriveGuochengAndJielun } from '../logic/jiwang/auction-derive.js';
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
const autoDisplay = ref({
  diezhang: '', qingxu: '', kxian: '', kxianPrefix: '',
  guancha: '', guochengJieguo: '', jielun: ''
});

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
  // [JIWANG 2026-10-23 二版] 前缀拼接统一走 logic 层单一出口：
  //   「第一次」⇒ 第一次中阳 2.5%（标记词，不重复 K 线名）
  //   序列前缀 ⇒ 十字星0.5%+小阳1.2%+中阳2.5%
  //   ⛔ 不要在这里自己写 prefix + '+' + k，否则「第一次」会被拼成「第一次+中阳2.5%」
  return formatKxianWithPrefix(d.kxianPrefix || autoDisplay.value.kxianPrefix, k);
});

/**
 * [JIWANG 2026-10-23] 得出结论的【生效值】：库里优先，缺失才用自动值。
 * 印章、配色、样式都跟着它走 —— ⛔ 不许各处各读 display.jielun，否则会出现
 * 「文字写空仓、印章还是黄的问号」这种自相矛盾。
 */
const effJielun = computed(() => display.value.jielun || autoDisplay.value.jielun || '');

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
  const v = effJielun.value;
  if (v === '出手') return 'red-highlight';
  if (v === '空仓') return 'gray-highlight';
  return '';
});

// 印章配色：半透明 rgba，与旧 boards-jiwang.js 的 stamp.style 一致（红/灰/黄）
const stampClass = computed(() => {
  const v = effJielun.value;
  if (v === '出手') return 'red';
  if (v === '空仓') return 'gray';
  return 'yellow';
});

const stampStyle = computed(() => {
  const v = effJielun.value;
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
  // 复用统一取数口（含「空串≠0」的 §10 判定），⛔ 不要再各写一份 parseFloat
  return getMultiBoardCloseOf(prevDate);
}

/**
 * 取「最近多板%」在某天的收盘涨幅（用于算 K 线型态）。
 * ⛔ 缺数 / 空串 / 非数字一律返回 null，绝不返回 0（§10 不拿 0 冒充「收平」）。
 */
function getMultiBoardCloseOf(ymd) {
  const rows = getBiddingData()[ymd];
  if (!Array.isArray(rows)) return null;
  const row = rows.find(r => r && r.name === '最近多板%');
  if (!row) return null;
  const raw = row.close;
  if (raw === null || raw === undefined || raw === '') return null;
  const n = parseFloat(raw);
  return isFinite(n) ? n : null;
}

/**
 * 取「昨多板K线」序列：按时间【倒序】，series[0] = 前一交易日（也就是看板上那条「昨多板K线」），
 * 往后最多再取 days 天，供 kxian-trend 判断「第几次中阳 / 前面几根小阳」。
 *
 * 为什么从「前一交易日」起算而不是当天：看板上的「昨多板K线」讲的就是昨天那根多板K线，
 * 用户口径里的「倒退看昨天是十字星还是阴线」也是相对它而言。
 */
function getMultiBoardKxianSeries(days) {
  const out = [];
  const n = Math.max(0, Number(days) || 0);
  let cur = uiStore.currentDate;
  for (let i = 0; i <= n; i++) {
    const prev = getPreviousTradingDay(cur);
    if (!prev) break;
    const close = getMultiBoardCloseOf(prev);
    out.push({ ymd: prev, label: close === null ? '' : getKxianTypeByClose(close) });
    cur = prev;
  }
  return out;
}

/** 当天「最近多板%」那一行（提供 time920 / time925，竞价变化看板同源，只读不改） */
function getTodayMultiBoardRow() {
  const rows = getBiddingData()[uiStore.currentDate];
  if (!Array.isArray(rows)) return null;
  return rows.find(r => r && r.name === '最近多板%') || null;
}

/**
 * 计算前台「自动补全」的全部值（缺值时才补，已有真值一律以数据库为准）。
 *
 * ① 昨日跌涨 / 昨日情绪 ← 昨收盘结果（跌:涨）        → logic/jiwang/ratio-nodes.js
 * ② 昨多板K线 / 观察 / kxianPrefix ← 最近多板%收盘涨幅序列 → logic/jiwang/kxian-trend.js
 * ③ 过程结果 / 得出结论 ← 最近多板% 的 9:20 / 9:25      → logic/jiwang/auction-derive.js
 *
 * ⛔ 任何一项取不到就留空（前台显示 '-'），绝不用默认值冒充真实判断（§10）。
 * ⛔ 只读不写：本函数不触碰 jiwangData，不 markDirty。
 */
function computeAutoDisplay(d) {
  const out = {
    diezhang: '', qingxu: '', kxian: '', kxianPrefix: '',
    guancha: '', guochengJieguo: '', jielun: ''
  };

  // ① 昨收盘结果 → 跌涨简化比 + 情绪节点
  const derived = deriveFromShougu(d.shouguJieguo);
  if (derived) {
    out.diezhang = derived.diezhang;
    out.qingxu = derived.qingxu;
  }

  // ② 昨多板K线 + 观察（中阳/小阳要看前面几根，所以取序列）
  const series = getMultiBoardKxianSeries(KXIAN_LOOKBACK_DAYS);
  if (!d.kxian && series.length && series[0].label) out.kxian = series[0].label;
  const kres = deriveGuanchaByKxian(series);
  if (kres) {
    out.guancha = kres.guancha;
    out.kxianPrefix = kres.kxianPrefix;
  }

  // ③ 过程结果 + 得出结论
  //   ⚠️ 只在「观察」最终落在【最近多板过程/结果】时才自动填：
  //     若库里人工改成了「板块ETF过程」「两个过程」，这套 9:20/9:25 口径就不适用，宁可留空。
  //   ⚠️ 分支由【实际生效的观察】决定（不是由「是否首次中阳」决定）：
  //     观察=过程 ⇒ 过程递增/递减（看 9:25 vs 9:20）；观察=结果 ⇒ 结果为正/负（看 9:25 vs 0）。
  //     否则小阳判「过程」时会算出「过程结果=结果为正」这种下拉里不存在的组合。
  const effectiveGuancha = d.guancha || out.guancha;
  if (effectiveGuancha === GUANCHA_PROCESS || effectiveGuancha === GUANCHA_RESULT) {
    const row = getTodayMultiBoardRow();
    const res = deriveGuochengAndJielun({
      time920: row ? row.time920 : null,
      time925: row ? row.time925 : null,
      byAuctionTrend: effectiveGuancha === GUANCHA_PROCESS
    });
    if (res) {
      out.guochengJieguo = res.guochengJieguo;
      out.jielun = res.jielun;
    }
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
  form.kxianPrefix = d.kxianPrefix || auto.kxianPrefix || '';
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

  // 观察 / 过程结果 / 得出结论：库里有值就尊重人工填写，为空才用自动推导（用户口径：只补空值）
  form.guancha = d.guancha || auto.guancha || '';
  onGuanchaChange();
  form.guochengJieguo = d.guochengJieguo || auto.guochengJieguo || '';
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

  form.jielun = d.jielun || auto.jielun || '';
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
