#!/usr/bin/env node
/**
 * Standalone local preview & JSON API server for `agy-quota-monitor`.
 *
 * Allows contributors (or custom ACP Web UIs) to run the Quota Monitor UI and `/api/status`
 * endpoint outside Antigravity's `sidecar_sdk` runtime using pure Node.js built-ins:
 *
 *   node scripts/dev-server.mjs [--port 4790]
 */

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { QuotaCollector } from '../sidecars/quota_board/collector.mjs';
import { createMockSnapshot } from '../sidecars/quota_board/mock.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const boardDir = join(__dirname, '..', 'sidecars', 'quota_board');

const portArgIdx = process.argv.indexOf('--port');
const PORT = portArgIdx >= 0 && process.argv[portArgIdx + 1]
  ? Number(process.argv[portArgIdx + 1])
  : Number(process.env.PORT || 4790);
const FORCE_MOCK = process.argv.includes('--mock') || process.env.AGY_QUOTA_MOCK === '1';

const collector = new QuotaCollector();

const server = createServer((req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  if (url.pathname === '/' || url.pathname === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(readFileSync(join(boardDir, 'index.html'), 'utf-8'));
    return;
  }

  if (url.pathname === '/preload.js') {
    // Minimal standalone stub when running outside Antigravity's Sidecar iframe
    res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
    res.end('/* standalone mode: CSS fallback theme variables active */\n');
    return;
  }

  if (url.pathname === '/styles.css') {
    res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8' });
    res.end(readFileSync(join(boardDir, 'styles.css'), 'utf-8'));
    return;
  }

  if (url.pathname === '/app.js') {
    res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
    res.end(readFileSync(join(boardDir, 'app.js'), 'utf-8'));
    return;
  }

  if (url.pathname === '/api/status') {
    const conv = url.searchParams.get('conversationId') || '';
    const etag = url.searchParams.get('etag') || '';
    const forceRefresh = url.searchParams.get('refresh') === '1';
    const useMock = FORCE_MOCK || url.searchParams.get('mock') === '1';
    const mockMode = url.searchParams.get('mode') || 'healthy';
    const snap = useMock
      ? createMockSnapshot({ mode: mockMode })
      : collector.getSnapshot({ conversationId: conv, forceRefresh });
    const body = !forceRefresh && etag && etag === snap.etag
      ? { unchanged: true, etag: snap.etag, nowMs: snap.nowMs }
      : snap;
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify(body));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not Found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[agy-quota-monitor] Standalone server listening at http://127.0.0.1:${PORT}`);
});
