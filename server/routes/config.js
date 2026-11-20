const express = require('express');
const { getConfig, getConfigFileStatus, getConfigFile, saveConfigFile } = require('../controllers/config.controller');
const { requireConfigToken } = require('../middleware/config-token.middleware');

const router = express.Router();

/**
 * GET /config
 * Get current detector configuration
 */
router.get('/', getConfig);

/**
 * GET /config/file/status
 * Whether the config editor can load/save on this server (no token required)
 */
router.get('/file/status', getConfigFileStatus);

/**
 * GET /config/file
 * Full contents of the config file. Requires "Authorization: Bearer <FD_CONFIG_EDITOR_TOKEN>"
 */
router.get('/file', requireConfigToken, getConfigFile);

/**
 * PUT /config/file
 * Validate and save the config file (previous version is backed up to config/backups/).
 * Requires "Authorization: Bearer <FD_CONFIG_EDITOR_TOKEN>". Body: {"config": {...}}
 * Optional "If-Match: <version>" header prevents overwriting changes made since loading.
 */
router.put('/file', requireConfigToken, saveConfigFile);

module.exports = router;