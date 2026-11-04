import { json, readJsonBody } from '../responses.js';
import {
  generateStyleMaterial,
  importStyleReference,
  listStyleReferences,
} from '../../services/style-studio-service.js';

export function handleStyleReferences(req, res) {
  return json(res, 200, { references: listStyleReferences() });
}

export async function handleStyleImport(req, res, user) {
  const body = await readJsonBody(req);
  return json(res, 200, await importStyleReference(user.id, body.styleId));
}

export async function handleStyleGenerate(req, res, user) {
  const body = await readJsonBody(req);
  return json(res, 201, await generateStyleMaterial(user, body));
}
