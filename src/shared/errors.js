export class AppError extends Error {
  constructor(status, message, options = {}) {
    super(message, options);
    this.name = 'AppError';
    this.status = status;
  }
}

export function badRequest(message) {
  return new AppError(400, message);
}

export function unauthorized(message = '请先登录') {
  return new AppError(401, message);
}

export function forbidden(message = '没有权限') {
  return new AppError(403, message);
}

export function notFound(message = 'not found') {
  return new AppError(404, message);
}

export function conflict(message) {
  return new AppError(409, message);
}
