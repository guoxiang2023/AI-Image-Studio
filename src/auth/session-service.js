import {
  createAuthSession,
  deleteAuthSession,
  findAuthSession,
  touchAuthSession,
} from '../data/repositories/auth-sessions.js';
import { hashToken, randomToken } from './crypto.js';
import { parseCookies } from '../shared/cookies.js';
import { COOKIE_NAME, COOKIE_SECURE, SESSION_MS } from '../config.js';
import { now } from '../shared/utils.js';

export function sessionCookie(token) {
  const parts = [
    `${COOKIE_NAME}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(SESSION_MS / 1000)}`,
  ];
  if (COOKIE_SECURE) parts.push('Secure');
  return parts.join('; ');
}

export function clearSessionCookie() {
  const parts = [`${COOKIE_NAME}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (COOKIE_SECURE) parts.push('Secure');
  return parts.join('; ');
}

export function issueSession(userId) {
  const token = randomToken();
  createAuthSession({
    tokenHash: hashToken(token),
    userId,
    expiresAt: now() + SESSION_MS,
  });
  return token;
}

export function getRequestUser(req) {
  const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
  if (!token) return null;
  const tokenHash = hashToken(token);
  const row = findAuthSession(tokenHash, now());
  if (!row || row.disabled) return null;
  if (row.expires_at - now() < 24 * 60 * 60 * 1000) {
    touchAuthSession(tokenHash, now() + SESSION_MS);
  }
  return { id: row.id, username: row.username };
}

export function deleteRequestSession(req) {
  const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
  if (token) deleteAuthSession(hashToken(token));
}
