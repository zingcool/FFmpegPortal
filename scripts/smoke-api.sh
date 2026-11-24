#!/usr/bin/env bash
# M2 验收脚本：覆盖创建任务、报告下载、取消、以及 §9 错误码。
#
# 用法：
#   BASE=http://127.0.0.1:3000 ./scripts/smoke-api.sh
# 前置：服务已启动；本脚本会在 TESTDATA 目录合成测试素材（需要 ffmpeg）。
set -uo pipefail

BASE="${BASE:-http://127.0.0.1:3000}"
FFMPEG="${FFMPEG:-./ffmpeg/bin/ffmpeg}"
TESTDATA="${TESTDATA:-./tmp/testdata}"
PASS=0
FAIL=0

ok()   { PASS=$((PASS+1)); printf '  \033[32m✅\033[0m %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf '  \033[31m❌\033[0m %s\n' "$1"; }
head1() { printf '\n\033[1m%s\033[0m\n' "$1"; }

# 断言 HTTP 状态码
expect_status() { # $1=desc $2=expected $3=actual $4=body
  if [ "$3" = "$2" ]; then ok "$1 (HTTP $3)"; else bad "$1 —— 期望 $2，实际 $3: $(echo "$4" | head -c 200)"; fi
}

# 断言 JSON 里的 error.code
expect_code() { # $1=desc $2=expected_code $3=body
  local got
  got=$(echo "$3" | python3 -c "import sys,json;print(json.load(sys.stdin).get('error',{}).get('code',''))" 2>/dev/null)
  if [ "$got" = "$2" ]; then ok "$1 (code=$got)"; else bad "$1 —— 期望 code=$2，实际 '$got': $(echo "$3" | head -c 200)"; fi
}

json_get() { echo "$1" | python3 -c "import sys,json;print(json.load(sys.stdin)$2)" 2>/dev/null; }

# ---------- 准备素材 ----------
head1 "0. 准备测试素材 ($TESTDATA)"
mkdir -p "$TESTDATA"
if [ ! -f "$TESTDATA/ref720.mp4" ]; then
  "$FFMPEG" -v error -y -f lavfi -i "testsrc2=size=1280x720:rate=30:duration=6" \
    -c:v libx264 -crf 16 -preset veryfast -pix_fmt yuv420p -an "$TESTDATA/ref720.mp4" || { bad "生成参考片失败"; exit 1; }
fi
if [ ! -f "$TESTDATA/t_good.mp4" ]; then
  "$FFMPEG" -v error -y -i "$TESTDATA/ref720.mp4" -c:v libx264 -crf 28 -preset veryfast -pix_fmt yuv420p -an "$TESTDATA/t_good.mp4"
fi
if [ ! -f "$TESTDATA/t_bad.mp4" ]; then
  "$FFMPEG" -v error -y -i "$TESTDATA/ref720.mp4" -vf scale=854:480 -c:v libx264 -crf 40 -preset veryfast -pix_fmt yuv420p -an "$TESTDATA/t_bad.mp4"
fi
# 长片（用于取消测试）：参考与待测都必须是长片，否则公共可比时长被短的一侧截断
if [ ! -f "$TESTDATA/ref_long.mp4" ]; then
  "$FFMPEG" -v error -y -f lavfi -i "testsrc2=size=1920x1080:rate=30:duration=40" \
    -c:v libx264 -crf 16 -preset veryfast -pix_fmt yuv420p -an "$TESTDATA/ref_long.mp4"
fi
if [ ! -f "$TESTDATA/t_long.mp4" ]; then
  "$FFMPEG" -v error -y -i "$TESTDATA/ref_long.mp4" \
    -c:v libx264 -crf 32 -preset veryfast -pix_fmt yuv420p -an "$TESTDATA/t_long.mp4"
fi
echo "  素材就绪"

# ---------- 1. 健康检查 ----------
head1 "1. 健康与就绪"
R=$(curl -s -w '\n%{http_code}' "$BASE/healthz"); C=$(echo "$R" | tail -1); B=$(echo "$R" | sed '$d')
expect_status "GET /healthz" 200 "$C" "$B"
R=$(curl -s -m 60 -w '\n%{http_code}' "$BASE/readyz"); C=$(echo "$R" | tail -1); B=$(echo "$R" | sed '$d')
expect_status "GET /readyz" 200 "$C" "$B"

# ---------- 2. 参考视频 ----------
head1 "2. 参考视频上传"
R=$(curl -s -m 120 -w '\n%{http_code}' -F "file=@$TESTDATA/ref720.mp4" "$BASE/api/references")
C=$(echo "$R" | tail -1); B=$(echo "$R" | sed '$d')
if [ "$C" = "201" ]; then ok "上传参考视频 → 新建 (HTTP 201)"
elif [ "$C" = "200" ]; then ok "上传参考视频 → 已存在自动复用 (HTTP 200)"
else bad "上传参考视频 —— 期望 200/201，实际 $C: $(echo "$B" | head -c 200)"; fi
REFID=$(json_get "$B" "['referenceId']")
[ -n "$REFID" ] && ok "获得 referenceId=$REFID" || bad "未获得 referenceId"

R=$(curl -s -m 120 -w '\n%{http_code}' -F "file=@$TESTDATA/ref720.mp4" "$BASE/api/references")
C=$(echo "$R" | tail -1); B=$(echo "$R" | sed '$d')
REUSED=$(json_get "$B" "['reuse']")
if [ "$C" = "200" ] && [ "$REUSED" = "True" ]; then ok "重复上传自动复用 (reuse=True)"; else bad "重复上传未复用: HTTP $C $REUSED"; fi

R=$(curl -s -m 60 -w '\n%{http_code}' "$BASE/api/references"); C=$(echo "$R" | tail -1); B=$(echo "$R" | sed '$d')
expect_status "GET /api/references" 200 "$C" "$B"

# ---------- 3. 错误码 ----------
head1 "3. 错误码"
R=$(curl -s -w '\n%{http_code}' "$BASE/api/jobs/job_不存在"); C=$(echo "$R" | tail -1); B=$(echo "$R" | sed '$d')
expect_status "不存在的任务" 404 "$C" "$B"; expect_code "不存在的任务" JOB_NOT_FOUND "$B"

R=$(curl -s -m 60 -w '\n%{http_code}' -F "referenceId=$REFID" -F "metrics=psnr" "$BASE/api/jobs")
C=$(echo "$R" | tail -1); B=$(echo "$R" | sed '$d')
expect_status "无 targets" 400 "$C" "$B"; expect_code "无 targets" NO_TARGETS "$B"

R=$(curl -s -m 120 -w '\n%{http_code}' -F "referenceId=$REFID" -F "targets=@$TESTDATA/t_good.mp4" -F "metrics=psnr,bogus" "$BASE/api/jobs")
C=$(echo "$R" | tail -1); B=$(echo "$R" | sed '$d')
expect_status "非法指标" 400 "$C" "$B"; expect_code "非法指标" INVALID_METRICS "$B"

R=$(curl -s -m 120 -w '\n%{http_code}' -F "referenceId=ref_nope" -F "targets=@$TESTDATA/t_good.mp4" "$BASE/api/jobs")
C=$(echo "$R" | tail -1); B=$(echo "$R" | sed '$d')
expect_status "参考不存在" 404 "$C" "$B"; expect_code "参考不存在" REFERENCE_NOT_FOUND "$B"

echo "not a video" > "$TESTDATA/notvideo.txt"
R=$(curl -s -m 60 -w '\n%{http_code}' -F "file=@$TESTDATA/notvideo.txt" "$BASE/api/references")
C=$(echo "$R" | tail -1); B=$(echo "$R" | sed '$d')
if [ "$C" = "422" ] || [ "$C" = "415" ]; then ok "非视频文件被拒绝 (HTTP $C)"; else bad "非视频文件未被拒绝: HTTP $C $(echo "$B" | head -c 150)"; fi

R=$(curl -s -m 60 -w '\n%{http_code}' -F "wrongname=@$TESTDATA/t_good.mp4" "$BASE/api/references")
C=$(echo "$R" | tail -1); B=$(echo "$R" | sed '$d')
expect_status "错误的文件字段名" 400 "$C" "$B"

# ---------- 4. 正常任务 ----------
head1 "4. 批量评分（全指标）"
R=$(curl -s -m 180 -w '\n%{http_code}' -F "referenceId=$REFID" \
      -F "targets=@$TESTDATA/t_good.mp4" -F "targets=@$TESTDATA/t_bad.mp4" \
      -F "metrics=psnr,ssim,vmaf" "$BASE/api/jobs")
C=$(echo "$R" | tail -1); B=$(echo "$R" | sed '$d')
expect_status "创建任务" 202 "$C" "$B"
JOB=$(json_get "$B" "['jobId']")
[ -n "$JOB" ] && ok "获得 jobId=$JOB" || { bad "未获得 jobId"; exit 1; }

for i in $(seq 1 90); do
  sleep 1
  ST=$(curl -s -m 5 "$BASE/api/jobs/$JOB" | python3 -c "import sys,json;print(json.load(sys.stdin).get('status',''))" 2>/dev/null)
  [ "$ST" = "done" ] || [ "$ST" = "failed" ] || [ "$ST" = "canceled" ] && break
done
if [ "$ST" = "done" ]; then ok "任务完成 (status=done)"; else bad "任务未正常完成 (status=$ST)"; fi

DET=$(curl -s -m 10 "$BASE/api/jobs/$JOB")
VG=$(echo "$DET" | python3 -c "
import sys,json
d=json.load(sys.stdin)
items={i['name']:i for i in d['items']}
g=items.get('t_good.mp4',{}).get('metrics',{}).get('vmaf',{}).get('mean')
b=items.get('t_bad.mp4',{}).get('metrics',{}).get('vmaf',{}).get('mean')
print('OK' if (g and b and g>b) else f'BAD g={g} b={b}')
" 2>/dev/null)
[ "$VG" = "OK" ] && ok "劣化视频 VMAF 低于良好视频（方向正确）" || bad "VMAF 方向异常: $VG"

for f in report.csv report.html result.json; do
  R=$(curl -s -m 20 -o /dev/null -w '%{http_code}' "$BASE/api/jobs/$JOB/$f")
  expect_status "下载 $f" 200 "$R" ""
done
curl -s -m 20 -o /tmp/_r.csv "$BASE/api/jobs/$JOB/report.csv"
if [ "$(head -c 3 /tmp/_r.csv | xxd -p)" = "efbbbf" ]; then ok "CSV 带 UTF-8 BOM（Excel 友好）"; else bad "CSV 缺少 BOM"; fi
RJS=$(curl -s -m 20 "$BASE/api/jobs/$JOB/result.json")
RST=$(json_get "$RJS" "['status']")
[ "$RST" = "done" ] && ok "result.json status=done（无残留 running）" || bad "result.json status=$RST"

# ---------- 5. 指标子集 ----------
head1 "5. 只选 PSNR+SSIM（不跑 VMAF）"
R=$(curl -s -m 180 -w '\n%{http_code}' -F "referenceId=$REFID" \
      -F "targets=@$TESTDATA/t_bad.mp4" -F "metrics=psnr,ssim" "$BASE/api/jobs")
C=$(echo "$R" | tail -1); B=$(echo "$R" | sed '$d')
JOB2=$(json_get "$B" "['jobId']")
expect_status "创建任务(psnr,ssim)" 202 "$C" "$B"
for i in $(seq 1 60); do sleep 1; ST2=$(curl -s -m 5 "$BASE/api/jobs/$JOB2" | python3 -c "import sys,json;print(json.load(sys.stdin).get('status',''))" 2>/dev/null); [ "$ST2" = "done" ] || [ "$ST2" = "failed" ] && break; done
VMAF_NULL=$(curl -s -m 10 "$BASE/api/jobs/$JOB2" | python3 -c "
import sys,json
d=json.load(sys.stdin); it=d['items'][0]['metrics']
print('OK' if ('psnr' in it and 'ssim' in it and 'vmaf' not in it) else f'BAD {list(it)}')" 2>/dev/null)
[ "$VMAF_NULL" = "OK" ] && ok "未选 VMAF 时不产出 vmaf 字段" || bad "指标子集异常: $VMAF_NULL"

# ---------- 6. 取消 ----------
head1 "6. 取消运行中的任务"
# 用长参考（40s 1080p）+ 2 个长待测，确保任务持续足够久
R=$(curl -s -m 300 -w '\n%{http_code}' -F "file=@$TESTDATA/ref_long.mp4" "$BASE/api/references")
C=$(echo "$R" | tail -1); B=$(echo "$R" | sed '$d')
REFID_LONG=$(json_get "$B" "['referenceId']")
[ -n "$REFID_LONG" ] && ok "长参考就绪 ($REFID_LONG)" || bad "长参考上传失败: HTTP $C"

R=$(curl -s -m 300 -w '\n%{http_code}' -F "referenceId=$REFID_LONG" \
      -F "targets=@$TESTDATA/t_long.mp4" -F "targets=@$TESTDATA/t_long.mp4" \
      -F "metrics=psnr,ssim,vmaf" "$BASE/api/jobs")
C=$(echo "$R" | tail -1); B=$(echo "$R" | sed '$d')
JOB3=$(json_get "$B" "['jobId']")
expect_status "创建长任务" 202 "$C" "$B"

# 轮询到「有 item 正在运行」的瞬间再取消（避免因机器快而错过）
RUNNING=0
for i in $(seq 1 200); do
  D=$(curl -s -m 5 "$BASE/api/jobs/$JOB3" 2>/dev/null)
  ANY=$(echo "$D" | python3 -c "
import sys,json
d=json.load(sys.stdin)
print('1' if d.get('status')=='running' and any(i['status'] in ('running','probing') for i in d.get('items',[])) else '0')" 2>/dev/null)
  [ "$ANY" = "1" ] && { RUNNING=1; break; }
  sleep 0.1
done
[ "$RUNNING" = "1" ] && ok "已观测到运行中状态" || bad "未能观测到运行中状态（机器过快或任务失败）"

R=$(curl -s -m 20 -X POST -w '\n%{http_code}' "$BASE/api/jobs/$JOB3/cancel")
C=$(echo "$R" | tail -1); B=$(echo "$R" | sed '$d')
CST=$(json_get "$B" "['status']")
if [ "$CST" = "canceled" ]; then ok "任务已取消 (status=canceled)"; else bad "取消失败: HTTP $C $(echo "$B" | head -c 150)"; fi
sleep 2
R=$(curl -s -m 20 -X POST -w '\n%{http_code}' "$BASE/api/jobs/$JOB3/cancel")
C=$(echo "$R" | tail -1); B=$(echo "$R" | sed '$d')
expect_status "重复取消" 409 "$C" "$B"; expect_code "重复取消" JOB_ALREADY_FINISHED "$B"

# ---------- 7. 清理 ----------
head1 "7. 删除任务"
R=$(curl -s -m 20 -X DELETE -w '\n%{http_code}' "$BASE/api/jobs/$JOB2")
C=$(echo "$R" | tail -1)
expect_status "DELETE /api/jobs/:id" 204 "$C" ""
R=$(curl -s -m 20 -o /dev/null -w '%{http_code}' "$BASE/api/jobs/$JOB2")
expect_status "删除后查询" 404 "$R" ""

printf '\n\033[1m结果：通过 %d，失败 %d\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
