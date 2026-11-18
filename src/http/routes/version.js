import { checkForUpdate } from '../../services/update-service.js';
import { installerStatus, startInstall } from '../../services/update-install-service.js';
import { json } from '../responses.js';

export async function handleVersion(req, res, url) {
  const force = url?.searchParams?.get('refresh') === '1';
  res.setHeader('Cache-Control', 'no-store');
  return json(res, 200, await checkForUpdate({ force }));
}

export function handleUpdateStatus(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  return json(res, 200, installerStatus());
}

export async function handleUpdateInstall(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  return json(res, 200, await startInstall());
}
