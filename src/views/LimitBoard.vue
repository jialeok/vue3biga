<!--
  LimitBoard.vue — 「涨跌停」看板（独立看板组件，§15 独立业务模块，不与早盘竞价/情绪看板混用）

  需求对应：
    · 每个交易日收盘后 15:40 自动抓取同花顺涨停板 / 跌停板（Supabase Edge Function limit-pool-fetch + pg_cron；前端打开看板时自愈补齐）
    · 单页；股票按题材分类（复用早盘竞价「题材 toggle」同一套分组/组序口径）
    · 上=跌停板，下=涨停板，中间用蚂蚁线分隔
    · 题材条：只有「题材名称 + 题材数量」——⛔ 不再带十日涨幅（每只股票行尾已各自标了十日涨幅，
      题材条上再标一次纯属冗余，删掉后题材条更短更清爽）
    · 股票行：序号 + [股票名称 + 龙头小标 + 连板小标] + 题材 + 十日涨幅；十日涨幅最高者为龙头
    · 空间优先（2026-09-17 改版）：所有标一律 9px 小字、紧贴股票名（参照早盘竞价看板的
      龙一/龙二徽章与连板小标），龙头标放在【股票名称之后】；题材是主角列 —— 吃满剩余宽度、
      用英文逗号分隔、允许折行、完整展示，⛔ 不再用省略号截断
    · 「无题材」开关（默认关、无记忆）：只显示没有题材的股票，便于截图后统一补题材；
      样式与早盘竞价看板 toggle 同款（28×16 switch），随日期切换自动归位
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
        <!-- ★ 需求 1（2026-09-18）：题材自动回填提示（说明型，不是告警）。
             本看板的题材来自共享题材库；库里的空缺由「竞价一字」接口自动补齐，
             用户看到这条就知道不必再手动粘贴导入了。 -->
        <div
          v-if="topicAutoFillHint"
          class="limit-note"
        >
          {{ topicAutoFillHint }}
        </div>

        <!-- 「无题材」过滤开关（与早盘竞价看板同款紧凑 switch）。默认关、无记忆，
             随日期切换自动归位；题材库未就绪时不可用（§10 未就绪 ≠ 空）。 -->
        <div
          v-if="noTopicAvailable"
          class="limit-toolbar"
        >
          <div class="limit-toggle-item">
            <span class="limit-toggle-label">无题材</span>
            <label class="limit-toggle-switch">
              <input
                type="checkbox"
                :checked="noTopicView"
                @change="toggleNoTopic"
              >
              <span class="limit-toggle-slider" />
            </label>
          </div>
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
            <div
              v-else-if="sec.blocks.length === 0"
              class="limit-empty"
            >
              {{ sec.emptyText }}
            </div>

            <template v-else>
              <!-- 列图例（9px 单行，只为说明列义；本身不占宽度，宽度都让给题材列） -->
              <div class="limit-head-row">
                <span class="limit-head-seq">#</span>
                <span class="limit-head-name">股票 / {{ sec.key === 'up' ? '连板' : '跌停时间' }}</span>
                <span class="limit-head-topics">题材（全部，逗号分隔）</span>
                <span class="limit-head-range">十日涨幅</span>
              </div>

              <div
                v-for="block in sec.blocks"
                :key="sec.key + '-' + block.topic"
                class="limit-topic-group"
              >
                <div class="limit-topic-bar">
                  <span class="limit-topic-name">【{{ block.topic }}】</span>
                  <span class="limit-topic-count">{{ block.count }}只</span>
                </div>

                <div
                  v-for="stock in block.stocks"
                  :key="block.topic + '-' + stock.stock"
                  class="limit-row"
                  :class="{ 'is-leader': stock.isLeader }"
                >
                  <span class="limit-seq">{{ stock.seq }}</span>
                  <!-- 名称块 = 股票名 → 龙头标 → 连板标，三段紧贴、整体不换行。
                       标一律 9px 小字（与早盘竞价看板 .dragon-badge / .auction-streak-tag 同级占位），
                       宽度随内容伸缩、不占固定列 —— 省下的宽度全部留给右侧题材列。
                       名称配色（2026-09-19）：涨停板内一律红、跌停板内一律绿 —— 用 tone-up / tone-down
                       两个既有色调类（与十日涨幅同一套色值），class 只随所在分节走，不新增任何状态。 -->
                  <span class="limit-name-block">
                    <span
                      class="limit-name"
                      :class="[sec.key === 'up' ? 'tone-up' : 'tone-down', { leader: stock.isLeader }]"
                    >{{ stock.stock }}</span>
                    <span
                      v-if="stock.isLeader"
                      class="limit-leader-badge"
                      title="本题材内十日涨幅最高 → 该题材龙头"
                    >龙头</span>
                    <span
                      v-if="continueText(stock)"
                      class="limit-continue-tag"
                      :title="sec.key === 'up' ? '连板' : '首次跌停时间'"
                    >{{ continueText(stock) }}</span>
                  </span>
                  <!-- 题材（主角列）：完整展示、允许折行，⛔ 不做省略号截断 -->
                  <span class="limit-topics">{{ stock.topicsDisplay }}</span>
                  <span
                    class="limit-range"
                    :class="rangeClass(stock)"
                  >{{ rangeText(stock) }}</span>
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

const {
  state,
  expanded,
  toggleArrow,
  hasAnyData,
  summaryText,
  fetchTimeHint,
  topicAutoFillHint,
  rangeHint,
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
  rangeText,
  rangeClass,
  continueText
} = useLimitBoard();

defineExpose({ refresh });
</script>
