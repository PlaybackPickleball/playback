import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import type { AppConfig } from './config.js';
import { COURTS, FACILITY_COURTS, RECORDING_COURT } from './config.js';
import { Store } from './db.js';
import { ApiError } from './errors.js';
import { mountClub } from './club-routes.js';
import { mountPlay } from './play/routes.js';
import { markMatchRecording, releaseMatchRecording } from './club.js';
import {
  GAME_TO,
  deriveRallies,
  normalizePhone,
  tally,
  type EndId,
} from './match.js';
import {
  MIN_VIDEO_BYTES,
  dedupeHighlights,
  detectContainer,
  mimeMatches,
  playbackMime,
  removeEndVideo,
  removeVideos,
  videoPath,
  type Container,
} from './media.js';
import { LiveBook, type LiveAction } from './live.js';
import { StationBook } from './station.js';
import type {
  HighlightEvent,
  Mode,
  PublicContact,
  PublicSession,
  PublicVideo,
  ScoreEvent,
  SessionRow,
  SessionStatus,
  SwitchEvent,
  Teams,
} from './types.js';

const TOKEN_RE = /^[A-Za-z0-9_-]{20,80}$/;
const LIVE_ID = /^[A-Za-z0-9_-]{8,80}$/;
const TRANSITIONS: Record<SessionStatus, SessionStatus[]> = {
  draft: ['recording'],
  recording: ['saving', 'failed'],
  saving: ['ready', 'failed', 'saving'],
  failed: ['saving'],
  ready: [],
};

function isCourt(value: string): boolean {
  return (COURTS as readonly string[]).includes(value);
}

function cleanName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.trim().replace(/\s+/g, ' ');
  if (name.length < 1 || name.length > 40) return null;
  return name;
}

function parseTeams(body: unknown, mode: Mode): Teams {
  if (!body || typeof body !== 'object') throw new ApiError(400, 'invalid_body');
  const record = body as { teams?: { A?: unknown; B?: unknown } };
  const expected = mode === 'singles' ? 1 : 2;
  const read = (value: unknown) => {
    if (!Array.isArray(value) || value.length !== expected) return null;
    const names = value.map(cleanName);
    if (names.some((name) => name === null)) return null;
    return names as string[];
  };
  const A = read(record.teams?.A);
  const B = read(record.teams?.B);
  if (!A || !B) throw new ApiError(400, 'invalid_body');
  return { A, B };
}

function parseStartingEnds(body: unknown): { A: EndId; B: EndId } | null {
  if (!body || typeof body !== 'object') return null;
  const value = (body as { startingEnds?: unknown }).startingEnds;
  if (value == null) return null;
  if (!value || typeof value !== 'object') throw new ApiError(400, 'invalid_body');
  const A = (value as { A?: unknown }).A;
  const B = (value as { B?: unknown }).B;
  if ((A !== 1 && A !== 2) || (B !== 1 && B !== 2) || A === B) throw new ApiError(400, 'invalid_body');
  return { A, B };
}

function decodeHeaderJson(value: string | undefined): unknown {
  if (!value) return [];
  try {
    return JSON.parse(Buffer.from(value, 'base64').toString('utf8'));
  } catch {
    throw new ApiError(400, 'invalid_body');
  }
}

function parseScores(value: unknown, maxOffset: number): ScoreEvent[] {
  if (!Array.isArray(value) || value.length > 500) throw new ApiError(400, 'invalid_body');
  return value.map((item) => {
    if (!item || typeof item !== 'object') throw new ApiError(400, 'invalid_body');
    const team = (item as { team?: unknown }).team;
    const offsetMs = Number((item as { offsetMs?: unknown }).offsetMs);
    if ((team !== 'A' && team !== 'B') || !Number.isInteger(offsetMs) || offsetMs < 0 || offsetMs > maxOffset) {
      throw new ApiError(400, 'invalid_body');
    }
    return { team, offsetMs };
  });
}

function parseHighlights(value: unknown, maxOffset: number): HighlightEvent[] {
  if (!Array.isArray(value) || value.length > 200) throw new ApiError(400, 'invalid_body');
  const parsed = value.map((item) => {
    if (!item || typeof item !== 'object') throw new ApiError(400, 'invalid_body');
    const offsetMs = Number((item as { offsetMs?: unknown }).offsetMs);
    if (!Number.isInteger(offsetMs) || offsetMs < 0 || offsetMs > maxOffset) {
      throw new ApiError(400, 'invalid_body');
    }
    return { offsetMs };
  });
  return dedupeHighlights(parsed);
}

