<!--
  DecisionRulesHint.vue — 「决策」看板的灰色小问号 + 规则说明（点开 / 再点收起）

  §34 纯 UI 状态（open）放在本组件自己身上：它是「点一下出现、再点一下消失」的
  一次性说明，不进 store、不落 localStorage，天然满足「默认收起、无记忆」。

  规则文案由 props 传入（数组，一行一条）—— ⛔ 不在本组件里硬编码业务规则：
  规则归 logic/decision/decision-rules.js，文案与常量都从那里派生，避免两处分叉。
-->
<template>
  <span class="dcb-rules">
    <span
      class="dcb-rules-q"
      title="点击查看决策规则"
      @click.stop="open = !open"
    >?</span>
    <div
      v-show="open"
      class="dcb-rules-panel"
    >
      <div
        v-for="(line, i) in lines"
        :key="i"
        class="dcb-rules-line"
      >
        {{ line }}
      </div>
    </div>
  </span>
</template>

<script setup>
import { ref } from 'vue';

defineProps({
  lines: {
    type: Array,
    default: () => []
  }
});

const open = ref(false);
</script>
