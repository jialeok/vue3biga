<!--
  DecisionRulesHint.vue — 「决策」看板的灰色小问号 + 规则说明（点开 / 再点收起）

  [2026-09-26] 开合状态改为【受控】：open 由父级（useDecisionBoard 的 rulesOpen）持有。
    为什么要上提：用户要求「点看板条的小三角收起看板时，问号说明板也一起收起、说明文字一起消失」
    —— 这需要【父级能关掉它】，所以开合真相必须放在父级父子都能摸到的地方。
    ⛔ 组件内不再自己留一份 ref：父子各存一份必然出现「父关了、子还开着」的分叉（§6）。
    §34 它依然只是【纯 UI 态】：不进 store、不落 localStorage（默认收起、无记忆）。

  规则文案由 props 传入（数组，一行一条）—— ⛔ 不在本组件里硬编码业务规则：
  规则归 logic/decision/decision-rules.js，文案与常量都从那里派生，避免两处分叉。

  [COPY-ALL 2026-10-01 用户要求] 面板顶部加「一键复制全部规则」（用户原话「我复制下来研究下，
  看对不对」⇒ 复制物必须是【规则原文本身】，不是截图、不是摘要）。三个关键决定：
    ① 工具条 position:sticky（样式在 decision-board.css）—— 规则近百行、面板 max-height 62vh
       必须滚动，按钮不常驻就得先滚回顶部才点得到，那等于白加；
    ② 复制文本 = joinRulesLines(props.lines)，与下面 v-for 渲染的是【同一个数组】⇒ 显示什么就
       复制什么，不会出现「看着是这样、复制出来是那样」（§6）。拼接口径定义在 Logic 层，
       ⛔ 不在这里再写一遍 join（否则以后两边一改一分叉）；
    ③ 按钮 @click.stop：面板在 .decision-header 内，而头部整条是「点一下收起看板」——
       不拦住的话，点复制会顺手把看板连带收起、面板闪一下消失，用户会以为复制失败了。
-->
<template>
  <span class="dcb-rules">
    <span
      class="dcb-rules-q"
      title="点击查看决策规则"
      @click.stop="emit('update:open', !open)"
    >?</span>
    <!-- [COPY 2026-09-29] dcb-selectable = 白名单，允许长按选中复制规则原文（见 decision-board.css）。
         @click.stop：面板在 .decision-header 里，而头部整条是「点一下收起看板」；
         不拦住的话，长按选字松手会触发点击 → 看板与面板一起收起、刚选中的文字也没了。 -->
    <div
      v-show="open"
      class="dcb-rules-panel dcb-selectable"
      @click.stop
    >
      <!-- [COPY-ALL 2026-10-01] 面板工具条：左标题、右复制按钮。
           ⛔ 不设 v-if（无论 rules 是否为空都给按钮），文案由 Logic 决定有没有内容可复制。 -->
      <div class="dcb-rules-bar">
        <span class="dcb-rules-bar-title">决策规则</span>
        <span
          class="dcb-rules-copy"
          title="一键复制全部规则（纯文本，可直接粘贴）"
          @click.stop="onCopy"
        >复制</span>
      </div>
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
import { computed } from 'vue';
import { showToast } from '../../composables/useToast.js';
import { joinRulesLines } from '../../logic/decision/decision-rules.js';

const props = defineProps({
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

/** 要复制出去的纯文本（§21：模板不参与计算，这里一次算好）。 */
const copyText = computed(() => joinRulesLines(props.lines));

/**
 * 一键复制全部规则。
 * 与 components/DebugLogModal.vue 的复制同一套写法（clipboard 异步 API + Toast 反馈）。
 * ⛔ 不做 document.execCommand('copy') 兜底 —— 那是已废弃接口；本看板只跑在 https / localhost，
 *    clipboard 必可用。真遇上不支持的环境就【如实告知】并让用户长按选中手动复制，
 *    而不是敲一下什么都没有发生（§10 不静默）。
 */
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
      // 行数按【实际复制出去的行】报，不按 props.lines.length（两者不一致时也说得准）
      showToast('✅ 已复制全部决策规则（' + text.split('\n').length + ' 行）');
    },
    () => {
      showToast('复制失败，请长按选中文字手动复制');
    }
  );
}
</script>
