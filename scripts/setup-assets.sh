#!/usr/bin/env bash
# 置备运行资产：ffmpeg / ffprobe / VMAF 模型。
#
# 默认从 **FFmpeg-Builds（GitHub 上的 ffmpeg 构建仓库）** 下载预编译二进制，
# 并校验其确实带 libvmaf 滤波器；也支持离线从本地目录复制。
#
# 用法：
#   ./scripts/setup-assets.sh                    # 下载（默认 n8.1 稳定分支，linux64 GPL 静态构建）
#   ./scripts/setup-assets.sh --offline          # 离线：从本地候选目录复制
#   ASSET_SOURCE=/mnt/artifacts ./scripts/setup-assets.sh --offline
#   FFMPEG_URL=<固定版本URL> ./scripts/setup-assets.sh --download   # 固定版本（可复现）
#   FFMPEG_SHA256=<sha256> ./scripts/setup-assets.sh --download     # 附加完整性校验
#
# 可选环境变量：
#   FFMPEG_BRANCH   n8.1（默认） | n9.0 | master
#   FFMPEG_LICENSE  gpl（默认）  | lgpl
#   FFMPEG_URL      完整下载地址（覆盖上面的组合，用于固定版本）
#   FFMPEG_SHA256   期望的压缩包 sha256（留空则不校验，仍会校验 libvmaf）
#   ASSET_SOURCE    离线复制来源目录
#   KEEP_ARCHIVE=1  保留下载的压缩包（默认删除）
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

FFMPEG_BIN="ffmpeg/bin/ffmpeg"
FFPROBE_BIN="ffmpeg/bin/ffprobe"
MODEL_FILE="model/vmaf_v0.6.1.json"

ok()   { printf '  \033[32m✅\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m⚠️ \033[0m %s\n' "$1"; }
bad()  { printf '  \033[31m❌\033[0m %s\n' "$1"; }
info() { printf '  %s\n' "$1"; }

need_ffmpeg=1;  [ -x "$FFMPEG_BIN" ] && need_ffmpeg=0
need_ffprobe=1; [ -x "$FFPROBE_BIN" ] && need_ffprobe=0
need_model=1;   [ -f "$MODEL_FILE" ] && need_model=0

if [ "$need_ffmpeg" = 0 ] && [ "$need_ffprobe" = 0 ] && [ "$need_model" = 0 ]; then
  echo "资产已齐备，无需处理："
  ok "$FFMPEG_BIN"
  ok "$FFPROBE_BIN"
  ok "$MODEL_FILE"
  "$FFMPEG_BIN" -hide_banner -version 2>&1 | head -1 | sed 's/^/  /'
  exit 0
fi

MODE="download"
for arg in "$@"; do
  case "$arg" in
    --download) MODE="download" ;;
    --offline|--copy) MODE="offline" ;;
    -h|--help) sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) bad "未知参数: $arg（可用：--download | --offline）"; exit 2 ;;
  esac
done

# ---------------------------------------------------------------- 校验函数
verify_install() {
  local fail=0
  echo
  echo "校验："

  if [ -x "$FFMPEG_BIN" ]; then
    info "$("$FFMPEG_BIN" -hide_banner -version 2>&1 | head -1)"
    # 架构检查（内置二进制仅 x86-64 可用）
    if ! "$FFMPEG_BIN" -hide_banner -version >/dev/null 2>&1; then
      bad "ffmpeg 无法执行（可能是架构不符：本服务需要 x86-64）"
      fail=1
    fi
    # libvmaf 是硬性要求
    if "$FFMPEG_BIN" -hide_banner -filters 2>/dev/null | grep -qE '^\s*[A-Z.]+\s+libvmaf\s'; then
      ok "libvmaf 滤波器可用"
    else
      bad "该 ffmpeg 不包含 libvmaf —— VMAF 不可用，评分会失败"
      fail=1
    fi
    for f in psnr ssim; do
      "$FFMPEG_BIN" -hide_banner -filters 2>/dev/null | grep -qE "^\s*[A-Z.]+\s+$f\s" \
        && ok "$f 滤波器可用" || { bad "$f 滤波器缺失"; fail=1; }
    done
  else
    bad "缺少 $FFMPEG_BIN"
    fail=1
  fi

  [ -x "$FFPROBE_BIN" ] && ok "ffprobe 可执行" || { bad "缺少 $FFPROBE_BIN"; fail=1; }
  [ -f "$MODEL_FILE" ] && ok "VMAF 模型存在（$(du -h "$MODEL_FILE" | cut -f1)）" \
    || { bad "缺少 $MODEL_FILE"; fail=1; }

  return $fail
}

# ---------------------------------------------------------------- 下载模式
resolve_url() {
  if [ -n "${FFMPEG_URL:-}" ]; then
    echo "$FFMPEG_URL"
    return
  fi
  local branch="${FFMPEG_BRANCH:-n8.1}"
  local lic="${FFMPEG_LICENSE:-gpl}"
  local base="https://github.com/FFmpeg-Builds/FFmpeg-Builds/releases/download/latest"
  if [ "$branch" = "master" ]; then
    echo "$base/ffmpeg-master-latest-linux64-${lic}.tar.xz"
  else
    # 例：分支 n8.1 -> ffmpeg-n8.1-latest-linux64-gpl-8.1.tar.xz（后缀是 8.1，不带前导 n）
    local suffix="${branch#n}"
    echo "$base/ffmpeg-${branch}-latest-linux64-${lic}-${suffix}.tar.xz"
  fi
}

