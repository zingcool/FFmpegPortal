#!/usr/bin/env bash
# 置备运行资产：ffmpeg / ffprobe / VMAF 模型。
#
# 用途：干净克隆或未提交二进制时，用一条命令从既有位置（或制品库）取回资产。
#
# 用法：
#   ./scripts/setup-assets.sh                       # 自动探测常见来源
#   ASSET_SOURCE=/path/to/has/assets ./scripts/setup-assets.sh
#
# 需要的资产（相对 ASSET_SOURCE）：
#   ffmpeg/bin/ffmpeg    ffmpeg/bin/ffprobe    model/vmaf_v0.6.1.json
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

ok()  { printf '  \033[32m✅\033[0m %s\n' "$1"; }
bad() { printf '  \033[31m❌\033[0m %s\n' "$1"; }

need_ffmpeg=1; [ -x ffmpeg/bin/ffmpeg ] && need_ffmpeg=0
need_ffprobe=1; [ -x ffmpeg/bin/ffprobe ] && need_ffprobe=0
need_model=1; [ -f model/vmaf_v0.6.1.json ] && need_model=0

if [ "$need_ffmpeg" = 0 ] && [ "$need_ffprobe" = 0 ] && [ "$need_model" = 0 ]; then
  echo "资产已齐备，无需处理："
  ok "ffmpeg/bin/ffmpeg"
  ok "ffmpeg/bin/ffprobe"
  ok "model/vmaf_v0.6.1.json"
  exit 0
fi

# 候选来源：显式指定优先，否则探测常见位置
CANDIDATES=()
[ -n "${ASSET_SOURCE:-}" ] && CANDIDATES+=("$ASSET_SOURCE")
CANDIDATES+=(
  "$ROOT"
  "$ROOT/../python-autotest"
  "$HOME/src/python-autotest"
  "$HOME/src/perf-autotest"
)

SRC=""
for c in "${CANDIDATES[@]}"; do
  if [ -x "$c/ffmpeg/bin/ffmpeg" ] && [ -f "$c/model/vmaf_v0.6.1.json" ]; then
    SRC="$c"; break
  fi
done

if [ -z "$SRC" ]; then
  bad "未找到资产来源。请用 ASSET_SOURCE 指定包含 ffmpeg/bin/ 与 model/vmaf_v0.6.1.json 的目录。"
  exit 1
fi

echo "资产来源: $SRC"
mkdir -p ffmpeg/bin model

if [ "$need_ffmpeg" = 1 ]; then
  cp "$SRC/ffmpeg/bin/ffmpeg" ffmpeg/bin/ffmpeg
  ok "已复制 ffmpeg ($(du -h ffmpeg/bin/ffmpeg | cut -f1))"
fi
if [ "$need_ffprobe" = 1 ]; then
  cp "$SRC/ffmpeg/bin/ffprobe" ffmpeg/bin/ffprobe
  ok "已复制 ffprobe ($(du -h ffmpeg/bin/ffprobe | cut -f1))"
fi
if [ "$need_model" = 1 ]; then
  cp "$SRC/model/vmaf_v0.6.1.json" model/vmaf_v0.6.1.json
  ok "已复制 VMAF 模型"
fi

chmod +x ffmpeg/bin/ffmpeg ffmpeg/bin/ffprobe

echo
echo "校验："
./ffmpeg/bin/ffmpeg -hide_banner -version 2>&1 | head -1 | sed 's/^/  /'
if ./ffmpeg/bin/ffmpeg -hide_banner -filters 2>/dev/null | grep -qE '^\s*[A-Z.]+\s+libvmaf'; then
  ok "libvmaf 滤波器可用"
else
  bad "该 ffmpeg 不包含 libvmaf，VMAF 不可用"
  exit 1
fi
ok "资产置备完成"
