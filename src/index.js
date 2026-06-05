import express from 'express';
import { createServer } from 'http';
import helmet from 'helmet';
import cors from 'cors';

import env from './config/env.js';
import logger, { requestLogger } from './middleware/logger.js';
import { rateLimiter } from './middleware/rateLimiter.js';
import { apiKeyAuth } from './middleware/auth.js';
import webhookRouter from './channels/webhook.js';
import zendeskRouter from './channels/zendesk.js';
import { attachLiveChat } from './channels/livechat.js';
import { getSessionStats } from './agent/conversationMgr.js';
import { startEmailPolling } from './channels/email.js';

/**
 * KopaDot — AI E-Commerce Support Agent
 *
 * Express server entry point.
 * Serves the REST API (webhook channel) and WebSocket (live chat channel).
 *
 * Everything is AI-driven:
 *   - Intent detection → Gemini
 *   - Entity extraction → Gemini
 *   - Tool selection → Gemini function calling
 *   - Response generation → Gemini
 *   - Escalation decisions → Gemini
 *
 * No regex. No static responses. No hardcoded intent mapping.
 */

const app = express();

// ── Global Middleware ────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(requestLogger);

// ── Health Check (no auth required) ─────────────────────────────────
app.get('/health', (req, res) => {
  const stats = getSessionStats();
  res.json({
    status: 'ok',
    service: 'kopadot',
    version: '1.0.0',
    uptime: Math.round(process.uptime()),
    sessions: stats,
    timestamp: new Date().toISOString(),
  });
});

// ── API Routes ──────────────────────────────────────────────────────
app.use('/api', rateLimiter, apiKeyAuth, webhookRouter);

// ── Zendesk Messaging Webhook (no API key auth — uses signature verification) ──
app.use('/zendesk', zendeskRouter);

// ── 404 Handler ─────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({
    error: 'Not found',
    hint: 'POST /api/chat to send messages, or connect to /ws/chat for live chat.',
  });
});

// ── Global Error Handler ────────────────────────────────────────────
app.use((err, req, res, next) => {
  logger.error(`Unhandled error: ${err.message}`, { stack: err.stack });
  res.status(500).json({
    error: 'Internal server error',
    message: env.isDev ? err.message : 'Something went wrong.',
  });
});

// ── Start Server ────────────────────────────────────────────────────
const server = createServer(app);

// Attach WebSocket live chat
attachLiveChat(server);

// Start polling for Microsoft 365 emails
if (env.msGraphTenantId && env.msGraphClientId && env.msGraphClientSecret && env.msGraphUserId) {
  startEmailPolling();
} else {
  logger.info('Microsoft 365 Email Polling disabled (missing Graph credentials).');
}

server.listen(env.port, () => {
  logger.info(`
╔══════════════════════════════════════════════════════════╗
║                                                          ║
║   🚀  KopaDot AI Support Agent — LIVE                    ║
║                                                          ║
║   REST API:   http://localhost:${env.port}/api/chat           ║
║   Live Chat:  ws://localhost:${env.port}/ws/chat              ║
║   Zendesk:    http://localhost:${env.port}/zendesk/webhooks        ║
║   Health:     http://localhost:${env.port}/health              ║
║                                                          ║
║   Model:      ${env.geminiModel.padEnd(38)}   ║
║   Mode:       ${(env.isDev ? 'Development' : 'Production').padEnd(38)}   ║
║                                                          ║
║   🧠 All intelligence powered by Gemini AI               ║
║   📡 No regex • No static responses • Pure AI            ║
║                                                          ║
╚══════════════════════════════════════════════════════════╝
  `);
});

// ── Graceful Shutdown ───────────────────────────────────────────────
function shutdown(signal) {
  logger.info(`${signal} received — shutting down gracefully...`);
  server.close(() => {
    logger.info('HTTP server closed');
    process.exit(0);
  });

  // Force exit after 10 seconds
  setTimeout(() => {
    logger.error('Graceful shutdown timed out — forcing exit');
    process.exit(1);
  }, 10_000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection', { error: reason?.message || reason });
});

process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception', { error: error.message, stack: error.stack });
  process.exit(1);
});

export default app;
