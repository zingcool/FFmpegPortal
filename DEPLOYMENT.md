# FFmpegPortal 部署手册

> 适用版本：**1.0.0**（镜像 `ffmpeg-portal:1.0.0`）
> 面向：负责把服务部署到服务器、并长期运维它的人
> 配套文档：[README.md](README.md)（功能与 API）、[DESIGN.md](DESIGN.md)（设计决策与原理）、本文（部署与运维）

---

## 目录

1. [部署形态与前置条件](#1-部署形态与前置条件)
2. [快速部署（Docker Compose，推荐）](#2-快速部署docker-compose推荐)
3. [手工部署（docker run）](#3-手工部署docker-run)
4. [无 Docker 部署（本地 Node）](#4-无-docker-部署本地-node)
5. [配置参考](#5-配置参考)
6. [资源规划与性能实测](#6-资源规划与性能实测)
7. [数据、持久化与清理](#7-数据持久化与清理)
8. [反向代理与 HTTPS](#8-反向代理与-https)
9. [日常运维操作](#9-日常运维操作)
10. [故障排查](#10-故障排查)
11. [安全加固清单](#11-安全加固清单)
12. [部署后验收清单](#12-部署后验收清单)
13. [附录：错误码与接口速查](#13-附录错误码与接口速查)

---

## 1. 部署形态与前置条件

### 1.1 架构

```
浏览器 ──HTTPS──▶ 反向代理(可选) ──HTTP:3000──▶ ffmpeg-portal 容器
                                                    ├─ SQLite（/data/db.sqlite）
                                                    ├─ 参考视频（/data/refs/）
                                                    └─ 任务产物（/data/jobs/）
```

单容器、单进程、单机。**不需要** Redis / 消息队列 / 外部数据库 / 对象存储。所有状态都在 `/data` 卷里。

### 1.2 硬件要求

| 项目 | 最低 | 推荐 | 说明 |
|---|---|---|---|
| CPU | 2 核 | **4 核及以上** | VMAF 是纯 CPU 计算，核数直接决定吞吐 |
| 内存 | 2 GB | **4 GB** | 1080p 单任务 VMAF 峰值约 0.5–1.5 GB |
| 磁盘 | 5 GB | **50 GB+** | 见 §7.3 容量估算 |
| 架构 | **仅 x86-64** | — | 内置 ffmpeg 是 x86-64 ELF，arm64 不可用 |

> 内存不足时 ffmpeg 会被 OOM kill，表现为任务 `failed` 且错误含 `ffmpeg 退出码 137`。

### 1.3 软件要求

| 软件 | 版本 | 说明 |
|---|---|---|
| Docker Engine | ≥ 20.10 | 需支持 `HEALTHCHECK`
| Docker Compose | ≥ v2 | 使用 `docker compose`（v2 子命令形式） |
| （可选）Node.js | ≥ 24 | 仅「无 Docker 部署」时需要 |

### 1.4 基础镜像获取（重要）

镜像基于 `node:24-bookworm-slim`。**部分网络环境无法直连 Docker Hub**（本机实测：`docker pull node:24-bookworm-slim` 超时，`curl registry-1.docker.io` 亦超时）。若遇到，先通过国内镜像源拉取并打 tag：

```bash
# 方案 A：用可用镜像源拉取后改成本地 tag
docker pull docker.m.daocloud.io/library/node:24-bookworm-slim
docker tag docker.m.daocloud.io/library/node:24-bookworm-slim node:24-bookworm-slim

# 方案 B：配置 daemon 镜像加速器后直接构建
#   /etc/docker/daemon.json -> {"registry-mirrors": ["<你的可用镜像源>"]}
#   然后 systemctl restart docker
```

构建阶段 `npm ci` 直接访问 npm registry（**不走 Docker 代理**）。若目标机器 npm 也不通，见 §10.6。

### 1.5 构建上下文里必须存在的资产

```
ffmpeg/bin/ffmpeg        约 168 MB
ffmpeg/bin/ffprobe       约 168 MB
model/vmaf_v0.6.1.json   19 KB
```

**镜像里不装任何 apt 包**：`node:24-bookworm-slim` 自带 glibc 2.36（二进制只需 2.28）与唯一额外依赖 `libgcc_s.so.1`。

**这三个文件中，`ffmpeg/bin/*` 不入 git 仓库**（每个约 168MB，超出 GitHub 单文件 100MB 上限）；`model/vmaf_v0.6.1.json`（19KB）已入库。

因此**新克隆的仓库首次部署前必须先置备**：

```bash
./scripts/setup-assets.sh            # 从 GitHub 下载（默认）
./scripts/setup-assets.sh --offline  # 从本地已有资产复制（无外网时）
```

#### 下载模式（默认）

来源于 [FFmpeg-Builds](https://github.com/FFmpeg-Builds/FFmpeg-Builds)（GitHub 上的 ffmpeg 构建仓库）
的 **linux64 GPL 静态构建**，默认取 `n8.1` 稳定分支、`latest` 滚动发布：

```
https://github.com/FFmpeg-Builds/FFmpeg-Builds/releases/download/latest/ffmpeg-n8.1-latest-linux64-gpl-8.1.tar.xz
```

- 只解出 `ffmpeg` 与 `ffprobe`（**不装 ffplay**，省约 170MB）
- 安装后**强制校验** `libvmaf` / `psnr` / `ssim` 滤波器，缺任一即报错退出
- 需要 `curl`（或 `wget`）+ `tar`（支持 xz）

可调环境变量：

| 变量 | 默认 | 说明 |
|---|---|---|
| `FFMPEG_BRANCH` | `n8.1` | `n8.1` / `n9.0` / `master` |
| `FFMPEG_LICENSE` | `gpl` | `gpl` / `lgpl`（**lgpl 构建通常不含 libvmaf，不建议**） |
| `FFMPEG_URL` | 空 | 完整下载地址，覆盖上面的组合，用于**固定版本** |
| `FFMPEG_SHA256` | 空 | 压缩包 sha256，设置后强制校验 |

**固定版本示例**（推荐用于需要结果可复现的生产环境）：

```bash
FFMPEG_URL=https://github.com/FFmpeg-Builds/FFmpeg-Builds/releases/download/autobuild-2026-11-23-12-43/ffmpeg-n8.1.3-39-g660b5aa7db-linux64-gpl-8.1.tar.xz \
FFMPEG_SHA256=255b73431adc3c14f91533b6cf08090c0b1314f6789761140a196f820f6347a2 \
  ./scripts/setup-assets.sh --download
```

带版本号的 `autobuild-*` 标签资产是**不可变**的，`latest` 标签的资产会被覆盖。

#### 离线模式（`--offline`）

按顺序在本地候选目录找现成资产并复制：`$ASSET_SOURCE` → 项目自身 → `$ROOT/../python-autotest`
→ `$HOME/src/python-autotest` → `$HOME/src/perf-autotest`。要求来源含 `ffmpeg/bin/ffmpeg`、
`ffmpeg/bin/ffprobe`、`model/vmaf_v0.6.1.json`。

#### 版本差异对分数的影响

本服务最初使用的是一份 ffbuild 自建二进制（`N-122953`），改用 FFmpeg-Builds 的 `n8.1.3` 后实测：

| 指标 | 原二进制 | FFmpeg-Builds n8.1.3 | 差异 |
|---|---|---|---|
| PSNR | 29.808674 | 29.808674 | **完全一致** |
| SSIM | 0.923312 | 0.923312 | **完全一致** |
| VMAF | 64.165984 | 64.166166 | **+0.000182** |

PSNR/SSIM 逐位一致；VMAF 有约 1e-4 量级的实现差异（libvmaf 版本不同）。跨部署环境做横向对比时，应固定同一 `FFMPEG_URL`。

脚本会校验 `libvmaf` 滤波器是否存在，不存在则报错退出。

---

## 2. 快速部署（Docker Compose，推荐）

```bash
cd /path/to/FFmpegPortal
docker compose up -d --build
```

首次构建约需数分钟（镜像 **912 MB**）。随后校验：

```bash
docker compose ps                              # 期望 Up (healthy)
curl -s localhost:3000/readyz | jq .status     # 期望 "ready"
curl -s localhost:3000/api/config | jq         # 查看生效配置（cpuCores/threads/dataDir）
```

浏览器打开 `http://<服务器IP>:3000` 即为操作界面。

### 2.1 部署到其他目录 / 修改端口

`docker-compose.yml` 中改：

```yaml
ports:
  - "8080:3000"        # 宿主机 8080 → 容器 3000（容器内端口不要改）
```

### 2.2 常见自定义

```yaml
environment:
  AUTH_TOKEN: "your-token"      # 开启鉴权（内网可留空）
  MAX_FILE_MB: "4096"           # 允许更大的单文件
  RETENTION_DAYS: "30"          # 报告保留更久
  KEEP_INPUTS: "true"           # 保留待测原文件（磁盘消耗大）
cpus: 8.0                       # 机器核数多时提高
mem_limit: 8g
```

改完 `docker compose up -d` 生效（配置项为启动时读取，**修改需重启容器**）。

---

## 3. 手工部署（docker run）

不使用 Compose 时，**必须挂载可写的 `/data`**：

```bash
docker volume create portal-data

docker run -d \
  --name ffmpeg-portal \
  -p 3000:3000 \
  -v portal-data:/data \
  --cpus 4 --memory 4g \
  --read-only --tmpfs /tmp:size=2g \
  --shm-size 1g \
  --restart unless-stopped \
  --stop-timeout 20 \
  -e AUTH_TOKEN=your-token \
  -e RETENTION_DAYS=7 \
  ffmpeg-portal:1.0.0
```

参数说明：

| 参数 | 为什么需要 |
|---|---|
| `-v portal-data:/data` | **必需**。不挂载则 `/data` 不可写，容器启动即退出（§10.1） |
| `--read-only` + `--tmpfs /tmp` | 根文件系统只读；ffmpeg 与 npm 缓存需要可写 `/tmp` |
| `--shm-size 1g` | 防止长视频解码时共享内存不足 |
| `--stop-timeout 20` | 容器 20s 才强杀，给应用留出优雅停机时间 |
| `--restart unless-stopped` | 崩溃自动拉起（含 OOM） |

也可直接挂宿主机目录：`-v /srv/portal-data:/data`（注意宿主目录属主需可写，容器内以 uid `node`=1000 运行）。

---

## 4. 无 Docker 部署（本地 Node）

适合开发机、内网小规模验证。

```bash
cd /path/to/FFmpegPortal
npm ci                      # 仅生产依赖也可用 npm ci --omit=dev
DATA_DIR=./data npm start   # 默认监听 0.0.0.0:3000
```

要求 **Node ≥ 24**：依赖内置 `node:sqlite`（无需原生编译，无需 gcc/python）。

> 默认 `DATA_DIR` 在本地运行时为项目内 `./data`（自动创建）；容器内由镜像 `ENV DATA_DIR=/data` 覆盖。

### 4.1 用 systemd 托管

```ini
# /etc/systemd/system/ffmpeg-portal.service
[Unit]
Description=FFmpegPortal video quality scoring service
After=network.target

[Service]
Type=simple
User=portal
WorkingDirectory=/opt/FFmpegPortal
Environment=DATA_DIR=/var/lib/ffmpeg-portal
Environment=PORT=3000
Environment=CONCURRENCY=1
ExecStart=/usr/bin/node src/server.js
Restart=on-failure
RestartSec=5
# 优雅停机：SIGTERM 后最多等 20s
TimeoutStopSec=25

[Install]
WantedBy=multi-user.target
```

```bash
sudo useradd -r -s /sbin/nologin portal
sudo mkdir -p /var/lib/ffmpeg-portal && sudo chown portal: /var/lib/ffmpeg-portal
sudo systemctl daemon-reload && sudo systemctl enable --now ffmpeg-portal
```

---

## 5. 配置参考

全部通过环境变量配置，**启动时读取一次，修改后需重启**。

### 5.1 完整变量表

| 变量 | 默认值 | 取值范围 | 说明 |
|---|---|---|---|
| `PORT` | `3000` | 1–65535 | 监听端口 |
| `HOST` | `0.0.0.0` | — | 监听地址（仅本机可设 `127.0.0.1` 配合反向代理） |
| `DATA_DIR` | 容器 `/data`；本地 `./data` | 可写目录 | 数据根目录，见 §7 |
| `FFMPEG_PATH` | `<项目>/ffmpeg/bin/ffmpeg` | 文件路径 | 可执行文件 |
| `FFPROBE_PATH` | `<项目>/ffmpeg/bin/ffprobe` | 文件路径 | 可执行文件 |
| `VMAF_MODEL` | `<项目>/model/vmaf_v0.6.1.json` | 文件路径 | VMAF 模型 |
| `CONCURRENCY` | `1` | 1–16 | 同时运行的 ffmpeg 进程数 |
| `FFMPEG_THREADS` | 自动 = ⌊CPU核数 / CONCURRENCY⌋，限 1–16 | 1–64 | 单次评分的 VMAF 线程数 |
| `TIMEOUT_MS` | `1800000`（30 min） | ≥ 1000 | 单个视频评分超时，超时后杀进程并标记失败 |
| `MAX_FILE_MB` | `2048` | ≥ 1 | 单文件上限，超出返回 413 |
| `MAX_JOB_MB` | `5120` | ≥ 1 | 单任务总大小上限，超出返回 413 |
| `MAX_QUEUE` | `20` | ≥ 1 | 排队+运行中任务数上限，超出返回 429 |
| `RETENTION_DAYS` | `7` | ≥ 1 | 已结束任务与报告的保留天数 |
| `KEEP_INPUTS` | `false` | true/false | 是否保留待测原文件（默认报告生成后删除） |
| `AUTH_TOKEN` | 空（不鉴权） | 任意字符串 | 设置后所有 `/api` 需 `Authorization: Bearer <token>` |
| `LOG_LEVEL` | `info` | pino 级别 | `trace`/`debug`/`info`/`warn`/`error` |
| `NODE_ENV` | `production`（镜像内） | — | 保持 `production` |

> **取值非法会导致启动失败**（例如 `TIMEOUT_MS=800` 低于 1000、`CONCURRENCY=0`），这是刻意设计：宁可启动时报错，也不要运行期行为不确定。

### 5.2 CPU 与线程数的确定逻辑

1. 读取 cgroup 配额（容器限核）：`/sys/fs/cgroup/cpu.max`（v2）或 `cpu.cfs_quota_us`（v1）
2. 取不到配额则用 `os.availableParallelism()`
3. `FFMPEG_THREADS = clamp(⌊CPU核数 / CONCURRENCY⌋, 1, 16)`

例如 `--cpus 4, CONCURRENCY=1` → 4 线程（`/api/config` 里可核对 `cpuCores:4, ffmpegThreads:4`）。

### 5.3 并发策略建议

**默认 `CONCURRENCY=1` 是正确的**。原因：VMAF 本身已是多线程 CPU 密集任务，再叠加多进程并行会让各进程互相抢核心，**总吞吐不增反降**，且内存峰值不可控。

| 场景 | 建议 |
|---|---|
| 多人同时提交、机器 4 核 | 保持 `CONCURRENCY=1`，任务自然排队 |
| 机器 16 核以上、以吞吐为目标 | 可试 `CONCURRENCY=2`，同时把 `FFMPEG_THREADS` 显式设为 8 |
| 需要更高吞吐 | 更有效的是**多容器副本 + 前置负载均衡**（注意此时队列/DB 不共享，需按请求分发） |

---

## 6. 资源规划与性能实测

### 6.1 实测吞吐

环境：本机 32 核 x86-64，容器限制 `--cpus 4`，ffmpeg `N-122953`，素材 1920×1080 / 30fps。

| 指标组合 | 视频时长 | 耗时 | 折合速度 |
|---|---|---|---|
| PSNR + SSIM + VMAF | 10 s | 4.2 s | 2.37× 实时 |
| PSNR + SSIM + VMAF | 30 s | 12.4 s | 2.42× 实时 |
| PSNR + SSIM + VMAF | 60 s | 24.6 s | 2.44× 实时 |
| **仅 PSNR + SSIM** | 30 s | **3.1 s** | **9.8× 实时** |

**结论：VMAF 占总耗时的约 75–80%**。只勾 PSNR+SSIM 可提速约 4 倍。

### 6.2 容量换算（4 核 / 全三指标）

| 视频时长 | 单条耗时 | 100 条总耗时 | 每小时可处理素材 |
|---|---|---|---|
| 30 s | ≈ 12 s | ≈ 20 min | ≈ 150 min |
| 60 s | ≈ 25 s | ≈ 41 min | ≈ 145 min |
| 5 min | ≈ 2 min | ≈ 3.4 h | ≈ 122 min |

> 素材时长越长，单位开销越趋稳（固定启动开销被摊薄）。上表按 2.4× 实时折算后取保守值。

### 6.3 磁盘容量估算

| 项目 | 占用 |
|---|---|
| 镜像 | 912 MB |
| 构建上下文（含二进制） | ≈ 410 MB |
| 参考视频（保留） | **等于参考文件本身大小**，长期累积 |
| 单个任务报告 | 4–6 KB（CSV ≈ 0.3 KB） |
| **VMAF 逐帧日志** | ≈ **15 KB / 每秒视频**（60 s ≈ 930 KB，1 h ≈ 56 MB） |
| 待测原文件 | 默认评分后即删；`KEEP_INPUTS=true` 则等于原文件大小 |

**规划建议**：
- 参考视频要定期清理（`DELETE /api/references/:id`）——实测一个测试环境 219 MB / 3 个参考
- 若长期跑大量长视频，`RETENTION_DAYS` 不要设太大（VMAF 日志是大头）
- 按「每天 N 个任务 × 平均时长」估算日志量，预留 3 倍余量

---

## 7. 数据、持久化与清理

### 7.1 目录结构

```
/data/
├── db.sqlite  db.sqlite-wal  db.sqlite-shm     # 任务与参考元数据（WAL 模式）
├── refs/<referenceId>/source.<ext>              # 参考视频（长期保留）
└── jobs/<jobId>/
    ├── inputs/<itemId>.<ext>                    # 待测原文件（KEEP_INPUTS=false 时评分后删除）
    ├── logs/<itemId>.vmaf.json                  # VMAF 逐帧数据
    ├── logs/<itemId>.log                        # 失败时的 ffmpeg stderr
    ├── report.html                              # 自包含 HTML 报告
    ├── report.csv                               # UTF-8 BOM CSV
    └── result.json                              # 机器可读结果
```

### 7.2 备份与恢复

**备份**（服务运行中亦可，但建议先停）：

```bash
# Docker Compose 卷
docker run --rm -v portal-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/portal-backup-$(date +%F).tar.gz -C /data .

# 或手工拷贝：至少包含 db.sqlite（含 -wal/-shm）+ refs/
```

**恢复**：

```bash
docker compose down
docker run --rm -v portal-data:/data -v "$PWD":/backup alpine \
  sh -c 'rm -rf /data/* && tar xzf /backup/portal-backup-YYYY-MM-DD.tar.gz -C /data'
docker compose up -d
```

> 建议用 `sqlite3 db.sqlite "VACUUM INTO '/backup/db.sqlite'"` 做一致性快照，或直接停服务再复制。
> 恢复后若 DB 与目录不一致，启动时的**孤儿清扫**会删掉 DB 里没有的目录（属预期行为，但也意味着**只恢复目录、不恢复 DB 会导致数据被清理**）。

### 7.3 自动清理机制

| 机制 | 触发时机 | 行为 |
|---|---|---|
| **保留期清理** | 启动时 + 每最多 1 小时 | 删除 `finished_at` 早于 `RETENTION_DAYS` 的已完成/失败/已取消任务（目录 + DB 记录） |
| **孤儿清扫** | 启动时 + 每最多 1 小时 | 删除 `/data/jobs/*`、`/data/refs/*` 中 **DB 无对应记录**的目录 |
| 输入清理 | 任务收尾时 | `KEEP_INPUTS=false` 时删除该任务 `inputs/` |

**注意**：参考视频**不受保留期影响**，需手动删除：

```bash
curl -X DELETE localhost:3000/api/references/<referenceId>
```

### 7.4 手工清理示例

```bash
# 删除某个任务
curl -X DELETE localhost:3000/api/jobs/<jobId>

# 查看磁盘
docker exec ffmpeg-portal du -sh /data /data/refs /data/jobs
```

---

## 8. 反向代理与 HTTPS

服务本身只提供 HTTP。需要域名或 HTTPS 时用 nginx 等代理。**以下三点配错会导致上传失败**：

1. `client_max_body_size` —— 默认 1 MB，GB 级视频必失败（返回 413）
2. `proxy_request_buffering off` —— 关闭后请求体直接流式转发，避免 nginx 先落盘
3. 长超时 —— 大文件上传可能持续数分钟

```nginx
server {
    listen 443 ssl http2;
    server_name video-quality.example.com;

    ssl_certificate     /etc/nginx/ssl/fullchain.pem;
    ssl_certificate_key /etc/nginx/ssl/privkey.pem;

    # 上传大文件：需 >= MAX_FILE_MB，并留出余量
    client_max_body_size 2g;
    client_body_timeout  600s;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # 流式上传，不在 nginx 侧缓冲整个文件
        proxy_request_buffering off;

        # 上传与响应超时
        proxy_connect_timeout 30s;
        proxy_send_timeout    600s;
        proxy_read_timeout    600s;
    }
}
```

> **已知限制**：应用未启用 Fastify 的 `trustProxy`，因此日志里的客户端地址会是代理 IP。若需要真实 IP 审计，需自行在 `src/server.js` 中配置 `trustProxy` 后再构建。

---

## 9. 日常运维操作

### 9.1 健康检查

| 端点 | 语义 | 建议用途 |
|---|---|---|
| `GET /healthz` | 进程存活即 200 | 容器 `HEALTHCHECK` / 存活探针 |
| `GET /readyz` | 9 项自检全通过才 200，否则 **503** | 就绪探针、部署后验收 |
| `GET /api/config` | 当前生效配置 | 排障（查看 `cpuCores`、`ffmpegThreads`、`dataDir`） |

`/readyz` 检查项：`ffmpeg:exists` `ffprobe:exists` `ffmpeg:exec` `ffprobe:exec` `filter:psnr` `filter:ssim` `filter:libvmaf` `vmaf:model` `data:writable`

结果缓存 60 秒；加 `?force=1` 强制重跑（排查时用）。未就绪时**创建任务会被拒绝**（503 `NOT_READY`），避免堆积必然失败的任务。

### 9.2 日志

```bash
docker compose logs -f --tail=100          # compose
docker logs -f ffmpeg-portal               # 纯 docker
```

关键日志行：

| 日志 | 含义 |
|---|---|
| `服务配置与自检` + 各 `自检 PASS/FAIL xxx` | 启动自检结果 |
| `SIGTERM 收到，开始优雅停机` | 正在停机 |
| `[停机] HTTP 服务已关闭 (Nms)` | 停机分步耗时，用于确认没有卡住 |
| `服务停机，item 已退回排队等待重启后继续` | 停机打断了任务，重启后会续跑 |
| `启动恢复：N 个 item / M 个任务 从「进行中」回退为「排队」` | 崩溃/重启后的自动恢复 |
| `清理完成 {...}` | 保留期/孤儿清理执行了删除 |

`LOG_LEVEL=debug` 可看到每次请求（生产建议保持 `info`）。

### 9.3 启停与重启语义（重要）

| 操作 | 行为 | 耗时（实测） |
|---|---|---|
| `docker stop`（空闲） | 关闭 HTTP → 停队列 → 关库 → 退出 | ≈ 0.2 s |
| `docker stop`（任务运行中） | 额外杀掉 ffmpeg、把该 item 退回排队、**保留 inputs** | ≈ 1.2 s |
| `docker kill`（SIGKILL） | 立即死，DB 保留「进行中」状态 | 立即 |
| 重启后 | `recoverInterrupted()` 把「进行中」回退为「排队」，**任务自动续跑** | 自动 |

**两条恢复路径都已实测通过**：
- 优雅停机（SIGTERM）→ 重启 → 任务继续并**成功完成**
- 崩溃（`kill -9`）→ 重启 → 任务继续并**成功完成**

> 注意：续跑是**整个视频重算**，ffmpeg 不续传中间进度。一个 5 分钟视频若在 90% 处被中断，重启后会重新开始。

### 9.4 升级与回滚

```bash
# 升级：先备份（§7.2），再重建
docker compose down
git pull            # 或替换项目目录
docker compose up -d --build

# 回滚：指定旧镜像 tag
docker compose down
docker tag ffmpeg-portal:0.9.0 ffmpeg-portal:1.0.0   # 或修改 compose 里的 image
docker compose up -d
```

**升级前必读**：
- 数据库迁移是**向前兼容的轻量列补充**（`ALTER TABLE ADD COLUMN`，已存在则忽略），不提供逆向迁移
- 若新版本改动了表结构，**回滚到旧版本可能因缺少列而报错**——回滚请同时回滚 `/data` 备份
- 建议升级窗口内先 `docker compose down`，避免停机中断正在跑的任务（虽然会自动续跑）

### 9.5 监控建议

| 指标 | 采集方式 |
|---|---|
| 服务就绪 | `GET /readyz` 状态码（503 告警） |
| 队列积压 | `GET /api/jobs?status=queued` 计数 |
| 失败率 | `GET /api/jobs?status=failed` |
| 磁盘 | 监控 `/data` 使用率（参考视频与 VMAF 日志会累积） |
| CPU/内存 | 容器级指标；CPU 长期 100% 属正常（VMAF 计算），内存接近 `mem_limit` 需告警 |

---

## 10. 故障排查

### 10.1 容器启动即退出，日志提示「数据目录不可写」

```
[启动失败] 数据目录不可写: /data
  原因: EROFS: read-only file system, access '/data'
```

**原因**：`--read-only` 但没挂载 `/data` 卷。
**处理**：加 `-v <卷>:/data`（compose 默认已挂 `portal-data:/data`）。

### 10.2 容器起不来，日志提示「无法打开数据库」

```
[启动失败] 无法打开数据库: /data/db.sqlite
```

**处理**：
- 确认 `/data` 可写且不是只读挂载
- 若挂宿主机目录，确认属主可写：`sudo chown -R 1000:1000 /srv/portal-data`（容器内为 uid 1000）
- 检查磁盘是否已满：`df -h`

### 10.3 `/readyz` 返回 503

```bash
curl -s localhost:3000/readyz?force=1 | jq '.checks[] | select(.ok==false)'
```

| 失败项 | 原因 | 处理 |
|---|---|---|
| `ffmpeg:exists` / `ffprobe:exists` | 二进制缺失 | 重新构建镜像（确认构建上下文有 `ffmpeg/bin/`），或 `./scripts/setup-assets.sh` |
| `ffmpeg:exec` | 无法执行（权限/架构不符） | `docker exec ffmpeg-portal /app/bin/ffmpeg -version` 看具体报错；arm64 机器无法运行 |
| `filter:libvmaf` | 该 ffmpeg 未编译 libvmaf | 必须使用随项目分发的 ffmpeg，不要替换成系统 ffmpeg |
| `vmaf:model` | 模型文件缺失或 JSON 结构不符 | 检查 `model/vmaf_v0.6.1.json` 是否被 `.dockerignore` 排除或在构建时缺失 |
| `data:writable` | `/data` 不可写 | 同 §10.1 |

### 10.4 上传报 413

```
{ "error": { "code": "FILE_TOO_LARGE", ... } }
```

三种可能：
1. 文件超过 `MAX_FILE_MB`（默认 2048 MB）→ 调大该值
2. 任务总量超过 `MAX_JOB_MB`（默认 5120 MB）→ 调大或减少一次提交的待测数
3. **前面有 nginx** 且 `client_max_body_size` 太小 → 见 §8

### 10.5 上传报 429 `QUEUE_FULL`

排队中 + 运行中的任务已达 `MAX_QUEUE`（默认 20）。等任务完成，或调大该值。若长期打满，说明需要加机器/副本。

### 10.6 构建时 `npm ci` 失败

构建阶段会直连 npm registry。若目标机器不通：

```bash
# 方案：在可联网机器预置 node_modules，再用 .dockerignore 排除重装
# 或改用内网 npm 镜像后构建：
docker build --build-arg NPM_REGISTRY=https://registry.npmmirror.com ...
```

> 当前 Dockerfile 未暴露 `NPM_REGISTRY` 构建参数。若需要，可在 `RUN npm ci` 前加
> `RUN npm config set registry <镜像源>`。**这是需要改 Dockerfile 的动作**，本手册不假设已支持。

### 10.7 任务卡在 `running` 不动

可能原因：
- 视频极长且未超时（默认 30 min 超时）→ 看进度：`/api/jobs/<id>` 里 `compared` 是否有值
- ffmpeg 卡在解析异常文件 → 等 `TIMEOUT_MS` 到期自动失败

**处理**：`curl -X POST localhost:3000/api/jobs/<id>/cancel`；若仍无响应，重启容器（任务会自动续跑，若想终止则先取消再重启）。

### 10.8 任务失败，错误含 `ffmpeg 退出码 137`

被 OOM kill。调大 `mem_limit`（建议 ≥ 4 GB）或降低同时运行的任务数。

### 10.9 任务失败，错误含 `[PROBE_FAILED]` / `[UNSUPPORTED_MEDIA]`

文件不含视频流（纯音频）、文件损坏，或容器格式无法解析。用 `ffprobe` 先确认：

```bash
docker exec ffmpeg-portal /app/bin/ffprobe -v error -show_streams /path/to/file
```

### 10.10 分数看起来不合理（VMAF 个位数、PSNR 十几 dB）

这通常**不是服务故障**，而是素材本身不可比：

- 待测视频与参考内容不同（片头偏移、变速、剪切）→ 逐帧对不齐，分数无意义
- 帧率/分辨率相差极大 → 插帧或抽帧引入伪影

见 README「已知局限」。可用 `?maxDurationS=` 只比前 N 秒来验证是否对齐问题。

---

## 11. 安全加固清单

部署到内网也建议逐项确认：

- [ ] **开启鉴权**：设置 `AUTH_TOKEN`，客户端加 `Authorization: Bearer <token>`
- [ ] **不要暴露到公网**；若要，必须经反向代理 + HTTPS（§8）
- [ ] `--read-only` + `--tmpfs /tmp`（compose 已默认）
- [ ] 非 root 运行（镜像内 `USER node`，已默认）
- [ ] 限制资源：`--cpus` / `--memory`（防单个大任务拖垮宿主机）
- [ ] 限制上传：按需调低 `MAX_FILE_MB` / `MAX_JOB_MB` / `MAX_QUEUE`
- [ ] 定期备份 `/data`（§7.2）并验证可恢复
- [ ] 定期清理参考视频（不受保留期自动清理）
- [ ] 若用自签证书，注意浏览器上传时的混合内容限制

**已内建的安全措施**（无需额外配置）：
- 全部外部命令以**参数数组**调用，不经 shell，杜绝命令注入
- 上传文件名只用于展示（HTML 转义），落盘路径由服务端 id 生成，无路径穿越
- 流式落盘，不把大文件读入内存
- 报告 HTML 所有用户输入均转义（防 XSS）

**许可证提示**：内置 ffmpeg 为 **GPL 版**（`--enable-gpl`，含 libvmaf/x264 等）。内部部署无碍；**对外分发镜像需自行评估 GPL 合规性**。

---

## 12. 部署后验收清单

在部署机器上依次执行，全部通过才算部署成功。

### 12.1 分钟级冒烟

```bash
# 1) 就绪
curl -s localhost:3000/readyz | jq -r '.status'                  # ready

# 2) 环境自检（在容器内跑，验证 ffmpeg/模型/三指标真的可用）
docker exec ffmpeg-portal node scripts/selftest.js
#   期望末尾：=== 自检全部通过 ✅ ===
#   并打印 PSNR / SSIM / VMAF 三个数值
```

### 12.2 完整验收（三套脚本，可重复执行）

```bash
# REST 接口 + 错误码（35 项断言）
BASE=http://localhost:3000 ./scripts/smoke-api.sh

# 健壮性：超时/队列满/鉴权/未就绪/进程泄漏（17 项断言，需本机有 ffmpeg 与素材自动合成）
node scripts/smoke-robust.mjs

# 浏览器级（可选，需无头 Chrome）
google-chrome --headless --no-sandbox --disable-dev-shm-usage \
  --remote-debugging-port=9222 --user-data-dir=/tmp/cdp about:blank &
CDP=http://127.0.0.1:9222 PAGE=http://localhost:3000/ node scripts/smoke-ui.mjs
```

期望结果：`35/35`、`17/17`、`13/13`。

### 12.3 人工确认

- [ ] 浏览器打开首页，状态区显示「● 就绪」
- [ ] 上传一个参考视频 + 两个待测视频，勾选三指标，任务完成
- [ ] 打开 HTML 报告：表格有色阶、有 VMAF 条形图、页脚有限局声明
- [ ] 下载 CSV，用 Excel 打开中文不乱码（BOM 生效）
- [ ] 重启容器后再查该任务，状态与报告仍在
- [ ] （可选）任务运行中执行 `docker compose restart`，确认重启后任务自动续跑完成

---

## 13. 附录：错误码与接口速查

### 13.1 错误码表

响应体统一为 `{ "error": { "code", "message", "details?" } }`。

| HTTP | code | 触发条件 | 处理建议 |
|---|---|---|---|
| 400 | `INVALID_MULTIPART` | 表单结构非法 / 字段名不对（应为 `file`/`reference`/`targets`） | 检查客户端表单 |
| 400 | `NO_TARGETS` | 未提供待测视频 | 至少传一个 `targets` |
| 400 | `INVALID_METRICS` | 指标不在 `psnr,ssim,vmaf` 内或为空 | 修正 `metrics` |
| 400 | `INVALID_PARAM` | `fpsOverride`/`maxDurationS` 非正数 | 传正数或留空 |
| 401 | `UNAUTHORIZED` | 启用 `AUTH_TOKEN` 但未带/带错 token | 加 Bearer 头 |
| 404 | `JOB_NOT_FOUND` | 任务 id 不存在 | 核对 id |
| 404 | `REFERENCE_NOT_FOUND` | 参考 id 不存在 | 先上传参考 |
| 404 | `REPORT_NOT_READY` | 任务未完成就请求报告 | 轮询到 `done` 再取 |
| 409 | `JOB_ALREADY_FINISHED` | 对已结束任务取消 | 无需处理 |
| 413 | `FILE_TOO_LARGE` | 单文件超 `MAX_FILE_MB` | 调大或改 nginx（§8） |
| 413 | `JOB_TOO_LARGE` | 任务总量超 `MAX_JOB_MB` | 同上 |
| 415 | `UNSUPPORTED_MEDIA` | 无视频流（纯音频/损坏） | 换文件 |
| 422 | `PROBE_FAILED` | ffprobe 解析失败或元信息异常 | 用 ffprobe 排查（§10.9） |
| 422 | `NO_COMMON_OVERLAP` | 两路无公共可比时长 | 检查素材时长 |
| 429 | `QUEUE_FULL` | 排队+运行中达 `MAX_QUEUE` | 等待或调大（§10.5） |
| 500 | `FFMPEG_FAILED` | ffmpeg 非零退出（`details.stderrTail` 有末尾输出） | 看 stderr；137=OOM |
| 500 | `PARSE_FAILED` | ffmpeg 成功但指标解析不出 | 通常素材异常，附 stderr 反馈 |
| 500 | `TIMEOUT` | 超过 `TIMEOUT_MS` | 调大 `TIMEOUT_MS` |
| 503 | `NOT_READY` | 自检未通过 | 按 §10.3 逐项修 |
| 404 | `NOT_FOUND` | 路由不存在 | 核对路径 |

### 13.2 接口速查

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/` | 操作界面 |
| `GET` | `/healthz` | 存活探针 |
| `GET` | `/readyz` | 就绪探针（`?force=1` 跳过缓存） |
| `GET` | `/api/config` | 生效配置 |
| `POST` | `/api/references` | 上传参考（字段 `file`），相同内容自动复用 |
| `GET` | `/api/references` | 参考列表（`?limit=&offset=`） |
| `DELETE` | `/api/references/:id` | 删除参考（含文件） |
| `POST` | `/api/jobs` | 建任务（`referenceId` 或 `reference` 文件 + N×`targets` + `metrics`） |
| `GET` | `/api/jobs` | 任务列表（`?status=&limit=&offset=`） |
| `GET` | `/api/jobs/:id` | 任务详情与进度 |
| `POST` | `/api/jobs/:id/cancel` | 取消 |
| `DELETE` | `/api/jobs/:id` | 删除任务与产物 |
| `GET` | `/api/jobs/:id/report.csv` | CSV 下载 |
| `GET` | `/api/jobs/:id/report.html` | HTML 报告 |
| `GET` | `/api/jobs/:id/result.json` | 机器可读结果 |

### 13.3 最小 curl 示例

```bash
BASE=http://localhost:3000

# 上传参考
REF=$(curl -s -F "file=@ref.mp4" $BASE/api/references | jq -r .referenceId)

# 建任务（两个待测，全三指标）
JOB=$(curl -s -F "referenceId=$REF" \
           -F "targets=@a.mp4" -F "targets=@b.mp4" \
           -F "metrics=psnr,ssim,vmaf" \
           $BASE/api/jobs | jq -r .jobId)

# 轮询
while :; do
  S=$(curl -s $BASE/api/jobs/$JOB | jq -r .status)
  echo "status=$S"
  case "$S" in done|failed|canceled) break;; esac
  sleep 2
done

# 取报告
curl -s -o report.html $BASE/api/jobs/$JOB/report.html
curl -s -o report.csv  $BASE/api/jobs/$JOB/report.csv
```
