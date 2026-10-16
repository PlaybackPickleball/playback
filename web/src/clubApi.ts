import { request } from './api';

export type TeamId = 'A' | 'B';
export type MatchStatus = 'scheduled' | 'ready' | 'recording' | 'completed' | 'verified';
export type Skill = 'beginner' | 'intermediate' | 'advanced';
export type Hand = 'left' | 'right' | 'either';
export type Equipment = { paddle?: string; shoes?: string; apparel?: string; notes?: string };

export type ClubPlayer = {
  id: string;
  displayName: string;
  initials: string;
  language: 'en' | 'vi';
  skill: Skill | null;
  preferredHand: Hand | null;
  rating: number;
  confidence: number;
  wins: number;
  losses: number;
  matchesPlayed: number;
  equipment: Equipment | null;
  equipmentConsentAt: string | null;
  recordingConsentAt: string | null;
  demo: boolean;
  guest: boolean;
  provisional?: boolean;
  latitude?: number | null;
  longitude?: number | null;
  homeFacilityId?: string | null;
  checkInUrl: string;
};

export type RatingPoint = {
  matchId: string;
  ratingBefore: number;
  ratingAfter: number;
  confidenceBefore: number;
  confidenceAfter: number;
  at: string;
};

export type PlayerMatch = {
  id: string;
  courtId: string;
  mode: 'singles' | 'doubles';
  status: MatchStatus;
  team: TeamId;
  scoreA: number | null;
  scoreB: number | null;
  winner: TeamId | null;
  at: string;
  simulated: boolean;
  sessionToken?: string | null;
};

export type PlayerDetail = ClubPlayer & {
  history: RatingPoint[];
  matches: PlayerMatch[];
  unmeasured: { serveSpeed: null; shotPlacement: null; movement: null };
  simulatedAnalytics: { demo: true; titleEn: string; titleVi: string; bodyEn: string; bodyVi: string };
};

export type ClubMatch = {
  id: string;
  courtId: string;
  facilityId: string;
  mode: 'singles' | 'doubles';
  status: MatchStatus;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  scoreA: number | null;
  scoreB: number | null;
  winner: TeamId | null;
  sessionToken: string | null;
  sessionStatus: string | null;
  simulated: boolean;
  ratingsApplied: boolean;
  teams: { A: ClubPlayer[]; B: ClubPlayer[] };
};

export type FacilityCourt = {
  id: string;
  number: number;
  records: boolean;
  simulated: boolean;
  activity: string;
  match: ClubMatch | null;
};

export type FacilitySummary = {
  id: string;
  name: string;
  demo: true;
  productionLogin: false;
  courts: FacilityCourt[];
  activeSessions: number;
  completedMatches: number;
  players: number;
  recordingTimeMs: number;
  participation: number;
};

export type Pairing = {
  teamA: { id: string; displayName: string; rating: number }[];
  teamB: { id: string; displayName: string; rating: number }[];
  strengthA: number;
  strengthB: number;
  gap: number;
};

export type MatchmakingResult = {
  pairings: Pairing[];
  recommendedIndex: number;
  gap: number;
  reason: string;
};

export function listClubPlayers() {
  return request<{ players: ClubPlayer[] }>('/api/players');
}

export function getClubPlayer(id: string) {
  return request<PlayerDetail>(`/api/players/${id}`);
}

export function createGuest(displayName: string, language: 'en' | 'vi') {
  return request<ClubPlayer>('/api/players', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ displayName, language }),
  });
}

export function updateClubPlayer(
  id: string,
  patch: {
    displayName?: string;
    language?: 'en' | 'vi';
    skill?: Skill | null;
    preferredHand?: Hand | null;
    equipment?: Equipment | null;
    equipmentConsent?: boolean;
  },
) {
  return request<ClubPlayer>(`/api/players/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
}

export function openCourtMatch(courtId: string) {
  return request<{ match: ClubMatch | null }>(`/api/courts/${courtId}/match`);
}

export function joinCourt(courtId: string, playerId: string, team: TeamId) {
  return request<ClubMatch>(`/api/courts/${courtId}/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ playerId, team }),
  });
}

export function leaveClubMatch(matchId: string, playerId: string) {
  return request<ClubMatch>(`/api/matches/${matchId}/leave`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ playerId }),
  });
}

export function setClubMode(matchId: string, mode: 'singles' | 'doubles') {
  return request<ClubMatch>(`/api/matches/${matchId}/mode`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode }),
  });
}

export function attachClubSession(matchId: string, token: string) {
  return request<ClubMatch>(`/api/matches/${matchId}/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  });
}

export function getClubMatch(id: string) {
  return request<ClubMatch>(`/api/matches/${id}`);
}

export function saveClubScore(id: string, scoreA: number, scoreB: number) {
  return request<ClubMatch>(`/api/matches/${id}/score`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scoreA, scoreB }),
  });
}

export function startSimulatedMatch(id: string) {
  return request<ClubMatch>(`/api/matches/${id}/start`, { method: 'POST' });
}

export function verifyClubMatch(id: string) {
  return request<ClubMatch>(`/api/matches/${id}/verify`, { method: 'POST' });
}

export function getVideoJob(id: string) {
  return request<{ status: 'unavailable'; events: []; confidence: null; modelVersion: null; note: string }>(
    `/api/matches/${id}/video-job`,
  );
}

export function matchForSession(token: string) {
  return request<{ match: ClubMatch | null }>(`/api/sessions/${token}/match`);
}

export function recommendPairings(playerIds: string[]) {
  return request<MatchmakingResult>('/api/matchmaking', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ playerIds }),
  });
}

export function getFacility() {
  return request<FacilitySummary>('/api/facility');
}

export function resetDemoData() {
  return request<{ ok: true; recordingsKept: true }>('/api/facility/reset', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirm: 'RESET DEMO' }),
  });
}
