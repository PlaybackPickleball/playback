import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, type RunningApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

type Started = { base: string; running: RunningApp; server: http.Server };
const started: Started[] = [];

async function boot(): Promise<Started> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'court-replay-intel-'));
  const config = loadConfig(
    {
      HOST: '127.0.0.1',
      PORT: '8787',
      PUBLIC_BASE_URL: 'http://127.0.0.1:5173',
      UPLOAD_LIMIT_MB: '8',
      STORAGE_DIR: path.join(dir, 'recordings'),
      DATABASE_PATH: path.join(dir, 'court.db'),
      RECORDING_LIMIT_SECONDS: '600',
      LAN_MODE: 'false',
    },
    dir,
  );
  const running = createApp(config);
  const server = http.createServer(running.app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const item = { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, running, server };
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
  const text = await response.text();
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

describe('player intelligence', () => {
  it('checks in a simulated doubles match and verifies the rating once', async () => {
    const { base, running } = await boot();
    const facility = await json(await fetch(`${base}/api/facility`));
    expect(facility.name).toBe('PlayBack Demo Club');
    expect(facility.productionLogin).toBe(false);
    expect(facility.revenue).toBeUndefined();
    const courts = facility.courts as { id: string; simulated: boolean; records: boolean }[];
    expect(courts).toHaveLength(8);
    expect(courts[0]).toMatchObject({ id: 'court-1', simulated: false, records: true });
    expect(courts[7]).toMatchObject({ id: 'court-8', simulated: true, records: false });

    const players = (await json(await fetch(`${base}/api/players`))).players as { id: string; rating: number; displayName: string }[];
    expect(players.length).toBeGreaterThanOrEqual(8);
    const byId = (id: string) => players.find((player) => player.id === id)!;
    const lan = byId('demo-lan');
    expect(lan.rating).toBeCloseTo(4.4, 2);

    const sessionsBefore = Number(
      (running.store.db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number | bigint }).n,
    );

    async function join(id: string, team: 'A' | 'B') {
      const response = await fetch(`${base}/api/courts/court-2/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ playerId: id, team }),
      });
      expect(response.status).toBe(201);
      return json(response);
    }

    const opened = await join('demo-lan', 'A');
    const matchId = opened.id as string;
    const doubled = await json(
      await fetch(`${base}/api/matches/${matchId}/mode`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'doubles' }),
      }),
    );
    expect(doubled.mode).toBe('doubles');
    const duplicate = await fetch(`${base}/api/courts/court-2/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerId: 'demo-lan', team: 'B' }),
    });
    expect(duplicate.status).toBe(409);
    expect((await json(duplicate)).error).toBe('duplicate_player');
    await join('demo-quang', 'A');
    await join('demo-an', 'B');
    const ready = await join('demo-mai', 'B');
    expect(ready.status).toBe('ready');

    const laptop = await fetch(`${base}/api/matches/${matchId}/start`, { method: 'POST' });
    expect(laptop.status).toBe(200);
    const started = await json(laptop);
    expect(started.simulated).toBe(true);
    expect(started.status).toBe('recording');

    const blocked = await fetch(`${base}/api/courts/court-1/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerId: 'demo-khoa', team: 'A' }),
    });
    expect(blocked.status).toBe(201);

    const early = await fetch(`${base}/api/matches/${matchId}/verify`, { method: 'POST' });
    expect(early.status).toBe(409);

    const saved = await json(
      await fetch(`${base}/api/matches/${matchId}/score`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scoreA: 11, scoreB: 7 }),
      }),
    );
    expect(saved.status).toBe('completed');
    expect(saved.ratingsApplied).toBe(false);
    expect((await json(await fetch(`${base}/api/players/demo-lan`))).rating).toBeCloseTo(4.4, 2);

    const blockedVerify = await fetch(`${base}/api/matches/${matchId}/verify`, { method: 'POST' });
    expect(blockedVerify.status).toBe(409);
    expect((await json(await fetch(`${base}/api/players/demo-lan`))).rating).toBeCloseTo(4.4, 2);

    const submitted = await json(
      await fetch(`${base}/api/matches/${matchId}/result`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          playerId: 'demo-lan',
          teamA: ['demo-lan', 'demo-an'],
          teamB: ['demo-quang', 'demo-mai'],
          scoreA: 11,
          scoreB: 7,
          target: 11,
        }),
      }),
    );
    expect(submitted.resultStatus).toBe('pending');
    expect(submitted.ratingsApplied).toBe(false);

    const ownSide = await fetch(`${base}/api/matches/${matchId}/result/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerId: 'demo-lan' }),
    });
    expect(ownSide.status).toBe(409);

    const verifiedResponse = await fetch(`${base}/api/matches/${matchId}/result/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerId: 'demo-quang' }),
    });
    expect(verifiedResponse.status).toBe(200);
    const verified = await json(verifiedResponse);
    expect(verified.status).toBe('verified');
    expect(verified.winner).toBe('A');
    expect(verified.ratingsApplied).toBe(true);
    const job = await json(await fetch(`${base}/api/matches/${matchId}/video-job`));
    expect(job).toMatchObject({ status: 'unavailable', events: [], confidence: null, modelVersion: null });

    const lanAfter = await json(await fetch(`${base}/api/players/demo-lan`));
    expect(Math.abs(lanAfter.rating - 4.4)).toBeGreaterThan(0.001);
    expect(lanAfter.wins).toBe(1);
    expect(lanAfter.matchesPlayed).toBe(1);
    expect(lanAfter.history).toHaveLength(1);
    expect(lanAfter.simulatedAnalytics).toMatchObject({ demo: true });
    expect(lanAfter.unmeasured).toEqual({ serveSpeed: null, shotPlacement: null, movement: null });

    const again = await fetch(`${base}/api/matches/${matchId}/result/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerId: 'demo-mai' }),
    });
    expect(again.status).toBe(200);
    expect((await json(again)).replayed).toBe(true);
    expect((await json(await fetch(`${base}/api/players/demo-lan`))).rating).toBe(lanAfter.rating);

    const refused = await fetch(`${base}/api/players/demo-lan`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rating: 9000 }),
    });
    expect(refused.status).toBe(400);

    const made = await json(
      await fetch(`${base}/api/matchmaking`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ playerIds: ['demo-lan', 'demo-quang', 'demo-an', 'demo-mai'] }),
      }),
    );
    expect(made.pairings).toHaveLength(3);
    expect(made.reason).toBe('closest_average_split');

    const resetDenied = await fetch(`${base}/api/facility/reset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: 'no' }),
    });
    expect(resetDenied.status).toBe(400);
    const reset = await json(
      await fetch(`${base}/api/facility/reset`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: 'RESET DEMO' }),
      }),
    );
    expect(reset.recordingsKept).toBe(true);
    expect((await json(await fetch(`${base}/api/players/demo-lan`))).rating).toBeCloseTo(4.4, 2);
    const sessionsAfter = Number(
      (running.store.db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number | bigint }).n,
    );
    expect(sessionsAfter).toBe(sessionsBefore);
  });

  it('keeps equipment on the live player with its own consent, editable and removable', async () => {
    const { base } = await boot();
    const patch = (id: string, body: unknown) =>
      fetch(`${base}/api/players/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    const guest = await json(
      await fetch(`${base}/api/players`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName: 'Thu', language: 'en' }),
      }),
    );
    const id = guest.id as string;
    expect(guest.equipment).toBeNull();

    // Recording consent does not count: equipment needs its own consent.
    const denied = await patch(id, { equipment: { paddle: 'Selkirk Vanguard' } });
    expect(denied.status).toBe(409);
    expect((await json(denied)).error).toBe('consent_required');
    expect((await json(await patch(id, { equipment: { paddle: 'X' }, equipmentConsent: false }))).error).toBe(
      'consent_required',
    );

    const saved = await json(
      await patch(id, { equipment: { paddle: 'Selkirk Vanguard', shoes: 'Asics Gel' }, equipmentConsent: true }),
    );
    expect(saved.equipment).toEqual({ paddle: 'Selkirk Vanguard', shoes: 'Asics Gel' });
    expect(saved.equipmentConsentAt).toEqual(expect.any(String));
    expect(saved.recordingConsentAt).toBeNull();

    // Same live player id, listed once, and editable.
    const edited = await json(await patch(id, { equipment: { paddle: 'Joola Perseus', apparel: 'Club tee' } }));
    expect(edited.equipment).toEqual({ paddle: 'Joola Perseus', apparel: 'Club tee' });
    const players = (await json(await fetch(`${base}/api/players`))).players as { id: string }[];
    expect(players.filter((player) => player.id === id)).toHaveLength(1);
    const fetched = await json(await fetch(`${base}/api/players/${id}`));
    expect(fetched.equipment).toEqual(edited.equipment);

    // Removing clears the equipment and the consent.
    const removed = await json(await patch(id, { equipment: null }));
    expect(removed.equipment).toBeNull();
    expect(removed.equipmentConsentAt).toBeNull();
    expect((await patch(id, { equipment: { paddle: 'Again' } })).status).toBe(409);
  });
});
