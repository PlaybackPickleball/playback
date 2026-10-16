import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  ContactChannel,
  ContactRow,
  FacilityPerson,
  FacilityPersonDetail,
  HighlightEvent,
  ScoreEvent,
  SessionRow,
  SessionStatus,
  StoredVideo,
  SwitchEvent,
} from './types.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  public_token TEXT NOT NULL UNIQUE,
  court_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('singles', 'doubles')),
  status TEXT NOT NULL CHECK (status IN ('draft', 'recording', 'saving', 'ready', 'failed')),
  team_a_json TEXT NOT NULL,
  team_b_json TEXT NOT NULL,
  consent_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  started_at TEXT,
  ended_at TEXT,
  duration_ms INTEGER,
  video_mime TEXT,
  video_size INTEGER,
  video_ext TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS score_events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  team TEXT NOT NULL CHECK (team IN ('A', 'B')),
  offset_ms INTEGER NOT NULL,
  seq INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS highlights (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  offset_ms INTEGER NOT NULL,
  seq INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS videos (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  end INTEGER NOT NULL CHECK (end IN (1, 2)),
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  ext TEXT NOT NULL,
  PRIMARY KEY (session_id, end)
);
CREATE TABLE IF NOT EXISTS end_switches (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  offset_ms INTEGER NOT NULL,
  seq INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id) ON DELETE CASCADE,
  phone TEXT NOT NULL,
  player_names TEXT NOT NULL,
  court_id TEXT NOT NULL,
  language TEXT NOT NULL CHECK (language IN ('en', 'vi')),
  recording_consent_at TEXT NOT NULL,
  marketing_consent_at TEXT,
  created_at TEXT NOT NULL,
  opted_out_at TEXT
);
CREATE TABLE IF NOT EXISTS people (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL CHECK (channel IN ('zalo', 'whatsapp')),
  phone TEXT NOT NULL,
  display_name TEXT NOT NULL,
  balance INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (channel, phone)
);
`;

function ensureColumn(db: DatabaseSync, table: string, name: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!columns.some((column) => column.name === name)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
  }
}

export class Store {
  readonly db: DatabaseSync;

  constructor(databasePath: string) {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    this.db = new DatabaseSync(databasePath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA);
    ensureColumn(this.db, 'sessions', 'team_a_end', 'INTEGER');
    ensureColumn(this.db, 'sessions', 'team_b_end', 'INTEGER');
    ensureColumn(this.db, 'sessions', 'expected_ends', 'TEXT');
    ensureColumn(this.db, 'sessions', 'end_switch', "TEXT NOT NULL DEFAULT 'none'");
    ensureColumn(this.db, 'contacts', 'channel', "TEXT NOT NULL DEFAULT 'zalo'");
    ensureColumn(this.db, 'contacts', 'person_id', 'TEXT');
    this.linkLooseContacts();
    const now = new Date().toISOString();
    this.db.prepare(`UPDATE sessions SET status = 'failed', updated_at = ? WHERE status = 'saving'`).run(now);
  }

  close(): void {
    this.db.close();
  }

  insertSession(row: SessionRow): void {
    this.db
      .prepare(
        `INSERT INTO sessions (
          id, public_token, court_id, mode, status, team_a_json, team_b_json, consent_at,
          created_at, started_at, ended_at, duration_ms, video_mime, video_size, video_ext, updated_at,
          team_a_end, team_b_end, expected_ends, end_switch
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.public_token,
        row.court_id,
        row.mode,
        row.status,
        row.team_a_json,
        row.team_b_json,
        row.consent_at,
        row.created_at,
        row.started_at,
        row.ended_at,
        row.duration_ms,
        row.video_mime,
        row.video_size,
        row.video_ext,
        row.updated_at,
        row.team_a_end,
        row.team_b_end,
        row.expected_ends,
        row.end_switch,
      );
  }

  getByToken(token: string): SessionRow | undefined {
    const row = this.db.prepare('SELECT * FROM sessions WHERE public_token = ?').get(token);
    return row ? (row as unknown as SessionRow) : undefined;
  }

  listVisible(): SessionRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM sessions WHERE status != 'draft' ORDER BY created_at DESC`)
      .all();
    return rows as unknown as SessionRow[];
  }

  updateStatus(id: string, status: SessionStatus, extra: Partial<SessionRow> = {}): void {
    const current = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined;
    if (!current) return;
    const next = { ...current, ...extra, status, updated_at: new Date().toISOString() };
    this.db
      .prepare(
        `UPDATE sessions SET
          status = ?, started_at = ?, ended_at = ?, duration_ms = ?,
          video_mime = ?, video_size = ?, video_ext = ?, updated_at = ?,
          expected_ends = ?, team_a_end = ?, team_b_end = ?
        WHERE id = ?`,
      )
      .run(
        next.status,
        next.started_at,
        next.ended_at,
        next.duration_ms,
        next.video_mime,
        next.video_size,
        next.video_ext,
        next.updated_at,
        next.expected_ends,
        next.team_a_end,
        next.team_b_end,
        id,
      );
  }

  replaceEvents(sessionId: string, scores: ScoreEvent[], highlights: HighlightEvent[], switches: SwitchEvent[]): void {
    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM score_events WHERE session_id = ?').run(sessionId);
      this.db.prepare('DELETE FROM highlights WHERE session_id = ?').run(sessionId);
      this.db.prepare('DELETE FROM end_switches WHERE session_id = ?').run(sessionId);
      const scoreStmt = this.db.prepare(
        'INSERT INTO score_events (id, session_id, team, offset_ms, seq) VALUES (?, ?, ?, ?, ?)',
      );
      scores.forEach((event, index) => {
        scoreStmt.run(crypto.randomUUID(), sessionId, event.team, event.offsetMs, index);
      });
      const highlightStmt = this.db.prepare(
        'INSERT INTO highlights (id, session_id, offset_ms, seq) VALUES (?, ?, ?, ?)',
      );
      highlights.forEach((event, index) => {
        highlightStmt.run(crypto.randomUUID(), sessionId, event.offsetMs, index);
      });
      const switchStmt = this.db.prepare(
        'INSERT INTO end_switches (id, session_id, offset_ms, seq) VALUES (?, ?, ?, ?)',
      );
      switches.forEach((event, index) => {
        switchStmt.run(crypto.randomUUID(), sessionId, event.offsetMs, index);
      });
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  scores(sessionId: string): ScoreEvent[] {
    const rows = this.db
      .prepare('SELECT team, offset_ms FROM score_events WHERE session_id = ? ORDER BY seq ASC')
      .all(sessionId) as unknown as { team: 'A' | 'B'; offset_ms: number }[];
    return rows.map((row) => ({ team: row.team, offsetMs: row.offset_ms }));
  }

  highlights(sessionId: string): { id: string; offsetMs: number }[] {
    const rows = this.db
      .prepare('SELECT id, offset_ms FROM highlights WHERE session_id = ? ORDER BY seq ASC')
      .all(sessionId) as unknown as { id: string; offset_ms: number }[];
    return rows.map((row) => ({ id: row.id, offsetMs: row.offset_ms }));
  }

  switches(sessionId: string): SwitchEvent[] {
    const rows = this.db
      .prepare('SELECT offset_ms FROM end_switches WHERE session_id = ? ORDER BY seq ASC')
      .all(sessionId) as unknown as { offset_ms: number }[];
    return rows.map((row) => ({ offsetMs: row.offset_ms }));
  }

  videos(sessionId: string): StoredVideo[] {
    const rows = this.db
      .prepare('SELECT end, mime, size, ext FROM videos WHERE session_id = ? ORDER BY end ASC')
      .all(sessionId) as unknown as { end: number; mime: string; size: number; ext: string }[];
    return rows
      .filter((row) => row.end === 1 || row.end === 2)
      .map((row) => ({
        end: row.end as 1 | 2,
        mime: row.mime,
        size: row.size,
        ext: row.ext === 'mp4' ? 'mp4' : 'webm',
      }));
  }

  upsertVideo(sessionId: string, video: StoredVideo): void {
    this.db.prepare('DELETE FROM videos WHERE session_id = ? AND end = ?').run(sessionId, video.end);
    this.db
      .prepare('INSERT INTO videos (session_id, end, mime, size, ext) VALUES (?, ?, ?, ?, ?)')
      .run(sessionId, video.end, video.mime, video.size, video.ext);
  }

  getContact(sessionId: string): ContactRow | undefined {
    const row = this.db.prepare('SELECT * FROM contacts WHERE session_id = ?').get(sessionId);
    return row ? (row as unknown as ContactRow) : undefined;
  }

  saveContact(row: ContactRow): void {
    const existing = this.getContact(row.session_id);
    const person = this.upsertPerson(row.channel, row.phone, row.player_names);
    const previousPerson = existing?.person_id && existing.person_id !== person.id ? existing.person_id : null;
    if (!existing) {
      this.db
        .prepare(
          `INSERT INTO contacts (
            id, session_id, phone, player_names, court_id, language,
            recording_consent_at, marketing_consent_at, created_at, opted_out_at, channel, person_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          row.id,
          row.session_id,
          row.phone,
          row.player_names,
          row.court_id,
          row.language,
          row.recording_consent_at,
          row.marketing_consent_at,
          row.created_at,
          row.opted_out_at,
          row.channel,
          person.id,
        );
      return;
    }
    this.db
      .prepare(
        `UPDATE contacts SET
          phone = ?, player_names = ?, court_id = ?, language = ?,
          recording_consent_at = ?, marketing_consent_at = ?, opted_out_at = ?, channel = ?, person_id = ?
        WHERE session_id = ?`,
      )
      .run(
        row.phone,
        row.player_names,
        row.court_id,
        row.language,
        row.recording_consent_at,
        row.marketing_consent_at,
        row.opted_out_at,
        row.channel,
        person.id,
        row.session_id,
      );
    if (previousPerson) this.releasePerson(previousPerson);
  }

  optOutContact(sessionId: string, at: string): ContactRow | undefined {
    const existing = this.getContact(sessionId);
    if (!existing) return undefined;
    this.db.prepare('UPDATE contacts SET opted_out_at = ? WHERE session_id = ?').run(at, sessionId);
    return this.getContact(sessionId);
  }

  deleteSession(id: string): void {
    const contact = this.getContact(id);
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
    if (contact?.person_id) this.releasePerson(contact.person_id);
  }

  listPeople(): FacilityPerson[] {
    const rows = this.db
      .prepare(
        `SELECT p.id, p.channel, p.phone, p.display_name, p.balance,
                (SELECT COUNT(*) FROM contacts c WHERE c.person_id = p.id) AS video_count
         FROM people p
         ORDER BY p.updated_at DESC`,
      )
      .all() as Array<{
      id: string;
      channel: string;
      phone: string;
      display_name: string;
      balance: number | bigint;
      video_count: number | bigint;
    }>;
    return rows.map((row) => this.toPerson(row, Number(row.video_count)));
  }

  getPerson(id: string): FacilityPersonDetail | undefined {
    const row = this.db.prepare('SELECT id, channel, phone, display_name, balance FROM people WHERE id = ?').get(id) as
      | {
          id: string;
          channel: string;
          phone: string;
          display_name: string;
          balance: number | bigint;
        }
      | undefined;
    if (!row) return undefined;
    const videos = this.db
      .prepare(
        `SELECT s.public_token AS token, s.court_id AS courtId, s.created_at AS createdAt,
                c.player_names AS playerNames, c.marketing_consent_at AS marketingAt, c.opted_out_at AS optedOutAt
         FROM contacts c
         JOIN sessions s ON s.id = c.session_id
         WHERE c.person_id = ?
         ORDER BY s.created_at DESC`,
      )
      .all(id) as Array<{
      token: string;
      courtId: string;
      createdAt: string;
      playerNames: string;
      marketingAt: string | null;
      optedOutAt: string | null;
    }>;
    return {
      ...this.toPerson(row, videos.length),
      videos: videos.map((video) => ({
        token: video.token,
        courtId: video.courtId,
        createdAt: video.createdAt,
        playerNames: video.playerNames,
        marketing: Boolean(video.marketingAt),
        optedOut: Boolean(video.optedOutAt),
      })),
    };
  }

  setBalance(id: string, balance: number): FacilityPersonDetail | undefined {
    const now = new Date().toISOString();
    const info = this.db.prepare('UPDATE people SET balance = ?, updated_at = ? WHERE id = ?').run(balance, now, id);
    if (Number(info.changes) === 0) return undefined;
    return this.getPerson(id);
  }

  private linkLooseContacts(): void {
    const rows = this.db
      .prepare(`SELECT id, channel, phone, player_names FROM contacts WHERE person_id IS NULL OR person_id = ''`)
      .all() as Array<{ id: string; channel: string; phone: string; player_names: string }>;
    for (const row of rows) {
      const person = this.upsertPerson(row.channel, row.phone, row.player_names);
      this.db.prepare('UPDATE contacts SET person_id = ? WHERE id = ?').run(person.id, row.id);
    }
  }

  private upsertPerson(channel: string, phone: string, name: string): { id: string } {
    const safeChannel: ContactChannel = channel === 'whatsapp' ? 'whatsapp' : 'zalo';
    const now = new Date().toISOString();
    const existing = this.db.prepare('SELECT id FROM people WHERE channel = ? AND phone = ?').get(safeChannel, phone) as
      | { id: string }
      | undefined;
    if (existing) {
      this.db.prepare('UPDATE people SET display_name = ?, updated_at = ? WHERE id = ?').run(name, now, existing.id);
      return { id: existing.id };
    }
    const id = crypto.randomUUID();
    this.db
      .prepare(
        `INSERT INTO people (id, channel, phone, display_name, balance, created_at, updated_at)
         VALUES (?, ?, ?, ?, 0, ?, ?)`,
      )
      .run(id, safeChannel, phone, name, now, now);
    return { id };
  }

  private releasePerson(personId: string): void {
    const countRow = this.db.prepare('SELECT COUNT(*) AS n FROM contacts WHERE person_id = ?').get(personId) as
      | { n: number | bigint }
      | undefined;
    const person = this.db.prepare('SELECT balance FROM people WHERE id = ?').get(personId) as
      | { balance: number | bigint }
      | undefined;
    if (!person) return;
    if (Number(countRow?.n ?? 0) === 0 && Number(person.balance) === 0) {
      this.db.prepare('DELETE FROM people WHERE id = ?').run(personId);
    }
  }

  private toPerson(
    row: { id: string; channel: string; phone: string; display_name: string; balance: number | bigint },
    videoCount: number,
  ): FacilityPerson {
    return {
      id: row.id,
      name: row.display_name,
      channel: row.channel === 'whatsapp' ? 'whatsapp' : 'zalo',
      phone: row.phone,
      videoCount,
      balance: Number(row.balance),
    };
  }
}
