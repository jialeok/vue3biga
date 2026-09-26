<!--
  DecisionRulesHint.vue — 「决策」看板的灰色小问号 + 规则说明（点开 / 再点收起）

  [2026-09-26] 开合状态改为【受控】：open 由父级（useDecisionBoard 的 rulesOpen）持有。
    为什么要上提：用户要求「点看板条的小三角收起看板时，问号说明板也一起收起、说明文字一起消失」
    —— 这需要【父级能关掉它】，所以开合真相必须放在父级父子都能摸到的地方。
    ⛔ 组件内不再自己留一份 ref：父子各存一份必然出现「父关了、子还开着」的分叉（§6）。
    §34 它依然只是【纯 UI 态】：不进 store、不落 localStorage（默认收起、无记忆）。

  规则文案由 props 传入（数组，一行一条）—— ⛔ 不在本组件里硬编码业务规则：
  规则归 logic/decision/decision-rules.js，文案与常量都从那里派生，避免两处分叉。
-->
<template>
  <span class="dcb-rules">
    <span
      class="dcb-rules-q"
      title="点击查看决策规则"
      @click.stop="emit('update:open', !open)"
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
defineProps({
  lines: {
    type: Array,
    default: () => []
  },
  /** 受控开合：真相在父级（useDecisionBoard#rulesOpen） */
  open: {
    type: Boolean,
    default: false
  }
});

const emit = defineEmits(['update:open']);
</script>
