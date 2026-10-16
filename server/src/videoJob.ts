/**
 * Placeholder for a future video job.
 * No detector runs. Confidence and model version stay empty.
 * PIR must not read this object.
 */

export type VideoJob = {
  id: string;
  matchId: string;
  status: 'unavailable';
  events: [];
  confidence: null;
  modelVersion: null;
  note: 'manual-result-only';
};

export function emptyVideoJob(matchId: string): VideoJob {
  return {
    id: `job-${matchId}`,
    matchId,
    status: 'unavailable',
    events: [],
    confidence: null,
    modelVersion: null,
    note: 'manual-result-only',
  };
}
