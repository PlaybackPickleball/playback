import type { SessionStatus, StationStatus } from '../types';

export type RemoteState = 'offline' | 'waiting' | 'ready' | 'starting' | 'recording' | 'saving' | 'saved' | 'failed';

/** What the phone may say. Recording is only claimed when the laptop station reports it. */
export function remoteRecorderState(
  station: Pick<StationStatus, 'online' | 'ready' | 'phase' | 'command'>,
  sessionStatus: SessionStatus | null,
): RemoteState {
  if (sessionStatus === 'ready') return 'saved';
  if (sessionStatus === 'failed') return 'failed';
  if (sessionStatus === 'saving' || station.phase === 'saving') return 'saving';
  if (station.phase === 'recording') return 'recording';
  if (station.command?.action === 'start') return 'starting';
  if (station.online && station.ready && station.phase === 'ready') return 'ready';
  if (station.online) return 'waiting';
  return 'offline';
}
