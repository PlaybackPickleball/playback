import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(here, '../..');

export const COURTS = ['court-1', 'court-2', 'court-3', 'court-4', 'court-5', 'court-6', 'court-7', 'court-8'] as const;
export const FACILITY_COURTS = COURTS;
export const RECORDING_COURT = 'court-1';
export type CourtId = (typeof COURTS)[number];

export type AppConfig = {
  host: string;
  port: number;
  publicBaseUrl: string;
  uploadLimitMb: number;
  uploadLimitBytes: number;
  storageDir: string;
  databasePath: string;
  recordingLimitSeconds: number;
  lanMode: boolean;
  serveStatic: boolean;
  repoRoot: string;
  /** Optional overrides for the court booking module (tests set a fake clock). */
  play?: Partial<import('./play/util.js').PlayConfig>;
};

function requiredUrl(value: string, label: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be an absolute http(s) URL. Received: ${value}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${label} must use http or https.`);
  }
  url.hash = '';
  url.search = '';
  url.pathname = '';
  return url.toString().replace(/\/$/, '');
}

function positiveInt(value: string | undefined, fallback: number, label: string): number {
  const raw = value === undefined || value === '' ? String(fallback) : value;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return parsed;
}

function resolveDir(value: string | undefined, fallback: string, root: string): string {
  const chosen = value && value.trim() ? value.trim() : fallback;
  return path.resolve(root, chosen);
}

type Nic = { address: string; family: string | number; internal: boolean };

function interfaceRank(name: string): number {
  const normalized = name.toLowerCase();
  if (normalized === 'en0') return 0;
  if (/^(en|eth|wlan|wi-fi|wifi)/.test(normalized)) return 1;
  if (/utun|awdl|llw|bridge|vmnet|vbox|docker|br-|veth|tun|gif|stf|ap|anpi/.test(normalized)) return 3;
  return 2;
}

export function lanIPv4(interfaces: NodeJS.Dict<Nic[] | undefined> = os.networkInterfaces()): string | null {
  const ranked: { rank: number; address: string }[] = [];
  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries ?? []) {
      const isV4 = entry.family === 'IPv4' || entry.family === 4;
      if (!isV4 || entry.internal) continue;
      if (!entry.address || entry.address.startsWith('169.254.') || entry.address === '0.0.0.0') continue;
      ranked.push({ rank: interfaceRank(name), address: entry.address });
    }
  }
  ranked.sort((left, right) => left.rank - right.rank);
  return ranked[0]?.address ?? null;
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0';
}

export function loadConfig(env: NodeJS.ProcessEnv, root = repoRoot, detectLan: () => string | null = lanIPv4): AppConfig {
  const uploadLimitMb = positiveInt(env.UPLOAD_LIMIT_MB, 512, 'UPLOAD_LIMIT_MB');
  const recordingLimitSeconds = positiveInt(
    env.RECORDING_LIMIT_SECONDS,
    600,
    'RECORDING_LIMIT_SECONDS',
  );
  const port = positiveInt(env.PORT, 8787, 'PORT');
  const lanMode = env.LAN_MODE === 'true';
  const explicit = env.PUBLIC_BASE_URL?.trim() ?? '';
  const devBase = 'http://127.0.0.1:5173';
  const productionBase = `http://127.0.0.1:${port}`;
  let publicBaseUrl = requiredUrl(explicit || (env.NODE_ENV === 'production' ? productionBase : devBase), 'PUBLIC_BASE_URL');
  if (lanMode && isLoopbackHost(new URL(publicBaseUrl).hostname)) {
    const lanAddress = detectLan();
    if (!lanAddress) {
      throw new Error(
        'LAN mode is on, but no LAN IPv4 address was found. Set PUBLIC_BASE_URL to this laptop’s Wi-Fi address, such as http://192.168.1.20:5173.',
      );
    }
    const uiPort = env.NODE_ENV === 'production' ? port : 5173;
    publicBaseUrl = `http://${lanAddress}:${uiPort}`;
  }
  return {
    host: lanMode ? '0.0.0.0' : env.HOST?.trim() || '127.0.0.1',
    port,
    publicBaseUrl,
    uploadLimitMb,
    uploadLimitBytes: uploadLimitMb * 1024 * 1024,
    storageDir: resolveDir(env.STORAGE_DIR, 'data/recordings', root),
    databasePath: resolveDir(env.DATABASE_PATH, 'data/court-replay.db', root),
    recordingLimitSeconds,
    lanMode,
    serveStatic: env.NODE_ENV === 'production',
    repoRoot: root,
  };
}
