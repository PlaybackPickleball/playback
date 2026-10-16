import type { AppConfigResponse, DashboardData, EndId, FacilityPersonDetail, Mode, PublicSession, StationStatus } from './types';
import type { HighlightMark, ScoreEvent } from './lib/score';

export class ApiError extends Error {
  code: string;
  status: number;

  constructor(code: string, status: number) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

async function parse(response: Response): Promise<unknown> {
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, init);
  } catch {
    throw new ApiError('network', 0);
  }
  const data = (await parse(response)) as { error?: string } | null;
  if (!response.ok) throw new ApiError(data?.error || 'server_error', response.status);
  return data as T;
}

export function getConfig(): Promise<AppConfigResponse> {
  return request('/api/config');
}

export function createSession(input: {
  courtId: string;
  mode: Mode;
  teams: { A: string[]; B: string[] };
  consent: true;
  startingEnds?: { A: EndId; B: EndId };
  endSwitch?: 'none';
}): Promise<PublicSession> {
  return request('/api/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export function getSession(token: string): Promise<PublicSession> {
  return request(`/api/sessions/${token}`);
}

export function startSession(token: string, startingEnds?: { A: EndId; B: EndId }): Promise<PublicSession> {
  return request(`/api/sessions/${token}/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(startingEnds ? { startingEnds } : {}),
  });
}

export function saveContact(
  token: string,
  input: { phone: string; language: 'en' | 'vi'; marketingConsent: boolean; channel: 'zalo' | 'whatsapp'; name: string },
): Promise<PublicSession> {
  return request(`/api/sessions/${token}/contact`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export function optOutContact(token: string): Promise<PublicSession> {
  return request(`/api/sessions/${token}/contact/opt-out`, { method: 'POST' });
}

export function failSession(token: string): Promise<PublicSession> {
  return request(`/api/sessions/${token}/fail`, { method: 'POST' });
}

export function getStation(courtId: string): Promise<StationStatus> {
  return request(`/api/courts/${courtId}/station`);
}

export function beatStation(
  courtId: string,
  body: { ready: boolean; phase: 'armed' | 'recording' | 'saving'; sessionToken: string | null },
): Promise<StationStatus> {
  return request(`/api/courts/${courtId}/station`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export type LiveAction =
  | { id: string; action: 'point'; team: 'A' | 'B' }
  | { id: string; action: 'undo' }
  | { id: string; action: 'switch' };

export type LiveBoard = {
  recording: boolean;
  teams: { A: string[]; B: string[] };
  startingEnds: { A: EndId; B: EndId } | null;
  endSwitch: 'none';
  scores: ScoreEvent[];
  switches: { offsetMs: number }[];
  inbox: LiveAction[];
};

export function getLive(token: string): Promise<LiveBoard> {
  return request(`/api/sessions/${token}/live`);
}

export function postLive(token: string, action: LiveAction): Promise<LiveBoard> {
  return request(`/api/sessions/${token}/live`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(action),
  });
}

export function syncLive(
  token: string,
  body: { scores: ScoreEvent[]; switches: { offsetMs: number }[]; applied: string[] },
): Promise<LiveBoard> {
  return request(`/api/sessions/${token}/live/sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export function commandStation(courtId: string, body: { action: 'start' | 'stop'; token: string }): Promise<StationStatus> {
  return request(`/api/courts/${courtId}/commands`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export function getDashboard(): Promise<DashboardData> {
  return request('/api/dashboard');
}

export function getPerson(id: string): Promise<FacilityPersonDetail> {
  return request(`/api/people/${id}`);
}

export function setBalance(id: string, balance: number): Promise<FacilityPersonDetail> {
  return request(`/api/people/${id}/balance`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ balance }),
  });
}

export function deleteSession(token: string): Promise<void> {
  return request(`/api/sessions/${token}`, { method: 'DELETE' });
}

function encodeJson(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = '';
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
}

export function uploadVideo(
  token: string,
  blob: Blob,
  meta: {
    durationMs: number;
    scores: ScoreEvent[];
    highlights: HighlightMark[];
    switches?: { offsetMs: number }[];
    cameraEnd?: EndId;
    expectedEnds?: EndId[];
  },
): Promise<PublicSession> {
  const headers: Record<string, string> = {
    'Content-Type': blob.type || 'application/octet-stream',
    'X-Duration-Ms': String(meta.durationMs),
    'X-Scores': encodeJson(meta.scores),
    'X-Highlights': encodeJson(meta.highlights),
    'X-Switches': encodeJson(meta.switches ?? []),
  };
  if (meta.cameraEnd) {
    headers['X-Camera-End'] = String(meta.cameraEnd);
    headers['X-Expected-Ends'] = (meta.expectedEnds ?? [meta.cameraEnd]).join(',');
  }
  return request(`/api/sessions/${token}/video`, {
    method: 'POST',
    headers,
    body: blob,
  });
}
