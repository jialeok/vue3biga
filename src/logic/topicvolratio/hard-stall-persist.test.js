// hard-stall-persist.test.js — [HARD-STALL-PERSIST 2026-11-26] 「网络硬兜底 ⇒ 定稿不入库」事故锁
//
// ══════════════════════════════════════════════════════════════════════════════════════
// 用户报障（原话）
//   「11月23日，题材量比买点侧为什么有海立股份呢？……我之前当天都没见这个买点侧有这只
//     股票啊，现在怎么又冒出来了。能修复就按照规则修复下。」
//   —— 追问后确认：页面显示的是**新文案**（第二十九条通道），但库里存档还停在 v28，
//      所以「别人打开那天」读到的仍是旧存档里的旧文案 ⇒ 观感就是「又冒出来」。
// ══════════════════════════════════════════════════════════════════════════════════════
// 库/页面实证（2026-11-23，`[TVRB-*]` 日志原文，非推测）：
//   · 02:21:47 `[TVRB-BUY-SETTLE] 2026-11-23 选股输入已齐 ⇒ 买点侧放行`
//             ⇒ 规则层判九项输入全齐（`plan.buyPending === false`）—— **结论是完整的**
//   · 02:22:06 `netHardStalled` 到点（装载窗口 02:21:21 + NET_HARD_MS 45s）
//   · 02:22:08 `[TVRB-BUY-PUBLISH] 2026-11-23 选股结论【定稿】（上游硬兜底，结论可能不完整，已标注）`
//             ⇒ `_persistPlanSnapshot` 第一行 `if (netHardStalled.value) return;` 整份丢弃
//   · 02:24~02:27 每 20s 轮询，库里恒为 `v28:79cb50e9 rev=2`
//
// 根因（整类，不只 11-23）：`netHardStalled` 只表示「窗口到期仍有请求在途，我们不等了」，
//   **不表示结论残缺**。而 `_buyPublished` 已把当天闩死（同一天不再定稿）⇒ 一旦被这条闸门
//   丢掉，连「等网络静默后再补写」都没有 ⇒ 那天的定稿永远不入库。
//   只要尾部请求拖过 45s（慢网 / 冷启动 / 历史日请求本来就多 / 走代理）就必然复现。
//
// 锁住四根线：
//   ① `_persistPlanSnapshot` 里 **不许** 再出现 `if (netHardStalled.value) return;`
//   ② 真正的降级判据必须在场：buyPending ⇒ divergePending ⇒ buyDataGate.blocked（顺序固定）
//   ③ `_buyPublished.degraded` 仍然保留（UI 要如实提示「读取超时」，只是不影响落库）
//   ④ 定稿门控里「硬兜底穿透」那三条 `&& !netHardStalled.value` 一律不许动
//      （删了就会在慢网时永久停在占位 —— 那是更严重的「打不开」）
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const SRC = readFileSync('src/composables/useTopicVolRatioBoard.js', 'utf8');

/** 取 `_persistPlanSnapshot` 函数体（到下一个 `function ` 或 `watch(` 为止）。 */
function persistBody() {
  const at = SRC.indexOf('function _persistPlanSnapshot(d, plan) {');
  expect(at).toBeGreaterThan(-1);
  const rest = SRC.slice(at + 10);
  const endRel = rest.search(/\n  (?:function |watch\()/);
  const body = endRel === -1 ? rest : rest.slice(0, endRel);
  expect(body.length).toBeGreaterThan(200);
  return body;
}

describe('[HARD-STALL-PERSIST] 写库准入里不许再用「硬兜底」当降级判据', () => {
  it('⛔ 不许出现 if (netHardStalled.value) return;', () => {
    // 这一行曾在函数第一行，把 11-23 那份**完整**结论整份丢弃
    expect(persistBody()).not.toContain('if (netHardStalled.value) return;');
  });

  it('整个函数体里 netHardStalled 一次都不许当 return 条件', () => {
    const body = persistBody();
    expect(body).not.toMatch(/if\s*\(\s*netHardStalled\.value\s*\)\s*return/);
    expect(body).not.toMatch(/netHardStalled\.value\s*&&\s*.*return/);
  });
});

describe('[HARD-STALL-PERSIST] 真正的降级判据必须在场且顺序固定', () => {
  it('buyPending / divergePending / buyDataGate 三条都在', () => {
    const body = persistBody();
    expect(body).toMatch(/if \(plan\.buyPending\) \{/);
    expect(body).toMatch(/if \(plan\.divergePending\) \{/);
    expect(body).toMatch(/if \(plan\.buyDataGate && plan\.buyDataGate\.blocked\) \{/);
  });

  it('顺序：buyPending → divergePending → buyDataGate（由宽到窄，别乱）', () => {
    const body = persistBody();
    const iBuy = body.indexOf('if (plan.buyPending) {');
    const iDiv = body.indexOf('if (plan.divergePending) {');
    const iGate = body.indexOf('if (plan.buyDataGate && plan.buyDataGate.blocked) {');
    expect(iBuy).toBeGreaterThan(-1);
    expect(iDiv).toBeGreaterThan(iBuy);
    expect(iGate).toBeGreaterThan(iDiv);
  });

  it('§10 禁止静默：三条拦下时都必须留痕（否则下次又查不出为什么没写）', () => {
    const body = persistBody();
    expect(body).toContain('买点侧输入未齐（buyPending）⇒ 本次不存档');
    expect(body).toContain('买点侧仍是分歧占位帧（divergePending）⇒ 本次不存档');
    expect(body).toContain('数据闸门已拦（buyDataGate.blocked）⇒ 本次不存档');
  });

  it('写侧与读侧同源：占位帧判据（isSnapshotPlaceholderFrame）三项覆盖一致', () => {
    // 读侧靠这个纯函数判 corrupt，写侧必须一一对应，否则又会出现「写进去 ⇒ 读时判 corrupt」的死循环
    const rules = readFileSync('src/logic/topicvolratio/plan-snapshot-rules.js', 'utf8');
    const at = rules.indexOf('export function isSnapshotPlaceholderFrame(plan) {');
    expect(at).toBeGreaterThan(-1);
    const body = rules.slice(at, at + 400);
    expect(body).toContain('if (p.buyPending) return true;');
    expect(body).toContain('if (p.divergePending) return true;');
    expect(body).toContain('if (p.buyDataGate && p.buyDataGate.blocked) return true;');
  });
});

describe('[HARD-STALL-PERSIST] 降级标注保留在 UI，只是不再影响落库', () => {
  it('_buyPublished 仍带 degraded 标记', () => {
    expect(SRC).toContain('degraded: !!netHardStalled.value');
  });

  it('定稿日志仍如实写「上游硬兜底，结论可能不完整，已标注」', () => {
    expect(SRC).toContain('（上游硬兜底，结论可能不完整，已标注）');
  });
});

describe('[HARD-STALL-PERSIST] 定稿门控的「硬兜底穿透」一律保留', () => {
  it('buyPending / divergePending / 半成品 三条穿透都在', () => {
    // ⛔ 删掉这些 ⇔ 慢网时买点侧永久停在占位（用户说的「打不开」），比丢一次存档严重得多
    expect(SRC).toContain('if (plan && plan.buyPending && !netHardStalled.value) return;');
    expect(SRC).toContain('if (plan && plan.divergePending && !netHardStalled.value) return;');
    expect(SRC).toContain('if (plan && plan.pickCount > 0 && !_buySigHasNames(buySelSig.value) && !netHardStalled.value) return;');
  });
});
