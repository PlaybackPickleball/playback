import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { ApiError } from '../errors.js';

export class PlayError extends ApiError {}

export const fail = (status: number, code: string): never => {
  throw new PlayError(status, code);
};

export type PlayConfig = {
  holdTtlSeconds: number;
  staleMinutes: number;
  /** null disables every facility/admin action. */
  adminToken: string | null;
  now: () => number;
  /** Open matches keep their court held this long while players are found. */
  openMatchHoldSeconds: number;
  /** A pending invitation reserves a seat for this long. */
  inviteTtlSeconds: number;
  /** Seed the demo open matches at start. Tests that count bookings switch it off. */
  seedDemoMatches: boolean;
  /** Smart Queue: a free court is offered automatically only when its slot starts within this many minutes. */
  queueLookaheadMinutes: number;
  /** Smart Queue: a waiting entry (not a demo one) expires after this many minutes. */
  queueEntryTtlMinutes: number;
};

function positive(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export function loadPlayConfig(env: NodeJS.ProcessEnv = process.env): PlayConfig {
  const explicit = env.PLAYBACK_ADMIN_TOKEN?.trim();
  return {
    holdTtlSeconds: positive(env.PLAY_HOLD_TTL_SECONDS, 300),
    staleMinutes: positive(env.PLAY_STALE_MINUTES, 15),
    // Demo token for local use only. A production run without an explicit token has no admin access.
    adminToken: explicit || (env.NODE_ENV === 'production' ? null : 'demo-admin'),
    now: () => Date.now(),
    openMatchHoldSeconds: positive(env.PLAY_OPEN_MATCH_HOLD_SECONDS, 1800),
    inviteTtlSeconds: positive(env.PLAY_INVITE_TTL_SECONDS, 1800),
    seedDemoMatches: true,
    queueLookaheadMinutes: positive(env.PLAY_QUEUE_LOOKAHEAD_MINUTES, 60),
    queueEntryTtlMinutes: positive(env.PLAY_QUEUE_ENTRY_TTL_MINUTES, 180),
  };
}

const depth = new WeakMap<DatabaseSync, number>();

/** BEGIN IMMEDIATE transaction. Nested calls join the outer transaction. */
export function tx<T>(db: DatabaseSync, fn: () => T): T {
  const level = depth.get(db) ?? 0;
  if (level > 0) return fn();
  db.exec('BEGIN IMMEDIATE');
  depth.set(db, 1);
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // already rolled back by SQLite
    }
    throw error;
  } finally {
    depth.set(db, 0);
  }
}

export const newId = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
export const iso = (ms: number) => new Date(ms).toISOString();

const VENUE_OFFSET_MS = 7 * 3600_000; // Asia/Ho_Chi_Minh, no DST

/** Venue-local `YYYY-MM-DDTHH:MM` for a UTC millisecond clock. */
export const venueLocal = (ms: number) => new Date(ms + VENUE_OFFSET_MS).toISOString().slice(0, 16);

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export function validDate(value: unknown): value is string {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

export function cleanKey(value: unknown): string | null {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{8,100}$/.test(value)) return fail(400, 'invalid_idempotency_key');
  return value;
}

export const rowNum = (value: unknown) => Number(value);
