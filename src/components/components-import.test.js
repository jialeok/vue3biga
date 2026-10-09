// components-import.test.js — 组件契约防回归：模板里用到的组件，必须在 `<script setup>` 里 import
//
// ⭐ [CHART-JUDGE-SELL-ALL 2026-10-09 事故] 决策看板【卖点】的 <ChartJudgeSelect> 漏了 import ——
//    Vue 把未解析的 <ChartJudgeSelect> 当【原生自定义元素】渲染 ⇒ 卖点上什么都不显示
//    （DOM 里连标签都没有，只在控制台留一句 "Failed to resolve component"），
//    导致用户连续两次反馈「卖点那里还是没有显示那个选择 UI，只有买点有」。
//
// ⛔ 这类漏写【不会】被现有手段拦住：
//    · eslint 不检查模板里的组件名是否 import（eslint-plugin-vue 也没有这条规则）；
//    · `vite build` 照常成功 —— 编译期就把模板产成了 `resolveComponent("ChartJudgeSelect")`，
//      要等【运行期】渲染那一行才失败，所以构建 / 静态检查全绿而页面缺一块；
//    · 本仓库的单测只覆盖 Logic 纯函数，没有组件挂载测试（没有 @vue/test-utils）。
//
// ⇒ 本文件用 @vue/compiler-sfc 在【测试期】把每个 .vue 的模板编译一遍：
//    只要产出 `resolveComponent("Xxx")`，就说明 Xxx 在模板里被用了、却没在 `<script setup>` 里绑定
//    ⇒ 直接失败。这样「模板用到什么，script 就要 import 什么」这条纪律从此由机器守着。
//
// §6 / §21 都不涉及，纯粹是「组件契约」检查。

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, compileScript, compileTemplate } from 'vue/compiler-sfc';

/** src/ 根目录（本文件位于 src/components/ 下） */
const SRC_DIR = fileURLToPath(new URL('..', import.meta.url));

/**
 * 允许「未在 script 里绑定」的组件 —— 仅限框架级【插件全局注册】的组件。
 * vue-router 在 `app.use(router)` 时全局注册了这两个，所以 App.vue 里直接用是合法的。
 * ⛔ 白名单只能放这一类；项目自己的组件（components/ 下的）一律必须显式 import。
 */
const GLOBAL_COMPONENT_ALLOWLIST = ['RouterView', 'RouterLink'];

/** 递归收集所有 .vue（排序保证用例顺序稳定、失败信息可读） */
function walkVue(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkVue(p, out);
    else if (e.name.endsWith('.vue')) out.push(p);
  }
  return out;
}

const vueFiles = walkVue(SRC_DIR).sort();

describe('组件契约：模板用到的组件必须在 <script setup> 里 import', () => {
  it('至少扫描到 30 个 .vue（防止扫描路径写错导致「空跑全绿」）', () => {
    expect(vueFiles.length).toBeGreaterThanOrEqual(30);
  });

  it.each(vueFiles.map(function(f) { return [path.relative(SRC_DIR, f).replace(/\\/g, '/'), f]; }))(
    '%s',
    function(rel, file) {
      const src = fs.readFileSync(file, 'utf8');
      const { descriptor, errors } = parse(src, { filename: file });
      // SFC 本身要能解析（语法错误也在这里暴露）
      expect(errors.map(function(e) { return e.message; })).toEqual([]);

      // 没有模板、或没有 <script setup>（用的是 options API 的 components 选项）⇒ 不在本契约范围内
      if (!descriptor.template || !descriptor.scriptSetup) return;

      const bindings = (compileScript(descriptor, { id: 'components-import-test' }).bindings) || {};
      const tpl = compileTemplate({
        source: descriptor.template.content,
        filename: file,
        id: 'components-import-test',
        compilerOptions: { bindingMetadata: bindings }
      });

      const unresolved = [...new Set(
        (tpl.code.match(/resolveComponent\("([A-Za-z0-9]+)"\)/g) || [])
          .map(function(s) { return s.slice('resolveComponent("'.length, -2); })
      )].filter(function(name) { return !GLOBAL_COMPONENT_ALLOWLIST.includes(name); });

      expect(
        unresolved,
        rel + ' 的模板用了但没 import 的组件：' + unresolved.join(', ') +
        ' —— 补上 `import X from \'./X.vue\';`，否则 Vue 会把它当原生元素、什么都不渲染。'
      ).toEqual([]);
    }
  );
});
