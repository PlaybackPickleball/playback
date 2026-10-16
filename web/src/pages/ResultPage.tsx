import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ApiError } from '../api';
import { getClubMatch, getVideoJob, saveClubScore, verifyClubMatch, type ClubMatch } from '../clubApi';
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

  async function load() {
    const next = await getClubMatch(matchId);
    setMatch(next);
    if (next.scoreA !== null) setScoreA(String(next.scoreA));
    if (next.scoreB !== null) setScoreB(String(next.scoreB));
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

  async function verify() {
    setMessage('');
    try {
      setMatch(await verifyClubMatch(matchId));
      setMessage(t('ratingsUpdated'));
    } catch (error) {
      const code = error instanceof ApiError ? error.code : '';
      setMessage(code === 'already_verified' ? t('alreadyVerified') : t('errorGeneric'));
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
        <div className="mt-4 flex flex-wrap gap-2">
          <Button data-testid="save-result" disabled={match.status === 'verified'} onClick={() => void save()}>{t('saveResult')}</Button>
          <Button data-testid="verify-result" disabled={match.status !== 'completed'} onClick={() => void verify()}>{t('verifyResult')}</Button>
        </div>
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
