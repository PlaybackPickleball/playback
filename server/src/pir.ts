/**
 * Single rating surface used by club code and Play Now.
 * The algorithm lives in playbackRating.ts. There is no second rating and no second player id.
 * `confidence` is the Play Now ranking weight (Low 0.15, Medium 0.55, High 0.85), not a probability.
 */

export {
  ALGORITHM_VERSION,
  ESTABLISHED_MATCHES,
  START_RATINGS,
  applyPlaybackResult,
  categoryOf,
  confidenceBand,
  confidenceWeight,
  expectedScore,
  isProvisional,
  kFactor,
  roundRating,
  startingRating,
  teamStrength,
  toPlayback,
  type ExplanationCode,
  type RatingUpdate,
  type RatedSide,
  type StartCategory,
} from './playbackRating.js';

export { confidenceWeight as confidence } from './playbackRating.js';

/** New guests start at Intermediate 3.5, provisional, with no verified matches. */
export const PIR_START = 3.5;
export const GUEST_START_RATING = PIR_START;

export type PirPlayer = {
  id: string;
  rating: number;
  matchesPlayed: number;
};
