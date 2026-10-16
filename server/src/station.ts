export const STATION_STALE_MS = 5000;

export type StationBeatPhase = 'armed' | 'recording' | 'saving';
export type StationPhase = 'offline' | 'waiting' | 'ready' | 'recording' | 'saving';
export type StationCommandAction = 'start' | 'stop';

export type StationCommand = {
  id: string;
  action: StationCommandAction;
  token: string;
};

export type StationPresence = {
  ready: boolean;
  phase: StationBeatPhase;
  sessionToken: string | null;
  seenAt: number;
  pending: StationCommand | null;
};

export type StationStatus = {
  online: boolean;
  ready: boolean;
  phase: StationPhase;
  sessionToken: string | null;
  command: StationCommand | null;
};

export type HeartbeatInput = {
  ready: boolean;
  phase: StationBeatPhase;
  sessionToken: string | null;
};

export type CommandError = 'station_offline' | 'station_not_ready' | 'station_busy' | 'not_recording';

const offline: StationStatus = {
  online: false,
  ready: false,
  phase: 'offline',
  sessionToken: null,
  command: null,
};

export function stationStatus(presence: StationPresence | null, now: number, staleMs = STATION_STALE_MS): StationStatus {
  if (!presence || now - presence.seenAt > staleMs) return offline;
  if (presence.phase === 'recording') {
    return {
      online: true,
      ready: presence.ready,
      phase: 'recording',
      sessionToken: presence.sessionToken,
      command: presence.pending,
    };
  }
  if (presence.phase === 'saving') {
    return {
      online: true,
      ready: presence.ready,
      phase: 'saving',
      sessionToken: presence.sessionToken,
      command: presence.pending,
    };
  }
  if (!presence.ready) {
    return {
      online: true,
      ready: false,
      phase: 'waiting',
      sessionToken: null,
      command: presence.pending,
    };
  }
  return {
    online: true,
    ready: true,
    phase: 'ready',
    sessionToken: presence.sessionToken,
    command: presence.pending,
  };
}

export function applyHeartbeat(
  previous: StationPresence | null,
  now: number,
  beat: HeartbeatInput,
  staleMs = STATION_STALE_MS,
): StationPresence {
  const fresh = previous && now - previous.seenAt <= staleMs ? previous : null;
  let pending = fresh?.pending ?? null;
  if (pending?.action === 'start' && beat.phase === 'recording' && beat.sessionToken === pending.token) pending = null;
  if (pending?.action === 'stop' && (beat.phase !== 'recording' || (beat.sessionToken != null && beat.sessionToken !== pending.token))) {
    pending = null;
  }
  return {
    ready: beat.ready,
    phase: beat.phase,
    sessionToken: beat.sessionToken,
    seenAt: now,
    pending,
  };
}

export function queueCommand(
  presence: StationPresence | null,
  now: number,
  input: StationCommand,
  staleMs = STATION_STALE_MS,
): { ok: true; presence: StationPresence; command: StationCommand } | { ok: false; error: CommandError } {
  const status = stationStatus(presence, now, staleMs);
  if (!status.online || !presence) return { ok: false, error: 'station_offline' };

  if (input.action === 'start') {
    if (presence.pending?.action === 'start' && presence.pending.token === input.token) {
      return { ok: true, presence, command: presence.pending };
    }
    if (status.phase === 'recording' || status.phase === 'saving' || presence.pending) {
      return { ok: false, error: 'station_busy' };
    }
    if (!status.ready || status.phase !== 'ready') return { ok: false, error: 'station_not_ready' };
    const command: StationCommand = { id: input.id, action: 'start', token: input.token };
    return { ok: true, command, presence: { ...presence, pending: command } };
  }

  if (presence.pending?.action === 'stop' && presence.pending.token === input.token) {
    return { ok: true, presence, command: presence.pending };
  }
  const recordingThis = status.phase === 'recording' && status.sessionToken === input.token;
  const startingThis = presence.pending?.action === 'start' && presence.pending.token === input.token;
  if (!recordingThis && !startingThis) return { ok: false, error: 'not_recording' };
  const command: StationCommand = { id: input.id, action: 'stop', token: input.token };
  return { ok: true, command, presence: { ...presence, pending: command } };
}

export class StationBook {
  private courts = new Map<string, StationPresence>();

  read(courtId: string, now: number): StationStatus {
    return stationStatus(this.courts.get(courtId) ?? null, now);
  }

  heartbeat(courtId: string, beat: HeartbeatInput, now: number): StationStatus {
    const next = applyHeartbeat(this.courts.get(courtId) ?? null, now, beat);
    this.courts.set(courtId, next);
    return stationStatus(next, now);
  }

  command(
    courtId: string,
    input: StationCommand,
    now: number,
  ): { ok: true; status: StationStatus } | { ok: false; error: CommandError } {
    const decision = queueCommand(this.courts.get(courtId) ?? null, now, input);
    if (!decision.ok) return decision;
    this.courts.set(courtId, decision.presence);
    return { ok: true, status: stationStatus(decision.presence, now) };
  }
}
