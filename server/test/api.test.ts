import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, type RunningApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

type Started = { base: string; running: RunningApp; dir: string; server: http.Server };

const started: Started[] = [];

function webm(bytes: number): Buffer {
  const buffer = Buffer.alloc(bytes, 0x22);
  buffer[0] = 0x1a;
  buffer[1] = 0x45;
  buffer[2] = 0xdf;
  buffer[3] = 0xa3;
  return buffer;
}

function mp4(bytes: number): Buffer {
  const buffer = Buffer.alloc(bytes, 0x33);
  buffer.write('ftyp', 4, 'ascii');
  return buffer;
}

async function boot(overrides: Record<string, string> = {}): Promise<Started> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'court-replay-'));
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
      ...overrides,
    },
    dir,
  );
  const running = createApp(config);
  const server = http.createServer(running.app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const item = { base: `http://127.0.0.1:${port}`, running, dir, server };
  started.push(item);
  return item;
}

async function stop(item: Started) {
  await new Promise<void>((resolve, reject) => {
    item.server.close((error) => (error ? reject(error) : resolve()));
  });
  item.running.close();
}

afterEach(async () => {
  while (started.length) {
    const item = started.pop();
    if (item) await stop(item);
  }
});

async function json(response: Response) {
  const text = await response.text();
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

async function createSession(base: string, name = 'Lan') {
  const response = await fetch(`${base}/api/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      courtId: 'court-1',
      mode: 'singles',
      consent: true,
      teams: { A: [name], B: ['Minh'] },
    }),
  });
  expect(response.status).toBe(201);
  return (await json(response)) as { token: string; status: string };
}

async function start(base: string, token: string) {
  const response = await fetch(`${base}/api/sessions/${token}/start`, { method: 'POST' });
  expect(response.status).toBe(200);
  return json(response);
}

function headers(durationMs: number, scores: unknown[], highlights: unknown[], mime = 'video/webm') {
  return {
    'Content-Type': mime,
    'X-Duration-Ms': String(durationMs),
    'X-Scores': Buffer.from(JSON.stringify(scores)).toString('base64'),
    'X-Highlights': Buffer.from(JSON.stringify(highlights)).toString('base64'),
  };
}

async function upload(
  base: string,
  token: string,
  body: Buffer,
  extra?: { durationMs?: number; scores?: unknown[]; highlights?: unknown[]; mime?: string },
) {
  return fetch(`${base}/api/sessions/${token}/video`, {
    method: 'POST',
    headers: headers(extra?.durationMs ?? 16000, extra?.scores ?? [], extra?.highlights ?? [], extra?.mime),
    body,
  });
}

async function uploadEnd(
  base: string,
  token: string,
  body: Buffer,
  end: 1 | 2,
  extra?: { durationMs?: number; scores?: unknown[]; highlights?: unknown[]; switches?: unknown[]; expected?: string },
) {
  return fetch(`${base}/api/sessions/${token}/video`, {
    method: 'POST',
    headers: {
      ...headers(extra?.durationMs ?? 8000, extra?.scores ?? [], extra?.highlights ?? []),
      'X-Switches': Buffer.from(JSON.stringify(extra?.switches ?? [])).toString('base64'),
      'X-Camera-End': String(end),
      'X-Expected-Ends': extra?.expected ?? String(end),
    },
    body,
  });
}

describe('sessions and video', () => {
  it('requires consent and validates names', async () => {
    const { base } = await boot();
    const denied = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        courtId: 'court-1',
        mode: 'singles',
        consent: false,
        teams: { A: ['Lan'], B: ['Minh'] },
      }),
    });
    expect(denied.status).toBe(400);
    expect((await json(denied)).error).toBe('consent_required');

    const blank = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        courtId: 'court-1',
        mode: 'doubles',
        consent: true,
        teams: { A: ['  ', 'An'], B: ['Binh', 'Chi'] },
      }),
    });
    expect(blank.status).toBe(400);
  });

  it('rejects a second start and does not create a video', async () => {
    const { base } = await boot();
    const session = await createSession(base);
    await start(base, session.token);
    const again = await fetch(`${base}/api/sessions/${session.token}/start`, { method: 'POST' });
    expect(again.status).toBe(409);
    expect((await json(again)).error).toBe('already_recording');
    const fetched = await json(await fetch(`${base}/api/sessions/${session.token}`));
    expect(fetched.status).toBe('recording');
    expect(fetched.video).toBeNull();
  });

  it('saves scores, highlights, and a ranged video without duplicating a retry', async () => {
    const { base, running } = await boot();
    const session = await createSession(base, 'Hoa');
    await start(base, session.token);
    const scores = [
      { team: 'A', offsetMs: 1200 },
      { team: 'B', offsetMs: 2400 },
      { team: 'A', offsetMs: 3600 },
    ];
    const highlights = [
      { offsetMs: 2000 },
      { offsetMs: 2800 },
      { offsetMs: 9000 },
    ];
    const first = await upload(base, session.token, webm(4096), { scores, highlights });
    expect(first.status).toBe(200);
    const saved = await json(first);
    expect(saved.status).toBe('ready');
    expect(saved.score).toEqual({ A: 2, B: 1 });
    expect(saved.highlights).toHaveLength(2);
    expect((saved.highlights as { offsetMs: number }[])[0].offsetMs).toBe(2000);
    expect((saved.highlights as { offsetMs: number }[])[1].offsetMs).toBe(9000);
    expect(saved.video).toMatchObject({ mime: 'video/webm' });
    expect(JSON.stringify(saved)).not.toContain(running.config.storageDir);

    const file = path.join(running.config.storageDir, `${session.token}.webm`);
    const before = fs.statSync(file);
    const retry = await upload(base, session.token, webm(5000), { scores, highlights });
    expect(retry.status).toBe(200);
    const after = fs.statSync(file);
    expect(after.size).toBe(before.size);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    const list = await json(await fetch(`${base}/api/dashboard`));
    expect(list.savedSessions).toBe(1);

    const video = await fetch(`${base}/api/sessions/${session.token}/video`, {
      headers: { Range: 'bytes=0-99' },
    });
    expect(video.status).toBe(206);
    expect(video.headers.get('content-type')).toContain('video/webm');
    expect(video.headers.get('content-range')).toBe(`bytes 0-99/${before.size}`);
    expect((await video.arrayBuffer()).byteLength).toBe(100);

    const download = await fetch(`${base}/api/sessions/${session.token}/video?download=1`);
    expect(download.status).toBe(200);
    expect(download.headers.get('content-disposition')).toContain('playback_court-1');
    expect(download.headers.get('content-type')).toContain('video/webm');
    expect((await download.arrayBuffer()).byteLength).toBe(before.size);
  });

  it('rejects invalid, empty, and oversized uploads and allows one retry', async () => {
    const { base } = await boot({ UPLOAD_LIMIT_MB: '1' });
    const session = await createSession(base);
    await start(base, session.token);

    const bad = await upload(base, session.token, Buffer.alloc(2048, 1));
    expect(bad.status).toBe(400);
    expect((await json(bad)).error).toBe('invalid_media');
    expect((await json(await fetch(`${base}/api/sessions/${session.token}`))).status).toBe('failed');

    const tiny = await upload(base, session.token, webm(100));
    expect(tiny.status).toBe(400);
    expect((await json(tiny)).error).toBe('empty_media');

    const huge = await upload(base, session.token, webm(1024 * 1024 + 50));
    expect(huge.status).toBe(413);

    const mp4Response = await upload(base, session.token, mp4(2048), { mime: 'video/mp4' });
    expect(mp4Response.status).toBe(200);
    const saved = await json(mp4Response);
    expect(saved.status).toBe('ready');
    expect((saved.video as { mime: string }).mime).toBe('video/mp4');
    const dashboard = await json(await fetch(`${base}/api/dashboard`));
    expect(dashboard.savedSessions).toBe(1);
    expect(dashboard.sessions).toHaveLength(1);
  });

  it('isolates tokens and removes media on delete', async () => {
    const { base, running } = await boot();
    const first = await createSession(base, 'An');
    const second = await createSession(base, 'Binh');
    await start(base, first.token);
    await start(base, second.token);
    expect((await upload(base, first.token, webm(2048))).status).toBe(200);
    expect((await upload(base, second.token, webm(3072))).status).toBe(200);

    const seen = await json(await fetch(`${base}/api/sessions/${first.token}`));
    expect(JSON.stringify(seen.teams)).toContain('An');
    expect(JSON.stringify(seen.teams)).not.toContain('Binh');
    const otherVideo = await fetch(`${base}/api/sessions/${second.token}/video`);
    const firstVideo = await fetch(`${base}/api/sessions/${first.token}/video`);
    expect((await otherVideo.arrayBuffer()).byteLength).not.toBe((await firstVideo.arrayBuffer()).byteLength);

    const traversal = await fetch(`${base}/api/sessions/${encodeURIComponent('../../etc/passwd')}`);
    expect(traversal.status).toBe(400);
    expect(await traversal.text()).not.toMatch(/root:/);
    const dotted = await fetch(`${base}/api/sessions/${'..'.repeat(12)}`);
    expect(dotted.status).toBe(400);
    expect((await fetch(`${base}/api/sessions/not-a-real-token-value-123456`)).status).toBe(404);

    const removed = await fetch(`${base}/api/sessions/${first.token}`, { method: 'DELETE' });
    expect(removed.status).toBe(204);
    expect((await fetch(`${base}/api/sessions/${first.token}`)).status).toBe(404);
    expect(fs.existsSync(path.join(running.config.storageDir, `${first.token}.webm`))).toBe(false);
    expect((await json(await fetch(`${base}/api/sessions/${second.token}`))).status).toBe('ready');
  });

  it('keeps a saved session after the database is reopened', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'court-replay-restart-'));
    const env = {
      HOST: '127.0.0.1',
      PORT: '8787',
      PUBLIC_BASE_URL: 'http://127.0.0.1:5173',
      UPLOAD_LIMIT_MB: '8',
      STORAGE_DIR: path.join(dir, 'recordings'),
      DATABASE_PATH: path.join(dir, 'court.db'),
      RECORDING_LIMIT_SECONDS: '600',
    };
    const first = createApp(loadConfig(env, dir));
    const server = http.createServer(first.app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const session = await createSession(base, 'Chi');
    await start(base, session.token);
    expect((await upload(base, session.token, webm(2200), { durationMs: 18000, scores: [{ team: 'B', offsetMs: 4000 }] })).status).toBe(200);
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    first.close();

    const second = createApp(loadConfig(env, dir));
    const server2 = http.createServer(second.app);
    await new Promise<void>((resolve) => server2.listen(0, '127.0.0.1', resolve));
    const base2 = `http://127.0.0.1:${(server2.address() as AddressInfo).port}`;
    const restored = await json(await fetch(`${base2}/api/sessions/${session.token}`));
    expect(restored.status).toBe('ready');
    expect(restored.durationMs).toBe(18000);
    expect(restored.score).toEqual({ A: 0, B: 1 });
    const video = await fetch(`${base2}/api/sessions/${session.token}/video`);
    expect(video.status).toBe(200);
    expect((await video.arrayBuffer()).byteLength).toBeGreaterThan(1000);
    await new Promise<void>((resolve, reject) => server2.close((error) => (error ? reject(error) : resolve())));
    second.close();
  });

  it('stores two end files, one end when that is all that was recorded, and still plays an unlabeled file', async () => {
    const { base, running } = await boot();
    const dual = await createSession(base, 'Cam');
    await start(base, dual.token);
    const both = {
      durationMs: 9000,
      scores: [
        { team: 'A', offsetMs: 4000 },
        { team: 'B', offsetMs: 8000 },
      ],
      highlights: [{ offsetMs: 2000 }],
      switches: [{ offsetMs: 5000 }],
      expected: '1,2',
    };
    const first = await uploadEnd(base, dual.token, webm(3000), 1, both);
    expect(first.status).toBe(200);
    expect((await json(first)).status).toBe('saving');
    const second = await uploadEnd(base, dual.token, webm(4200), 2, both);
    expect(second.status).toBe(200);
    const saved = await json(second);
    expect(saved.status).toBe('ready');
    expect(saved.videos).toEqual([
      expect.objectContaining({ end: 1, size: 3000 }),
      expect.objectContaining({ end: 2, size: 4200 }),
    ]);
    expect(saved.switches).toEqual([]);
    expect(saved.rallies).toEqual([
      expect.objectContaining({ scoringTeam: 'A', starred: true, startMs: 1500, endMs: 2500 }),
      expect.objectContaining({ scoringTeam: 'B', starred: false, startMs: 5500, endMs: 6500 }),
    ]);
    expect(fs.existsSync(path.join(running.config.storageDir, `${dual.token}-e1.webm`))).toBe(true);
    expect(fs.existsSync(path.join(running.config.storageDir, `${dual.token}-e2.webm`))).toBe(true);
    const end2 = await fetch(`${base}/api/sessions/${dual.token}/video?end=2`);
    expect(end2.status).toBe(200);
    expect((await end2.arrayBuffer()).byteLength).toBe(4200);

    const single = await createSession(base, 'Solo');
    await start(base, single.token);
    const only = await uploadEnd(base, single.token, webm(2500), 1, { expected: '1', durationMs: 4000 });
    expect((await json(only)).status).toBe('ready');
    expect((await fetch(`${base}/api/sessions/${single.token}/video?end=2`)).status).toBe(404);
    const unlabeled = await fetch(`${base}/api/sessions/${single.token}/video`);
    expect(unlabeled.status).toBe(200);
    expect((await unlabeled.arrayBuffer()).byteLength).toBe(2500);

    const legacy = await createSession(base, 'Old');
    await start(base, legacy.token);
    expect((await upload(base, legacy.token, webm(2200))).status).toBe(200);
    expect(fs.existsSync(path.join(running.config.storageDir, `${legacy.token}.webm`))).toBe(true);
    const legacyBody = await json(await fetch(`${base}/api/sessions/${legacy.token}`));
    expect(legacyBody.videos).toEqual([expect.objectContaining({ end: null })]);
    expect((await fetch(`${base}/api/sessions/${legacy.token}/video`)).status).toBe(200);
  });

  it('saves a Zalo number for later without sending anything, and opt-out leaves the video', async () => {
    const { base } = await boot();
    const session = await createSession(base, 'Lan');
    await start(base, session.token);
    const uploaded = await json(await upload(base, session.token, webm(2048), { durationMs: 5000 }));
    expect(uploaded.contact).toBeNull();
    const watch = await fetch(`${base}/api/sessions/${session.token}/video`);
    expect(watch.status).toBe(200);

    const bad = await fetch(`${base}/api/sessions/${session.token}/contact`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: '123', language: 'vi', marketingConsent: false }),
    });
    expect(bad.status).toBe(400);
    expect((await json(bad)).error).toBe('invalid_phone');

    const saved = await json(
      await fetch(`${base}/api/sessions/${session.token}/contact`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: '090 123 4567', language: 'vi', marketingConsent: true }),
      }),
    );
    const contact = saved.contact as {
      phone: string;
      playerNames: string;
      courtId: string;
      language: string;
      recordingConsentAt: string;
      marketingConsentAt: string | null;
      optedOutAt: string | null;
    };
    expect(contact.phone).toBe('0901234567');
    expect(contact.playerNames).toContain('Lan');
    expect(contact.courtId).toBe('court-1');
    expect(contact.language).toBe('vi');
    expect(contact.recordingConsentAt).toBe(saved.consentAt);
    expect(contact.marketingConsentAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(contact.optedOutAt).toBeNull();
    expect((contact as { channel: string }).channel).toBe('zalo');

    const rejected = await fetch(`${base}/api/sessions/${session.token}/contact`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: '0901234567', language: 'vi', marketingConsent: false, channel: 'email', name: 'Lan' }),
    });
    expect(rejected.status).toBe(400);

    const cleared = await json(
      await fetch(`${base}/api/sessions/${session.token}/contact`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phone: '+84 90 123 4567',
          language: 'en',
          marketingConsent: false,
          channel: 'whatsapp',
          name: 'Lan Minh',
        }),
      }),
    );
    const updated = cleared.contact as { marketingConsentAt: string | null; channel: string; playerNames: string; phone: string };
    expect(updated.marketingConsentAt).toBeNull();
    expect(updated.channel).toBe('whatsapp');
    expect(updated.playerNames).toBe('Lan Minh');
    expect(updated.phone).toBe('84901234567');

    const opted = await json(await fetch(`${base}/api/sessions/${session.token}/contact/opt-out`, { method: 'POST' }));
    expect((opted.contact as { optedOutAt: string | null }).optedOutAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect((await fetch(`${base}/api/sessions/${session.token}/video`)).status).toBe(200);
  });

  it('stores a contact, lists it with the video, and groups one person at balance 0', async () => {
    const { base } = await boot();
    const first = await createSession(base, 'Lan');
    await start(base, first.token);
    expect((await upload(base, first.token, webm(4096))).status).toBe(200);
    const saved = await json(
      await fetch(`${base}/api/sessions/${first.token}/contact`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phone: '0901234567',
          language: 'vi',
          marketingConsent: true,
          channel: 'zalo',
          name: 'Lan',
        }),
      }),
    );
    expect((saved.contact as { phone: string }).phone).toBe('0901234567');
    expect((saved.contact as { channel: string }).channel).toBe('zalo');
    expect((saved.contact as { playerNames: string }).playerNames).toBe('Lan');

    const second = await createSession(base, 'Lan');
    await start(base, second.token);
    expect((await upload(base, second.token, webm(4096))).status).toBe(200);
    const again = await fetch(`${base}/api/sessions/${second.token}/contact`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        phone: '0901 234 567',
        language: 'en',
        marketingConsent: false,
        channel: 'zalo',
        name: 'Lan',
      }),
    });
    expect(again.status).toBe(200);

    const skipped = await createSession(base, 'Hoa');
    await start(base, skipped.token);
    expect((await upload(base, skipped.token, webm(4096))).status).toBe(200);

    const dashboard = await json(await fetch(`${base}/api/dashboard`));
    const sessions = dashboard.sessions as Array<{
      token: string;
      contact: { playerNames: string; phone: string; channel: string; marketing: boolean; personId: string } | null;
    }>;
    const withLan = sessions.find((item) => item.token === first.token);
    expect(withLan?.contact).toMatchObject({
      playerNames: 'Lan',
      phone: '0901234567',
      channel: 'zalo',
      marketing: true,
    });
    expect(sessions.find((item) => item.token === skipped.token)?.contact).toBeNull();

    const people = dashboard.people as Array<{
      id: string;
      name: string;
      channel: string;
      phone: string;
      videoCount: number;
      balance: number;
    }>;
    expect(people).toHaveLength(1);
    expect(people[0]).toMatchObject({
      name: 'Lan',
      channel: 'zalo',
      phone: '0901234567',
      videoCount: 2,
      balance: 0,
    });
    expect(withLan?.contact?.personId).toBe(people[0].id);

    const detail = await json(await fetch(`${base}/api/people/${people[0].id}`));
    expect(detail.balance).toBe(0);
    expect(detail.videoCount).toBe(2);
    const tokens = (detail.videos as Array<{ token: string }>).map((video) => video.token).sort();
    expect(tokens).toEqual([first.token, second.token].sort());
  });

  it('serves the configured base URL and does not invent another origin', async () => {
    const { base } = await boot({ PUBLIC_BASE_URL: 'http://127.0.0.1:5173' });
    const config = await json(await fetch(`${base}/api/config`));
    expect(config.publicBaseUrl).toBe('http://127.0.0.1:5173');
    expect(config.lanMode).toBe(false);
    expect(config.recordingLimitSeconds).toBe(600);
    expect(config.courts).toEqual(['court-1', 'court-2', 'court-3', 'court-4', 'court-5', 'court-6', 'court-7', 'court-8']);
    expect(config.recordingCourt).toBe('court-1');
  });

  it('reports LAN mode and keeps an explicit Wi-Fi host', async () => {
    const { base } = await boot({ LAN_MODE: 'true', PUBLIC_BASE_URL: 'http://192.168.9.9:5173' });
    const config = await json(await fetch(`${base}/api/config`));
    expect(config.lanMode).toBe(true);
    expect(config.publicBaseUrl).toBe('http://192.168.9.9:5173');
  });
});
