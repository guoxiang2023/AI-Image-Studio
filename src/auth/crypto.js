import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);
const KEY_LENGTH = 64;

/* ------------------------------- passwords -------------------------------- */

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, KEY_LENGTH);
  return `scrypt$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

export async function verifyPassword(password, stored) {
  try {
    const [scheme, saltPart, hashPart] = String(stored).split('$');
    if (scheme !== 'scrypt' || !saltPart || !hashPart) return false;
    const salt = Buffer.from(saltPart, 'base64url');
    const expected = Buffer.from(hashPart, 'base64url');
    const actual = await scrypt(password, salt, expected.length);
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/* --------------------------------- tokens --------------------------------- */

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/* ------------------------------- secret box ------------------------------- */

export function createSecretBox(key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    throw new Error('加密密钥必须是 32 字节');
  }

  return {
    seal(text) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const encrypted = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();
      return `v1.${iv.toString('base64url')}.${tag.toString('base64url')}.${encrypted.toString('base64url')}`;
    },
    unseal(payload) {
      if (!payload) return '';
      const [version, ivPart, tagPart, dataPart] = String(payload).split('.');
      if (version !== 'v1' || !ivPart || !tagPart || !dataPart) return '';
      try {
        const decipher = crypto.createDecipheriv(
          'aes-256-gcm',
          key,
          Buffer.from(ivPart, 'base64url'),
        );
        decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));
        const plain = Buffer.concat([
          decipher.update(Buffer.from(dataPart, 'base64url')),
          decipher.final(),
        ]);
        return plain.toString('utf8');
      } catch {
        return '';
      }
    },
  };
}
