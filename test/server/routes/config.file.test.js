const { expect } = require('chai');
const express = require('express');
const request = require('supertest');
const fs = require('fs');
const os = require('os');
const path = require('path');
const configRoutes = require('../../../server/routes/config');
const { errorHandler } = require('../../../server/middleware/error.middleware');
const { _resetFailures, TOKEN_ENV_VAR } = require('../../../server/middleware/config-token.middleware');

const TOKEN = 'test-token-0123456789abcdef';

function validConfig(name = 'Station 1') {
    return {
        audio: { inputDevice: 'hw:1,0', sampleRate: 44100, channels: 1 },
        detection: {
            minRecordingLengthSec: 30, maxRecordingLengthSec: 45, defaultMatchThreshold: 6,
            defaultTolerancePercent: 0.05, defaultResetTimeoutMs: 5000, defaultLockoutTimeoutMs: 7000,
            detectors: [{ name, tones: [850, 525], notifications: { preRecording: { emails: [], pushbullet: [], webhooks: [], externalCommands: [] } } }]
        },
        email: { from: 'a@example.com', host: 'smtp.example.com', port: 465, secure: true }
    };
}

describe('Config file API (/api/config/file)', function () {
    let app, dir, savedEnv;

    before(function () {
        savedEnv = { dir: process.env.NODE_CONFIG_DIR, instance: process.env.NODE_APP_INSTANCE, token: process.env[TOKEN_ENV_VAR] };
        app = express();
        app.use(express.json({ limit: '5mb' }));
        app.use('/api/config', configRoutes);
        app.use(errorHandler);
    });

    after(function () {
        const restore = (k, v) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };
        restore('NODE_CONFIG_DIR', savedEnv.dir);
        restore('NODE_APP_INSTANCE', savedEnv.instance);
        restore(TOKEN_ENV_VAR, savedEnv.token);
    });

    beforeEach(function () {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fdtn-config-'));
        fs.writeFileSync(path.join(dir, 'default.json'), JSON.stringify(validConfig('Original'), null, 2));
        process.env.NODE_CONFIG_DIR = dir;
        delete process.env.NODE_APP_INSTANCE;
        process.env[TOKEN_ENV_VAR] = TOKEN;
        _resetFailures();
    });

    afterEach(function () {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    const auth = { Authorization: `Bearer ${TOKEN}` };

    describe('GET /status', function () {
        it('reports enabled when a token is configured', async function () {
            const res = await request(app).get('/api/config/file/status');
            expect(res.status).to.equal(200);
            expect(res.body).to.include({ enabled: true, filename: 'default.json' });
        });

        it('reports disabled when no token is configured', async function () {
            delete process.env[TOKEN_ENV_VAR];
            const res = await request(app).get('/api/config/file/status');
            expect(res.body.enabled).to.equal(false);
            expect(res.body.reason).to.match(/FD_CONFIG_EDITOR_TOKEN/);
        });

        it('reports disabled when the token is too short', async function () {
            process.env[TOKEN_ENV_VAR] = 'short';
            const res = await request(app).get('/api/config/file/status');
            expect(res.body.enabled).to.equal(false);
        });

        it('uses the instance file name when NODE_APP_INSTANCE is set', async function () {
            process.env.NODE_APP_INSTANCE = 'east';
            const res = await request(app).get('/api/config/file/status');
            expect(res.body.filename).to.equal('default-east.json');
        });
    });

    describe('authentication', function () {
        it('rejects requests without a token', async function () {
            const res = await request(app).get('/api/config/file');
            expect(res.status).to.equal(401);
        });

        it('rejects requests with a wrong token', async function () {
            const res = await request(app).put('/api/config/file').set('Authorization', 'Bearer nope').send({ config: validConfig() });
            expect(res.status).to.equal(401);
            const disk = JSON.parse(fs.readFileSync(path.join(dir, 'default.json'), 'utf8'));
            expect(disk.detection.detectors[0].name).to.equal('Original');
        });

        it('returns 403 when saving is disabled, even with a token', async function () {
            delete process.env[TOKEN_ENV_VAR];
            const res = await request(app).get('/api/config/file').set(auth);
            expect(res.status).to.equal(403);
        });

        it('locks out a client after repeated failures', async function () {
            for (let i = 0; i < 10; i++)
                await request(app).get('/api/config/file').set('Authorization', 'Bearer wrong');
            const res = await request(app).get('/api/config/file').set(auth);
            expect(res.status).to.equal(429);
        });
    });

    describe('GET /', function () {
        it('returns the config file and a version', async function () {
            const res = await request(app).get('/api/config/file').set(auth);
            expect(res.status).to.equal(200);
            expect(res.body.filename).to.equal('default.json');
            expect(res.body.config.detection.detectors[0].name).to.equal('Original');
            expect(res.body.version).to.match(/^[a-f0-9]{64}$/);
        });

        it('returns 404 when the file does not exist', async function () {
            fs.unlinkSync(path.join(dir, 'default.json'));
            const res = await request(app).get('/api/config/file').set(auth);
            expect(res.status).to.equal(404);
        });
    });

    describe('PUT /', function () {
        it('saves a valid config and backs up the previous file', async function () {
            const res = await request(app).put('/api/config/file').set(auth).send({ config: validConfig('Updated') });
            expect(res.status).to.equal(200);
            expect(res.body.restartRequired).to.equal(true);
            const disk = JSON.parse(fs.readFileSync(path.join(dir, 'default.json'), 'utf8'));
            expect(disk.detection.detectors[0].name).to.equal('Updated');
            const backups = fs.readdirSync(path.join(dir, 'backups'));
            expect(backups).to.have.length(1);
            const backup = JSON.parse(fs.readFileSync(path.join(dir, 'backups', backups[0]), 'utf8'));
            expect(backup.detection.detectors[0].name).to.equal('Original');
            expect(fs.readdirSync(dir).filter(f => f.endsWith('.tmp'))).to.have.length(0);
        });

        it('rejects an invalid config without touching the file', async function () {
            const bad = validConfig('Bad');
            bad.detection.detectors[0].tones = [];
            const res = await request(app).put('/api/config/file').set(auth).send({ config: bad });
            expect(res.status).to.equal(400);
            expect(res.body.error).to.match(/tones/);
            const disk = JSON.parse(fs.readFileSync(path.join(dir, 'default.json'), 'utf8'));
            expect(disk.detection.detectors[0].name).to.equal('Original');
        });

        it('rejects a body without a config object', async function () {
            const res = await request(app).put('/api/config/file').set(auth).send({ audio: {} });
            expect(res.status).to.equal(400);
        });

        it('returns 409 when the file changed since it was loaded', async function () {
            const loaded = await request(app).get('/api/config/file').set(auth);
            fs.writeFileSync(path.join(dir, 'default.json'), JSON.stringify(validConfig('Edited by hand')));
            const res = await request(app).put('/api/config/file').set(auth).set('If-Match', loaded.body.version).send({ config: validConfig('Mine') });
            expect(res.status).to.equal(409);
            const disk = JSON.parse(fs.readFileSync(path.join(dir, 'default.json'), 'utf8'));
            expect(disk.detection.detectors[0].name).to.equal('Edited by hand');
        });

        it('saves when If-Match matches the current version', async function () {
            const loaded = await request(app).get('/api/config/file').set(auth);
            const res = await request(app).put('/api/config/file').set(auth).set('If-Match', loaded.body.version).send({ config: validConfig('Mine') });
            expect(res.status).to.equal(200);
            const again = await request(app).get('/api/config/file').set(auth);
            expect(again.body.version).to.equal(res.body.version);
        });
    });
});
