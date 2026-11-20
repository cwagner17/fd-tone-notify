const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const log = require('../util/logger');
const { ErrorWithStatusCode } = require('../util/ErrorWithStatusCode');
const { TonesDetectorConfig } = require('../obj/config/TonesDetectorConfig');

const MAX_BACKUPS = 20;

/**
 * Reads, validates and writes the FD Tone Notify config file used by the running instance
 * (config/default.json, or config/default-<instance>.json when NODE_APP_INSTANCE is set).
 *
 * Used by the config editor API. Writes are atomic (temp file + rename) and the previous
 * file is copied to config/backups/ first.
 */
class ConfigFileService {
    /**
     * @param {Object} [options]
     * @param {string} [options.configDir] - Directory holding the config files. Defaults to NODE_CONFIG_DIR or ./config
     * @param {string} [options.instanceName] - Instance name. Defaults to NODE_APP_INSTANCE
     */
    constructor({ configDir, instanceName } = {}) {
        this.configDir = path.resolve(configDir || process.env.NODE_CONFIG_DIR || path.join(process.cwd(), 'config'));
        const instance = instanceName !== undefined ? instanceName : process.env.NODE_APP_INSTANCE;
        this.filename = instance ? `default-${instance}.json` : 'default.json';
        this.filePath = path.join(this.configDir, this.filename);
        this.backupDir = path.join(this.configDir, 'backups');
    }

    static version(text) {
        return crypto.createHash('sha256').update(text).digest('hex');
    }

    /**
     * @returns {{filename: string, config: Object, version: string}}
     */
    read() {
        let text;
        try {
            text = fs.readFileSync(this.filePath, 'utf8');
        } catch (e) {
            if (e.code === 'ENOENT')
                throw ErrorWithStatusCode.notFound(`Config file not found: ${this.filePath}`, `Config file ${this.filename} does not exist`);
            throw e;
        }
        let config;
        try {
            config = JSON.parse(text);
        } catch (e) {
            throw ErrorWithStatusCode.internal(`Config file ${this.filePath} is not valid JSON: ${e.message}`,
                `The existing ${this.filename} is not valid JSON and cannot be loaded`);
        }
        return { filename: this.filename, config, version: ConfigFileService.version(text) };
    }

    /**
     * Validate and save a config object.
     * @param {Object} config - Full configuration object
     * @param {Object} [options]
     * @param {string} [options.expectedVersion] - If set, the save fails with 409 when the file on disk has changed
     * @returns {{filename: string, version: string, backup: (string|null)}}
     */
    write(config, { expectedVersion } = {}) {
        const errors = ConfigFileService.validate(config);
        if (errors.length)
            throw ErrorWithStatusCode.validation(`Invalid configuration: ${errors.join('; ')}`);

        let currentText = null;
        try {
            currentText = fs.readFileSync(this.filePath, 'utf8');
        } catch (e) {
            if (e.code !== 'ENOENT') throw e;
        }

        if (expectedVersion && currentText !== null && ConfigFileService.version(currentText) !== expectedVersion) {
            throw new ErrorWithStatusCode(`Config file ${this.filePath} changed since it was loaded`, 409,
                `${this.filename} has been changed on the server since you loaded it. Reload it, or save again to overwrite.`);
        }

        fs.mkdirSync(this.configDir, { recursive: true });

        let backup = null;
        if (currentText !== null) {
            fs.mkdirSync(this.backupDir, { recursive: true });
            const stamp = new Date().toISOString().replace(/[:.]/g, '-');
            backup = path.join(this.backupDir, `${path.basename(this.filename, '.json')}.${stamp}.json`);
            fs.writeFileSync(backup, currentText);
            this._pruneBackups();
        }

        const text = JSON.stringify(config, null, 2) + '\n';
        const tmp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
        fs.writeFileSync(tmp, text);
        fs.renameSync(tmp, this.filePath);

        log.notice(`Config editor: saved ${this.filePath}${backup ? ` (previous version backed up to ${backup})` : ''}`);
        return { filename: this.filename, version: ConfigFileService.version(text), backup: backup ? path.relative(this.configDir, backup) : null };
    }

    _pruneBackups() {
        const prefix = `${path.basename(this.filename, '.json')}.`;
        let files;
        try {
            files = fs.readdirSync(this.backupDir).filter(f => f.startsWith(prefix) && f.endsWith('.json')).sort();
        } catch (e) {
            return;
        }
        files.slice(0, Math.max(0, files.length - MAX_BACKUPS)).forEach(f => {
            try { fs.unlinkSync(path.join(this.backupDir, f)); } catch (e) { /* ignore */ }
        });
    }

    /**
     * Validate a full configuration object. Detectors are checked with TonesDetectorConfig using the
     * same default fallbacks the app applies at startup.
     * @param {Object} config
     * @returns {string[]} List of problems (empty when valid)
     */
    static validate(config) {
        const errors = [];
        const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
        const isNum = v => typeof v === 'number' && Number.isFinite(v);

        if (!isObj(config)) return ['Configuration must be a JSON object'];

        const audio = config.audio;
        if (!isObj(audio)) errors.push('"audio" section is required');
        else {
            if (typeof audio.inputDevice !== 'string' || !audio.inputDevice.trim()) errors.push('audio.inputDevice is required');
            if (!isNum(audio.sampleRate) || audio.sampleRate <= 0) errors.push('audio.sampleRate must be a positive number');
        }

        const detection = config.detection;
        if (!isObj(detection)) {
            errors.push('"detection" section is required');
            return errors;
        }
        ['defaultMatchThreshold', 'defaultTolerancePercent', 'defaultResetTimeoutMs', 'defaultLockoutTimeoutMs', 'minRecordingLengthSec'].forEach(k => {
            if (!isNum(detection[k])) errors.push(`detection.${k} must be a number`);
        });
        if (!Array.isArray(detection.detectors) || detection.detectors.length === 0) {
            errors.push('detection.detectors must contain at least one detector');
            return errors;
        }

        detection.detectors.forEach((d, i) => {
            const label = `detector ${i + 1}${d && d.name ? ` ("${d.name}")` : ''}`;
            if (!isObj(d)) { errors.push(`${label} must be an object`); return; }
            try {
                new TonesDetectorConfig({
                    name: d.name,
                    tones: d.tones,
                    resetTimeoutMs: d.resetTimeoutMs ? d.resetTimeoutMs : detection.defaultResetTimeoutMs,
                    lockoutTimeoutMs: d.lockoutTimeoutMs ? d.lockoutTimeoutMs : detection.defaultLockoutTimeoutMs,
                    minRecordingLengthSec: d.minRecordingLengthSec ? d.minRecordingLengthSec : detection.minRecordingLengthSec,
                    maxRecordingLengthSec: d.maxRecordingLengthSec ? d.maxRecordingLengthSec : detection.maxRecordingLengthSec,
                    matchThreshold: d.matchThreshold ? d.matchThreshold : detection.defaultMatchThreshold,
                    tolerancePercent: d.tolerancePercent ? d.tolerancePercent : detection.defaultTolerancePercent,
                    isRecordingEnabled: d.isRecordingEnabled,
                    notifications: d.notifications
                });
            } catch (e) {
                errors.push(`${label}: ${e.message}`);
            }
        });

        if (config.email !== undefined && !isObj(config.email)) errors.push('"email" must be an object');
        if (config.recording !== undefined && !isObj(config.recording)) errors.push('"recording" must be an object');
        return errors;
    }
}

module.exports = { ConfigFileService };
