import { json, readJsonBody } from '../responses.js';
import {
  publicSettings,
  revealApiKey,
  updateSettingsPatch,
} from '../../services/model-settings-service.js';
import { listModels, testModel } from '../../services/model-probe-service.js';

export async function handleConfig(req, res, user) {
  if (req.method === 'GET') return json(res, 200, publicSettings(user.id));
  if (req.method !== 'PUT') return json(res, 405, { error: 'Method Not Allowed' });
  const body = await readJsonBody(req);
  return json(res, 200, updateSettingsPatch(user.id, body));
}

export function handleRevealKey(req, res, user) {
  const url = new URL(req.url, 'http://localhost');
  const target = url.searchParams.get('target') === 'image' ? 'image' : 'llm';
  const apiKey = revealApiKey(user.id, target);
  res.setHeader('Cache-Control', 'no-store');
  if (!apiKey) return json(res, 404, { error: '未配置 API Key' });
  return json(res, 200, { apiKey });
}

export async function handleModels(req, res, user) {
  const body = await readJsonBody(req);
  return json(res, 200, await listModels({ userId: user.id, body }));
}

export async function handleTest(req, res, user) {
  const body = await readJsonBody(req);
  return json(res, 200, await testModel({ userId: user.id, body }));
}
