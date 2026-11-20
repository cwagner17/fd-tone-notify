const crypto = require('crypto');
const log = require('../../util/logger');
const { ErrorWithStatusCode } = require('../../util/ErrorWithStatusCode');

const TOKEN_ENV_VAR = 'FD_CONFIG_EDITOR_TOKEN';
const MIN_TOKEN_LENGTH = 16;
const MAX_FAILURES = 10;
const FAILURE_WINDOW_MS = 15 * 60 * 1000;

// ip -> {count, first}
const failures = new Map();

function configuredToken() {
    const token = process.env[TOKEN_ENV_VAR];
    return typeof token === 'string' ? token.trim() : '';
}

/**
 * @returns {{enabled: boolean, reason: (string|null)}}
 */
function tokenStatus() {
    const token = configuredToken();
    if (!token)
        return { enabled: false, reason: `Saving to the server is disabled. Set ${TOKEN_ENV_VAR} in config/secrets.json or the environment and restart.` };
    if (token.length < MIN_TOKEN_LENGTH)
        return { enabled: false, reason: `${TOKEN_ENV_VAR} must be at least ${MIN_TOKEN_LENGTH} characters. Saving to the server is disabled.` };
    return { enabled: true, reason: null };
}

function safeEqual(a, b) {
    // Hash both sides so the comparison is constant time regardless of length
    const ha = crypto.createHash('sha256').update(a).digest();
    const hb = crypto.createHash('sha256').update(b).digest();
    return crypto.timingSafeEqual(ha, hb);
}

function clientKey(req) {
    return req.ip || (req.connection && req.connection.remoteAddress) || 'unknown';
}

function isLockedOut(key, now) {
    const f = failures.get(key);
    if (!f) return false;
    if (now - f.first > FAILURE_WINDOW_MS) {
        failures.delete(key);
        return false;
    }
    return f.count >= MAX_FAILURES;
}

function recordFailure(key, now) {
    const f = failures.get(key);
    if (!f || now - f.first > FAILURE_WINDOW_MS) failures.set(key, { count: 1, first: now });
    else f.count++;
}

/**
 * Requires "Authorization: Bearer <FD_CONFIG_EDITOR_TOKEN>".
 * Disabled (403) unless a token of sufficient length is configured.
 * Repeated failures from one client are locked out for 15 minutes (429).
 */
function requireConfigToken(req, res, next) {
    const status = tokenStatus();
    if (!status.enabled)
        return next(ErrorWithStatusCode.forbidden('Config editor token not configured', status.reason));

    const key = clientKey(req);
    const now = Date.now();
    if (isLockedOut(key, now))
        return next(new ErrorWithStatusCode(`Config editor: too many failed token attempts from ${key}`, 429,
            'Too many failed attempts. Try again in 15 minutes.'));

    const header = req.get('authorization') || '';
    const match = /^Bearer\s+(.+)$/i.exec(header);
    const provided = match ? match[1].trim() : '';

    if (!provided || !safeEqual(provided, configuredToken())) {
        recordFailure(key, now);
        log.warning(`Config editor: rejected request with ${provided ? 'invalid' : 'missing'} token from ${key}`);
        return next(ErrorWithStatusCode.unauthorized('Invalid config editor token', 'Invalid or missing token'));
    }

    failures.delete(key);
    next();
}

function _resetFailures() {
    failures.clear();
}

module.exports = { requireConfigToken, tokenStatus, TOKEN_ENV_VAR, MIN_TOKEN_LENGTH, _resetFailures };
