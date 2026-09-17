<!--
  LimitBoard.vue — 「涨跌停」看板（独立看板组件，§15 独立业务模块，不与早盘竞价/情绪看板混用）

  需求对应：
    · 每个交易日收盘后 15:40 自动抓取同花顺涨停板 / 跌停板（Supabase Edge Function limit-pool-fetch + pg_cron；前端打开看板时自愈补齐）
    · 单页、无 toggle；股票按题材分类（复用早盘竞价「题材 toggle」同一套分组/组序口径）
    · 上=跌停板，下=涨停板，中间用蚂蚁线分隔
    · 题材条：题材名称 + 题材数量 + 十日涨幅（该题材龙头股的十日涨幅）
    · 股票行：序号 + 股票名称 + 连板（首板/二板…）+ 题材 + 十日涨幅；十日涨幅最高者为龙头（红标）
    · 手动粘贴导入题材的后台入口（写入【共享题材库】，与早盘竞价看板互通）

  分层：本文件只有模板与调用；全部业务在 logic/limitpool/*，数据在 data/limit-pool.js。
-->
<template>
  <div
    class="limit-board trading-day-element"
    :class="{ minimized: !expanded }"
  >
    <div
      class="limit-header"
      @click="toggleExpand"
    >
      <span class="limit-title">涨跌停</span>
      <span class="limit-summary">{{ summaryText }}</span>
      <span
        class="limit-import-entry"
        title="手动粘贴导入题材（与早盘竞价看板共享同一题材库）"
        @click.stop="openImport"
      >导入题材</span>
      <span class="limit-toggle-btn">{{ toggleArrow }}</span>
    </div>

    <div
      v-show="expanded"
      class="limit-content"
    >
      <div
        v-if="state.error"
        class="limit-error"
      >
        {{ state.error }}（<span
          class="limit-retry"
          @click.stop="refresh"
        >重试</span>）
      </div>
      <div
        v-if="!state.topicLibraryReady"
        class="limit-warn"
      >
        题材库未就绪，题材分组可能不完整（<span
          class="limit-retry"
          @click.stop="refresh"
        >重试</span>）
      </div>
      <div
        v-if="state.rangeError"
        class="limit-warn"
      >
        {{ state.rangeError }}
      </div>

      <div
        v-if="state.loading && !hasAnyData"
        class="limit-empty"
      >
        加载中…
      </div>
      <div
        v-else-if="!hasAnyData"
        class="limit-empty"
      >
        {{ fetchTimeHint || '暂无涨跌停数据' }}
      </div>

      <template v-else>
        <div
          v-if="rangeHint"
          class="limit-warn"
        >
          {{ rangeHint }}
        </div>

        <template
          v-for="(sec, si) in sections"
          :key="sec.key"
        >
          <!-- 蚂蚁线：跌停板与涨停板之间的分隔 -->
          <div
            v-if="si > 0"
            class="limit-antline"
            role="separator"
          />

          <div class="limit-section">
            <div
              class="limit-section-title"
              :class="sec.key"
            >
              {{ sec.title }}
              <span class="limit-section-count">{{ sec.count }}只</span>
            </div>

            <div
              v-if="sec.count === 0"
              class="limit-empty"
            >
              当日无{{ sec.key === 'down' ? '跌停' : '涨停' }}
            </div>

            <template v-else>
              <div class="limit-head-row">
                <span style="flex:0 0 16px;text-align:center">#</span>
                <span style="flex:0 0 66px">股票名称</span>
                <span style="flex:0 0 46px">{{ sec.key === 'up' ? '连板' : '跌停时间' }}</span>
                <span style="flex:1">题材</span>
                <span style="flex:0 0 82px;text-align:right">十日涨幅</span>
              </div>

              <div
                v-for="block in sec.blocks"
                :key="sec.key + '-' + block.topic"
                class="limit-topic-group"
              >
                <div class="limit-topic-bar">
                  <span class="limit-topic-name">【{{ block.topic }}】</span>
                  <span class="limit-topic-count">{{ block.count }}只</span>
                  <span
                    class="limit-topic-range"
                    :class="toneClass(block.leaderPct)"
                  >
                    <span
                      v-if="block.hasLeader"
                      class="limit-topic-range-lb"
                    >龙头 {{ block.leaderStock }}</span>
                    十日 {{ formatRangePctText(block) }}
                  </span>
                </div>

                <div
                  v-for="stock in block.stocks"
                  :key="block.topic + '-' + stock.stock"
                  class="limit-row"
                  :class="{ 'is-leader': stock.isLeader }"
                >
                  <span class="limit-seq">{{ stock.seq }}</span>
                  <span
                    class="limit-name"
                    :class="{ leader: stock.isLeader }"
                  >{{ stock.stock }}</span>
                  <span class="limit-continue">{{ continueText(stock) }}</span>
                  <span class="limit-topics">{{ topicsText(stock) }}</span>
                  <span
                    class="limit-range"
                    :class="rangeClass(stock)"
                  >{{ rangeText(stock) }}</span>
                  <span
                    v-if="stock.isLeader"
                    class="limit-leader-badge"
                  >龙头</span>
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
      <div class="limit-import-hint">
        每行一只股票：<b>股票名 [代码] 题材1 题材2 …</b><br>
        支持空格 / 逗号 / 顿号 / 竖线 分隔；同一股票多行会合并去重；<br>
        写入后与早盘竞价看板<b>共享同一题材库</b>（两看板互通）。
      </div>
      <textarea
        v-model="importText"
        class="limit-import-textarea"
        rows="10"
        placeholder="兆易创新 600000 存储芯片,AI应用"
      />
      <div
        v-if="importResult"
        class="limit-import-result"
      >
        {{ importResult }}
      </div>
    </EditModal>
  </div>
</template>

<script setup>
import EditModal from '../components/EditModal.vue';
import { useLimitBoard } from '../composables/useLimitBoard.js';
import { formatRangePct } from '../logic/limitpool/model.js';

const {
  state,
  expanded,
  toggleArrow,
  hasAnyData,
  summaryText,
  fetchTimeHint,
  rangeHint,
  sections,
  importOpen,
  importText,
  importSaving,
  importResult,
  toggleExpand,
  refresh,
  openImport,
  doImport,
  rangeText,
  rangeClass,
  toneClass,
  continueText,
  topicsText
} = useLimitBoard();

// 题材条上的十日涨幅（该题材龙头的十日涨幅）
function formatRangePctText(block) {
  return formatRangePct(block.leaderPct, block.leaderDays);
}

defineExpose({ refresh });
</script>