function parseSwitches(value: unknown, maxOffset: number): SwitchEvent[] {
  if (!Array.isArray(value) || value.length > 20) throw new ApiError(400, 'invalid_body');
  return value.map((item) => {
    if (!item || typeof item !== 'object') throw new ApiError(400, 'invalid_body');
    const offsetMs = Number((item as { offsetMs?: unknown }).offsetMs);
    if (!Number.isInteger(offsetMs) || offsetMs < 0 || offsetMs > maxOffset) {
      throw new ApiError(400, 'invalid_body');
    }
    return { offsetMs };
  });
}

function parseLiveAction(body: unknown): LiveAction {
  if (!body || typeof body !== 'object') throw new ApiError(400, 'invalid_body');
  const id = (body as { id?: unknown }).id;
  const action = (body as { action?: unknown }).action;
  if (typeof id !== 'string' || !LIVE_ID.test(id)) throw new ApiError(400, 'invalid_body');
  if (action === 'undo' || action === 'switch') return { id, action };
  if (action === 'point') {
    const team = (body as { team?: unknown }).team;
    if (team !== 'A' && team !== 'B') throw new ApiError(400, 'invalid_body');
    return { id, action, team };
  }
  throw new ApiError(400, 'invalid_body');
}

function parseCameraEnd(value: string | undefined): EndId | null {
  if (value == null || value === '') return null;
  if (value === '1') return 1;
  if (value === '2') return 2;
  throw new ApiError(400, 'invalid_body');
}

function parseExpectedEnds(value: string | undefined, end: EndId): EndId[] {
  const raw = (value && value.trim() ? value : String(end)).split(',').map((item) => item.trim());
  const ends: EndId[] = [];
  for (const item of raw) {
    if (item === '1') ends.push(1);
    else if (item === '2') ends.push(2);
    else throw new ApiError(400, 'invalid_body');
  }
  const unique = [...new Set(ends)].sort((a, b) => a - b);
  if (!unique.includes(end)) throw new ApiError(400, 'invalid_body');
  return unique;
}

function endsKey(ends: EndId[]): string {
  return ends.join(',');
}

function parseEndsKey(value: string | null): EndId[] {
  if (!value) return [];
  return value.split(',').flatMap((item) => (item === '1' ? [1] : item === '2' ? [2] : []));
}

