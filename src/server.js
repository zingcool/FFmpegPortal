/**
 * 服务入口。
 * 权威依据：docs/web-service-design.md §3 §8.3
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyMultipart from '@fastify/multipart';

import { config, ensureDataDirs, describeConfig } from './config.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerReferenceRoutes } from './routes/references.js';
import { registerJobRoutes } from './routes/jobs.js';
import { openDb } from './lib/db.js';
import { JobQueue } from './lib/queue.js';
import { runSelfCheck, createSelfCheckCache } from './lib/selfcheck.js';
import { CleanupService } from './lib/cleanup.js';
import { toHttpError } from './lib/errors.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function buildApp(cfg = config) {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      transport:
        cfg.env === 'development' && process.env.LOG_PRETTY === '1' ? { target: 'pino-pretty' } : undefined,
    },
    bodyLimit: 8 * 1024 * 1024, // JSON 请求体上限（文件走 multipart 流式，不受此限）
  });

  // 统一错误响应：{ error: { code, message, details } }
  app.setErrorHandler((err, req, reply) => {
    const { status, code, message, details } = toHttpError(err);
    if (status >= 500) req.log.error({ err }, '请求处理失败');
    reply.code(status).send({ error: { code, message, ...(details ? { details } : {}) } });
  });

  app.setNotFoundHandler((req, reply) => {
    reply.code(404).send({ error: { code: 'NOT_FOUND', message: `未找到路由 ${req.method} ${req.url}` } });
  });

  // ---- 基础设施 ----
  ensureDataDirs(cfg);
  const db = openDb(cfg.dbPath);

  // 自检拿到 ffmpeg 版本（写进报告页脚）
  let ffmpegVersion = '';
  try {
    const self = await runSelfCheck(cfg);
    ffmpegVersion = self.versions?.ffmpeg ?? '';
  } catch {
    /* 自检失败不阻止启动，/readyz 会反映 */
  }

  const queue = new JobQueue({ db, cfg, log: app.log, ffmpegVersion });
  const selfCheck = createSelfCheckCache(cfg);
  const cleanup = new CleanupService({ cfg, db, log: app.log });

  // ---- 可选鉴权 ----
  if (cfg.authToken) {
    app.addHook('onRequest', async (req, reply) => {
      const open = ['/healthz', '/readyz'];
      if (open.includes(req.url.split('?')[0])) return;
      const auth = req.headers.authorization ?? '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
      if (token !== cfg.authToken) {
        reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: '需要有效的 Bearer Token' } });
      }
    });
  }

  // ---- multipart（流式，不落内存） ----
  await app.register(fastifyMultipart, {
    limits: {
      fileSize: cfg.maxFileMb * 1024 * 1024,
      files: 201,
      fields: 20,
      parts: 220,
    },
  });

  // ---- 路由 ----
  await app.register(registerHealthRoutes, { cfg, selfCheck });
  await app.register(registerReferenceRoutes, { cfg, db });
  await app.register(registerJobRoutes, { cfg, db, queue, selfCheck });

  // 静态资源（极简单页）
  await app.register(fastifyStatic, {
    root: path.join(__dirname, 'public'),
    prefix: '/',
    index: ['index.html'],
  });

  // 暴露给 main 做生命周期收尾
  app.decorate('resources', { db, queue, cleanup, selfCheck, ffmpegVersion });
  return app;
}

async function main() {
  // 预检数据目录：这是部署最常见的配置错误，给出可操作的提示而不是底层堆栈
  try {
    ensureDataDirs(config);
    fs.accessSync(config.dataDir, fs.constants.W_OK);
  } catch (err) {
    console.error(
      `\n[启动失败] 数据目录不可写: ${config.dataDir}\n` +
        `  原因: ${err.message}\n` +
        `  处理: 挂载可写卷（docker run -v <卷>:/data，compose 默认已挂 portal-data:/data）\n` +
        `        本地运行请设置 DATA_DIR=<可写目录>\n`,
    );
    process.exit(1);
  }

  let app;
  try {
    app = await buildApp(config);
  } catch (err) {
    if (/unable to open database file|SQLITE/i.test(String(err?.message ?? err))) {
      console.error(
        `\n[启动失败] 无法打开数据库: ${config.dbPath}\n` +
          `  原因: ${err.message}\n` +
          `  处理: 确认 ${config.dataDir} 可写，且未被只读挂载\n`,
      );
      process.exit(1);
    }
    throw err;
  }

  app.ready().then(async () => {
    const res = await app.inject({ method: 'GET', url: '/readyz' });
    const body = res.json();
    app.log.info({ config: describeConfig(config), ready: body.status }, '服务配置与自检');
    for (const c of body.checks ?? []) {
      const msg = `自检 ${c.ok ? 'PASS' : 'FAIL'} ${c.name}: ${c.detail}`;
      if (c.ok) app.log.info(msg);
      else app.log.error(msg);
    }
  });

  app.resources.queue.start();
  app.resources.cleanup.start();
  await app.listen({ port: config.port, host: config.host });

  // 优雅停机：停止接新请求 → 终止在跑的 ffmpeg → 关库
  let shuttingDown = false;
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      const t0 = Date.now();
      const since = () => `${Date.now() - t0}ms`;
      app.log.info(`${signal} 收到，开始优雅停机`);
      const timer = setTimeout(() => {
        app.log.error(`优雅停机超时（${since()}），强制退出`);
        process.exit(1);
      }, 20_000);
      timer.unref?.();
      try {
        const { queue: q, cleanup, db } = app.resources;
        await app.close();
        app.log.info(`[停机] HTTP 服务已关闭 (${since()})`);
        await q.shutdown();
        app.log.info(`[停机] 任务队列已停止 (${since()})`);
        cleanup.stop();
        db.close();
        app.log.info(`[停机] 资源已释放，退出 (${since()})`);
        // process.exit 会截断仍在缓冲中的日志：先 flush 再退出
        if (typeof app.log.flush === 'function') {
          await new Promise((resolve) => app.log.flush(resolve));
        }
        process.exit(0);
      } catch (err) {
        app.log.error({ err }, '停机时出错');
        process.exit(1);
      }
    });
  }
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main().catch((err) => {
    console.error('启动失败:', err);
    process.exit(1);
  });
}
