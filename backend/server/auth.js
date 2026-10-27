const crypto = require('crypto');
const { promisify } = require('util');
const User = require('./models/User');

const scrypt = promisify(crypto.scrypt);
const TOKEN_TTL_SECONDS = 60 * 60 * 24 * 7;

async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const key = await scrypt(password, salt, 64);
  return `scrypt$${salt}$${key.toString('hex')}`;
}

async function verifyPassword(password, stored) {
  const [scheme, salt, expectedHex] = String(stored).split('$');
  if (scheme !== 'scrypt' || !salt || !expectedHex) return false;
  const expected = Buffer.from(expectedHex, 'hex');
  const actual = await scrypt(password, salt, expected.length);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function signToken(userId) {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32) throw new Error('JWT_SECRET must be configured with at least 32 characters');
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ sub: String(userId), iat: now, exp: now + TOKEN_TTL_SECONDS })).toString('base64url');
  const input = `${header}.${payload}`;
  const signature = crypto.createHmac('sha256', secret).update(input).digest('base64url');
  return `${input}.${signature}`;
}

function verifyToken(token) {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32) throw new Error('JWT_SECRET must be configured with at least 32 characters');
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  const [headerPart, payloadPart, signaturePart] = parts;
  const header = JSON.parse(Buffer.from(headerPart, 'base64url').toString());
  const payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString());
  if (header.alg !== 'HS256' || typeof payload.sub !== 'string' || !Number.isFinite(payload.exp)) return null;
  const expected = crypto.createHmac('sha256', secret).update(`${headerPart}.${payloadPart}`).digest();
  const supplied = Buffer.from(signaturePart, 'base64url');
  if (expected.length !== supplied.length || !crypto.timingSafeEqual(expected, supplied)) return null;
  if (payload.exp <= Math.floor(Date.now() / 1000)) return null;
  return payload;
}

async function requireAuth(req, res, next) {
  const match = /^Bearer\s+(.+)$/i.exec(req.get('authorization') || '');
  if (!match) return res.status(401).json({ success: false, error: 'Authentication required' });
  try {
    const payload = verifyToken(match[1]);
    if (!payload) return res.status(401).json({ success: false, error: 'Invalid or expired token' });
    const user = await User.findById(payload.sub).select('_id email');
    if (!user) return res.status(401).json({ success: false, error: 'Invalid or expired token' });
    req.user = user;
    return next();
  } catch (error) {
    if (error.name === 'JsonWebTokenError' || error instanceof SyntaxError) {
      return res.status(401).json({ success: false, error: 'Invalid or expired token' });
    }
    return next(error);
  }
}

module.exports = { hashPassword, verifyPassword, signToken, verifyToken, requireAuth };
