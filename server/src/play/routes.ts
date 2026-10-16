import { timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Express, Request } from 'express';
import { ApiError } from '../errors.js';
import {
  adminTransition,
  cancelBooking,
  confirmBooking,
  createBooking,
  createHold,
  getBooking,
  listAllBookings,
  listMyBookings,
  releaseExpiredHolds,
  type Actor,
} from './bookings.js';
import { ensureMatchSchema } from './matchSchema.js';
import {
  acceptInvitation,
  createOpenMatch,
  declineInvitation,
  getPreferences,
  inviteToMatch,
  joinOpenMatch,
  listMatchesForFacility,
  myGames,
  searchPlayNow,
  seedDemoOpenMatches,
  setPreferences,
} from './openMatches.js';
import {
  acceptOffer,
  adminQueue,
  cancelEntry,
  courtReady,
  declineOffer,
  getSettings,
  joinQueue,
  listAudit,
  myQueue,
  onSlotFreed,
  publicStatus,
  putSettings,
  seedDemoQueue,
  sweepQueue,
} from './queue.js';
import { ensureQueueSchema } from './queueSchema.js';
import { ensureFillSchema, seedPromotionRules } from './fillSchema.js';
import { ensurePlaySchema } from './schema.js';
import {
  approveFillRequest,
  disableFill,
  fillRevenueSummary,
  getFillSettings,
  listVacantDemoSlots,
  publishFillGame,
  putFillSettings,
  rejectFillRequest,
  requestFillJoin,
} from './smartFill.js';
import { createSlot, listSlots, seedDemoSlots, setSlotStatus, verifySlot } from './slots.js';
import { iso, loadPlayConfig, type PlayConfig } from './util.js';

export type PlayHandle = { config: PlayConfig; stop: () => void };

const PLAYER_ID = /^[A-Za-z0-9_.-]{1,80}$/;

/**
 * Demo identity: there is no player login yet, so a player is whoever sends `x-player-id` for an
 * existing player row. Facility actions need `x-admin-token` to match PLAYBACK_ADMIN_TOKEN
 * (local default `demo-admin`; disabled in production unless the variable is set).
 */
function playerOf(db: DatabaseSync, req: Request): string {
  const id = req.header('x-player-id');
  if (!id || !PLAYER_ID.test(id)) throw new ApiError(401, 'player_required');
  if (!db.prepare('SELECT 1 FROM players WHERE id = ?').get(id)) throw new ApiError(401, 'player_required');
  return id;
}

function requireAdmin(cfg: PlayConfig, req: Request): void {
  const given = req.header('x-admin-token') ?? '';
  const expected = cfg.adminToken;
  if (!expected) throw new ApiError(403, 'admin_disabled');
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new ApiError(403, 'admin_required');
}

const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const body = (req: Request): Record<string, unknown> =>
  req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {};
const keyOf = (req: Request) => body(req).idempotencyKey ?? req.header('idempotency-key');

