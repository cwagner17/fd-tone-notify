const { expect } = require('chai');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ConfigFileService } = require('../../service/ConfigFileService');

function cfg(name) {
    return {
        audio: { inputDevice: 'dsnoop', sampleRate: 44100 },
        detection: {
            minRecordingLengthSec: 30, defaultMatchThreshold: 6, defaultTolerancePercent: 0.05,
            defaultResetTimeoutMs: 5000, defaultLockoutTimeoutMs: 7000,
            detectors: [{ name, tones: [1000, 2000] }]
        }
    };
}

describe('ConfigFileService', function () {
    describe('validate', function () {
        it('accepts a valid config', function () {
            expect(ConfigFileService.validate(cfg('A'))).to.deep.equal([]);
        });

        it('accepts the shipped default config', function () {
            const def = JSON.parse(fs.readFileSync(path.join(__dirname, '../../config/default.json'), 'utf8'));
            expect(ConfigFileService.validate(def)).to.deep.equal([]);
        });

        it('rejects missing sections', function () {
            expect(ConfigFileService.validate({})).to.include('"audio" section is required');
            expect(ConfigFileService.validate([])).to.deep.equal(['Configuration must be a JSON object']);
        });

        it('applies detection defaults before validating detectors', function () {
            const c = cfg('A');
            c.detection.maxRecordingLengthSec = 10; // shorter than the 30s minimum
            const errors = ConfigFileService.validate(c);
            expect(errors.join()).to.match(/maxRecordingLengthSec/);
        });

        it('reports invalid notifications', function () {
            const c = cfg('A');
            c.detection.detectors[0].notifications = { preRecording: { webhooks: [{ address: 'not a url' }] } };
            expect(ConfigFileService.validate(c).join()).to.match(/Invalid webhook URL/);
        });
    });

    describe('backups', function () {
        it('keeps at most 20 backups', function () {
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fdtn-cfs-'));
            try {
                const svc = new ConfigFileService({ configDir: dir, instanceName: '' });
                fs.mkdirSync(path.join(dir, 'backups'));
                for (let i = 0; i < 25; i++)
                    fs.writeFileSync(path.join(dir, 'backups', `default.2020-01-${String(i + 1).padStart(2, '0')}.json`), '{}');
                fs.writeFileSync(svc.filePath, JSON.stringify(cfg('Old')));
                svc.write(cfg('New'));
                const backups = fs.readdirSync(path.join(dir, 'backups'));
                expect(backups).to.have.length(20);
                expect(backups).to.not.include('default.2020-01-01.json');
            } finally {
                fs.rmSync(dir, { recursive: true, force: true });
            }
        });
    });
});