function canTransition(from: SessionStatus, to: SessionStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export type RunningApp = {
  app: express.Express;
  store: Store;
  config: AppConfig;
  close: () => void;
};

export function createApp(config: AppConfig): RunningApp {
  fs.mkdirSync(config.storageDir, { recursive: true });
  const store = new Store(config.databasePath);
  const saving = new Set<string>();
  const stations = new StationBook();
  const live = new LiveBook();
  const app = express();

  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });
  app.use((req, res, next) => {
    const started = Date.now();
    res.on('finish', () => {
      if (req.path.startsWith('/api')) {
        console.log(`${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - started}ms`);
      }
    });
    next();
  });
  app.use(express.json({ limit: '1mb' }));

  function present(row: SessionRow): PublicSession {
    const scores = store.scores(row.id);
    const highlights = store.highlights(row.id);
    const switches = store.switches(row.id);
    const stored = store.videos(row.id);
    const videos: PublicVideo[] = stored.length
      ? stored.map((clip) => ({
          end: clip.end,
          mime: clip.mime,
          size: clip.size,
          url: `/api/sessions/${row.public_token}/video?end=${clip.end}`,
        }))
      : row.status === 'ready' && row.video_size && row.video_mime
        ? [
            {
              end: null,
              mime: row.video_mime,
              size: row.video_size,
              url: `/api/sessions/${row.public_token}/video`,
            },
          ]
        : [];
    const contactRow = store.getContact(row.id);
    const contact: PublicContact | null = contactRow
      ? {
          phone: contactRow.phone,
          playerNames: contactRow.player_names,
          courtId: contactRow.court_id,
          language: contactRow.language,
          recordingConsentAt: contactRow.recording_consent_at,
          marketingConsentAt: contactRow.marketing_consent_at,
          createdAt: contactRow.created_at,
          optedOutAt: contactRow.opted_out_at,
          channel: contactRow.channel === 'whatsapp' ? 'whatsapp' : 'zalo',
        }
      : null;
    const primary = videos[0] ?? null;
    return {
      token: row.public_token,
      courtId: row.court_id,
      mode: row.mode,
      status: row.status,
      teams: { A: JSON.parse(row.team_a_json) as string[], B: JSON.parse(row.team_b_json) as string[] },
      consentAt: row.consent_at,
      createdAt: row.created_at,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      durationMs: row.duration_ms,
      video: primary ? { mime: primary.mime, size: primary.size, url: primary.url } : null,
      videos,
      scores,
      highlights,
      switches: [],
      startingEnds: { A: 1, B: 2 },
      rallies: deriveRallies(scores, highlights),
      contact,
      score: tally(scores),
      gameTo: GAME_TO,
      switchAt: null,
      endSwitch: 'none' as const,
    };
  }

  function requireToken(raw: string): string {
    if (!TOKEN_RE.test(raw)) throw new ApiError(400, 'invalid_token');
    return raw;
  }

  function requireSession(token: string): SessionRow {
    const row = store.getByToken(token);
    if (!row) throw new ApiError(404, 'not_found');
    return row;
  }

  function requirePersonId(raw: string): string {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) {
      throw new ApiError(400, 'invalid_body');
    }
    return raw;
  }

  function dashboardContact(row: SessionRow) {
    const contact = store.getContact(row.id);
    if (!contact) return null;
    return {
      playerNames: contact.player_names,
      phone: contact.phone,
      channel: contact.channel === 'whatsapp' ? ('whatsapp' as const) : ('zalo' as const),
      marketing: Boolean(contact.marketing_consent_at),
      optedOut: Boolean(contact.opted_out_at),
      personId: contact.person_id,
    };
  }

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.get('/api/config', (_req, res) => {
    res.json({
      publicBaseUrl: config.publicBaseUrl,
      recordingLimitSeconds: config.recordingLimitSeconds,
      uploadLimitMb: config.uploadLimitMb,
      lanMode: config.lanMode,
      courts: COURTS,
      facilityCourts: FACILITY_COURTS,
      recordingCourt: RECORDING_COURT,
      gameTo: GAME_TO,
      switchAt: null,
    });
  });

  app.get('/api/courts/:courtId/station', (req, res) => {
    if (!isCourt(req.params.courtId)) throw new ApiError(404, 'not_found');
    res.json(stations.read(req.params.courtId, Date.now()));
  });

  app.post('/api/courts/:courtId/station', (req, res) => {
    if (!isCourt(req.params.courtId)) throw new ApiError(404, 'not_found');
    const ready = req.body?.ready;
    const phase = req.body?.phase;
    const sessionToken = req.body?.sessionToken ?? null;
    if (typeof ready !== 'boolean' || (phase !== 'armed' && phase !== 'recording' && phase !== 'saving')) {
      throw new ApiError(400, 'invalid_body');
    }
    if (sessionToken != null && (typeof sessionToken !== 'string' || (sessionToken !== '' && !TOKEN_RE.test(sessionToken)))) {
      throw new ApiError(400, 'invalid_body');
    }
    res.json(
      stations.heartbeat(
        req.params.courtId,
        {
          ready,
          phase,
          sessionToken: typeof sessionToken === 'string' && sessionToken ? sessionToken : null,
        },
        Date.now(),
      ),
    );
  });

  app.post('/api/courts/:courtId/commands', (req, res) => {
    const courtId = req.params.courtId;
    if (!isCourt(courtId)) throw new ApiError(404, 'not_found');
    const action = req.body?.action;
    const token = req.body?.token;
    if ((action !== 'start' && action !== 'stop') || typeof token !== 'string' || !TOKEN_RE.test(token)) {
      throw new ApiError(400, 'invalid_body');
    }
    const row = store.getByToken(token);
    if (!row || row.court_id !== courtId) throw new ApiError(404, 'not_found');
    const current = stations.read(courtId, Date.now());
    if (action === 'start' && row.status === 'recording' && current.phase === 'recording' && current.sessionToken === token) {
      res.json(current);
      return;
    }
    if (action === 'start' && row.status !== 'draft') throw new ApiError(409, 'invalid_transition');
    if (action === 'stop' && row.status !== 'recording' && row.status !== 'draft') throw new ApiError(409, 'not_recording');
    const decision = stations.command(courtId, { id: crypto.randomUUID(), action, token }, Date.now());
    if (!decision.ok) throw new ApiError(409, decision.error);
    res.json(decision.status);
  });

  function livePayload(row: SessionRow) {
    const board = live.read(row.public_token);
    return {
      recording: row.status === 'recording',
      teams: { A: JSON.parse(row.team_a_json) as string[], B: JSON.parse(row.team_b_json) as string[] },
      startingEnds: { A: 1 as const, B: 2 as const },
      endSwitch: 'none' as const,
      scores: board.snapshot.scores,
      switches: [],
      inbox: board.inbox,
    };
  }

  app.get('/api/sessions/:token/live', (req, res) => {
    const row = requireSession(requireToken(req.params.token));
    res.json(livePayload(row));
  });

  app.post('/api/sessions/:token/live', (req, res) => {
    const token = requireToken(req.params.token);
    const row = requireSession(token);
    if (row.status !== 'recording') throw new ApiError(409, 'not_recording');
    const pushed = live.push(token, parseLiveAction(req.body));
    if (!pushed.ok) throw new ApiError(409, pushed.error);
    res.json(livePayload(row));
  });

  app.post('/api/sessions/:token/live/sync', (req, res) => {
    const token = requireToken(req.params.token);
    const row = requireSession(token);
    if (row.status !== 'recording') throw new ApiError(409, 'not_recording');
    const maxOffset = Math.max(1, config.recordingLimitSeconds * 1000);
    const scores = parseScores(req.body?.scores ?? [], maxOffset);
    parseSwitches(req.body?.switches ?? [], maxOffset);
    const applied = req.body?.applied;
    if (!Array.isArray(applied) || applied.length > 100 || applied.some((item) => typeof item !== 'string')) {
      throw new ApiError(400, 'invalid_body');
    }
    live.sync(token, { scores, switches: [] }, applied);
    res.json(livePayload(row));
  });

  app.post('/api/sessions', (req, res) => {
    const courtId = typeof req.body?.courtId === 'string' ? req.body.courtId : '';
    const mode = req.body?.mode;
    if (!isCourt(courtId) || (mode !== 'singles' && mode !== 'doubles')) {
      throw new ApiError(400, 'invalid_body');
    }
    if (courtId !== RECORDING_COURT) throw new ApiError(409, 'simulated_court');
    if (req.body?.consent !== true) throw new ApiError(400, 'consent_required');
    const teams = parseTeams(req.body, mode);
    parseStartingEnds(req.body);
    const now = new Date().toISOString();
    const row: SessionRow = {
      id: crypto.randomUUID(),
      public_token: randomBytes(24).toString('base64url'),
      court_id: courtId,
      mode,
      status: 'draft',
      team_a_json: JSON.stringify(teams.A),
      team_b_json: JSON.stringify(teams.B),
      consent_at: now,
      created_at: now,
      started_at: null,
      ended_at: null,
      duration_ms: null,
      video_mime: null,
      video_size: null,
      video_ext: null,
      updated_at: now,
      team_a_end: 1,
      team_b_end: 2,
      expected_ends: null,
      end_switch: 'none',
    };
    store.insertSession(row);
    res.status(201).json(present(row));
  });

  app.post('/api/sessions/:token/start', (req, res) => {
    const token = requireToken(req.params.token);
    const row = store.getByToken(token);
    if (!row) throw new ApiError(404, 'not_found');
    if (row.status === 'recording') throw new ApiError(409, 'already_recording');
    if (!canTransition(row.status, 'recording')) throw new ApiError(409, 'invalid_transition');
    parseStartingEnds(req.body);
    const started = new Date().toISOString();
    store.updateStatus(row.id, 'recording', {
      started_at: started,
      team_a_end: 1,
      team_b_end: 2,
    });
    markMatchRecording(store.db, token, started);
    res.json(present(store.getByToken(token)!));
  });

  app.post('/api/sessions/:token/fail', (req, res) => {
    const token = requireToken(req.params.token);
    const row = store.getByToken(token);
    if (!row) throw new ApiError(404, 'not_found');
    if (row.status === 'failed') {
      res.json(present(row));
      return;
    }
    if (!canTransition(row.status, 'failed')) throw new ApiError(409, 'invalid_transition');
    store.updateStatus(row.id, 'failed');
    releaseMatchRecording(store.db, token);
    res.json(present(store.getByToken(token)!));
  });

  app.post('/api/sessions/:token/contact', (req, res) => {
    const token = requireToken(req.params.token);
    const row = requireSession(token);
    if (row.status !== 'ready') throw new ApiError(409, 'invalid_transition');
    const phone = normalizePhone(typeof req.body?.phone === 'string' ? req.body.phone : '');
    if (!phone) throw new ApiError(400, 'invalid_phone');
    const language = req.body?.language;
    if (language !== 'en' && language !== 'vi') throw new ApiError(400, 'invalid_body');
    if (typeof req.body?.marketingConsent !== 'boolean') throw new ApiError(400, 'invalid_body');
    const rawChannel = req.body?.channel;
    const channel = rawChannel == null || rawChannel === '' ? 'zalo' : rawChannel;
    if (channel !== 'zalo' && channel !== 'whatsapp') throw new ApiError(400, 'invalid_body');
    const teams = { A: JSON.parse(row.team_a_json) as string[], B: JSON.parse(row.team_b_json) as string[] };
    let playerNames = [...teams.A, ...teams.B].join(', ');
    if (req.body?.name != null) {
      if (typeof req.body.name !== 'string') throw new ApiError(400, 'invalid_body');
      const name = req.body.name.trim().replace(/\s+/g, ' ');
      if (name.length < 1 || name.length > 80) throw new ApiError(400, 'invalid_body');
      playerNames = name;
    }
    const existing = store.getContact(row.id);
    const now = new Date().toISOString();
    store.saveContact({
      id: existing?.id ?? crypto.randomUUID(),
      session_id: row.id,
      phone,
      player_names: playerNames,
      court_id: row.court_id,
      language,
      recording_consent_at: row.consent_at,
      marketing_consent_at: req.body.marketingConsent ? now : null,
      created_at: existing?.created_at ?? now,
      opted_out_at: null,
      channel,
      person_id: existing?.person_id ?? null,
    });
    res.json(present(store.getByToken(token)!));
  });

  app.post('/api/sessions/:token/contact/opt-out', (req, res) => {
    const token = requireToken(req.params.token);
    const row = requireSession(token);
    const updated = store.optOutContact(row.id, new Date().toISOString());
    if (!updated) throw new ApiError(404, 'not_found');
    res.json(present(store.getByToken(token)!));
  });

  app.post(
    '/api/sessions/:token/video',
    express.raw({
      limit: config.uploadLimitBytes,
      type: () => true,
    }),
    (req, res, next) => {
      const token = requireToken(req.params.token);
      const row = store.getByToken(token);
      if (!row) throw new ApiError(404, 'not_found');
      if (row.status === 'ready' && playable(row)) {
        res.json(present(row));
        return;
      }
      if (saving.has(token)) throw new ApiError(409, 'already_saving');
      if (row.status !== 'recording' && row.status !== 'failed' && row.status !== 'saving') {
        throw new ApiError(409, 'invalid_transition');
      }

      const durationMs = Number(req.header('x-duration-ms'));
      const maxDuration = config.recordingLimitSeconds * 1000 + 5000;
      if (!Number.isInteger(durationMs) || durationMs < 0 || durationMs > maxDuration) {
        throw new ApiError(400, 'invalid_body');
      }
      const maxOffset = Math.max(durationMs + 2000, maxDuration);
      const scores = parseScores(decodeHeaderJson(req.header('x-scores')), maxOffset);
      const highlights = parseHighlights(decodeHeaderJson(req.header('x-highlights')), maxOffset);
      parseSwitches(decodeHeaderJson(req.header('x-switches')), maxOffset);
      const cameraEnd = parseCameraEnd(req.header('x-camera-end'));
      const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const contentType = req.header('content-type') || '';

      saving.add(token);
      const tmp = path.join(config.storageDir, `.tmp-${token}-${crypto.randomUUID()}`);
      try {
        if (!canTransition(row.status, 'saving') && row.status !== 'saving') {
          throw new ApiError(409, 'invalid_transition');
        }
        store.updateStatus(row.id, 'saving');
        if (body.length < MIN_VIDEO_BYTES) throw new ApiError(400, 'empty_media');
        const container = detectContainer(body);
        if (!container || !mimeMatches(contentType, container)) throw new ApiError(400, 'invalid_media');
        fs.mkdirSync(config.storageDir, { recursive: true });
        fs.writeFileSync(tmp, body);

        if (cameraEnd == null) {
          if (store.videos(row.id).length > 0 || row.expected_ends) throw new ApiError(400, 'invalid_body');
          const finalPath = videoPath(config.storageDir, token, container, null);
          removeVideos(config.storageDir, token);
          fs.renameSync(tmp, finalPath);
          const size = fs.statSync(finalPath).size;
          store.replaceEvents(row.id, scores, highlights, []);
          store.updateStatus(row.id, 'ready', {
            ended_at: new Date().toISOString(),
            duration_ms: durationMs,
            video_mime: playbackMime(container),
            video_size: size,
            video_ext: container,
            expected_ends: null,
          });
          res.json(present(store.getByToken(token)!));
          return;
        }

        const expected = parseExpectedEnds(req.header('x-expected-ends'), cameraEnd);
        const expectedText = endsKey(expected);
        if (row.expected_ends && row.expected_ends !== expectedText) throw new ApiError(400, 'invalid_body');
        const finalPath = videoPath(config.storageDir, token, container, cameraEnd);
        removeEndVideo(config.storageDir, token, cameraEnd);
        fs.renameSync(tmp, finalPath);
        const size = fs.statSync(finalPath).size;
        store.upsertVideo(row.id, {
          end: cameraEnd,
          mime: playbackMime(container),
          size,
          ext: container,
        });
        store.replaceEvents(row.id, scores, highlights, []);
        const saved = store.videos(row.id);
        const complete = expected.every((end) => saved.some((clip) => clip.end === end && clip.size >= MIN_VIDEO_BYTES));
        const summary = saved[0];
        store.updateStatus(row.id, complete ? 'ready' : 'saving', {
          ended_at: complete ? new Date().toISOString() : null,
          duration_ms: durationMs,
          video_mime: summary ? summary.mime : null,
          video_size: saved.reduce((sum, clip) => sum + clip.size, 0),
          video_ext: summary ? summary.ext : null,
          expected_ends: expectedText,
        });
        res.json(present(store.getByToken(token)!));
      } catch (error) {
        fs.rmSync(tmp, { force: true });
        const current = store.getByToken(token);
        if (current && current.status !== 'ready') store.updateStatus(current.id, 'failed');
        next(error);
        return;
      } finally {
        saving.delete(token);
      }
    },
  );

  app.get('/api/sessions/:token', (req, res) => {
    const token = requireToken(req.params.token);
    const row = store.getByToken(token);
    if (!row) throw new ApiError(404, 'not_found');
    res.json(present(row));
  });

  app.get('/api/sessions/:token/video', (req, res) => {
    const token = requireToken(req.params.token);
    const row = store.getByToken(token);
    if (!row || row.status !== 'ready') throw new ApiError(404, 'not_found');
    const stored = store.videos(row.id);
    const download = req.query.download === '1';
    const day = row.created_at.slice(0, 10);
    if (stored.length) {
      const requested = req.query.end;
      let clip = stored.length === 1 ? stored[0] : (stored.find((item) => item.end === 1) ?? stored[0]);
      if (requested != null && requested !== '') {
        const end = requested === '1' ? 1 : requested === '2' ? 2 : null;
        if (!end) throw new ApiError(400, 'invalid_body');
        const match = stored.find((item) => item.end === end);
        if (!match) throw new ApiError(404, 'not_found');
        clip = match;
      }
      const file = videoPath(config.storageDir, token, clip.ext === 'mp4' ? 'mp4' : 'webm', clip.end);
      if (!fs.existsSync(file)) throw new ApiError(404, 'not_found');
      const filename = `playback_${row.court_id}_${day}_${token.slice(0, 8)}_end${clip.end}.${clip.ext}`;
      sendVideo(req, res, file, clip.mime, download ? filename : undefined);
      return;
    }
    if (!row.video_ext || !row.video_mime) throw new ApiError(404, 'not_found');
    const ext: Container = row.video_ext === 'mp4' ? 'mp4' : 'webm';
    const file = videoPath(config.storageDir, token, ext, null);
    if (!fs.existsSync(file)) throw new ApiError(404, 'not_found');
    const filename = `playback_${row.court_id}_${day}_${token.slice(0, 8)}.${row.video_ext}`;
    sendVideo(req, res, file, row.video_mime, download ? filename : undefined);
  });

  app.get('/api/dashboard', (_req, res) => {
    const rows = store.listVisible();
    const sessions = rows.map((row) => {
      const full = present(row);
      const videoSize = full.videos.length
        ? full.videos.reduce((sum, clip) => sum + clip.size, 0)
        : (full.video?.size ?? null);
      return {
        token: full.token,
        courtId: full.courtId,
        mode: full.mode,
        status: full.status,
        teams: full.teams,
        createdAt: full.createdAt,
        durationMs: full.durationMs,
        score: full.score,
        videoSize,
        contact: dashboardContact(row),
      };
    });
    const ready = sessions.filter((session) => session.status === 'ready');
    res.json({
      savedSessions: ready.length,
      totalDurationMs: ready.reduce((sum, session) => sum + (session.durationMs ?? 0), 0),
      sessions,
      people: store.listPeople(),
    });
  });

  app.get('/api/people/:id', (req, res) => {
    const person = store.getPerson(requirePersonId(req.params.id));
    if (!person) throw new ApiError(404, 'not_found');
    res.json(person);
  });

  app.post('/api/people/:id/balance', (req, res) => {
    const id = requirePersonId(req.params.id);
    const balance = req.body?.balance;
    if (!Number.isInteger(balance) || balance < -1_000_000 || balance > 1_000_000) {
      throw new ApiError(400, 'invalid_body');
    }
    const person = store.setBalance(id, balance);
    if (!person) throw new ApiError(404, 'not_found');
    res.json(person);
  });

  app.delete('/api/sessions/:token', (req, res) => {
    const token = requireToken(req.params.token);
    const row = store.getByToken(token);
    if (!row) throw new ApiError(404, 'not_found');
    store.deleteSession(row.id);
    removeVideos(config.storageDir, token);
    res.status(204).end();
  });

  mountClub(app, store, config.publicBaseUrl);
  const play = mountPlay(app, store.db, config.play);

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'not_found' });
  });

  if (config.serveStatic) {
    const dist = path.join(config.repoRoot, 'web', 'dist');
    app.use(express.static(dist, { index: false }));
    app.use((req, res, next) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') return next();
      const index = path.join(dist, 'index.html');
      if (!fs.existsSync(index)) return next();
      res.sendFile(index);
    });
  }

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof ApiError) {
      res.status(error.status).json({ error: error.code });
      return;
    }
    const err = error as { status?: number; type?: string };
    if (err.status === 413 || err.type === 'entity.too.large') {
      res.status(413).json({ error: 'upload_too_large' });
      return;
    }
    console.error(error);
    res.status(500).json({ error: 'server_error' });
  });

  return {
    app,
    store,
    config,
    close: () => {
      play.stop();
      store.close();
    },
  };

  function playable(row: SessionRow): boolean {
    const stored = store.videos(row.id);
    if (stored.length) {
      const expected = parseEndsKey(row.expected_ends);
      if (!expected.length) return stored.every((clip) => clip.size >= MIN_VIDEO_BYTES);
      return expected.every((end) => stored.some((clip) => clip.end === end && clip.size >= MIN_VIDEO_BYTES));
    }
    return Boolean(row.video_size && row.video_size >= MIN_VIDEO_BYTES && row.video_mime);
  }
}

