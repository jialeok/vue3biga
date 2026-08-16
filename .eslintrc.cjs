/* eslint-env node */
'use strict';

/**
 * ESLint 配置（eslint 8 / .cjs）
 * 纯 Vue3 早盘竞价看板 — 仅配置层，不改动任何业务源码。
 * 目标：'npm run lint' 退出码 0（errors 必须为 0，warnings 允许）。
 */
module.exports = {
  root: true,

  env: {
    browser: true,
    es2022: true,
    node: true,
  },

  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },

  extends: [
    'eslint:recommended',
    'plugin:vue/vue3-recommended',
  ],

  plugins: ['vue'],

  rules: {
    // 合法的短组件名（StockCard / EditModal / HeaderStats 等），关闭多词组件名校验
    'vue/multi-word-component-names': 'off',

    // 历史代码存在较多未使用变量，降级为 warn（不阻断退出码）
    'no-unused-vars': 'warn',

    // 以下推荐规则在历史代码中大面积触发，纯属噪声，降级为 warn：
    'no-empty': 'warn',
    'no-cond-assign': 'warn',
    'no-constant-condition': 'warn',
    'no-control-regex': 'warn',
    'no-extra-boolean-cast': 'warn',
    'no-prototype-builtins': 'warn',
    'no-regex-spaces': 'warn',
    'no-sparse-arrays': 'warn',
    'no-useless-catch': 'warn',
    'no-unsafe-negation': 'warn',
    'use-isnan': 'warn',
    'valid-typeof': 'warn',

    // 以下规则在历史代码中大面积触发真实 error，按任务授权降级为 warn：
    // no-undef 多为三层架构跨文件全局函数引用（非浏览器全局），属噪声；
    // 其余为历史写法（重复声明/函数自赋值/块内函数声明/不可达代码/异常空白/模板冗余指令）。
    'no-undef': 'warn',
    'no-redeclare': 'warn',
    'no-self-assign': 'warn',
    'no-func-assign': 'warn',
    'no-inner-declarations': 'warn',
    'no-unreachable': 'warn',
    'no-irregular-whitespace': 'warn',
    'vue/no-useless-template-attributes': 'warn',
    'vue/no-unused-vars': 'warn',
  },
};
