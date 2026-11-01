import crypto from 'node:crypto';
import { countUsers, createUser, findUserByUsername } from '../data/repositories/users.js';
import { hashPassword, verifyPassword } from '../auth/crypto.js';
import { issueSession } from '../auth/session-service.js';
import { createRateLimiter } from '../shared/rate-limit.js';
import { getDummyPasswordHash } from '../shared/runtime.js';
import { ALLOW_REGISTRATION, REGISTRATION_CODE, USERNAME_RE } from '../config.js';
import { AppError } from '../shared/errors.js';
import { newId } from '../shared/utils.js';
import { loadSettings } from './model-settings-service.js';

const loginLimiter = createRateLimiter({ max: 10, windowMs: 5 * 60 * 1000 });
const loginIpLimiter = createRateLimiter({ max: 200, windowMs: 5 * 60 * 1000 });
const registerLimiter = createRateLimiter({ max: 30, windowMs: 60 * 60 * 1000 });

function codeMatches(input) {
  if (!REGISTRATION_CODE) return true;
  const a = crypto.createHash('sha256').update(String(input || '')).digest();
  const b = crypto.createHash('sha256').update(REGISTRATION_CODE).digest();
  return crypto.timingSafeEqual(a, b);
}

function rateLimitError(retryAfter) {
  const error = new AppError(429, '尝试次数过多，请稍后再试');
  error.retryAfter = retryAfter;
  return error;
}

export function getAuthStatus() {
  return {
    registrationOpen: ALLOW_REGISTRATION,
    requiresCode: Boolean(REGISTRATION_CODE),
    hasUsers: countUsers() > 0,
  };
}

export async function registerUser({ username, password, code, ip }) {
  if (!ALLOW_REGISTRATION) throw new AppError(403, '当前环境未开放注册');

  if (!USERNAME_RE.test(username)) {
    throw new AppError(400, '用户名需为 2–24 位字母、数字、下划线、短横线或中文');
  }
  if (password.length < 8 || password.length > 128) {
    throw new AppError(400, '密码长度需为 8–128 位');
  }
  if (!codeMatches(code)) throw new AppError(403, '邀请码不正确');

  const limit = registerLimiter.hit(`register:${ip}`);
  if (!limit.ok) throw rateLimitError(limit.retryAfter);

  if (findUserByUsername(username)) throw new AppError(409, '用户名已存在');

  const passwordHash = await hashPassword(password);
  const user = { id: newId(), username };
  try {
    createUser({ ...user, passwordHash });
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      throw new AppError(409, '用户名已存在');
    }
    throw err;
  }

  loadSettings(user.id);
  return { user, token: issueSession(user.id) };
}

export async function loginUser({ username, password, ip }) {
  const key = `login:${ip}:${username.toLowerCase()}`;
  const ipKey = `login-ip:${ip}`;
  const limit = loginLimiter.hit(key);
  const ipLimit = loginIpLimiter.hit(ipKey);
  if (!limit.ok || !ipLimit.ok) {
    throw rateLimitError(Math.max(limit.retryAfter, ipLimit.retryAfter));
  }

  const user = username ? findUserByUsername(username) : null;
  const valid = user
    ? await verifyPassword(password, user.password_hash)
    : await verifyPassword(password, getDummyPasswordHash());

  if (!user || !valid || user.disabled) {
    throw new AppError(401, '用户名或密码不正确');
  }

  loginLimiter.reset(key);
  loginIpLimiter.reset(ipKey);
  return {
    user: { id: user.id, username: user.username },
    token: issueSession(user.id),
  };
}
