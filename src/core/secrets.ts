import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export interface Sealed {
  iv: string;
  tag: string;
  data: string;
}

const KEY_BYTES = 32;

export const tokenKey = (base64: string) => {
  const key = Buffer.from(base64, 'base64');
  if (key.length !== KEY_BYTES) throw new Error('ECONOME_TOKEN_KEY must be 32 bytes, base64-encoded (openssl rand -base64 32).');
  return key;
};

export const seal = (key: Buffer, plain: string): Sealed => {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
};

export const unseal = (key: Buffer, { iv, tag, data }: Sealed) => {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
};
