import crypto from 'node:crypto';

export function newSessionToken() {
  return crypto.randomBytes(32).toString('base64url');
}

/** Only the SHA-256 of a session token is stored, so a database leak does not leak live sessions. */
export function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest();
}
