/**
 * 健康与就绪探针。
 * 权威依据：docs/web-service-design.md §4.2 §9
 */
import { describeConfig } from '../config.js';

export async function registerHealthRoutes(app, { cfg, selfCheck }) {

  // 存活探针：进程活着即 200
  app.get('/healthz', async () => ({ status: 'ok', uptimeS: Math.round(process.uptime()) }));

  // 就绪探针：ffmpeg/ffprobe/模型自检通过才 200，否则 503
  app.get('/readyz', async (req, reply) => {
    const force = req.query?.force === '1' || req.query?.force === 'true';
    const result = await selfCheck.fresh(force);
    reply.code(result.ok ? 200 : 503);
    return {
      status: result.ok ? 'ready' : 'not_ready',
      checks: result.checks,
      versions: result.versions,
    };
  });

  // 运行时配置（便于排障；不含敏感值）
  app.get('/api/config', async () => describeConfig(cfg));
}
