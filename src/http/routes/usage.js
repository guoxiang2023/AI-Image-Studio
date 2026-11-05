import { json } from '../responses.js';
import { usageOverview } from '../../services/usage-service.js';

export function handleUsage(req, res, user) {
  if (req.method !== 'GET') return json(res, 405, { error: 'Method Not Allowed' });
  const url = new URL(req.url, 'http://localhost');
  return json(res, 200, usageOverview(user.id, url.searchParams.get('sessionId')));
}
