/**
 * 上传处理：流式落盘、大小限制、sha256 计算。
 * 安全要点：文件名不可信 → 只用于展示；落盘路径完全由服务端 id 生成。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { finished } from 'node:stream/promises';

import { AppError } from './errors.js';

/** 生成形如 ref_2f8c1a5d9b3e 的短 id */
export function newId(prefix) {
  return `${prefix}_${randomBytes(6).toString('hex')}`;
}

/** 只保留安全的扩展名（用于给 ffmpeg 提示容器格式），其余一律 .bin */
const SAFE_EXT = /^\.(mp4|m4v|mov|mkv|webm|avi|flv|wmv|ts|m2ts|mts|3gp|mpg|mpeg|vob|rmvb|rm|ogv|mxf|y4m)$/i;

export function safeExtension(origName) {
  const ext = path.extname(String(origName ?? '')).toLowerCase();
  return SAFE_EXT.test(ext) ? ext : '.bin';
}

/** 展示用的文件名清洗（不含路径、去控制字符、限长） */
export function sanitizeDisplayName(origName) {
  const base = path.basename(String(origName ?? 'unnamed'));
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return (cleaned || 'unnamed').slice(0, 200);
}

/**
 * 把一个 multipart 文件 part 流式写入目标路径，并计算 sha256。
 * @param {object} part @fastify/multipart 的 part
 * @param {string} destPath
 * @param {{maxBytes:number}} opts
 * @returns {Promise<{bytes:number, sha256:string}>}
 */
export async function savePartToFile(part, destPath, { maxBytes }) {
  const stream = part.file ?? part;
  const hash = createHash('sha256');
  const ws = createWriteStream(destPath, { flags: 'wx' });
  let bytes = 0;

  const cleanup = async () => {
    ws.destroy();
    await fsp.rm(destPath, { force: true }).catch(() => {});
  };

  try {
    for await (const chunk of stream) {
      bytes += chunk.length;
      if (maxBytes && bytes > maxBytes) {
        throw new AppError(
          'FILE_TOO_LARGE',
          `文件 ${sanitizeDisplayName(part.filename)} 超过单文件上限 ${(maxBytes / 1024 / 1024).toFixed(0)} MB`,
        );
      }
      hash.update(chunk);
      if (!ws.write(chunk)) {
        await new Promise((resolve) => ws.once('drain', resolve));
      }
    }
    ws.end();
    await finished(ws);
  } catch (err) {
    await cleanup();
    throw err;
  }

  if (stream.truncated) {
    await cleanup();
    throw new AppError('FILE_TOO_LARGE', `文件 ${sanitizeDisplayName(part.filename)} 超过服务端限制被截断`);
  }
  if (bytes === 0) {
    await cleanup();
    throw new AppError('INVALID_MULTIPART', '上传的文件为空');
  }

  return { bytes, sha256: hash.digest('hex') };
}

/** 确保目录存在 */
export async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

/** 读取目录大小（用于清理报告） */
export function dirSizeSync(dir) {
  let total = 0;
  if (!fs.existsSync(dir)) return 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) total += dirSizeSync(p);
    else if (entry.isFile()) total += fs.statSync(p).size;
  }
  return total;
}

/** 安全删除目录（幂等） */
export async function removeDir(dir) {
  await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
}
