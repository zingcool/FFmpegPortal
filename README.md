# FFmpegPortal

视频画质评分 Web 服务：**上传 1 个参考视频 + N 个待测视频，批量计算 PSNR / SSIM / VMAF，产出 CSV 与自包含 HTML 报告。**

从 `python-autotest` 仓库的离线评分脚本演进而来，重写为可部署的服务：Node.js（Fastify）+ SQLite + 文件存储 + Docker。

> 📘 **部署到服务器、配置调优、故障排查、备份恢复** → 见 [DEPLOYMENT.md](DEPLOYMENT.md)

---

## 特性

| 能力 | 说明 |
|---|---|
| 批量对比 | 1 个参考 + 多个待测，一次任务出全部结果 |
| 三项指标 | PSNR（平均/最差帧）、SSIM、VMAF（均值/最差帧/谐波均值） |
| 自动归一化 | 分辨率、帧率、时长、像素格式、SAR、旋转——**两路都归一化** |
| 两种报告 | `report.csv`（UTF-8 BOM，Excel 直开）+ `report.html`（自包含，无 CDN，离线可看） |
| 实时进度 | 极简单页 1s 轮询，逐项状态可见 |
| 任务管理 | 队列、并发限流、超时、取消、删除、保留期清理 |
| 可靠性 | 重启/崩溃后任务自动恢复；无 ffmpeg 进程与临时文件泄漏 |
| 安全 | 参数数组调用（无 shell 拼接）、流式落盘、非 root、只读根、可选 Bearer Token |

---

## 快速开始

> 生产部署（含反向代理、资源规划、运维手册）请看 [DEPLOYMENT.md](DEPLOYMENT.md)。

> ⚠️ **克隆后第一步**：`ffmpeg` 二进制（各约 192MB）不入库，需先置备资产，否则无法运行：
> ```bash
> ./scripts/setup-assets.sh          # 或 ASSET_SOURCE=/path/to/assets ./scripts/setup-assets.sh
> ```

### 方式一：Docker（推荐）

```bash
docker compose up -d --build
curl -s localhost:3000/readyz | jq
```

浏览器打开 <http://localhost:3000>。

### 方式二：本地 Node

```bash
# 需要 Node >= 24（使用内置 node:sqlite）
npm ci
DATA_DIR=./data npm start
```

若 `ffmpeg/bin/` 或 `model/` 缺失：

```bash
./scripts/setup-assets.sh        # 或 ASSET_SOURCE=/path/to/assets ./scripts/setup-assets.sh
```

---

## 验证（四套脚本，全部可重复执行）

```bash
npm run selftest        # 环境自检 + 合成素材端到端评分
npm run smoke:api       # 35 项 REST 断言（含 8 个错误码）
npm run smoke:robust    # 17 项健壮性断言（超时/队列满/鉴权/未就绪/进程泄漏）
```

浏览器级验收（需先启动无头 Chrome）：

```bash
google-chrome --headless --no-sandbox --disable-dev-shm-usage \
  --remote-debugging-port=9222 --user-data-dir=/tmp/chrome-e2e about:blank &
BASE=http://127.0.0.1:3000 npm run smoke:ui
```

预期结果：`selftest` 全绿；`smoke:api` 35/35；`smoke:robust` 17/17；`smoke:ui` 13/13。

---

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/api/references` | 上传参考视频（相同内容自动复用） |
| `GET` | `/api/references` | 参考视频列表 |
| `DELETE` | `/api/references/:id` | 删除参考视频 |
| `POST` | `/api/jobs` | 创建任务：`referenceId` 或 `reference` 文件 + N 个 `targets` |
| `GET` | `/api/jobs` | 任务列表 |
| `GET` | `/api/jobs/:id` | 任务详情（含逐项指标与进度） |
| `POST` | `/api/jobs/:id/cancel` | 取消任务 |
| `DELETE` | `/api/jobs/:id` | 删除任务与产物 |
| `GET` | `/api/jobs/:id/report.csv` | 下载 CSV |
| `GET` | `/api/jobs/:id/report.html` | 查看 HTML 报告 |
| `GET` | `/api/jobs/:id/result.json` | 机器可读结果 |
| `GET` | `/healthz` `/readyz` | 健康 / 就绪探针 |

命令行示例：

```bash
# 1) 上传参考
REF=$(curl -s -F "file=@ref.mp4" localhost:3000/api/references | jq -r .referenceId)

# 2) 建任务（可多个 targets）
JOB=$(curl -s -F "referenceId=$REF" \
           -F "targets=@a.mp4" -F "targets=@b.mp4" \
           -F "metrics=psnr,ssim,vmaf" \
           localhost:3000/api/jobs | jq -r .jobId)

