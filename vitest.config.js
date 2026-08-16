import { defineConfig } from 'vitest/config';

// 纯逻辑单测：不启浏览器，使用 node 环境。
// include 限定在 src 下，避免扫描 _graphtest/ 与 newbigamain没彻底拆分最新原始文件/ 诱饵副本。
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.js'],
  },
});
