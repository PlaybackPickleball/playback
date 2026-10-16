import type { EndAssignment } from './cameras';
import type { RecorderTake } from './media';

export type LiveSlots = { 1: MediaStream | null; 2: MediaStream | null };

export type ArmedStation = {
  courtId: string;
  slots: LiveSlots;
  assignment: EndAssignment;
  cameras: MediaDeviceInfo[];
  mic: 'on' | 'off' | 'fallback';
};

export type LiveTake = ArmedStation & {
  token: string;
  takes: RecorderTake[];
  startedAt: number;
};

let armed: ArmedStation | null = null;
let live: LiveTake | null = null;
let stationSession: string | null = null;
let stationMounts = 0;
let recordMounts = 0;

export function setArmedStation(value: ArmedStation | null) {
  armed = value;
}

export function getArmedStation() {
  return armed;
}

export function setLiveTake(value: LiveTake | null) {
  live = value;
}

export function getLiveTake() {
  return live;
}

export function clearLiveTake() {
  live = null;
}

export function markStationSession(token: string) {
  stationSession = token;
}

export function isStationSession(token: string) {
  return stationSession === token;
}

export function clearStationSession() {
  stationSession = null;
}

export function retainStation(): () => void {
  stationMounts += 1;
  return () => {
    stationMounts -= 1;
  };
}

export function stationStillMounted() {
  return stationMounts > 0;
}

export function retainRecordPage(): () => void {
  recordMounts += 1;
  return () => {
    recordMounts -= 1;
  };
}

export function recordPageStillMounted() {
  return recordMounts > 0;
}
