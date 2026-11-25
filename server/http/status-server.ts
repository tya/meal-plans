/**
 * The bot talks to Slack over Socket Mode and needs no inbound port for that.
 * This server exists only so meal-plans.tynet.us has something to answer with —
 * the health report from ./health.ts, on every path. TLS cert and key come from
 * a cert-manager Secret mounted by the chart; if they're not present (local
 * dev), the server simply doesn't start.
 *
 * /healthz answers 503 when the report is `down`, so a probe can act on it;
 * every other path always answers 200, so the page stays readable either way.
 */

import { createServer as createHttpsServer } from 'node:https';
import { existsSync, readFileSync } from 'node:fs';
import type { HealthReport } from './health.js';
import { log } from '../utils/logger.js';

export function startStatusServer(health: () => Promise<HealthReport>): void {
  const port = Number(process.env.STATUS_PORT ?? 8443);
  const certFile = process.env.TLS_CERT_FILE ?? '/etc/tls/tls.crt';
  const keyFile = process.env.TLS_KEY_FILE ?? '/etc/tls/tls.key';

  if (!existsSync(certFile) || !existsSync(keyFile)) {
    log('info', 'Status server not started: no TLS cert at ' + certFile);
    return;
  }

  const server = createHttpsServer(
    { cert: readFileSync(certFile), key: readFileSync(keyFile) },
    (req, res) => {
      health()
        .then((report) => {
          const code = req.url === '/healthz' && report.status === 'down' ? 503 : 200;
          res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(report, null, 2));
        })
        .catch((error: unknown) => {
          log('error', 'Health report failed', error);
          res.writeHead(500, { 'content-type': 'text/plain' }).end('health report failed');
        });
    }
  );

  server.listen(port, () => log('info', `Status server listening on ${port}`));
}
