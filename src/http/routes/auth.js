import { clientIp, json, readJsonBody } from '../responses.js';
import {
  getAuthStatus,
  loginUser,
  registerUser,
} from '../../services/auth-service.js';
import {
  clearSessionCookie,
  deleteRequestSession,
  sessionCookie,
} from '../../auth/session-service.js';

export function handleAuthStatus(req, res) {
  return json(res, 200, getAuthStatus());
}

export async function handleRegister(req, res) {
  const body = await readJsonBody(req);
  const { user, token } = await registerUser({
    username: String(body.username || '').trim(),
    password: String(body.password || ''),
    code: String(body.code || ''),
    ip: clientIp(req),
  });
  res.setHeader('Set-Cookie', sessionCookie(token));
  return json(res, 201, { user });
}

export async function handleLogin(req, res) {
  const body = await readJsonBody(req);
  const { user, token } = await loginUser({
    username: String(body.username || '').trim(),
    password: String(body.password || ''),
    ip: clientIp(req),
  });
  res.setHeader('Set-Cookie', sessionCookie(token));
  return json(res, 200, { user });
}

export async function handleLogout(req, res) {
  deleteRequestSession(req);
  res.setHeader('Set-Cookie', clearSessionCookie());
  return json(res, 200, { ok: true });
}

export function handleMe(res, user) {
  return json(res, 200, { user: { id: user.id, username: user.username } });
}
