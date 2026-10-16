import { request } from './api';

export type SmartFillPrices = {
  normalPriceVnd: number;
  promoPriceVnd: number;
};

export type PlayPerson = {
  playerId: string;
  displayName: string;
  level: number;
  provisional?: boolean;
  isHost?: boolean;
};

export type PlaySplit = {
  recommended: { teamA: PlayPerson[]; teamB: PlayPerson[] };
  note?: string;
};

export type PlayMatch = {
  id: string;
  status?: string;
  demo: boolean;
  facilityId?: string;
  facilityName: string;
  courtId?: string | null;
  courtNumber: number | null;
  start: string;
  format: string;
  seatsOpen: number;
  pricePerPlayerVnd: number;
  levelRange?: { min: number; max: number };
  participants: PlayPerson[];
  teamSplit: PlaySplit | null;
  /** Absent until the server adds Smart Fill prices onto a match. */
  smartFill?: SmartFillPrices | null;
};

export type PlaySearch = {
  categories: {
    join_existing: {
      match: PlayMatch;
      distanceKm: number;
      explanation: string;
    }[];
    build_my_game: {
      slot: {
        id: string;
        facilityId: string;
        facilityName: string;
        courtId?: string;
        courtNumber: number;
        start: string;
        priceVnd: number;
      };
      distanceKm: number;
      suggestedMatch: { levelRange: { min: number; max: number }; pricePerPlayerVnd: number };
      candidates: {
        playerId: string;
        displayName: string;
        level: number;
        provisional: boolean;
        explanation: string;
      }[];
    }[];
    join_queue: {
      facilityId: string;
      facilityName: string;
      distanceKm: number;
      activeQueueLength: number;
      estimate: {
        status: string;
        waitMinutes: number | null;
        typicalMinutes?: { low: number; high: number };
      };
    }[];
  };
};

export type PlaySlot = {
  id: string;
  facilityId: string;
  courtId: string;
  courtNumber: number;
  date: string;
  start: string;
  end: string;
  priceVnd: number;
  status: string;
  demo: boolean;
  bookable: boolean;
};

export type PlayPreferences = {
  radiusKm: number;
  format: string;
  start: { kind: string; at?: string; date?: string; from?: string; to?: string };
  notificationsOptIn: boolean;
  matchInviteOptIn: boolean;
  availability: { optedIn: boolean; windows: { day: number; start: string; end: string }[] };
};

export type FillRequest = {
  id: string;
  openMatchId: string;
  playerId: string;
  status: string;
  demo: boolean;
};

export type PlayQueueEntry = {
  id: string;
  facilityId: string;
  facilityName: string;
  status: string;
  state: string;
  position: number | null;
  level: number;
};

export type PlayQueueStatus = {
  facilityId: string;
  facilityName: string;
  waitingPlayers: number;
  estimate: PlaySearch['categories']['join_queue'][number]['estimate'];
};

function playerHeaders(playerId: string, json = false): HeadersInit {
  return json ? { 'Content-Type': 'application/json', 'x-player-id': playerId } : { 'x-player-id': playerId };
}

export function searchPlay(
  playerId: string,
  body: { format?: string; radiusKm?: number; start?: 'asap' | { date?: string; from?: string; to?: string }; candidateLimit?: number },
) {
  return request<PlaySearch>('/api/play/search', {
    method: 'POST',
    headers: playerHeaders(playerId, true),
    body: JSON.stringify(body),
  });
}

export function createOpenMatch(playerId: string, slotId: string, format = 'doubles') {
  return request<{ match: PlayMatch; replayed: boolean }>('/api/play/open-matches', {
    method: 'POST',
    headers: playerHeaders(playerId, true),
    body: JSON.stringify({ slotId, format }),
  });
}

export function joinOpenMatch(playerId: string, matchId: string) {
  return request<{ match: PlayMatch; replayed: boolean }>(`/api/play/open-matches/${encodeURIComponent(matchId)}/join`, {
    method: 'POST',
    headers: playerHeaders(playerId),
  });
}

export function requestSmartFill(playerId: string, openMatchId: string) {
  return request<{ request: FillRequest; replayed: boolean }>('/api/play/smart-fill/requests', {
    method: 'POST',
    headers: playerHeaders(playerId, true),
    body: JSON.stringify({ openMatchId }),
  });
}

export function listMyGames(playerId: string) {
  return request<{ games: PlayMatch[]; invitations: { id: string; status: string; match: PlayMatch }[] }>('/api/play/my-games', {
    headers: playerHeaders(playerId),
  });
}

export function getPlayPreferences(playerId: string) {
  return request<{ preferences: PlayPreferences }>('/api/play/preferences', { headers: playerHeaders(playerId) });
}

export function savePlayPreferences(playerId: string, body: Partial<PlayPreferences>) {
  return request<{ preferences: PlayPreferences }>('/api/play/preferences', {
    method: 'PUT',
    headers: playerHeaders(playerId, true),
    body: JSON.stringify(body),
  });
}

export function listPlaySlots(playerId: string, facilityId: string, date: string) {
  const query = new URLSearchParams({ facilityId, date });
  return request<{ slots: PlaySlot[] }>(`/api/play/slots?${query}`, { headers: playerHeaders(playerId) });
}

export function joinPlayQueue(playerId: string, facilityId: string, format = 'doubles') {
  return request<{ entry: PlayQueueEntry; replayed: boolean }>('/api/play/queue/join', {
    method: 'POST',
    headers: playerHeaders(playerId, true),
    body: JSON.stringify({ facilityId, format, source: 'app', partySize: 1 }),
  });
}

export function cancelPlayQueue(playerId: string, entryId: string) {
  return request<{ entry: PlayQueueEntry; replayed: boolean }>(`/api/play/queue/${encodeURIComponent(entryId)}/cancel`, {
    method: 'POST',
    headers: playerHeaders(playerId),
  });
}

export function playQueueStatus(playerId: string, facilityId: string, radiusKm?: number) {
  const query = new URLSearchParams({ facilityId });
  if (radiusKm != null) query.set('radiusKm', String(radiusKm));
  return request<PlayQueueStatus>(`/api/play/queue/status?${query}`, { headers: playerHeaders(playerId) });
}

export function myPlayQueue(playerId: string) {
  return request<{ entry: PlayQueueEntry | null }>('/api/play/queue/my', { headers: playerHeaders(playerId) });
}

export function acceptQueueOffer(playerId: string, offerId: string) {
  return request<{ offer: { id: string; status: string }; replayed: boolean }>(`/api/play/queue/offers/${encodeURIComponent(offerId)}/accept`, {
    method: 'POST',
    headers: playerHeaders(playerId),
  });
}

export function declineQueueOffer(playerId: string, offerId: string) {
  return request<{ offer: { id: string; status: string }; replayed: boolean }>(`/api/play/queue/offers/${encodeURIComponent(offerId)}/decline`, {
    method: 'POST',
    headers: playerHeaders(playerId),
  });
}