dl_fetch() { # $1=url $2=dest
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --retry 3 --retry-delay 2 --connect-timeout 20 --max-time 1800 -o "$2" "$1"
  elif command -v wget >/dev/null 2>&1; then
    wget --tries=3 --timeout=30 -O "$2" "$1"
  else
    bad "需要 curl 或 wget 之一来下载"
    return 1
  fi
}

do_download() {
  local url; url="$(resolve_url)"
  local tmpdir; tmpdir="$(mktemp -d)"
  local archive="$tmpdir/ffmpeg.tar.xz"
  trap 'rm -rf "$tmpdir"' RETURN

  echo "下载模式（来源：FFmpeg-Builds / GitHub）"
  info "URL: $url"
  echo "  正在下载（约 150 MB）…"
  if ! dl_fetch "$url" "$archive"; then
    bad "下载失败。若网络受限，可改用离线模式："
    info "  ASSET_SOURCE=/已有资产的目录 ./scripts/setup-assets.sh --offline"
    return 1
  fi
  ok "下载完成（$(du -h "$archive" | cut -f1)）"

  # 完整性校验（可选，但指定了就一定校验）
  if [ -n "${FFMPEG_SHA256:-}" ]; then
    local got; got="$(sha256sum "$archive" | cut -d' ' -f1)"
    if [ "$got" = "${FFMPEG_SHA256,,}" ]; then
      ok "sha256 校验通过"
    else
      bad "sha256 不匹配！"
      info "  期望: ${FFMPEG_SHA256,,}"
      info "  实际: $got"
      return 1
    fi
  fi

  # 只取 ffmpeg 与 ffprobe（ffplay 无用，约 170 MB）
  echo "  解包 ffmpeg / ffprobe（跳过 ffplay）…"
  mkdir -p ffmpeg/bin
  if ! tar xf "$archive" -C "$tmpdir" --strip-components=1 '*/bin/ffmpeg' '*/bin/ffprobe' 2>/dev/null; then
    # 兼容目录层级不同的压缩包：退回整包解压后再挑
    mkdir -p "$tmpdir/full"
    tar xf "$archive" -C "$tmpdir/full" || { bad "解包失败（压缩包损坏？）"; return 1; }
    local src
    src="$(find "$tmpdir/full" -type f -name ffmpeg -path '*/bin/*' | head -1)"
    [ -n "$src" ] || { bad "压缩包内未找到 bin/ffmpeg"; return 1; }
    cp "$src" "$FFMPEG_BIN"
    cp "$(dirname "$src")/ffprobe" "$FFPROBE_BIN"
  else
    cp "$tmpdir/bin/ffmpeg" "$FFMPEG_BIN"
    cp "$tmpdir/bin/ffprobe" "$FFPROBE_BIN"
  fi

  chmod +x "$FFMPEG_BIN" "$FFPROBE_BIN"
  ok "已安装到 ffmpeg/bin/"
}

# ---------------------------------------------------------------- 离线模式
do_offline() {
  local CANDIDATES=()
  [ -n "${ASSET_SOURCE:-}" ] && CANDIDATES+=("$ASSET_SOURCE")
  CANDIDATES+=("$ROOT" "$ROOT/../python-autotest" "$HOME/src/python-autotest" "$HOME/src/perf-autotest")

  local SRC=""
  for c in "${CANDIDATES[@]}"; do
    if [ -x "$c/ffmpeg/bin/ffmpeg" ] && [ -f "$c/model/vmaf_v0.6.1.json" ]; then SRC="$c"; break; fi
  done

  echo "离线模式（从本地目录复制）"
  if [ -z "$SRC" ]; then
    bad "未找到资产来源"
    info "请用 ASSET_SOURCE 指定含 ffmpeg/bin/ 与 model/vmaf_v0.6.1.json 的目录："
    info "  ASSET_SOURCE=/path/to/assets ./scripts/setup-assets.sh --offline"
    return 1
  fi
  ok "来源: $SRC"

  mkdir -p ffmpeg/bin model
  [ "$need_ffmpeg" = 1 ]  && { cp "$SRC/ffmpeg/bin/ffmpeg" "$FFMPEG_BIN"; chmod +x "$FFMPEG_BIN"; ok "已复制 ffmpeg"; }
  [ "$need_ffprobe" = 1 ] && { cp "$SRC/ffmpeg/bin/ffprobe" "$FFPROBE_BIN"; chmod +x "$FFPROBE_BIN"; ok "已复制 ffprobe"; }
  [ "$need_model" = 1 ]   && { cp "$SRC/model/vmaf_v0.6.1.json" "$MODEL_FILE"; ok "已复制 VMAF 模型"; }
  return 0
}

# ---------------------------------------------------------------- 执行
# 模型始终在仓库内（19KB），缺失时优先从本地候选补，不单独下载
if [ "$need_model" = 1 ]; then
  for c in "${ASSET_SOURCE:-}" "$ROOT" "$ROOT/../python-autotest" "$HOME/src/python-autotest" "$HOME/src/perf-autotest"; do
    [ -n "$c" ] && [ -f "$c/$MODEL_FILE" ] && { mkdir -p model; cp "$c/$MODEL_FILE" "$MODEL_FILE"; break; }
  done
fi

case "$MODE" in
  download) do_download || { echo; bad "下载模式失败，可尝试离线模式"; exit 1; } ;;
  offline)  do_offline  || { echo; bad "离线模式失败，可尝试下载模式"; exit 1; } ;;
esac

echo
if verify_install; then
  echo
  ok "资产置备完成"
  info "提示：下载的构建版本可能与项目最初使用的不同，VMAF 分数可能有约 1e-4 量级差异（PSNR/SSIM 不受影响）。"
  exit 0
else
  echo
  bad "资产校验未通过"
  exit 1
fi
