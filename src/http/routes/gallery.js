import { json, readJsonBody } from '../responses.js';
import {
  createFolder,
  deleteFolder,
  getGallery,
  hideImage,
  updateImage,
} from '../../services/gallery-service.js';

export function handleGallery(req, res, user) {
  return json(res, 200, getGallery(user.id));
}

export async function handleCreateFolder(req, res, user) {
  const body = await readJsonBody(req);
  return json(res, 201, { folder: createFolder(user.id, body) });
}

export async function handleDeleteFolder(req, res, user, folderId) {
  deleteFolder(user.id, folderId);
  return json(res, 200, { ok: true });
}

export async function handleUpdateImage(req, res, user, imageId) {
  const body = await readJsonBody(req);
  updateImage(user.id, imageId, body);
  return json(res, 200, { ok: true });
}

export async function handleHideImage(req, res, user, imageId) {
  hideImage(user.id, imageId);
  return json(res, 200, { ok: true });
}
