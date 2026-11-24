# syntax=docker/dockerfile:1
# FFmpegPortal —— 视频画质评分服务
# 构建上下文必须是**本目录**（需要 ffmpeg/bin 与 model/）：
#   docker build -t ffmpeg-portal:1.0.0 .
#
# 关键约束：
#   - 必须用 glibc 基础镜像，禁用 alpine（musl 无法运行该 ffmpeg）
#   - 二进制仅依赖 glibc + libgcc_s，bookworm-slim 已自带，无需 apt 安装
#   - 不带 ffplay（省约 200MB）
#   - 用 COPY --chown，不要 COPY 后再 chown -R（会为 400MB 二进制多生成一整层）

# ---------- 依赖层 ----------
FROM node:24-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# ---------- 运行层 ----------
FROM node:24-bookworm-slim

ENV NODE_ENV=production \
    HOME=/tmp

WORKDIR /app

COPY --chown=node:node --from=deps /app/node_modules ./node_modules
COPY --chown=node:node package.json ./

# ffmpeg 资产（若缺失请先执行 scripts/setup-assets.sh）
COPY --chown=node:node ffmpeg/bin/ffmpeg ffmpeg/bin/ffprobe /app/bin/
COPY --chown=node:node model/vmaf_v0.6.1.json /app/model/vmaf_v0.6.1.json

COPY --chown=node:node src ./src
COPY --chown=node:node scripts ./scripts

RUN mkdir -p /data/refs /data/jobs \
 && chown -R node:node /data

USER node

ENV FFMPEG_PATH=/app/bin/ffmpeg \
    FFPROBE_PATH=/app/bin/ffprobe \
    VMAF_MODEL=/app/model/vmaf_v0.6.1.json \
    DATA_DIR=/data \
    PORT=3000

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
