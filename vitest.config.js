import { defineConfig } from 'vitest/config';

// 纯逻辑单测：不启浏览器，使用 node 环境。
// include 限定在 src 下，避免扫描 _graphtest/ 与 newbigamain没彻底拆分最新原始文件/ 诱饵副本。
// 例外：workers/bidding-auto-fetch 的纯逻辑单测（额度安全/幂等类不变量）也纳入，见 extras-workflow.test.js。
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.js', 'workers/bidding-auto-fetch/**/*.test.js'],
  },
});
