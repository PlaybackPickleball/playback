import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ApiError } from '../api';
import { confirmMatchResult, disputeMatchResult, getClubMatch, getVideoJob, saveClubScore, submitMatchResult, type ClubMatch } from '../clubApi';
import { Button, Card } from '../components/Ui';
import { useI18n } from '../i18n/context';
import { matchStatusLabel } from '../i18n/format';

export function ResultPage() {
  const { matchId = '' } = useParams();
  const { t } = useI18n();
  const [match, setMatch] = useState<ClubMatch | null>(null);
  const [scoreA, setScoreA] = useState('');
  const [scoreB, setScoreB] = useState('');
  const [job, setJob] = useState('');
  const [message, setMessage] = useState('');
  const [target, setTarget] = useState('11');
  const [actor, setActor] = useState('');

  async function load() {
    const next = await getClubMatch(matchId);
    setMatch(next);
    if (next.scoreA !== null) setScoreA(String(next.scoreA));
    if (next.scoreB !== null) setScoreB(String(next.scoreB));
    if (next.scoreTarget) setTarget(String(next.scoreTarget));
    const people = [...next.teams.A, ...next.teams.B];
    setActor((current) => current || people[0]?.id || '');
    const video = await getVideoJob(matchId);
    setJob(video.status);
  }

  useEffect(() => {
    void load().catch(() => setMessage(t('loadFailed')));
  }, [matchId]);

  async function save() {
    setMessage('');
    try {
      setMatch(await saveClubScore(matchId, Number(scoreA), Number(scoreB)));
    } catch (error) {
      const code = error instanceof ApiError ? error.code : '';
      setMessage(code === 'recording_not_saved' || code === 'not_recording' ? t('videoNotSaved') : code === 'tied_score' ? t('tiedScore') : t('errorGeneric'));
    }
  }

  async function submit() {
    if (!match) return;
    setMessage('');
    try {
      setMatch(await submitMatchResult(matchId, {
        playerId: actor,
        teamA: match.teams.A.map((player) => player.id),
        teamB: match.teams.B.map((player) => player.id),
        scoreA: Number(scoreA),
        scoreB: Number(scoreB),
        target: Number(target),
      }));
    } catch (error) {
      const code = error instanceof ApiError ? error.code : '';
      setMessage(code === 'players_not_in_match' ? t('errorGeneric') : code === 'win_by_two' || code === 'invalid_score' ? t('tiedScore') : t('errorGeneric'));
    }
  }

  async function confirm() {
    setMessage('');
    try {
      setMatch(await confirmMatchResult(matchId, actor));
      setMessage(t('ratingsUpdated'));
    } catch (error) {
      const code = error instanceof ApiError ? error.code : '';
      setMessage(code === 'cannot_confirm_own' ? t('pbResultPending') : code === 'disputed' ? t('pbResultDisputed') : code === 'already_verified' ? t('alreadyVerified') : t('errorGeneric'));
    }
  }

  async function dispute() {
    setMessage('');
    try {
      setMatch(await disputeMatchResult(matchId, actor));
      setMessage(t('pbResultDisputed'));
    } catch {
      setMessage(t('errorGeneric'));
    }
  }

  if (!match) return <main className="mx-auto max-w-3xl px-4 py-8">{message || '…'}</main>;

  return (
    <main className="mx-auto grid w-full max-w-3xl gap-4 px-4 py-8">
      <h1 className="text-3xl font-semibold">{t('resultTitle')}</h1>
      <p className="text-sm leading-6 text-muted">{t('resultHelp')}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        {(['A', 'B'] as const).map((team) => (
          <div key={team} className="rounded-2xl p-4 text-white" style={{ backgroundColor: team === 'A' ? '#b91c1c' : '#1d4ed8' }}>
            <p className="text-sm font-semibold">{t(team === 'A' ? 'teamARed' : 'teamBBlue')}</p>
            <p className="mt-2 text-lg font-semibold">{match.teams[team].map((player) => player.displayName).join(', ') || '—'}</p>
          </div>
        ))}
      </div>
      <Card>
        <p>{t('matchStatus')}: {matchStatusLabel(match.status, t)}</p>
        <div className="mt-3 grid grid-cols-2 gap-3">
          <label className="text-sm font-semibold">
            {t('scoreA')}
            <input data-testid="result-score-a" inputMode="numeric" value={scoreA} onChange={(event) => setScoreA(event.target.value)} className="mt-1 min-h-12 w-full rounded-xl border border-line px-3 text-2xl" />
          </label>
          <label className="text-sm font-semibold">
            {t('scoreB')}
            <input data-testid="result-score-b" inputMode="numeric" value={scoreB} onChange={(event) => setScoreB(event.target.value)} className="mt-1 min-h-12 w-full rounded-xl border border-line px-3 text-2xl" />
          </label>
        </div>
        <label className="mt-3 block text-sm font-semibold">
          {t('pbActingAs')}
          <select data-testid="result-actor" className="mt-1 min-h-11 w-full rounded-xl border border-line px-3" value={actor} onChange={(event) => setActor(event.target.value)}>
            {[...match.teams.A, ...match.teams.B].map((player) => (
              <option key={player.id} value={player.id}>{player.displayName}</option>
            ))}
          </select>
        </label>
        <label className="mt-3 block text-sm font-semibold">
          {t('pbTargetScore')}
          <select data-testid="result-target" className="mt-1 min-h-11 w-full rounded-xl border border-line px-3" value={target} onChange={(event) => setTarget(event.target.value)}>
            <option value="11">11</option>
            <option value="15">15</option>
            <option value="21">21</option>
          </select>
        </label>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button data-testid="save-result" disabled={match.status === 'verified'} onClick={() => void save()}>{t('saveResult')}</Button>
          <Button data-testid="submit-result" disabled={match.ratingsApplied} onClick={() => void submit()}>{t('pbSubmitResult')}</Button>
          <Button data-testid="confirm-result" disabled={match.resultStatus !== 'pending'} onClick={() => void confirm()}>{t('pbConfirmResult')}</Button>
          <Button data-testid="dispute-result" variant="secondary" disabled={match.resultStatus !== 'pending'} onClick={() => void dispute()}>{t('pbDisputeResult')}</Button>
        </div>
        {match.resultStatus === 'pending' ? <p className="mt-3 text-sm">{t('pbResultPending')}</p> : null}
        {match.resultStatus === 'disputed' ? <p className="mt-3 text-sm">{t('pbResultDisputed')}</p> : null}
        {message ? <p data-testid="result-message" className="mt-3 font-semibold">{message}</p> : null}
        {match.ratingsApplied ? <p className="mt-2 text-sm">{t('ratingsUpdated')}</p> : null}
      </Card>
      <Card>
        <p className="text-sm leading-6 text-muted">{t('videoJobUnavailable')}</p>
        <p className="mt-1 text-xs text-muted">{job}</p>
      </Card>
      <div className="flex flex-wrap gap-4 text-sm font-semibold">
        {match.sessionToken ? <Link to={`/watch/${match.sessionToken}`}>{t('watch')}</Link> : null}
        {match.teams.A[0] ? <Link to={`/players/${match.teams.A[0].id}`}>{match.teams.A[0].displayName}</Link> : null}
      </div>
    </main>
  );
}
