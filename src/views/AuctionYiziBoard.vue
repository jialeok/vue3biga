<!--
  AuctionYiziBoard.vue — 「竞价一字」看板（独立看板组件，§15 独立业务模块，不与涨跌停/早盘竞价/情绪看板混用）

  需求对应（用户原话要点）：
    · 位置：涨跌停看板【下方】、早盘竞价看板【上方】（见 views/DashboardView.vue 挂载顺序）
    · 数据：猫抓数据【另一只小号】的 daily_auc_fd（竞价一字）接口
    · 定时：每交易日【北京 09:25】自动抓取（函数内部轮询截止 09:25:55，绝不越过 09:26），
           走 Supabase（独立 Edge Function auction-yizi-fetch + 独立 pg_cron）
    · 独立：独立函数 / 独立令牌 / 独立 key / 独立表 auction_yizi / 独立日志，绝不与既有看板混用
    · 布局：与「涨跌停」看板基本一致（题材分块 + 题材条 + 股票行 + 列图例 + 开关 + 导入入口）
    · 题材：接口自带 开盘啦(theme_names_kpl) → 选股宝(theme_names_xgb) → 共享题材库 stock_topics
           → 无（显示 '-'，可用「无题材」开关筛出后手动导入，与涨跌停看板同一份共享库）
    · 封单额：只看 9:20 与 9:25 两个时点（「9点25」开关切换，**默认关 = 9:20**）；
             9:15 不再作为独立展示时点。口径见 logic/yizi/model.js 第二节。
             · 未打开 = 9:20 口径：度量列 `封单额(9:20) · 十日涨幅`，行内时点标 `9:20`
             · 打开   = 9:25 口径：度量列 `变化(较9:20) · 封单额(9:25)`，行内时点标 `9:25`，
                       且**隐藏十日涨幅**；变化量增红 / 减绿
                       （9:20~9:25 不可撤单，这段里加单 = 抢筹坚决、撤单 = 次日易开板）
    · 一字判据：9:25 竞价涨幅 ≈ 涨停幅度（= 「一字就是涨停」）——
             与「早盘竞价看板」的红线下划线共用 logic/auction/limit-up.js#isAuctionYiZi。
             口径不符的行会被剔除，且剔除只数如实提示（⛔ 不静默丢）。
    · 排序/龙头：块内按【十日涨幅】降序，第一名 = 该题材龙头（与涨跌停看板同一口径）
    · 连板标：首板 / 二板 / 三板…（读涨跌停池 T-1 连板数 +1）
    · 行内时点标：股票名后面显示【当前时点】9:20 / 9:25（不再是首封时刻 09:15 —— 用户明确要求）；
                 首封时刻降级为悬停提示（title），信息不丢
    · ST：本看板【不出现】ST 股票（剔除只数会在看板上如实提示）
    · 导入题材：只写共享题材库 stock_topics，⛔ 不会增减本看板的股票只数

  分层：本文件只有模板与调用；全部业务在 logic/yizi/*，数据在 data/auction-yizi.js。
-->
<template>
  <div
    class="yizi-board trading-day-element"
    :class="{ minimized: !expanded }"
  >
    <div
      class="yizi-header"
      @click="toggleExpand"
    >
      <span class="yizi-title">竞价一字</span>
      <span class="yizi-summary">{{ summaryText }}</span>
      <span
        class="yizi-import-entry"
        title="手动粘贴导入题材（写入共享题材库，与涨跌停 / 早盘竞价看板互通）"
        @click.stop="openImport"
      >导入题材</span>
      <span class="yizi-toggle-btn">{{ toggleArrow }}</span>
    </div>

    <div
      v-show="expanded"
      class="yizi-content"
    >
      <div
        v-if="state.error"
        class="yizi-error"
      >
        {{ state.error }}（<span
          class="yizi-retry"
          @click.stop="refresh"
        >重试</span>）
      </div>
      <div
        v-if="!state.topicLibraryReady"
        class="yizi-warn"
      >
        题材库未就绪，题材分组可能不完整（<span
          class="yizi-retry"
          @click.stop="refresh"
        >重试</span>）
      </div>
      <div
        v-if="state.rangeError"
        class="yizi-warn"
      >
        {{ state.rangeError }}
      </div>

      <!-- 空态：唯一出口走 emptyText（区分「正在加载这一天」/「等到 9:25」/「这一天确实没有」）。
           ⛔ 日期未对齐时绝不渲染另一天的行 —— 那是把上一天的一字池冒充成这一天。 -->
      <div
        v-if="!hasAnyData"
        class="yizi-empty"
      >
        {{ emptyText }}
      </div>

      <template v-else>
        <!-- 题材来源提示：只在「有票靠共享库兜底」或「完全没题材」时出现（用户需要动手补题材的信号） -->
        <div
          v-for="hint in themeHints"
          :key="hint"
          class="yizi-warn"
        >
          {{ hint }}
        </div>
        <div
          v-if="rangeHint"
          class="yizi-warn"
        >
          {{ rangeHint }}
        </div>
        <div
          v-if="stHint"
          class="yizi-note"
        >
          {{ stHint }}
        </div>
        <!-- 一字口径剔除提示：把「表里有多少行被按判据剔掉」如实说出来 ——
             ⛔ 不提示的话，用户只会看到「今天只有 8 只」而不知道另外 113 行为什么不见了。 -->
        <div
          v-if="yiziFilterHint"
          class="yizi-note"
        >
          {{ yiziFilterHint }}
        </div>
        <!-- ★ 需求 1（2026-09-18）：题材自动回填提示。
             本看板的接口自带题材，加载时会「只补空缺」写进共享题材库 ——
             用户看到这条就知道「涨跌停看板不用再手动导入了」，而不是靠猜。 -->
        <div
          v-if="topicAutoFillHint"
          class="yizi-note"
        >
          {{ topicAutoFillHint }}
        </div>
        <!-- ★ 趋势（近5日折线）的板级提示（唯一出口）：
             · 接口/读库失败 → 红字警告（§10：失败必须可见，⛔ 不静默成「没有历史」）；
             · 本轮的说明（缓存已齐 / 9:25 保护窗口内不补拉 / 某条腿补拉失败）→ 灰底说明。
             ⛔ 不在每个展开面板里重复打印同一句话（8 个面板 = 8 遍噪声）。 -->
        <div
          v-if="trendErrorText"
          class="yizi-error"
        >
          {{ trendErrorText }}
        </div>
        <div
          v-else-if="trendNoteText"
          class="yizi-note"
        >
          {{ trendNoteText }}
        </div>

        <!-- 开关条：「9点25」封单额时点 + 「无题材」过滤。
             两者都是纯展示态：默认关、无记忆、随日期切换归位；⛔ 不落 localStorage、不进全局 store。
             ★ 默认关 = 9:20 口径（度量列含十日涨幅）；打开 = 9:25 口径（变化量 + 9:25 封单额，隐藏十日涨幅）。
             ★ 开关旁【只留一个「9点25」】——「现在是哪个时点」由右侧表头 + 行内时点标呈现，
               不再在开关旁并排写第二个时点（并排出现会让人以为是两个开关）。 -->
        <div class="yizi-toolbar">
          <div class="yizi-toggle-item">
            <span class="yizi-toggle-label">9点25</span>
            <label
              class="yizi-toggle-switch"
              :title="show925
                ? '已打开：显示 9:25 口径（fa_0925l 末笔）+ 9:25 对比 9:20 的封单额变化量（增红/减绿），并隐藏十日涨幅。'
                : '未打开：显示 9:20 口径（fa_0920f 首笔）+ 十日涨幅。打开则改为 9:25 口径与变化量。'"
            >
              <input
                type="checkbox"
                :checked="show925"
                @change="toggle925"
              >
              <span class="yizi-toggle-slider" />
            </label>
          </div>
          <div
            v-if="noTopicAvailable"
            class="yizi-toggle-item"
          >
            <span class="yizi-toggle-label">无题材</span>
            <label class="yizi-toggle-switch">
              <input
                type="checkbox"
                :checked="noTopicView"
                @change="toggleNoTopic"
              >
              <span class="yizi-toggle-slider" />
            </label>
          </div>
        </div>

        <template
          v-for="sec in sections"
          :key="sec.key"
        >
          <div class="yizi-section">
            <div class="yizi-section-title">
              {{ sec.title }}
              <span class="yizi-section-count">{{ sec.count }}只</span>
            </div>

            <div
              v-if="sec.count === 0"
              class="yizi-empty"
            >
              当日无一字涨停
            </div>
            <div
              v-else-if="sec.blocks.length === 0"
              class="yizi-empty"
            >
              {{ sec.emptyText }}
            </div>

            <template v-else>
              <!-- 列图例（9px 单行，只为说明列义；本身不占宽度，宽度都让给题材列）。
                   度量列表头随 toggle 切换：未打开 `封单额(9:20) · 十日涨幅`
                   / 打开 `变化(较9:20) · 封单额(9:25)`。开关旁不重复写时点。 -->
              <div class="yizi-head-row">
                <span class="yizi-head-seq">#</span>
                <span class="yizi-head-name">股票 / 时点 / 连板</span>
                <span class="yizi-head-topics">题材（全部，逗号分隔）</span>
                <span class="yizi-head-metric">{{ metricHeadText }}</span>
              </div>

              <div
                v-for="block in sec.blocks"
                :key="sec.key + '-' + block.topic"
                class="yizi-topic-group"
              >
                <div class="yizi-topic-bar">
                  <span class="yizi-topic-name">【{{ block.topic }}】</span>
                  <span class="yizi-topic-count">{{ block.count }}只</span>
                </div>

                <template
                  v-for="stock in block.stocks"
                  :key="block.topic + '-' + stock.stock"
                >
                  <div
                    class="yizi-row"
                    :class="{ 'is-leader': stock.isLeader }"
                  >
                    <!-- 序号 = 趋势面板开关（与早盘竞价看板同一交互：点序号展开）
                         ★ 2026-09-18：用户要求「和早盘竞价看板一样，点击可以展开」。 -->
                    <span
                      class="yizi-seq is-clickable"
                      title="点击展开该股近 5 日趋势（竞价量 / 昨日成交量 / 竞价涨幅 / 涨幅）"
                      @click.stop="toggleYiziTrend(stock.stock)"
                    >{{ trendExpanded.has(stock.stock) ? '▼' : '▶' }}{{ stock.seq }}</span>
                    <!-- 名称块 = 股票名 → 时点标(9:20/9:25) → 龙头标 → 连板标，四段紧贴、整体不换行。
                         标一律 9px 小字（与涨跌停看板 .limit-leader-badge / .limit-continue-tag 同级占位），
                         宽度随内容伸缩、不占固定列 —— 省下的宽度全部留给右侧题材列。 -->
                    <span class="yizi-name-block">
                      <span
                        class="yizi-name"
                        :class="{ leader: stock.isLeader }"
                        :title="stock.themeSource ? ('题材来源：' + stock.themeSourceLabel) : ''"
                      >{{ stock.stock }}</span>
                      <!-- 行内时点标（★ 2026-09-18 起 = 【当前时点】9:20 / 9:25，不再是首封时刻）。
                           用户原话：「9:25分对应的竞价时间点（现在打开只显示9:15分，
                           没打开9点25toggle时应该显示的是9:20）」。
                           首封时刻没有丢 —— 它挪进了悬停提示（title），信息不丢、不占宽度。 -->
                      <span
                        class="yizi-time-tag"
                        :title="'当前显示的是 ' + pointTagText + ' 时点数据' +
                          (firstTimeText(stock) ? ('；该股首次封上涨停价 ' + firstTimeText(stock)) : '')"
                      >{{ pointTagText }}</span>
                      <span
                        v-if="stock.isLeader"
                        class="yizi-leader-badge"
                        title="本题材内十日涨幅最高 → 该题材龙头"
                      >龙头</span>
                      <span
                        v-if="continueText(stock)"
                        class="yizi-continue-tag"
                        title="连板档位（按前一交易日连续涨停数递推）"
                      >{{ continueText(stock) }}</span>
                    </span>
                    <!-- 题材（主角列）：完整展示、允许折行，⛔ 不做省略号截断 -->
                    <span
                      class="yizi-topics"
                      :title="stock.themeSource ? ('题材来源：' + stock.themeSourceLabel) : '题材来源：无（可手动导入）'"
                    >{{ stock.topicsDisplay }}</span>
                    <!-- 度量列：封单额（按时点开关切换）+ 十日涨幅（块内排序 / 龙头判据） -->
                    <span class="yizi-metric">
                      <!-- 打开「9点25」态：先显示【变化量】（9:25 − 9:20，增红 / 减绿），
                           再显示 9:25 封单额，并【隐藏十日涨幅】（★ 用户指定）。
                           9:20~9:25 是不可撤单阶段，这段里加单还是撤单 = 一字板硬度最直接的信号。 -->
                      <span
                        v-if="show925"
                        class="yizi-delta"
                        :class="sealDeltaClass(stock)"
                        :title="sealDeltaTitle(stock)"
                      >{{ sealDeltaText(stock) }}</span>
                      <span
                        class="yizi-seal"
                        :class="sealClass(stock)"
                        :title="sealTitle(stock)"
                      >{{ sealText(stock) }}</span>
                      <!-- 十日涨幅：仅【未打开】时显示。⚠️ 它始终是块内排序与龙头判据（与是否显示无关）。 -->
                      <span
                        v-if="!show925"
                        class="yizi-range"
                        :class="rangeClass(stock)"
                        title="近 10 个交易日区间涨幅（块内排序 / 龙头判据）"
                      >{{ rangeText(stock) }}</span>
                    </span>
                  </div>

                  <!-- ================= 趋势面板（★ 2026-09-18 新增）=================
                       与「早盘竞价看板」同形：顶部一行当前值汇总（含十日涨幅），下面 4 张近 5 日折线。
                       ⛔ 数据通道完全独立：Edge /trend（竞价一字小号），与早盘竞价的 numcat-proxy 无关。
                       §34：面板本身是纯展示，所有数值都由 Logic 纯函数算好（composable 的 trendMap）。
                       §26：trendExpanded 随日期切换归位；trendMap 仅在「日期对齐」时才有内容。 -->
                  <div
                    v-if="trendExpanded.has(stock.stock)"
                    class="yizi-trend-panel"
                    @dblclick.stop
                  >
                    <div class="yizi-trend-metrics">
                      <!-- 十日涨幅 = 该行既有字段（stock_range_pct），不是趋势缓存的一部分；
                           色调与行内度量列同源（rangeClass / rangeText）→ 两处永远一致。 -->
                      <span class="yizi-trend-metric-item">
                        <b>十日涨幅</b>：<span :class="rangeClass(stock)">{{ rangeText(stock) }}</span>
                      </span>
                      <span
                        v-for="m in trendMetrics(stock.stock)"
                        :key="m.label"
                        class="yizi-trend-metric-item"
                      ><b>{{ m.label }}</b>：{{ m.value }}</span>
                    </div>

                    <!-- 加载中：只在「这一天的趋势还没到」时显示（已有缓存 = 立刻出图，不闪） -->
                    <div
                      v-if="trendLoading && trendEmpty(stock.stock)"
                      class="yizi-trend-loading"
                    >
                      加载中…（正在取近 5 日趋势）
                    </div>
                    <!-- 一条数据都没有：给一句说明，⛔ 不画 4 张全是 '--' 的空图 -->
                    <div
                      v-else-if="trendEmpty(stock.stock)"
                      class="yizi-trend-empty"
                    >
                      {{ trendLoading ? '加载中…' : '近 5 日暂无趋势数据（9:25 抓取完成后自动补）' }}
                    </div>

                    <template v-else>
                      <div class="yizi-trend-chart-item">
                        <div class="yizi-trend-chart-label">
                          竞价量(万) 近5日
                        </div>
                        <TrendChart
                          :points="trendMap[stock.stock].volume"
                          color="#6366f1"
                        />
                      </div>
                      <div
                        v-if="trendHasLeg(stock.stock, 'yestVolume')"
                        class="yizi-trend-chart-item"
                      >
                        <div class="yizi-trend-chart-label">
                          昨日成交量(万) 近5日
                        </div>
                        <TrendChart
                          :points="trendMap[stock.stock].yestVolume"
                          color="#10b981"
                        />
                      </div>
                      <div
                        v-if="trendHasLeg(stock.stock, 'aucPctChg')"
                        class="yizi-trend-chart-item"
                      >
                        <div class="yizi-trend-chart-label">
                          竞价涨幅(%) 近5日
                        </div>
                        <TrendChart
                          :points="trendMap[stock.stock].aucPctChg"
                          color="#f59e0b"
                          :percent="true"
                        />
                      </div>
                      <div
                        v-if="trendHasLeg(stock.stock, 'changePct')"
                        class="yizi-trend-chart-item"
                      >
                        <div class="yizi-trend-chart-label">
                          涨幅(%) 近5日
                        </div>
                        <TrendChart
                          :points="trendMap[stock.stock].changePct"
                          color="#64748b"
                          :percent="true"
                        />
                      </div>
                    </template>
                  </div>
                </template>
              </div>
            </template>
          </div>
        </template>
      </template>
    </div>

    <EditModal
      v-model="importOpen"
      title="粘贴导入题材"
      :saving="importSaving"
      save-text="导入"
      @save="doImport"
    >
      <div class="yizi-import-hint">
        每行一只股票：<b>股票名 [代码] 题材1 题材2 …</b><br>
        支持空格 / 逗号 / 顿号 / 竖线 分隔；同一股票多行会合并去重；<br>
        写入后与涨跌停看板、早盘竞价看板<b>共享同一题材库</b>（三看板互通）；<br>
        导入的题材会在「接口未返回题材」时自动作为该股题材来源（优先级排在接口之后）。<br>
        <b>⚠️ 导入题材只写题材库，<u>不会增减本看板的股票只数</u></b>（只数只由「竞价一字」抓取结果决定）。
      </div>
      <textarea
        v-model="importText"
        class="yizi-import-textarea"
        rows="10"
        placeholder="兆易创新 600000 存储芯片,AI应用"
      />
      <div
        v-if="importResult"
        class="yizi-import-result"
      >
        {{ importResult }}
      </div>
    </EditModal>
  </div>
</template>

<script setup>
import EditModal from '../components/EditModal.vue';
// 趋势曲线：与「早盘竞价看板」同一个展示组件（纯 SVG 折线，props: points/color/percent）
import TrendChart from '../components/TrendChart.vue';
import { useAuctionYizi } from '../composables/useAuctionYizi.js';

const {
  state,
  expanded,
  toggleArrow,
  hasAnyData,
  summaryText,
  emptyText,
  themeHints,
  topicAutoFillHint,
  rangeHint,
  stHint,
  yiziFilterHint,
  sections,
  noTopicAvailable,
  noTopicView,
  toggleNoTopic,
  show925,
  pointTagText,
  metricHeadText,
  toggle925,
  sealDeltaText,
  sealDeltaClass,
  sealDeltaTitle,
  importOpen,
  importText,
  importSaving,
  importResult,
  toggleExpand,
  refresh,
  openImport,
  doImport,
  sealText,
  sealClass,
  sealTitle,
  rangeText,
  rangeClass,
  continueText,
  firstTimeText,
  trendExpanded,
  trendMap,
  trendLoading,
  trendErrorText,
  trendNoteText,
  trendMetrics,
  trendHasLeg,
  trendEmpty,
  toggleYiziTrend
} = useAuctionYizi();

defineExpose({ refresh });
</script>
