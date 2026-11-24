/**
 * 统一错误模型与 HTTP 状态码映射。
 * 权威依据：docs/web-service-design.md §9
 */

export class AppError extends Error {
  constructor(code, message, { status, details } = {}) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    // 未显式指定状态码时查表（否则一律 500，会把 413/429 等错误码埋掉）
    this.status = status ?? STATUS_BY_CODE[code] ?? 500;
    this.details = details;
  }
}

/** 错误码 → HTTP 状态码 */
export const STATUS_BY_CODE = {
  INVALID_MULTIPART: 400,
  NO_TARGETS: 400,
  INVALID_METRICS: 400,
  INVALID_PARAM: 400,
  UNAUTHORIZED: 401,
  JOB_NOT_FOUND: 404,
  REFERENCE_NOT_FOUND: 404,
  REPORT_NOT_READY: 404,
  JOB_ALREADY_FINISHED: 409,
  FILE_TOO_LARGE: 413,
  JOB_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA: 415,
  PROBE_FAILED: 422,
  NO_COMMON_OVERLAP: 422,
  QUEUE_FULL: 429,
  FFMPEG_FAILED: 500,
  PARSE_FAILED: 500,
  TIMEOUT: 500,
  INTERNAL: 500,
  NOT_READY: 503,
};

/** @fastify/multipart / 其他库的错误码映射 */
const LIB_ERROR_MAP = {
  FST_REQ_FILE_TOO_LARGE: ['FILE_TOO_LARGE', 413],
  FST_FILES_LIMIT: ['FILE_TOO_LARGE', 413],
  FST_PARTS_LIMIT: ['JOB_TOO_LARGE', 413],
  FST_FIELDS_LIMIT: ['INVALID_MULTIPART', 400],
  FST_INVALID_MULTIPART_CONTENT_TYPE: ['INVALID_MULTIPART', 400],
  FST_INVALID_MULTIPART_CONTENT_LENGTH: ['INVALID_MULTIPART', 400],
  FST_ERR_CTP_BODY_TOO_LARGE: ['JOB_TOO_LARGE', 413],
};

/** 把任意异常规范化为 { status, code, message, details } */
export function toHttpError(err) {
  if (err && typeof err.code === 'string' && LIB_ERROR_MAP[err.code]) {
    const [code, status] = LIB_ERROR_MAP[err.code];
    return { status, code, message: err.message };
  }
  if (err instanceof AppError) {
    return { status: err.status ?? STATUS_BY_CODE[err.code] ?? 500, code: err.code, message: err.message, details: err.details };
  }
  // 来自 lib 的错误（带 code 属性）
  if (err && typeof err.code === 'string' && STATUS_BY_CODE[err.code]) {
    return { status: STATUS_BY_CODE[err.code], code: err.code, message: err.message, details: err.details };
  }
  return { status: 500, code: 'INTERNAL', message: err?.message ?? '未知错误', details: undefined };
}
