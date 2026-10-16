import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, type RunningApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import {
  applyHeartbeat,
  queueCommand,
  stationStatus,
  type StationCommand,
  type StationPresence,
} from '../src/station.js';

const now = 1_000_000;

function armed(over: Partial<StationPresence> = {}): StationPresence {
  return {
    ready: true,
    phase: 'armed',
    sessionToken: null,
    seenAt: now,
    pending: null,
    ...over,
  };
}

describe('station command states', () => {
  it('stays offline until a fresh heartbeat, and never reports recording from an armed station', () => {
    expect(stationStatus(null, now).phase).toBe('offline');
    expect(stationStatus(armed({ seenAt: now - 5001 }), now)).toMatchObject({ online: false, phase: 'offline', ready: false });
    expect(stationStatus(armed({ ready: false }), now)).toMatchObject({ online: true, ready: false, phase: 'waiting' });
    expect(stationStatus(armed(), now)).toMatchObject({ online: true, ready: true, phase: 'ready' });
    expect(stationStatus(armed({ phase: 'recording', sessionToken: 'token-1' }), now).phase).toBe('recording');
  });

  it('rejects start until the camera is allowed, then keeps one start command', () => {
    const waiting = queueCommand(armed({ ready: false }), now, { id: 'c1', action: 'start', token: 'token-1' });
    expect(waiting).toEqual({ ok: false, error: 'station_not_ready' });
    expect(queueCommand(null, now, { id: 'c1', action: 'start', token: 'token-1' })).toEqual({ ok: false, error: 'station_offline' });

    const first = queueCommand(armed(), now, { id: 'c1', action: 'start', token: 'token-1' });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.command).toEqual({ id: 'c1', action: 'start', token: 'token-1' });

    const again = queueCommand(first.presence, now, { id: 'c2', action: 'start', token: 'token-1' });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.command.id).toBe('c1');

    const other = queueCommand(first.presence, now, { id: 'c3', action: 'start', token: 'token-2' });
    expect(other).toEqual({ ok: false, error: 'station_busy' });
  });

  it('clears start only once the laptop reports that recording, and accepts stop for that token', () => {
    const started = queueCommand(armed(), now, { id: 'c1', action: 'start', token: 'token-1' });
    if (!started.ok) throw new Error('expected start');
    const stillWaiting = applyHeartbeat(started.presence, now + 1000, { ready: true, phase: 'armed', sessionToken: null });
    expect(stillWaiting.pending?.action).toBe('start');

    const recording = applyHeartbeat(stillWaiting, now + 2000, { ready: true, phase: 'recording', sessionToken: 'token-1' });
    expect(recording.pending).toBeNull();
    expect(stationStatus(recording, now + 2000).phase).toBe('recording');

    const stop = queueCommand(recording, now + 2000, { id: 'c4', action: 'stop', token: 'token-1' });
    expect(stop.ok).toBe(true);
    if (!stop.ok) return;
    expect(queueCommand(recording, now + 2000, { id: 'c5', action: 'stop', token: 'other' })).toEqual({
      ok: false,
      error: 'not_recording',
    });

    const saved = applyHeartbeat(stop.presence, now + 3000, { ready: true, phase: 'saving', sessionToken: 'token-1' });
    expect(saved.pending).toBeNull();
    expect(stationStatus(saved, now + 3000).phase).toBe('saving');
  });

  it('drops a stale pending command instead of replaying it', () => {
    const pending: StationCommand = { id: 'c1', action: 'start', token: 'token-1' };
    const next = applyHeartbeat(armed({ pending, seenAt: now - 9000 }), now, {
      ready: true,
      phase: 'armed',
      sessionToken: null,
    });
    expect(next.pending).toBeNull();
  });
});

type Started = { base: string; running: RunningApp; server: http.Server };
const started: Started[] = [];

async function boot(): Promise<Started> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'court-replay-station-'));
  const config = loadConfig(
    {
      HOST: '127.0.0.1',
      PORT: '8787',
      PUBLIC_BASE_URL: 'http://127.0.0.1:5173',
      STORAGE_DIR: path.join(dir, 'recordings'),
      DATABASE_PATH: path.join(dir, 'court.db'),
      LAN_MODE: 'false',
    },
    dir,
  );
  const running = createApp(config);
  const server = http.createServer(running.app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const item = { base: `http://127.0.0.1:${port}`, running, server };
  started.push(item);
  return item;
}

afterEach(async () => {
  while (started.length) {
    const item = started.pop();
    if (!item) continue;
    await new Promise<void>((resolve, reject) => item.server.close((error) => (error ? reject(error) : resolve())));
    item.running.close();
  }
});

async function json(response: Response) {
  return (await response.json()) as Record<string, unknown>;
}

describe('station HTTP', () => {
  it('lets a phone queue start only after the laptop camera is allowed', async () => {
    const { base } = await boot();
    const created = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        courtId: 'court-1',
        mode: 'singles',
        consent: true,
        teams: { A: ['Lan'], B: ['Minh'] },
      }),
    });
    const session = (await json(created)) as { token: string };
    const offline = await fetch(`${base}/api/courts/court-1/commands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'start', token: session.token }),
    });
    expect(offline.status).toBe(409);
    expect((await json(offline)).error).toBe('station_offline');

    const waiting = await fetch(`${base}/api/courts/court-1/station`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ready: false, phase: 'armed', sessionToken: null }),
    });
    expect((await json(waiting)).phase).toBe('waiting');
    const tooSoon = await fetch(`${base}/api/courts/court-1/commands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'start', token: session.token }),
    });
    expect((await json(tooSoon)).error).toBe('station_not_ready');

    const ready = await fetch(`${base}/api/courts/court-1/station`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ready: true, phase: 'armed', sessionToken: null }),
    });
    expect((await json(ready)).phase).toBe('ready');
    const start = await fetch(`${base}/api/courts/court-1/commands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'start', token: session.token }),
    });
    expect(start.status).toBe(200);
    const queued = await json(start);
    expect(queued.command).toMatchObject({ action: 'start', token: session.token });
    expect(queued.phase).toBe('ready');

    const recording = await fetch(`${base}/api/courts/court-1/station`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ready: true, phase: 'recording', sessionToken: session.token }),
    });
    const live = await json(recording);
    expect(live.phase).toBe('recording');
    expect(live.command).toBeNull();

    const stop = await fetch(`${base}/api/courts/court-1/commands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'stop', token: session.token }),
    });
    expect((await json(stop)).command).toMatchObject({ action: 'stop', token: session.token });
  });
});
