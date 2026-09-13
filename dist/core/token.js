import { createHash, randomBytes } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { env } from '../config/env.js';
/**
 * Token utilities (docs/backend-master-spec.md §7, security-baseline).
 *
 * Access tokens are short-lived signed JWTs (HS256) carrying the session id
 * so the auth guard can enforce session/device revocation server-side.
 * Refresh tokens are opaque random strings whose SHA-256 hash is stored in
 * refresh_token.token_hash — they are never readable from the DB and are
 * rotated on every use (successor chain).
 */
const encoder = new TextEncoder();
const signingKey = encoder.encode(env.jwt.accessSecret);
const ALG = 'HS256';
export async function signAccessToken(claims) {
    const payload = {
        staffCode: claims.staffCode,
        role: claims.role,
        source: claims.source,
        sessionId: claims.sessionId,
    };
    if (claims.deviceId)
        payload.deviceId = claims.deviceId;
    if (claims.branchId)
        payload.branchId = claims.branchId;
    return new SignJWT(payload)
        .setProtectedHeader({ alg: ALG })
        .setSubject(claims.staffId)
        .setIssuer(env.jwt.issuer)
        .setAudience(env.jwt.audience)
        .setIssuedAt()
        .setExpirationTime(Math.floor(Date.now() / 1000) + env.jwt.accessTokenTtlMinutes * 60)
        .sign(signingKey);
}
export async function verifyAccessToken(token) {
    const { payload } = await jwtVerify(token, signingKey, {
        algorithms: [ALG],
        issuer: env.jwt.issuer,
        audience: env.jwt.audience,
    });
    const { sub, staffCode, role, source, sessionId, deviceId, branchId } = payload;
    if (typeof sub !== 'string' ||
        typeof staffCode !== 'string' ||
        typeof role !== 'string' ||
        typeof source !== 'string' ||
        typeof sessionId !== 'string') {
        throw new Error('Malformed access token payload');
    }
    return {
        staffId: sub,
        staffCode,
        role: role,
        source: source,
        sessionId,
        deviceId: typeof deviceId === 'string' ? deviceId : null,
        branchId: typeof branchId === 'string' ? branchId : null,
    };
}
/** Opaque token for refresh tokens / device registration secrets. */
export function generateOpaqueToken(bytes = 32) {
    return randomBytes(bytes).toString('base64url');
}
/** SHA-256 hex digest — used to store only hashes of refresh tokens. */
export function sha256Hex(value) {
    return createHash('sha256').update(value).digest('hex');
}
