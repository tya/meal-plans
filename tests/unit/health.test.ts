import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import Database from 'better-sqlite3';
import { runMigrations } from '../../server/db/schema.js';
import { checkDatabase, checkKroger, report, watchSlack } from '../../server/http/health.js';
import type { KrogerAuth } from '../../server/integrations/kroger/kroger-auth.js';
import type { KrogerTokenStore } from '../../server/integrations/kroger/token-store.js';

describe('watchSlack', () => {
  it('is ok once connected, degraded while reconnecting, down after the grace period', () => {
    const client = new EventEmitter();
    let t = 0;
    const check = watchSlack(client, () => t);

    client.emit('connected');
    expect(check()).toMatchObject({ status: 'ok', state: 'connected', reconnects: 0 });

    t = 1_000;
    client.emit('reconnecting');
    t = 60_000;
    expect(check()).toMatchObject({ status: 'degraded', state: 'reconnecting', reconnects: 1 });

    t = 1_000 + 120_000;
    expect(check()).toMatchObject({ status: 'down', state: 'reconnecting' });

    client.emit('connected');
    expect(check().status).toBe('ok');
  });
});

describe('checkDatabase', () => {
  it('counts what the planner draws on', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    db.prepare(`INSERT INTO recipes (id, title) VALUES ('r1', 'Tacos'), ('r2', 'Chili')`).run();
    db.prepare(
      `INSERT INTO cart_ledger (week_start, upc, quantity) VALUES ('2026-11-29', '1', 1), ('2026-11-29', '2', 2)`
    ).run();

    expect(checkDatabase(db)).toMatchObject({ status: 'ok', recipes: 2, receipts: 0, cartWeeks: 1 });
  });

  it('is down when SQLite fails', () => {
    const db = new Database(':memory:');
    db.close();
    expect(checkDatabase(db).status).toBe('down');
  });
});

describe('checkKroger', () => {
  const auth = (fails = false) =>
    ({ getClientToken: async () => { if (fails) throw new Error('401'); return 't'; } }) as unknown as KrogerAuth;
  const tokens = (status: ReturnType<KrogerTokenStore['status']>) =>
    ({ status: () => status }) as unknown as KrogerTokenStore;

  it('is degraded, not down, when Kroger is not configured', async () => {
    expect(await checkKroger(null, null)).toEqual({ status: 'degraded', configured: false });
  });

  it('is ok with working credentials and a customer token', async () => {
    const check = await checkKroger(auth(), tokens({ present: true, updatedAt: 'x', scope: 's', lastRefreshError: null }));
    expect(check).toMatchObject({ status: 'ok', api: { status: 'ok' }, cart: { status: 'ok' } });
  });

  it('reports the api and the cart separately', async () => {
    const check = await checkKroger(auth(true), tokens({ present: false, lastRefreshError: null }));
    expect(check).toMatchObject({ status: 'degraded', api: { status: 'degraded', error: '401' }, cart: { status: 'degraded' } });
  });

  it('surfaces a failed refresh', async () => {
    const check = await checkKroger(auth(), tokens({ present: true, updatedAt: 'x', lastRefreshError: 'invalid_grant' }));
    expect(check.cart).toMatchObject({ status: 'degraded', error: 'invalid_grant' });
  });
});

describe('report', () => {
  it('takes the worst status', () => {
    expect(report({ a: { status: 'ok' }, b: { status: 'degraded' } }, Date.now()).status).toBe('degraded');
    expect(report({ a: { status: 'down' }, b: { status: 'degraded' } }, Date.now()).status).toBe('down');
    expect(report({ a: { status: 'ok' } }, Date.now()).status).toBe('ok');
  });
});
