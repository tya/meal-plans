/**
 * What /healthz reports: one check per dependency, each `ok`, `degraded` or
 * `down`, rolled up into one status.
 *
 * Only Slack and the database can take the whole service down — they are what
 * a restart might fix. A Kroger problem is `degraded`: the bot still plans the
 * week, it just can't price it or fill the cart, and no restart re-authorizes
 * an expired refresh token.
 */

import type Database from 'better-sqlite3';
import type { KrogerAuth } from '../integrations/kroger/kroger-auth.js';
import type { KrogerTokenStore } from '../integrations/kroger/token-store.js';

export type CheckStatus = 'ok' | 'degraded' | 'down';

export interface Check {
  status: CheckStatus;
  [detail: string]: unknown;
}

export interface HealthReport {
  service: 'meal-planner';
  status: CheckStatus;
  uptimeSeconds: number;
  checks: Record<string, Check>;
}

/** Bolt reconnects on its own; a socket that hasn't come back by now won't. */
const SLACK_GRACE_MS = Number(process.env.HEALTH_SLACK_GRACE_MS ?? 120_000);
/** Long enough for a slow token endpoint, short enough for a probe. */
const KROGER_TIMEOUT_MS = 5_000;

/**
 * Follows the Socket Mode client's state events. The client has no public
 * "are you connected" getter, so the last event seen is the answer.
 */
export function watchSlack(client: { on(event: string, fn: () => void): unknown }, now: () => number = Date.now) {
  let state = 'connecting';
  let since = now();
  let lastConnectedAt: number | null = null;
  let reconnects = 0;

  for (const event of ['connecting', 'connected', 'reconnecting', 'disconnecting', 'disconnected']) {
    client.on(event, () => {
      state = event;
      since = now();
      if (event === 'connected') lastConnectedAt = since;
      if (event === 'reconnecting') reconnects += 1;
    });
  }

  return (): Check => {
    const forMs = now() - since;
    const status: CheckStatus =
      state === 'connected' ? 'ok' : forMs < SLACK_GRACE_MS ? 'degraded' : 'down';
    return {
      status,
      state,
      stateForSeconds: Math.round(forMs / 1000),
      lastConnectedAt: lastConnectedAt ? new Date(lastConnectedAt).toISOString() : null,
      reconnects,
    };
  };
}

/** Row counts for what the planner draws on. Any SQLite error is `down`. */
export function checkDatabase(db: Database.Database): Check {
  try {
    const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
    const latest = (sql: string) => (db.prepare(sql).get() as { at: string | null }).at;
    return {
      status: 'ok',
      recipes: count(`SELECT COUNT(*) AS n FROM recipes`),
      receipts: count(`SELECT COUNT(*) AS n FROM purchase_receipts`),
      lastPurchaseAt: latest(`SELECT MAX(purchased_at) AS at FROM purchase_receipts`),
      staples: count(`SELECT COUNT(*) AS n FROM purchase_upc_stats WHERE basket_count >= 3 AND description IS NOT NULL`),
      rejectedMatches: count(`SELECT COUNT(*) AS n FROM match_feedback`),
      cartWeeks: count(`SELECT COUNT(DISTINCT week_start) AS n FROM cart_ledger`),
      lastCartAddAt: latest(`SELECT MAX(added_at) AS at FROM cart_ledger`),
    };
  } catch (error) {
    return { status: 'down', error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Two things, because they fail separately: the app's own credentials (which
 * search and pricing use) and the household's customer token (which the cart
 * uses). The first is checked live — KrogerAuth caches it, so that is at most
 * one call to Kroger per half hour. The second is only read from disk:
 * refreshing it here would rotate the refresh token on every probe.
 */
export async function checkKroger(auth: KrogerAuth | null, tokens: KrogerTokenStore | null): Promise<Check> {
  if (!auth || !tokens) return { status: 'degraded', configured: false };

  let api: Check;
  try {
    await withTimeout(auth.getClientToken(), KROGER_TIMEOUT_MS);
    api = { status: 'ok' };
  } catch (error) {
    api = { status: 'degraded', error: error instanceof Error ? error.message : String(error) };
  }

  const token = tokens.status();
  const cart: Check = !token.present
    ? { status: 'degraded', error: 'no customer token — run `npm run kroger:auth`' }
    : token.lastRefreshError
      ? { status: 'degraded', error: token.lastRefreshError, lastRefreshedAt: token.updatedAt }
      : { status: 'ok', lastRefreshedAt: token.updatedAt, scope: token.scope };

  return { status: worst([api.status, cart.status]), configured: true, api, cart };
}

export function report(checks: Record<string, Check>, startedAt: number): HealthReport {
  return {
    service: 'meal-planner',
    status: worst(Object.values(checks).map((c) => c.status)),
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    checks,
  };
}

function worst(statuses: CheckStatus[]): CheckStatus {
  if (statuses.includes('down')) return 'down';
  if (statuses.includes('degraded')) return 'degraded';
  return 'ok';
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
