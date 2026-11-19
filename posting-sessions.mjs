import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const randomToken = () => randomBytes(32).toString('base64url');
const sessionLife = 24 * 60 * 60_000;

function readKey(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size !== 32 || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid()) {
      throw new Error('Session key must be a private, owner-only 32-byte file.');
    }
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

function signingKey(path) {
  if (!path) return randomBytes(32);
  try {
    return readKey(path);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = path + '.' + randomToken() + '.tmp';
  const fd = openSync(tmp, 'wx', 0o600);
  try {
    try {
      writeFileSync(fd, randomBytes(32));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      linkSync(tmp, path);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  } finally {
    unlinkSync(tmp);
  }
  return readKey(path);
}

export function createPostingSessions({ secretPath, now = Date.now } = {}) {
  const key = signingKey(secretPath);
  const sign = (scope, value) => createHmac('sha256', key).update(scope + '\0' + value).digest('base64url');

  function issue() {
    const payload = randomToken() + '.' + (now() + sessionLife).toString(36);
    return 'v1.' + payload + '.' + sign('guest', payload);
  }

  function valid(token) {
    if (typeof token !== 'string' || token.length > 128) return false;
    const parts = /^v1\.([\w-]{43})\.([a-z0-9]{1,12})\.([\w-]{43})$/.exec(token);
    if (!parts) return false;
    const [, nonce, expiry, signature] = parts;
    const expected = sign('guest', nonce + '.' + expiry);
    return timingSafeEqual(Buffer.from(expected), Buffer.from(signature)) && Number.parseInt(expiry, 36) > now();
  }

  return { issue, csrf: token => valid(token) ? sign('csrf', token) : null };
}