# 3) 轮询 → 取报告
curl -s localhost:3000/api/jobs/$JOB | jq '.status, .progress'
curl -s -o report.html localhost:3000/api/jobs/$JOB/report.html
```

错误响应统一为 `{ "error": { "code", "message", "details?" } }`，常见码：
`NO_TARGETS` `INVALID_METRICS` `REFERENCE_NOT_FOUND` `JOB_NOT_FOUND` `REPORT_NOT_READY`
`FILE_TOO_LARGE`(413) `JOB_TOO_LARGE`(413) `UNSUPPORTED_MEDIA`(415) `PROBE_FAILED`(422)
`QUEUE_FULL`(429) `JOB_ALREADY_FINISHED`(409) `NOT_READY`(503) `UNAUTHORIZED`(401)。

---

## 配置（环境变量）

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` / `HOST` | `3000` / `0.0.0.0` | 监听地址 |
| `DATA_DIR` | `/data` | 数据根目录（SQLite、参考片、任务产物） |
| `FFMPEG_PATH` / `FFPROBE_PATH` | 项目内 `ffmpeg/bin/*` | 可执行文件路径 |
| `VMAF_MODEL` | 项目内 `model/vmaf_v0.6.1.json` | VMAF 模型 |
| `CONCURRENCY` | `1` | 同时运行的 ffmpeg 进程数 |
| `FFMPEG_THREADS` | 按 cgroup 配额自动 | 单次评分的线程数 |
| `TIMEOUT_MS` | `1800000` | 单视频评分超时 |
| `MAX_FILE_MB` / `MAX_JOB_MB` / `MAX_QUEUE` | `2048` / `5120` / `20` | 容量限制 |
| `RETENTION_DAYS` | `7` | 任务与报告保留天数（到期清理） |
| `KEEP_INPUTS` | `false` | 是否保留待测原文件 |
| `AUTH_TOKEN` | 空 | 设置后所有 `/api` 需 `Authorization: Bearer <token>` |

---

## 架构

```
public/index.html ──multipart──▶ Fastify
                                  ├─ upload  流式落盘 + sha256 去重
                                  ├─ ffprobe 探测 → 归一化参数决策
                                  ├─ queue   SQLite 状态机 + 信号量 + 取消/超时
                                  ├─ ffmpeg  单条 filter_complex 跑完所有指标
                                  └─ report  CSV + 自包含 HTML
                                        │
                /data/{db.sqlite, refs/, jobs/<id>/{inputs,logs,report.*}}
```

关键实现取舍：

- **单条滤镜链**：`scale→setsar→fps→format→setpts→trim` 后 `split=N` 给各指标。同一路流**必须 split** 才能被多个滤镜消费；把三个指标放在一次解码里，实测比多进程快 6–7 倍。
- **两路都归一化**：原脚本只缩放待测片，用户上传的 VFR / 帧率不一致视频会导致逐帧对不齐。
- **时长取 min(参考, 待测)**：报告显式写出「比较了多少秒/帧」。
- **并发=1**：VMAF 已是多线程 CPU 密集任务，多进程并行会互相抢核，吞吐不增反降。
- **失败显式化**：解析不出指标就标 `failed` 并记录原因，**绝不用 0 兜底**（0 与「画质极差」无法区分）。

---

## 已知局限

1. PSNR/SSIM/VMAF 要求**逐帧空间对应**。本服务对齐了分辨率、帧率、时长与起始点，但**不做内容级时间轴纠偏**；若待测片相对参考存在片头偏移、变速或剪切，分数会失真且不可信。
2. 帧率取两路较小值：待测片帧率更低时参考片会被抽帧，反之待测片会被插帧。
3. VMAF 是空间域指标，不反映音频质量、卡顿或主观色彩偏好。
4. 报告只展示池化值，不含逐帧曲线。
5. ffmpeg 二进制为 **x86-64 + GPL 版**（含 libvmaf/x264 等）：仅支持 x86-64 部署；对外分发镜像需评估 GPL 合规。

---

## 目录

```
├── Dockerfile              # 多阶段构建（上下文=项目根）
├── docker-compose.yml
├── package.json
├── ffmpeg/bin/             # ffmpeg + ffprobe（必需资产，约 400MB，**不入库**）
├── model/vmaf_v0.6.1.json  # VMAF 模型（入库）
├── src/
│   ├── server.js           # 入口：插件、错误处理、优雅停机
│   ├── config.js           # 环境变量 + cgroup CPU 探测
│   ├── lib/                # runner/ffprobe/normalize/ffmpeg/queue/db/report/upload/cleanup/selfcheck/errors
│   ├── routes/             # health / references / jobs
│   └── public/index.html   # 极简单页
└── scripts/                # selftest + three smoke suites + setup-assets
```
