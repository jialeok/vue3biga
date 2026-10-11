<!--
  TvrbRulesHint.vue — 「题材量比」看板的灰色小问号 + 规则说明（点开 / 再点收起）

  与决策看板的 DecisionRulesHint 同款交互（受控开合 + 一键复制），但【类名与组件完全独立】：
  前缀 tvrb-（⛔ 不蹭 dcb- / decision-），任何一边改版都不会悄悄影响另一边。

  · 开合状态【受控】：open 由父级（useTopicVolRatioBoard 的 rulesOpen）持有 ——
    用户要求「点看板条的小三角收起看板时，说明板也一起收起」，这需要父级能关掉它；
    ⛔ 组件内不再自己留一份 ref（父子各存一份必然分叉，§6）。
    §34 它依然只是【纯 UI 态】：不进 store、不落 localStorage（默认收起、无记忆）。
  · 规则文案由 props 传入（数组，一行一条）—— ⛔ 不在本组件里硬编码业务规则：
    规则归 logic/topicvolratio/topic-vol-ratio-rules.js（文案与口径同一处，§6）。
  · 「复制」按钮 @click.stop：面板在 .tvrb-header 内，而头部整条是「点一下收起看板」——
    不拦住的话，点复制会顺手把看板连带收起、面板闪一下消失。
-->
<template>
  <span class="tvrb-rules">
    <span
      class="tvrb-rules-q"
      title="点击查看「题材量比」选股规则"
      @click.stop="emit('update:open', !open)"
    >?</span>
    <div
      v-show="open"
      class="tvrb-rules-panel tvrb-selectable"
      @click.stop
    >
      <div class="tvrb-rules-bar">
        <span class="tvrb-rules-bar-title">题材量比 规则</span>
        <span
          class="tvrb-rules-copy"
          title="一键复制全部规则（纯文本，可直接粘贴）"
          @click.stop="onCopy"
        >复制</span>
      </div>
      <div
        v-for="(line, i) in lines"
        :key="i"
        class="tvrb-rules-line"
      >
        {{ line }}
      </div>
    </div>
  </span>
</template>

<script setup>
import { computed } from 'vue';
import { showToast } from '../../composables/useToast.js';
import { joinRulesLines } from '../../logic/decision/decision-rules.js';

const props = defineProps({
  lines: {
    type: Array,
    default: () => []
  },
  /** 受控开合：真相在父级（useTopicVolRatioBoard#rulesOpen） */
  open: {
    type: Boolean,
    default: false
  }
});

const emit = defineEmits(['update:open']);

/** 要复制出去的纯文本（§21：模板不参与计算，这里一次算好）。 */
const copyText = computed(() => joinRulesLines(props.lines));

/** 一键复制全部规则（与 DebugLogModal / DecisionRulesHint 同一套写法：clipboard + Toast 反馈）。 */
function onCopy() {
  const text = copyText.value;
  if (!text) {
    showToast('没有可复制的规则内容');
    return;
  }
  if (!navigator.clipboard || !navigator.clipboard.writeText) {
    showToast('当前环境不支持一键复制，请长按选中文字');
    return;
  }
  navigator.clipboard.writeText(text).then(
    () => {
      showToast('✅ 已复制全部题材量比规则（' + text.split('\n').length + ' 行）');
    },
    () => {
      showToast('复制失败，请长按选中文字手动复制');
    }
  );
}
</script>
