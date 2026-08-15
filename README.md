# biga

A股早盘竞价 / 热门股票 / 行情指标看板。前端为纯 Vue3 单页应用，数据由 Supabase（Postgres + Edge Functions）与 Cloudflare Worker 代理提供。

## 技术栈

- **Vue 3**（`<script setup>` 组合式 API）+ **Vite**
- **Pinia**（全局状态，集中在 `src/stores`）
- **Supabase**（数据库、Edge Functions、实时订阅）
- 部署：静态产物（`dist/`）+ Supabase Functions + Cloudflare Worker

## 目录结构概览

```
src/
├── views/      页面级组件（看板前台展示 + 后台录入/编辑）
├── logic/      业务编排与计算逻辑（数据加工、聚合、规则）
├── data/       数据访问层（Supabase 查询、API 代理封装）
└── stores/     Pinia stores（跨页面共享状态）
supabase/       SQL 迁移 + Edge Functions 源码
workers/        Cloudflare Worker 代理打包源码
```

## 本地运行

```bash
npm install        # 安装依赖
npm run dev        # 启动 Vite 开发服务器（默认 http://localhost:5173）
npm run build      # 产物输出到 dist/
npm run preview    # 本地预览构建产物
```

## 部署说明

- **前端**：`npm run build` 后部署 `dist/` 到静态托管（Pages / 对象存储）。
- **Supabase Functions**：`supabase/functions` 下的 Edge Functions 通过 Supabase CLI 部署；环境变量/密钥在 Supabase 控制台配置，勿写入仓库。
- **Cloudflare Worker**：`workers/` 下的代理脚本打包后发布到 Cloudflare，用于转发第三方行情接口、规避跨域。

## 架构红线

本项目有严格的架构规范与数据同步约定（早盘竞价 / 热门股票 / 行情指标的边界、数据来源唯一性、后台录入入口等），改动相关业务前**务必先阅读 `ARCHITECTURE架构规范_V3.md`**，避免引入「数据不对 / 越改越乱 / 凭空冒出新股票 / 后台按钮不生效」类问题。

> 本地 token / 凭据文件（如 `*TOKEN.txt`）已被 `.gitignore` 忽略，切勿提交。
