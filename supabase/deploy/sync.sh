#!/usr/bin/env bash
# ============================================================================
# supabase/deploy/ —— Edge Function 部署副本同步脚本
# ============================================================================
#
# 【这个目录是干什么的】
#   Supabase CLI 要求函数入口必须叫 supabase/functions/<函数名>/index.ts，
#   所以在仓库里所有函数都叫 index.ts，光看文件名分不清谁是谁 ——
#   手机上打开 GitHub 复制粘贴时极易拿错文件（历史上就踩过这个坑）。
#
#   本目录把三个需要「网页粘贴部署」的函数各复制一份、并以函数名命名，
#   让你在手机上一眼就能对上是哪个函数。
#
# 【单一真相原则】
#   ⚠️ 源文件只有一个：supabase/functions/<函数名>/index.ts
#   本目录下的 *.ts 都是「忠实副本」，内容与源文件逐字节相同。
#   ❌ 不要直接修改本目录下的 .ts —— 改了会在下次 sync 时被覆盖。
#   ✅ 要改代码就改源文件，然后跑一次本脚本同步过来。
#
# 【用法】
#   bash supabase/deploy/sync.sh          # 同步副本 + 校验一致性
#   bash supabase/deploy/sync.sh --check  # 只校验，不写入（CI / 提交前用）
#
# 退出码：0 = 全部一致；1 = 有副本与源文件不一致（配 --check 时用）
# ============================================================================
set -euo pipefail

FUNCS=(bidding-a limit-pool-fetch auction-yizi-fetch)

# 定位仓库根（本脚本在 supabase/deploy/ 下）
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

CHECK_ONLY=0
[ "${1:-}" = "--check" ] && CHECK_ONLY=1

fail=0
for f in "${FUNCS[@]}"; do
  src="supabase/functions/$f/index.ts"
  dst="supabase/deploy/$f.ts"

  if [ ! -f "$src" ]; then
    echo "❌ 源文件不存在：$src"
    fail=1
    continue
  fi

  if [ "$CHECK_ONLY" -eq 0 ]; then
    cp -f "$src" "$dst"
  fi

  a=$(sha256sum "$src" | cut -d' ' -f1)
  b=$(sha256sum "$dst" 2>/dev/null | cut -d' ' -f1 || echo "MISSING")
  la=$(wc -l < "$src")
  lb=$(wc -l < "$dst" 2>/dev/null || echo 0)

  if [ "$a" = "$b" ]; then
    printf '✅ %-20s 行数=%-5s sha256=%s\n' "$f" "$la" "${a:0:16}"
  else
    printf '❌ %-20s 副本与源文件不一致！源=%s(%s行) 副本=%s(%s行)\n' \
      "$f" "${a:0:16}" "$la" "${b:0:16}" "$lb"
    fail=1
  fi
done

if [ "$fail" -eq 0 ]; then
  [ "$CHECK_ONLY" -eq 1 ] && echo "🎉 全部一致（--check 模式未写入）" || echo "🎉 同步完成，全部一致"
else
  echo ""
  echo "⚠️  存在不一致，请把源文件改好后再跑：bash supabase/deploy/sync.sh"
fi
exit "$fail"
