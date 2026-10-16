export type Mode = 'singles' | 'doubles';
export type SessionStatus = 'draft' | 'recording' | 'saving' | 'ready' | 'failed';
export type TeamId = 'A' | 'B';
export type EndId = 1 | 2;

export type PublicVideo = {
  end: EndId | null;
  mime: string;
  size: number;
  url: string;
};

export type ContactChannel = 'zalo' | 'whatsapp';

export type PublicContact = {
  phone: string;
  playerNames: string;
  courtId: string;
  language: 'en' | 'vi';
  recordingConsentAt: string;
  marketingConsentAt: string | null;
  createdAt: string;
  optedOutAt: string | null;
  channel: ContactChannel;
};

export type RallyView = {
  index: number;
  startMs: number;
  endMs: number;
  pointOffsetMs: number;
  scoringTeam: TeamId;
  starred: boolean;
};

export type PublicSession = {
  token: string;
  courtId: string;
  mode: Mode;
  status: SessionStatus;
  teams: { A: string[]; B: string[] };
  consentAt: string;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  video: { mime: string; size: number; url: string } | null;
  videos: PublicVideo[];
  scores: { team: TeamId; offsetMs: number }[];
  highlights: { id: string; offsetMs: number }[];
  switches: { offsetMs: number }[];
  startingEnds: { A: EndId; B: EndId } | null;
  rallies: RallyView[];
  contact: PublicContact | null;
  score: { A: number; B: number };
  gameTo: number;
  switchAt: number | null;
  endSwitch: 'none';
};

export type DashboardContact = {
  playerNames: string;
  phone: string;
  channel: ContactChannel;
  marketing: boolean;
  optedOut: boolean;
  personId: string | null;
};

export type FacilityPerson = {
  id: string;
  name: string;
  channel: ContactChannel;
  phone: string;
  videoCount: number;
  balance: number;
};

export type FacilityVideo = {
  token: string;
  courtId: string;
  createdAt: string;
  playerNames: string;
  marketing: boolean;
  optedOut: boolean;
};

export type FacilityPersonDetail = FacilityPerson & {
  videos: FacilityVideo[];
};

export type DashboardSession = {
  token: string;
  courtId: string;
  mode: Mode;
  status: SessionStatus;
  teams: { A: string[]; B: string[] };
  createdAt: string;
  durationMs: number | null;
  score: { A: number; B: number };
  videoSize: number | null;
  contact: DashboardContact | null;
};

export type DashboardData = {
  savedSessions: number;
  totalDurationMs: number;
  sessions: DashboardSession[];
  people: FacilityPerson[];
};

export type StationCommand = {
  id: string;
  action: 'start' | 'stop';
  token: string;
};

export type StationStatus = {
  online: boolean;
  ready: boolean;
  phase: 'offline' | 'waiting' | 'ready' | 'recording' | 'saving';
  sessionToken: string | null;
  command: StationCommand | null;
};

export type AppConfigResponse = {
  publicBaseUrl: string;
  recordingLimitSeconds: number;
  uploadLimitMb: number;
  lanMode: boolean;
  courts: string[];
  facilityCourts?: string[];
  recordingCourt?: string;
  gameTo: number;
  switchAt: null;
};