function sendVideo(req: Request, res: Response, filePath: string, mime: string, downloadName?: string): void {
  const total = fs.statSync(filePath).size;
  const baseMime = mime.split(';')[0] || 'application/octet-stream';
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', baseMime);
  res.setHeader('Cache-Control', 'private, max-age=0');
  if (downloadName) {
    const encoded = encodeURIComponent(downloadName);
    res.setHeader('Content-Disposition', `attachment; filename="${downloadName}"; filename*=UTF-8''${encoded}`);
  } else {
    res.setHeader('Content-Disposition', 'inline');
  }

  const range = req.headers.range;
  if (!range) {
    res.setHeader('Content-Length', total);
    fs.createReadStream(filePath).pipe(res);
    return;
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match) {
    res.status(416).setHeader('Content-Range', `bytes */${total}`).end();
    return;
  }
  let start = match[1] ? Number(match[1]) : NaN;
  let end = match[2] ? Number(match[2]) : total - 1;
  if (match[1] === '' && match[2]) {
    const suffix = Number(match[2]);
    start = Math.max(0, total - suffix);
    end = total - 1;
  }
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start > end || start >= total) {
    res.status(416).setHeader('Content-Range', `bytes */${total}`).end();
    return;
  }
  end = Math.min(end, total - 1);
  res.status(206);
  res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
  res.setHeader('Content-Length', end - start + 1);
  fs.createReadStream(filePath, { start, end }).pipe(res);
}
