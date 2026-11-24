/**
 * 参考视频接口。
 * 权威依据：docs/web-service-design.md §4.3
 */
import path from 'node:path';
import fsp from 'node:fs/promises';

import { AppError } from '../lib/errors.js';
import { probeVideo } from '../lib/ffprobe.js';
import { newId, safeExtension, sanitizeDisplayName, savePartToFile, ensureDir, removeDir } from '../lib/upload.js';

export async function registerReferenceRoutes(app, { cfg, db }) {
  /** 上传并登记参考视频；相同内容自动复用 */
  app.post('/api/references', async (req, reply) => {
    if (!req.isMultipart()) {
      throw new AppError('INVALID_MULTIPART', '请求必须是 multipart/form-data', { status: 400 });
    }

    const part = await req.file({ limits: { fileSize: cfg.maxFileMb * 1024 * 1024 } });
    if (!part) throw new AppError('INVALID_MULTIPART', '缺少文件字段 file', { status: 400 });
    if (part.fieldname !== 'file' && part.fieldname !== 'reference') {
      throw new AppError('INVALID_MULTIPART', `不支持的文件字段 ${part.fieldname}，应为 file`, { status: 400 });
    }

    const id = newId('ref');
    const refDir = await ensureDir(path.join(cfg.refsDir, id));
    const origName = sanitizeDisplayName(part.filename);
    const ext = safeExtension(origName);
    const storedPath = path.join(refDir, `source${ext}`);

    let saved;
    try {
      saved = await savePartToFile(part, storedPath, { maxBytes: cfg.maxFileMb * 1024 * 1024 });
    } catch (err) {
      await removeDir(refDir);
      throw err;
    }

    // 相同内容复用（避免重复上传大文件）
    const existing = db.findReferenceBySha(saved.sha256);
    if (existing && (await fsp.stat(existing.storedPath).then(() => true).catch(() => false))) {
      await removeDir(refDir);
      db.touchReference(existing.id);
      reply.code(200);
      return { referenceId: existing.id, reuse: true, probe: existing.probe, sizeBytes: existing.sizeBytes, createdAt: existing.createdAt };
    }

    let probe;
    try {
      probe = await probeVideo(cfg.ffprobePath, storedPath);
    } catch (err) {
      await removeDir(refDir);
      throw new AppError(err.code ?? 'PROBE_FAILED', `参考视频探测失败: ${err.message}`, {
        status: 422,
        details: undefined,
      });
    }

    const ref = db.insertReference({
      id,
      origName,
      storedPath,
      sizeBytes: saved.bytes,
      sha256: saved.sha256,
      probe,
      createdAt: new Date().toISOString(),
    });

    reply.code(201);
    return {
      referenceId: ref.id,
      reuse: false,
      origName: ref.origName,
      probe: ref.probe,
      sizeBytes: ref.sizeBytes,
      createdAt: ref.createdAt,
    };
  });

  /** 参考视频列表 */
  app.get('/api/references', async (req) => {
    const limit = Math.min(Number(req.query?.limit ?? 50) || 50, 200);
    const offset = Math.max(Number(req.query?.offset ?? 0) || 0, 0);
    const items = db.listReferences({ limit, offset });
    return {
      items: items.map((r) => ({
        referenceId: r.id,
        origName: r.origName,
        sizeBytes: r.sizeBytes,
        probe: r.probe,
        createdAt: r.createdAt,
        lastUsedAt: r.lastUsedAt,
      })),
      limit,
      offset,
    };
  });

  /** 删除参考视频（含磁盘文件） */
  app.delete('/api/references/:id', async (req, reply) => {
    const ref = db.getReference(req.params.id);
    if (!ref) throw new AppError('REFERENCE_NOT_FOUND', `参考视频不存在: ${req.params.id}`, { status: 404 });
    await removeDir(path.dirname(ref.storedPath));
    db.deleteReference(ref.id);
    reply.code(204);
    return null;
  });
}
