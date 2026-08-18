# AGENTS.md

## 工作流偏好

- **自动上传 GitHub**：每次完成代码更改（修复/新功能）并验证通过后，无需用户再次提醒，直接提交并推送到 `origin/main`（仓库 https://github.com/jialeok/vue3biga）。
  - 只提交本次改动相关的文件，不要包含未跟踪的无关文件（如根目录下的图片、排查 md 等）。
  - 提交信息用中文，按 `feat:` / `fix:` 前缀 + 简述（why 优先）。
  - 推送后用 `git status` 确认 `up to date with 'origin/main'`。

## 环境备注

- `node`/`npm`/`npx` 不在默认 PATH，需手动前置：`$env:PATH = "C:\Users\jialeok\.workbuddy\binaries\node\versions\22.22.2;" + $env:PATH`。
- lint：`npx eslint <files> --ext .js,.vue`；测试：`npx vitest run`。
- git push 时 `git-credential-manager.exe` 的 stderr 警告可忽略，以 `git status` 显示 `up to date` 为准。