import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { seal, tokenKey, unseal } from '../../src/core/secrets.ts';

const key = randomBytes(32);

describe('seal and unseal', () => {
  it('round-trips a token, never storing it as plain text', () => {
    const sealed = seal(key, 'refresh-token-123');

    expect(JSON.stringify(sealed)).not.toContain('refresh-token-123');
    expect(unseal(key, sealed)).toBe('refresh-token-123');
  });

  it('refuses a token sealed with another key or changed since', () => {
    const sealed = seal(key, 'refresh-token-123');

    expect(() => unseal(randomBytes(32), sealed)).toThrow();
    expect(() => unseal(key, { ...sealed, data: Buffer.from('tampered').toString('base64') })).toThrow();
  });
});

describe('tokenKey', () => {
  it('takes a 32-byte base64 key and refuses anything else', () => {
    expect(tokenKey(key.toString('base64'))).toHaveLength(32);
    expect(() => tokenKey(Buffer.from('short').toString('base64'))).toThrow(/32 bytes/);
  });
});
