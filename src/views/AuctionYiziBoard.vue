<!--
  AuctionYiziBoard.vue — 「竞价一字」看板（独立看板组件，§15 独立业务模块，不与涨跌停/早盘竞价/情绪看板混用）

  需求对应（用户原话要点）：
    · 位置：涨跌停看板【下方】、早盘竞价看板【上方】（见 views/DashboardView.vue 挂载顺序）
    · 数据：猫抓数据【另一只小号】的 daily_auc_fd（竞价一字）接口
    · 定时：每交易日【北京 09:25】自动抓取（函数内部轮询截止 09:25:55，绝不越过 09:26），
           走 Supabase（独立 Edge Function auction-yizi-fetch + 独立 pg_cron）
    · 独立：独立函数 / 独立令牌 / 独立 key / 独立表 auction_yizi / 独立日志，绝不与既有看板混用
    · 布局：与「涨跌停」看板基本一致（题材分块 + 题材条 + 股票行 + 列图例 + 无题材开关 + 导入入口）
    · 题材：接口自带 开盘啦(theme_names_kpl) → 选股宝(theme_names_xgb) → 共享题材库 stock_topics
           → 无（显示 '-'，可用「无题材」开关筛出后手动导入，与涨跌停看板同一份共享库）
    · 一字票按题材分好类；题材按块展示，块内按【9:25 封单额】降序，第一名 = 该题材龙头

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
        v-if="state.loading && !hasAnyData"
        class="yizi-empty"
      >
        加载中…
      </div>
      <div
        v-else-if="!hasAnyData"
        class="yizi-empty"
      >
        {{ fetchTimeHint || '暂无竞价一字数据' }}
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

        <!-- 「无题材」过滤开关（与早盘竞价 / 涨跌停看板同款紧凑 switch）。默认关、无记忆，
             随日期切换自动归位；题材库未就绪时不可用（§10 未就绪 ≠ 空）。 -->
        <div
          v-if="noTopicAvailable"
          class="yizi-toolbar"
        >
          <div class="yizi-toggle-item">
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
              <!-- 列图例（9px 单行，只为说明列义；本身不占宽度，宽度都让给题材列） -->
              <div class="yizi-head-row">
                <span class="yizi-head-seq">#</span>
                <span class="yizi-head-name">股票 / 首封</span>
                <span class="yizi-head-topics">题材（全部，逗号分隔）</span>
                <span class="yizi-head-metric">封单额 / 竞价</span>
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

                <div
                  v-for="stock in block.stocks"
                  :key="block.topic + '-' + stock.stock"
                  class="yizi-row"
                  :class="{ 'is-leader': stock.isLeader }"
                >
                  <span class="yizi-seq">{{ stock.seq }}</span>
                  <!-- 名称块 = 股票名 → 龙头标 → ST标 → 首封时刻标，四段紧贴、整体不换行。
                       标一律 9px 小字（与早盘竞价看板 .dragon-badge / 涨跌停看板 .limit-leader-badge 同级占位），
                       宽度随内容伸缩、不占固定列 —— 省下的宽度全部留给右侧题材列。 -->
                  <span class="yizi-name-block">
                    <span
                      class="yizi-name"
                      :class="{ leader: stock.isLeader }"
                      :title="stock.themeSource ? ('题材来源：' + stock.themeSourceLabel) : ''"
                    >{{ stock.stock }}</span>
                    <span
                      v-if="stock.isLeader"
                      class="yizi-leader-badge"
                      title="本题材内 9:25 封单额最大 → 该题材龙头"
                    >龙头</span>
                    <span
                      v-if="stock.stTag"
                      class="yizi-st-tag"
                      title="ST 股票（涨停幅度 5%，仍属一字）"
                    >ST</span>
                    <span
                      v-if="stock.faFirst"
                      class="yizi-fa-tag"
                      :title="'首次封上涨停价的时刻（有封单证据的时点共 ' + stock.faCount + ' 个）'"
                    >{{ stock.faFirst }}</span>
                  </span>
                  <!-- 题材（主角列）：完整展示、允许折行，⛔ 不做省略号截断 -->
                  <span
                    class="yizi-topics"
                    :title="stock.themeSource ? ('题材来源：' + stock.themeSourceLabel) : '题材来源：无（可手动导入）'"
                  >{{ stock.topicsDisplay }}</span>
                  <!-- 度量列：封单额（主，块内排序依据）+ 竞价涨幅（次） -->
                  <span class="yizi-metric">
                    <span
                      class="yizi-seal"
                      :class="'yizi-seal-' + stock.sealTone"
                      :title="'9:25 口径封单额（块内排序依据）'"
                    >{{ sealText(stock) }}</span>
                    <span
                      class="yizi-auc"
                      :class="'yizi-auc-' + stock.aucTone"
                      title="竞价涨幅"
                    >{{ aucText(stock) }}</span>
                  </span>
                </div>
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
        导入的题材会在「接口未返回题材」时自动作为该股题材来源（优先级排在接口之后）。
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
import { useAuctionYizi } from '../composables/useAuctionYizi.js';

const {
  state,
  expanded,
  toggleArrow,
  hasAnyData,
  summaryText,
  fetchTimeHint,
  themeHints,
  sections,
  noTopicAvailable,
  noTopicView,
  toggleNoTopic,
  importOpen,
  importText,
  importSaving,
  importResult,
  toggleExpand,
  refresh,
  openImport,
  doImport,
  aucText,
  sealText
} = useAuctionYizi();

defineExpose({ refresh });
</script>
