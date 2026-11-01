import { json, readJsonBody } from '../responses.js';
import {
  publicSettings,
  updateSettingsPatch,
} from '../../services/model-settings-service.js';
import { listModels, testModel } from '../../services/model-probe-service.js';

export async function handleConfig(req, res, user) {
  if (req.method === 'GET') return json(res, 200, publicSettings(user.id));
  if (req.method !== 'PUT') return json(res, 405, { error: 'Method Not Allowed' });
  const body = await readJsonBody(req);
  return json(res, 200, updateSettingsPatch(user.id, body));
}

export async function handleModels(req, res, user) {
  const body = await readJsonBody(req);
  return json(res, 200, await listModels({ userId: user.id, body }));
}

export async function handleTest(req, res, user) {
  const body = await readJsonBody(req);
  return json(res, 200, await testModel({ userId: user.id, body }));
}
