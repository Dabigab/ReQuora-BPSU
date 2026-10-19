const express = require('express');
const { authenticateToken } = require('../utils/auth');
const { ok } = require('../utils/http');
const notificationService = require('../services/notificationService');

const router = express.Router();
router.use(authenticateToken);

// GET /api/notifications — my newest notifications + how many are unread
router.get('/', (req, res) => ok(res, notificationService.list(req.user, req.query)));

// PUT /api/notifications/read-all — mark everything as read
router.put('/read-all', (req, res) => ok(res, notificationService.markAllRead(req.user)));

// PUT /api/notifications/:id/read — mark one as read (only my own)
router.put('/:id/read', (req, res) => ok(res, { notification: notificationService.markRead(req.user, req.params.id) }));

module.exports = router;
