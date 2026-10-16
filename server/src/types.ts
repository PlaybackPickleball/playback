export type Mode = 'singles' | 'doubles';
export type SessionStatus = 'draft' | 'recording' | 'saving' | 'ready' | 'failed';
export type TeamId = 'A' | 'B';

export type Teams = {
  A: string[];
  B: string[];
};

export type ScoreEvent = {
  team: TeamId;
  offsetMs: number;
};

export type HighlightEvent = {
  offsetMs: number;
};

export type SwitchEvent = {
  offsetMs: number;
};

export type EndId = 1 | 2;

export type StoredVideo = {
  end: EndId;
  mime: string;
  size: number;
  ext: 'webm' | 'mp4';
};

export type ContactChannel = 'zalo' | 'whatsapp';

export type ContactRow = {
  id: string;
  session_id: string;
  phone: string;
  player_names: string;
  court_id: string;
  language: 'en' | 'vi';
  recording_consent_at: string;
  marketing_consent_at: string | null;
  created_at: string;
  opted_out_at: string | null;
  channel: ContactChannel;
  person_id: string | null;
};

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

export type PublicVideo = {
  end: EndId | null;
  mime: string;
  size: number;
  url: string;
};

export type SessionRow = {
  id: string;
  public_token: string;
  court_id: string;
  mode: Mode;
  status: SessionStatus;
  team_a_json: string;
  team_b_json: string;
  consent_at: string;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
  duration_ms: number | null;
  video_mime: string | null;
  video_size: number | null;
  video_ext: string | null;
  updated_at: string;
  team_a_end: number | null;
  team_b_end: number | null;
  expected_ends: string | null;
  end_switch: 'at6' | 'none';
};

export type PublicSession = {
  token: string;
  courtId: string;
  mode: Mode;
  status: SessionStatus;
  teams: Teams;
  consentAt: string;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  video: { mime: string; size: number; url: string } | null;
  videos: PublicVideo[];
  scores: ScoreEvent[];
  highlights: { id: string; offsetMs: number }[];
  switches: SwitchEvent[];
  startingEnds: { A: EndId; B: EndId } | null;
  rallies: {
    index: number;
    startMs: number;
    endMs: number;
    pointOffsetMs: number;
    scoringTeam: TeamId;
    starred: boolean;
  }[];
  contact: PublicContact | null;
  score: { A: number; B: number };
  gameTo: number;
  switchAt: number | null;
  endSwitch: 'none';
};
