/**
 * Antigravity Sidecar UI entrypoint for Quota Monitor (`quota_board`).
 *
 * Uses Antigravity's built-in `sidecar_sdk` (zero npm install required) to serve
 * the auxiliary side-pane UI and a fast read-only `/api/status` JSON endpoint.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Response, SidecarApp } from 'sidecar_sdk';
import { QuotaCollector } from './collector.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const collector = new QuotaCollector();

const STATIC_ASSETS = {
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'application/javascript; charset=utf-8'],
};

const app = new SidecarApp();

app.page('/', () => readFileSync(join(__dirname, 'index.html'), 'utf-8'));

for (const [route, [filename, contentType]] of Object.entries(STATIC_ASSETS)) {
  app.api(
    route,
    () =>
      new Response(readFileSync(join(__dirname, filename), 'utf-8'), {
        contentType,
        headers: { 'Cache-Control': 'no-store, max-age=0' },
      }),
    'GET'
  );
}

/**
 * Primary read-only telemetry endpoint polled by the sidecar UI.
 * Responds synchronously in <2ms from mtime-cached local transcripts + background CLI cache.
 */
app.api(
  '/api/status',
  (data = {}) => {
    const conv = String(data.conversationId || app.config?.conversationId || '').trim();
    const forceRefresh = data.refresh === '1' || data.refresh === 'true';
    const snap = collector.getSnapshot({ conversationId: conv, forceRefresh });
    if (!forceRefresh && data.etag && data.etag === snap.etag) {
      return { unchanged: true, etag: snap.etag, nowMs: snap.nowMs };
    }
    return snap;
  },
  'GET'
);

app.run();
