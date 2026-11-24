/**
 * 子进程执行封装：超时、进程组终止、输出截断。
 * 安全要点：一律 spawn(bin, argsArray)，绝不经过 shell。
 */
import { spawn } from 'node:child_process';

const HEAD_BYTES = 64 * 1024;
const TAIL_BYTES = 1024 * 1024;

/** 保留头部与尾部、丢弃中段的缓冲器（ffmpeg 进度输出可能很大） */
class HeadTailBuffer {
  constructor(headLimit = HEAD_BYTES, tailLimit = TAIL_BYTES) {
    this.headLimit = headLimit;
    this.tailLimit = tailLimit;
    this.head = '';
    this.tail = '';
    this.truncated = false;
    this.bytes = 0;
  }

  push(chunk) {
    const s = chunk.toString('utf8');
    this.bytes += Buffer.byteLength(s);
    let rest = s;
    // 先填头部；只有溢出部分才进尾部，保证 head + tail 不重复
    if (this.head.length < this.headLimit) {
      const room = this.headLimit - this.head.length;
      this.head += rest.slice(0, room);
      rest = rest.slice(room);
    }
    if (rest) {
      this.tail += rest;
      if (this.tail.length > this.tailLimit) {
        this.truncated = true;
        this.tail = this.tail.slice(-this.tailLimit);
      }
    }
  }

  toString() {
    if (!this.truncated) return this.head + this.tail;
    return `${this.head}\n...[中段 ${this.bytes} 字节已截断]...\n${this.tail}`;
  }
}

/**
 * @returns {Promise<{code:number|null, signal:string|null, stdout:string, stderr:string, timedOut:boolean, elapsedMs:number}>}
 */
export function runProcess(bin, args, { timeoutMs = 0, cwd, onChild } = {}) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const stdout = new HeadTailBuffer();
    const stderr = new HeadTailBuffer();
    let timedOut = false;
    let settled = false;

    let child;
    try {
      child = spawn(bin, args, {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true, // 独立进程组，便于连带子进程一起终止
      });
    } catch (err) {
      reject(err);
      return;
    }

    const killGroup = (signal) => {
      try {
        process.kill(-child.pid, signal);
      } catch {
        try {
          child.kill(signal);
        } catch {
          /* 已退出 */
        }
      }
    };

    let killTimer = null;
    if (timeoutMs > 0) {
      killTimer = setTimeout(() => {
        timedOut = true;
        killGroup('SIGTERM');
        // 宽限 5s，仍在跑则强杀
        setTimeout(() => killGroup('SIGKILL'), 5000).unref?.();
      }, timeoutMs);
      killTimer.unref?.();
    }

    // 允许调用方注册「外部取消」能力（任务取消时终止该进程组）
    if (typeof onChild === 'function') {
      try {
        onChild({
          pid: child.pid,
          kill: (signal = 'SIGTERM') => killGroup(signal),
        });
      } catch {
        /* 回调异常不应影响主流程 */
      }
    }

    child.stdout.on('data', (c) => stdout.push(c));
    child.stderr.on('data', (c) => stderr.push(c));

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      if (killTimer) clearTimeout(killTimer);
      reject(err);
    });

    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      if (killTimer) clearTimeout(killTimer);
      resolve({
        code,
        signal,
        stdout: stdout.toString(),
        stderr: stderr.toString(),
        timedOut,
        elapsedMs: Date.now() - startedAt,
      });
    });
  });
}

/** 探测可执行文件是否可用，返回版本首行 */
export async function probeBinaryVersion(bin) {
  const res = await runProcess(bin, ['-hide_banner', '-version'], { timeoutMs: 15000 });
  if (res.code !== 0) {
    throw new Error(`${bin} 无法执行 (code=${res.code}): ${res.stderr.slice(0, 500)}`);
  }
  return res.stdout.split('\n')[0]?.trim() || '(unknown)';
}

/** 列出 ffmpeg 支持的滤波器名（用于自检 psnr/ssim/libvmaf） */
export async function listFilters(bin) {
  const res = await runProcess(bin, ['-hide_banner', '-filters'], { timeoutMs: 20000 });
  if (res.code !== 0) throw new Error(`ffmpeg -filters 失败: ${res.stderr.slice(0, 500)}`);
  const names = new Set();
  for (const line of res.stdout.split('\n')) {
    const m = /^\s*[A-Z.|\s]{2,6}\s+(\S+)\s+\S+->\S+/.exec(line);
    if (m) names.add(m[1]);
  }
  return names;
}
