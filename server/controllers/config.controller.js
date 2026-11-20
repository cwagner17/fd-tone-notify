const config = require('config');
const log = require('../../util/logger');
const { ConfigFileService } = require('../../service/ConfigFileService');
const { tokenStatus } = require('../middleware/config-token.middleware');
const { ErrorWithStatusCode } = require('../../util/ErrorWithStatusCode');

/**
 * Get current detector configuration
 */
async function getConfig(req, res) {
    try {
        const detectorConfigs = config.detection.detectors.map(detector => ({
            name: detector.name,
            tones: detector.tones,
            matchThreshold: detector.matchThreshold || config.detection.defaultMatchThreshold,
            tolerancePercent: detector.tolerancePercent || config.detection.defaultTolerancePercent,
            resetTimeoutMs: detector.resetTimeoutMs || config.detection.defaultResetTimeoutMs,
            lockoutTimeoutMs: detector.lockoutTimeoutMs || config.detection.defaultLockoutTimeoutMs
        }));

        res.json({
            success: true,
            detectors: detectorConfigs,
            defaults: {
                matchThreshold: config.detection.defaultMatchThreshold,
                tolerancePercent: config.detection.defaultTolerancePercent,
                resetTimeoutMs: config.detection.defaultResetTimeoutMs,
                lockoutTimeoutMs: config.detection.defaultLockoutTimeoutMs
            },
            audio: {
                sampleRate: config.audio.sampleRate,
                channels: config.audio.channels,
                frequencyScaleFactor: config.audio.frequencyScaleFactor
            }
        });
    } catch (error) {
        log.error(`API config error: ${error.message}`);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
}

/**
 * Whether saving from the config editor is enabled. Does not require a token.
 */
function getConfigFileStatus(req, res) {
    const { enabled, reason } = tokenStatus();
    res.json({ success: true, enabled, reason, filename: new ConfigFileService().filename });
}

/**
 * Return the full config file the running instance was started with (token required)
 */
function getConfigFile(req, res, next) {
    try {
        const { filename, config: fileConfig, version } = new ConfigFileService().read();
        res.json({ success: true, filename, version, config: fileConfig });
    } catch (e) {
        next(e);
    }
}

/**
 * Validate and save the config file (token required).
 * Body: { config: {...} }. Optional "If-Match: <version>" header rejects the save with 409
 * if the file changed since it was loaded.
 */
function saveConfigFile(req, res, next) {
    try {
        const body = req.body || {};
        if (body.config === null || typeof body.config !== 'object' || Array.isArray(body.config))
            throw ErrorWithStatusCode.validation('Request body must be JSON of the form {"config": {...}}');
        const ifMatch = req.get('if-match');
        const expectedVersion = ifMatch ? ifMatch.replace(/^W\//, '').replace(/"/g, '').trim() : undefined;
        const result = new ConfigFileService().write(body.config, { expectedVersion });
        res.json({ success: true, ...result, restartRequired: true,
            message: `Saved ${result.filename}. Restart FD Tone Notify to apply the changes.` });
    } catch (e) {
        next(e);
    }
}

module.exports = { getConfig, getConfigFileStatus, getConfigFile, saveConfigFile };