import { request } from './api';

export type QueueMode = 'fifo' | 'skill' | 'hybrid';

export type PlaySlot = {
  id: string;
  facilityId: string;
  courtId: string;
  courtNumber: number;
  date: string;
  start: string;
  end: string;
  priceVnd: number;
  currency: 'VND';
  status: string;
  source: string;
  demo: boolean;
  availabilityVerified: boolean;
  bookable: boolean;
};

export type PlayBooking = {
  id: string;
  facilityId: string;
  courtId: string;
  start: string;
  end: string;
  status: string;
  priceVnd: number;
  currency: 'VND';
  payment: { method: 'pay_at_facility'; processed: false; note: string };
  participants: { displayName: string; status: string }[];
};

export type QueueSettings = {
  facilityId: string;
  mode: QueueMode;
  acceptanceWindowSeconds: number;
};

export type QueueEntry = { status: string; partySize: number };

function adminHeaders(token: string, json = false): HeadersInit {
  return {
    'x-admin-token': token,
    ...(json ? { 'Content-Type': 'application/json' } : {}),
  };
}

/** Venue calendar day in Asia/Ho_Chi_Minh, as YYYY-MM-DD. */
export function venueToday(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Ho_Chi_Minh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

export function listSlots(facilityId: string, date: string) {
  const query = new URLSearchParams({ facilityId, date });
  return request<{ slots: PlaySlot[] }>(`/api/play/slots?${query}`);
}

export function createSlot(
  token: string,
  body: { facilityId: string; courtId: string; date: string; start: string; end: string; priceVnd: number },
) {
  return request<{ slot: PlaySlot }>('/api/play/admin/slots', {
    method: 'POST',
    headers: adminHeaders(token, true),
    body: JSON.stringify(body),
  });
}

export function listAdminBookings(token: string, facilityId: string) {
  const query = new URLSearchParams({ facilityId });
  return request<{ bookings: PlayBooking[] }>(`/api/play/admin/bookings?${query}`, { headers: adminHeaders(token) });
}

export function cancelAdminBooking(token: string, id: string) {
  return request<{ booking: PlayBooking }>(`/api/play/admin/bookings/${encodeURIComponent(id)}/cancel`, {
    method: 'POST',
    headers: adminHeaders(token),
  });
}

export function getQueueSettings(token: string, facilityId: string) {
  const query = new URLSearchParams({ facilityId });
  return request<{ settings: QueueSettings }>(`/api/play/admin/queue/settings?${query}`, { headers: adminHeaders(token) });
}

export function putQueueSettings(
  token: string,
  body: { facilityId: string; mode: QueueMode; acceptanceWindowSeconds: number },
) {
  return request<{ settings: QueueSettings }>('/api/play/admin/queue/settings', {
    method: 'PUT',
    headers: adminHeaders(token, true),
    body: JSON.stringify(body),
  });
}

export function getAdminQueue(token: string, facilityId: string) {
  const query = new URLSearchParams({ facilityId });
  return request<{ entries: QueueEntry[] }>(`/api/play/admin/queue?${query}`, { headers: adminHeaders(token) });
}

export type FillSettings = {
  facilityId: string;
  enabled: boolean;
  normalPriceVnd: number | null;
  promoPriceVnd: number | null;
  maxDiscountPercent: number | null;
  promotableStart: string | null;
  promotableEnd: string | null;
  demo: boolean;
  updatedAt: string | null;
};

export type FillSummary = {
  grossBookingValueVnd: number;
  playbackOriginatedVnd: number;
  estimatedIncrementalVnd: number;
  currency: 'VND';
};

export type FillWrite = {
  facilityId: string;
  enabled: boolean;
  normalPriceVnd: number;
  promoPriceVnd: number;
  maxDiscountPercent: number;
  promotableStart: string;
  promotableEnd: string;
};

export function getFillSettings(token: string, facilityId: string) {
  const query = new URLSearchParams({ facilityId });
  return request<{ settings: FillSettings }>(`/api/play/admin/smart-fill/settings?${query}`, { headers: adminHeaders(token) });
}

export function putFillSettings(token: string, body: FillWrite) {
  return request<{ settings: FillSettings }>('/api/play/admin/smart-fill/settings', {
    method: 'PUT',
    headers: adminHeaders(token, true),
    body: JSON.stringify(body),
  });
}

export function disableFill(token: string, facilityId: string) {
  return request<{ settings: FillSettings }>('/api/play/admin/smart-fill/disable', {
    method: 'POST',
    headers: adminHeaders(token, true),
    body: JSON.stringify({ facilityId }),
  });
}

export function publishFill(token: string, body: { slotId: string; hostPlayerId: string }) {
  return request<{ promoPriceVnd: number; replayed: boolean }>('/api/play/admin/smart-fill/publish', {
    method: 'POST',
    headers: adminHeaders(token, true),
    body: JSON.stringify(body),
  });
}

export function getFillSummary(token: string, facilityId: string) {
  const query = new URLSearchParams({ facilityId });
  return request<{ summary: FillSummary }>(`/api/play/admin/smart-fill/summary?${query}`, { headers: adminHeaders(token) });
}
