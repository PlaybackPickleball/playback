import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError, createSession } from '../api';
import {
  attachClubSession,
  createGuest,
  joinCourt,
  leaveClubMatch,
  listClubPlayers,
  openCourtMatch,
  setClubMode,
  startSimulatedMatch,
  type ClubMatch,
  type ClubPlayer,
  type TeamId,
} from '../clubApi';
import { useI18n } from '../i18n/context';
import { Button } from './Ui';

const teamStyle = {
  A: { backgroundColor: '#b91c1c', color: '#fff' },
  B: { backgroundColor: '#1d4ed8', color: '#fff' },
} as const;

export function CheckInPanel({ courtId }: { courtId: string }) {
  const { t, lang } = useI18n();
  const navigate = useNavigate();
  const [players, setPlayers] = useState<ClubPlayer[]>([]);
  const [match, setMatch] = useState<ClubMatch | null>(null);
  const [format, setFormat] = useState<'singles' | 'doubles'>('doubles');
  const [consent, setConsent] = useState(false);
  const [guest, setGuest] = useState('');
  const [message, setMessage] = useState('');
  const [pending, setPending] = useState(false);

  async function load() {
    const [roster, desk] = await Promise.all([listClubPlayers(), openCourtMatch(courtId)]);
    setPlayers(roster.players);
    setMatch(desk.match);
  }

  useEffect(() => {
    void load().catch(() => setMessage(t('loadFailed')));
  }, [courtId, t]);

  async function run(action: () => Promise<void>) {
    setPending(true);
    setMessage('');
    try {
      await action();
      await load();
    } catch (error) {
      const code = error instanceof ApiError ? error.code : 'error';
      setMessage(
        code === 'duplicate_player' ? t('alreadyJoined') : code === 'team_full' || code === 'roster_too_large' ? t('courtFull') : t('errorGeneric'),
      );
    } finally {
      setPending(false);
    }
  }

  async function start() {
    if (!match || match.status !== 'ready' || !consent) return;
    setPending(true);
    setMessage('');
    try {
      const session = await createSession({
        courtId,
        mode: match.mode,
        consent: true,
        teams: {
          A: match.teams.A.map((player) => player.displayName),
          B: match.teams.B.map((player) => player.displayName),
        },
        startingEnds: { A: 1, B: 2 },
      });
      await attachClubSession(match.id, session.token);
      navigate(`/record/${session.token}`);
    } catch (error) {
      const code = error instanceof ApiError ? error.code : '';
      setMessage(code === 'consent_required' ? t('consentError') : t('errorGeneric'));
      setPending(false);
    }
  }

  const onTeam = (id: string, team: TeamId) => match?.teams[team].some((player) => player.id === id);
  const laptop = courtId === 'court-1';

  async function startSimulated() {
    if (!match || match.status !== 'ready') return;
    setPending(true);
    setMessage('');
    try {
      const started = await startSimulatedMatch(match.id);
      navigate(`/matches/${started.id}`);
    } catch {
      setMessage(t('errorGeneric'));
      setPending(false);
    }
  }

  return (
    <section className="mt-8 grid gap-4" data-testid="check-in">
      <div>
        <h2 className="text-2xl font-semibold">{t('checkInTitle')}</h2>
        <p className="mt-2 text-sm leading-6 text-muted">{t('checkInHelp')}</p>
        <p className="mt-2 text-sm leading-6 text-muted">{t('hostStarts')}</p>
      </div>
      <div className="flex flex-wrap gap-2">
        {(['singles', 'doubles'] as const).map((mode) => (
          <button
            key={mode}
            type="button"
            data-testid={`checkin-mode-${mode}`}
            disabled={pending || match?.status === 'recording' || match?.status === 'completed' || match?.status === 'verified'}
            className={`min-h-12 rounded-2xl px-4 font-semibold ${(match?.mode ?? format) === mode ? 'bg-accent text-white' : 'border border-line bg-card'}`}
            onClick={() => {
              setFormat(mode);
              if (match) void run(async () => { await setClubMode(match.id, mode); });
            }}
          >
            {t(mode)}
          </button>
        ))}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {(['A', 'B'] as const).map((team) => (
          <div key={team} data-testid={`checkin-team-${team}`} className="rounded-2xl p-4" style={teamStyle[team]}>
            <p className="text-sm font-semibold">{t(team === 'A' ? 'teamARed' : 'teamBBlue')}</p>
            <ul className="mt-2 grid gap-1 text-lg font-semibold">
              {(match?.teams[team] ?? []).map((player) => (
                <li key={player.id} className="flex items-center justify-between gap-2">
                  <span>{player.displayName}</span>
                  {match && (match.status === 'scheduled' || match.status === 'ready') ? (
                    <button type="button" className="text-sm underline" onClick={() => void run(async () => { await leaveClubMatch(match.id, player.id); })}>
                      {t('leaveCourt')}
                    </button>
                  ) : null}
                </li>
              ))}
              {(match?.teams[team].length ?? 0) === 0 ? <li>—</li> : null}
            </ul>
          </div>
        ))}
      </div>
      <ul className="grid gap-2">
        {players.map((player) => (
          <li key={player.id} className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-line bg-card px-3 py-2">
            <span>
              <span className="font-semibold">{player.displayName}</span>
              <span className="ml-2 text-sm text-muted">PIR {player.rating}</span>
              {player.demo ? <span className="ml-2 rounded-full bg-line px-2 py-0.5 text-xs font-semibold text-muted">{t('demoBadge')}</span> : null}
            </span>
            <span className="flex gap-2">
              {(['A', 'B'] as const).map((team) => (
                <button
                  key={team}
                  type="button"
                  data-testid={`join-${team}-${player.id}`}
                  disabled={pending || onTeam(player.id, team)}
                  className="min-h-10 rounded-xl px-3 text-sm font-semibold disabled:opacity-50"
                  style={teamStyle[team]}
                  onClick={() => void run(async () => {
                    const joined = await joinCourt(courtId, player.id, team);
                    if (joined.mode !== format) await setClubMode(joined.id, format);
                  })}
                >
                  {t(team === 'A' ? 'joinTeamA' : 'joinTeamB')}
                </button>
              ))}
            </span>
          </li>
        ))}
      </ul>
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          const name = guest.trim();
          if (!name) return;
          void run(async () => {
            const created = await createGuest(name, lang);
            setGuest('');
            const joined = await joinCourt(courtId, created.id, 'A');
            if (joined.mode !== format) await setClubMode(joined.id, format);
          });
        }}
      >
        <input
          value={guest}
          onChange={(event) => setGuest(event.target.value)}
          placeholder={t('guestPlayer')}
          className="min-h-12 flex-1 rounded-xl border border-line bg-white px-3"
          data-testid="guest-name"
        />
        <Button type="submit" variant="secondary" disabled={pending}>{t('addGuest')}</Button>
      </form>
      <p className="text-sm text-muted">{t('guestHelp')}</p>
      {match?.status === 'ready' ? <p className="font-semibold" data-testid="court-ready">{t('courtReady')}</p> : null}
      {laptop ? (
        <>
          <label className="flex items-start gap-3 rounded-2xl border border-line bg-paper p-4">
            <input data-testid="checkin-consent" type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} className="mt-1 h-5 w-5" />
            <span className="font-semibold">{t('consentRecordStart')}</span>
          </label>
          <Button data-testid="start-match" disabled={pending || !consent || match?.status !== 'ready'} onClick={() => void start()}>
            {t('startMatch')}
          </Button>
        </>
      ) : (
        <>
          <p className="text-sm font-semibold">{t('simulatedCourt')}</p>
          <Button data-testid="start-simulated" disabled={pending || match?.status !== 'ready'} onClick={() => void startSimulated()}>
            {t('startSimulated')}
          </Button>
        </>
      )}
      {match?.sessionToken ? (
        <a className="font-semibold text-accent-dark" href={`/record/${match.sessionToken}`}>{t('openRecording')}</a>
      ) : null}
      {match && (match.status === 'recording' || match.status === 'completed' || match.status === 'verified') ? (
        <a data-testid="enter-result" className="font-semibold text-accent-dark" href={`/matches/${match.id}`}>{t('resultTitle')}</a>
      ) : null}
      {message ? <p role="status" className="text-sm">{message}</p> : null}
    </section>
  );
}