export function mountPlay(
  app: Express,
  db: DatabaseSync,
  overrides: Partial<PlayConfig> = {},
  timerMs = 15_000,
): PlayHandle {
  const cfg: PlayConfig = { ...loadPlayConfig(), ...overrides };
  ensurePlaySchema(db);
  seedDemoSlots(db, cfg.now());
  ensureMatchSchema(db);
  ensureFillSchema(db);
  if (cfg.seedDemoMatches) seedDemoOpenMatches(db, cfg);
  ensureQueueSchema(db);
  if (cfg.seedDemoMatches) seedDemoQueue(db, cfg);
  seedPromotionRules(db, iso(cfg.now()));

  app.get('/api/play/slots', (req, res) => {
    const facilityId = str(req.query.facilityId);
    const date = str(req.query.date);
    if (!facilityId || !date) throw new ApiError(400, 'invalid_query');
    res.json({ slots: listSlots(db, cfg, { facilityId, date }), staleAfterMinutes: cfg.staleMinutes });
  });

  app.post('/api/play/holds', (req, res) => {
    const player = playerOf(db, req);
    const result = createHold(db, cfg, player, { slotId: body(req).slotId, idempotencyKey: keyOf(req) });
    res.status(result.replayed ? 200 : 201).json(result);
  });

  app.post('/api/play/bookings', (req, res) => {
    const player = playerOf(db, req);
    const { slotId, holdId } = body(req);
    const result = createBooking(db, cfg, player, { slotId, holdId, idempotencyKey: keyOf(req) });
    res.status(result.replayed ? 200 : 201).json(result);
  });

  app.get('/api/play/my-bookings', (req, res) => {
    res.json({ bookings: listMyBookings(db, cfg, playerOf(db, req)) });
  });

  app.get('/api/play/bookings/:id', (req, res) => {
    const actor: Actor = { kind: 'player', playerId: playerOf(db, req) };
    res.json({ booking: getBooking(db, cfg, actor, req.params.id) });
  });

  app.post('/api/play/bookings/:id/confirm', (req, res) => {
    res.json(confirmBooking(db, cfg, playerOf(db, req), req.params.id));
  });

  app.post('/api/play/bookings/:id/cancel', (req, res) => {
    const result = cancelBooking(db, cfg, { kind: 'player', playerId: playerOf(db, req) }, req.params.id);
    if (!result.replayed && result.booking.slotId) onSlotFreed(db, cfg, result.booking.slotId);
    res.json(result);
  });

  // Play Now: search, open matches, invitations. Players are identified by x-player-id (demo scheme).
  app.get('/api/play/preferences', (req, res) => {
    res.json({ preferences: getPreferences(db, playerOf(db, req)) });
  });

  app.put('/api/play/preferences', (req, res) => {
    res.json({ preferences: setPreferences(db, cfg, playerOf(db, req), body(req)) });
  });

  app.post('/api/play/search', (req, res) => {
    res.json(searchPlayNow(db, cfg, playerOf(db, req), body(req)));
  });

  app.post('/api/play/open-matches', (req, res) => {
    const b = body(req);
    const result = createOpenMatch(db, cfg, playerOf(db, req), {
      slotId: b.slotId,
      format: b.format,
      minLevel: b.minLevel,
      maxLevel: b.maxLevel,
      idempotencyKey: keyOf(req),
    });
    res.status(result.replayed ? 200 : 201).json(result);
  });

  app.post('/api/play/open-matches/:id/join', (req, res) => {
    res.json(joinOpenMatch(db, cfg, playerOf(db, req), req.params.id));
  });

  app.post('/api/play/open-matches/:id/invite', (req, res) => {
    const result = inviteToMatch(db, cfg, playerOf(db, req), req.params.id, body(req).playerId);
    res.status(result.replayed ? 200 : 201).json(result);
  });

  app.post('/api/play/invitations/:id/accept', (req, res) => {
    res.json(acceptInvitation(db, cfg, playerOf(db, req), req.params.id));
  });

  app.post('/api/play/invitations/:id/decline', (req, res) => {
    res.json(declineInvitation(db, cfg, playerOf(db, req), req.params.id));
  });

  app.get('/api/play/my-games', (req, res) => {
    res.json(myGames(db, cfg, playerOf(db, req)));
  });

  app.get('/api/play/admin/open-matches', (req, res) => {
    requireAdmin(cfg, req);
    res.json({ matches: listMatchesForFacility(db, cfg, str(req.query.facilityId)) });
  });

  // Facility actions (demo admin token).
  app.post('/api/play/admin/slots', (req, res) => {
    requireAdmin(cfg, req);
    const b = body(req);
    const slot = createSlot(db, cfg, {
      facilityId: b.facilityId as string,
      courtId: b.courtId as string,
      date: b.date as string,
      start: b.start as string,
      end: b.end as string,
      priceVnd: b.priceVnd as number,
    });
    res.status(201).json({ slot });
  });

  app.post('/api/play/admin/slots/:id/verify', (req, res) => {
    requireAdmin(cfg, req);
    res.json({ slot: verifySlot(db, cfg, req.params.id) });
  });

  app.post('/api/play/admin/slots/:id/status', (req, res) => {
    requireAdmin(cfg, req);
    const slot = setSlotStatus(db, cfg, req.params.id, body(req).status);
    // A court that becomes available is offered to the queue when it is current.
    const offer = slot.status === 'available' ? onSlotFreed(db, cfg, slot.id) : null;
    res.json({ slot, queueOfferId: offer?.id ?? null });
  });

  app.get('/api/play/admin/bookings', (req, res) => {
    requireAdmin(cfg, req);
    res.json({
      bookings: listAllBookings(db, cfg, {
        facilityId: str(req.query.facilityId),
        status: str(req.query.status),
        date: str(req.query.date),
      }),
    });
  });

  app.post('/api/play/admin/bookings/:id/cancel', (req, res) => {
    requireAdmin(cfg, req);
    const result = cancelBooking(db, cfg, { kind: 'admin' }, req.params.id);
    if (!result.replayed && result.booking.slotId) onSlotFreed(db, cfg, result.booking.slotId);
    res.json(result);
  });

  app.post('/api/play/admin/bookings/:id/transition', (req, res) => {
    requireAdmin(cfg, req);
    res.json({ booking: adminTransition(db, cfg, req.params.id, body(req).to) });
  });

  // Smart Queue. Players are identified by x-player-id, staff by x-admin-token (demo scheme).
  app.post('/api/play/queue/join', (req, res) => {
    const b = body(req);
    const result = joinQueue(db, cfg, {
      playerId: playerOf(db, req),
      facilityId: b.facilityId,
      courtId: b.courtId,
      partySize: b.partySize,
      format: b.format,
      source: b.source,
      idempotencyKey: keyOf(req),
    });
    res.status(result.replayed ? 200 : 201).json(result);
  });

  app.post('/api/play/queue/:id/cancel', (req, res) => {
    res.json(cancelEntry(db, cfg, { kind: 'player', playerId: playerOf(db, req) }, req.params.id));
  });

  app.get('/api/play/queue/status', (req, res) => {
    const viewer = req.header('x-player-id');
    const known = viewer && PLAYER_ID.test(viewer) && db.prepare('SELECT 1 FROM players WHERE id = ?').get(viewer) ? viewer : null;
    res.json(publicStatus(db, cfg, str(req.query.facilityId), req.query.radiusKm, known));
  });

  app.get('/api/play/queue/my', (req, res) => {
    res.json(myQueue(db, cfg, playerOf(db, req)));
  });

  app.post('/api/play/queue/offers/:id/accept', (req, res) => {
    res.json(acceptOffer(db, cfg, playerOf(db, req), req.params.id));
  });

  app.post('/api/play/queue/offers/:id/decline', (req, res) => {
    res.json(declineOffer(db, cfg, playerOf(db, req), req.params.id));
  });

  app.get('/api/play/admin/queue', (req, res) => {
    requireAdmin(cfg, req);
    res.json(adminQueue(db, cfg, str(req.query.facilityId)));
  });

  app.get('/api/play/admin/queue/settings', (req, res) => {
    requireAdmin(cfg, req);
    const facilityId = str(req.query.facilityId);
    if (!facilityId || !db.prepare('SELECT 1 FROM facilities WHERE id = ?').get(facilityId)) throw new ApiError(404, 'facility_not_found');
    res.json({ settings: getSettings(db, facilityId) });
  });

  app.put('/api/play/admin/queue/settings', (req, res) => {
    requireAdmin(cfg, req);
    const b = body(req);
    res.json({ settings: putSettings(db, cfg, b.facilityId, b) });
  });

  app.post('/api/play/admin/queue/join', (req, res) => {
    requireAdmin(cfg, req);
    const b = body(req);
    if (typeof b.playerId !== 'string' || !PLAYER_ID.test(b.playerId)) throw new ApiError(400, 'invalid_body');
    const result = joinQueue(db, cfg, {
      playerId: b.playerId,
      facilityId: b.facilityId,
      courtId: b.courtId,
      partySize: b.partySize,
      format: b.format,
      idempotencyKey: keyOf(req),
      staff: true,
    });
    res.status(result.replayed ? 200 : 201).json(result);
  });

  app.post('/api/play/admin/queue/:id/cancel', (req, res) => {
    requireAdmin(cfg, req);
    res.json(cancelEntry(db, cfg, { kind: 'admin' }, req.params.id));
  });

  app.post('/api/play/admin/queue/court-ready', (req, res) => {
    requireAdmin(cfg, req);
    const b = body(req);
    res.json(courtReady(db, cfg, { facilityId: b.facilityId, courtId: b.courtId, slotId: b.slotId }));
  });

  app.get('/api/play/admin/queue/audit', (req, res) => {
    requireAdmin(cfg, req);
    res.json(listAudit(db, str(req.query.facilityId), req.query.entryId, req.query.limit));
  });

  // Smart Court Fill. The facility turns it on and approves who joins. Players are seated by Play Now.
  app.get('/api/play/admin/smart-fill/settings', (req, res) => {
    requireAdmin(cfg, req);
    res.json({ settings: getFillSettings(db, str(req.query.facilityId) ?? '') });
  });

  app.put('/api/play/admin/smart-fill/settings', (req, res) => {
    requireAdmin(cfg, req);
    res.json({ settings: putFillSettings(db, cfg, body(req)) });
  });

  app.post('/api/play/admin/smart-fill/disable', (req, res) => {
    requireAdmin(cfg, req);
    res.json({ settings: disableFill(db, cfg, body(req).facilityId) });
  });

  app.get('/api/play/admin/smart-fill/vacant-slots', (req, res) => {
    requireAdmin(cfg, req);
    res.json({ slots: listVacantDemoSlots(db, cfg, str(req.query.facilityId) ?? '') });
  });

  app.post('/api/play/admin/smart-fill/publish', (req, res) => {
    requireAdmin(cfg, req);
    const b = body(req);
    const result = publishFillGame(db, cfg, { slotId: b.slotId, hostPlayerId: b.hostPlayerId });
    res.status(result.replayed ? 200 : 201).json(result);
  });

  app.post('/api/play/admin/smart-fill/requests/:id/approve', (req, res) => {
    requireAdmin(cfg, req);
    res.json(approveFillRequest(db, cfg, req.params.id));
  });

  app.post('/api/play/admin/smart-fill/requests/:id/reject', (req, res) => {
    requireAdmin(cfg, req);
    res.json(rejectFillRequest(db, cfg, req.params.id));
  });

  app.get('/api/play/admin/smart-fill/summary', (req, res) => {
    requireAdmin(cfg, req);
    res.json({ summary: fillRevenueSummary(db, str(req.query.facilityId) ?? '') });
  });

  app.post('/api/play/smart-fill/requests', (req, res) => {
    const result = requestFillJoin(db, cfg, playerOf(db, req), body(req).openMatchId);
    res.status(result.replayed ? 200 : 201).json(result);
  });

  const timer = setInterval(() => {
    try {
      sweepQueue(db, cfg);
    } catch (error) {
      console.error('play: sweeping the queue failed', error);
    }
    try {
      releaseExpiredHolds(db, cfg);
    } catch (error) {
      console.error('play: releasing expired holds failed', error);
    }
  }, timerMs);
  timer.unref();

  return { config: cfg, stop: () => clearInterval(timer) };
}
