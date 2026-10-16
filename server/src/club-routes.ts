import type { Express } from 'express';
import { ApiError } from './errors.js';
import type { Store } from './db.js';
import {
  attachSession,
  ClubError,
  confirmMatchScore,
  courtMatch,
  createGuest,
  ensureClubSchema,
  facilitySummary,
  getMatch,
  getPlayer,
  joinCourt,
  leaveMatch,
  listPlayers,
  matchForSession,
  recommendFromIds,
  resetDemo,
  setMatchMode,
  startSimulated,
  updatePlayer,
  verifyMatch,
  videoJob,
} from './club.js';

function courtId(value: string): string {
  if (!/^court-[1-8]$/.test(value)) throw new ApiError(404, 'not_found');
  return value;
}

function mapClub(error: unknown): never {
  if (error instanceof ClubError) {
    const status =
      error.code === 'not_found'
        ? 404
        : error.code === 'invalid_body' ||
            error.code === 'need_four_players' ||
            error.code === 'invalid_score' ||
            error.code === 'tied_score' ||
            error.code === 'reset_denied'
          ? 400
          : 409;
    throw new ApiError(status, error.code);
  }
  throw error;
}

function nameOf(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.trim().replace(/\s+/g, ' ');
  if (name.length < 1 || name.length > 40) return null;
  return name;
}

export function mountClub(app: Express, store: Store, publicBaseUrl: string): void {
  ensureClubSchema(store.db);
  const db = store.db;

  app.get('/api/players', (_req, res) => {
    res.json({ players: listPlayers(db, publicBaseUrl) });
  });

  app.post('/api/players', (req, res) => {
    const displayName = nameOf(req.body?.displayName);
    const language = req.body?.language === 'vi' ? 'vi' : req.body?.language === 'en' ? 'en' : null;
    if (!displayName || !language) throw new ApiError(400, 'invalid_body');
    try {
      res.status(201).json(createGuest(db, displayName, language, publicBaseUrl));
    } catch (error) {
      mapClub(error);
    }
  });

  app.get('/api/players/:playerId', (req, res) => {
    try {
      res.json(getPlayer(db, req.params.playerId, publicBaseUrl));
    } catch (error) {
      mapClub(error);
    }
  });

  app.patch('/api/players/:playerId', (req, res) => {
    if (!req.body || typeof req.body !== 'object') throw new ApiError(400, 'invalid_body');
    try {
      res.json(updatePlayer(db, req.params.playerId, req.body as Record<string, unknown>, publicBaseUrl));
    } catch (error) {
      mapClub(error);
    }
  });

  app.get('/api/courts/:courtId/match', (req, res) => {
    res.json(courtMatch(db, courtId(req.params.courtId), publicBaseUrl));
  });

  app.post('/api/courts/:courtId/join', (req, res) => {
    const team = req.body?.team;
    if ((team !== 'A' && team !== 'B') || typeof req.body?.playerId !== 'string') throw new ApiError(400, 'invalid_body');
    try {
      res.status(201).json(joinCourt(db, courtId(req.params.courtId), req.body.playerId, team, publicBaseUrl));
    } catch (error) {
      mapClub(error);
    }
  });

  app.post('/api/matches/:matchId/leave', (req, res) => {
    if (typeof req.body?.playerId !== 'string') throw new ApiError(400, 'invalid_body');
    try {
      res.json(leaveMatch(db, req.params.matchId, req.body.playerId, publicBaseUrl));
    } catch (error) {
      mapClub(error);
    }
  });

  app.post('/api/matches/:matchId/mode', (req, res) => {
    const mode = req.body?.mode;
    if (mode !== 'singles' && mode !== 'doubles') throw new ApiError(400, 'invalid_body');
    try {
      res.json(setMatchMode(db, req.params.matchId, mode, publicBaseUrl));
    } catch (error) {
      mapClub(error);
    }
  });

  app.post('/api/matches/:matchId/session', (req, res) => {
    if (typeof req.body?.token !== 'string') throw new ApiError(400, 'invalid_body');
    try {
      res.json(attachSession(db, req.params.matchId, req.body.token, publicBaseUrl));
    } catch (error) {
      mapClub(error);
    }
  });

  app.post('/api/matches/:matchId/start', (req, res) => {
    try {
      res.json(startSimulated(db, req.params.matchId, publicBaseUrl));
    } catch (error) {
      mapClub(error);
    }
  });

  app.get('/api/matches/:matchId', (req, res) => {
    try {
      res.json(getMatch(db, req.params.matchId, publicBaseUrl));
    } catch (error) {
      mapClub(error);
    }
  });

  app.post('/api/matches/:matchId/score', (req, res) => {
    const scoreA = Number(req.body?.scoreA);
    const scoreB = Number(req.body?.scoreB);
    try {
      res.json(confirmMatchScore(db, req.params.matchId, scoreA, scoreB, publicBaseUrl));
    } catch (error) {
      mapClub(error);
    }
  });

  app.post('/api/matches/:matchId/verify', (req, res) => {
    try {
      res.json(verifyMatch(db, req.params.matchId, publicBaseUrl));
    } catch (error) {
      mapClub(error);
    }
  });

  app.get('/api/matches/:matchId/video-job', (req, res) => {
    res.json(videoJob(req.params.matchId));
  });

  app.get('/api/sessions/:token/match', (req, res) => {
    try {
      res.json(matchForSession(db, req.params.token, publicBaseUrl));
    } catch (error) {
      mapClub(error);
    }
  });

  app.post('/api/matchmaking', (req, res) => {
    const ids = req.body?.playerIds;
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) throw new ApiError(400, 'invalid_body');
    try {
      res.json(recommendFromIds(db, ids));
    } catch (error) {
      mapClub(error);
    }
  });

  app.get('/api/facility', (_req, res) => {
    res.json(facilitySummary(db, publicBaseUrl));
  });

  app.post('/api/facility/reset', (req, res) => {
    if (req.body?.confirm !== 'RESET DEMO') throw new ApiError(400, 'reset_denied');
    try {
      res.json(resetDemo(db));
    } catch (error) {
      mapClub(error);
    }
  });
}
