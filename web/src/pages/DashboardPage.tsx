import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, deleteSession, getDashboard } from '../api';
import { getFacility, resetDemoData, type FacilitySummary } from '../clubApi';
import { Button, Dialog, Notice, Scene } from '../components/Ui';
import { useI18n } from '../i18n/context';
import { activityLabel, courtNumberFromId, formatSpoken, formatWhen } from '../i18n/format';
import type { ContactChannel, DashboardData, DashboardSession } from '../types';

function channelName(channel: ContactChannel): string {
  return channel === 'whatsapp' ? 'WhatsApp' : 'Zalo';
}

export function DashboardPage() {
  const { t, lang } = useI18n();
  const [data, setData] = useState<DashboardData | null>(null);
  const [failed, setFailed] = useState(false);
  const [pending, setPending] = useState<DashboardSession | null>(null);
  const [message, setMessage] = useState('');
  const [facility, setFacility] = useState<FacilitySummary | null>(null);
  const [resetPhrase, setResetPhrase] = useState('');

  async function load() {
    setFailed(false);
    try {
      const dashboard = await getDashboard();
      setData(dashboard);
      try {
        setFacility(await getFacility());
      } catch {
        setFacility(null);
      }
    } catch {
      setFailed(true);
    }
  }

  useEffect(() => {
    document.title = `${t('dashboardTitle')} · ${t('appName')}`;
    void load();
  }, [t]);

  async function confirmDelete() {
    if (!pending) return;
    try {
      await deleteSession(pending.token);
      setMessage(t('deleted'));
      setPending(null);
      await load();
    } catch (error) {
      setMessage(error instanceof ApiError ? t('deleteFailed') : t('deleteFailed'));
      setPending(null);
    }
  }

  const minutes = Math.round((data?.totalDurationMs ?? 0) / 60000);

  return (
    <section className="min-w-0">
      <Scene image="court" className="px-6 py-10 sm:px-10 sm:py-14">
        <h1 className="text-4xl font-semibold tracking-tight text-balance sm:text-5xl">{t('dashboardTitle')}</h1>
        <p className="mt-4 max-w-2xl text-lg leading-8">{t('dashboardIntro')}</p>
        <div className="mt-6 max-w-2xl">
          <Notice tone="info" title={t('demoAdminNote')}>
            {t('realDataNote')}
          </Notice>
        </div>
      </Scene>
      {message ? <p className="mt-3 text-sm" role="status">{message}</p> : null}
      {failed ? (
        <div className="mt-4">
          <Notice tone="bad" title={t('loadFailed')}>
            <Button className="mt-2" onClick={() => void load()}>{t('refresh')}</Button>
          </Notice>
        </div>
      ) : null}
      {data ? (
        <div className="mt-8 grid gap-4 sm:grid-cols-2">
          <div className="panel p-5">
            <p className="text-sm text-muted">{t('savedSessions')}</p>
            <p data-testid="saved-count" className="mt-2 text-4xl font-semibold tracking-tight">
              {t('sessionsValue', { count: data.savedSessions })}
            </p>
          </div>
          <div className="panel p-5">
            <p className="text-sm text-muted">{t('totalMinutes')}</p>
            <p data-testid="total-minutes" className="mt-2 text-4xl font-semibold tracking-tight">
              {t('minutesValue', { count: minutes })}
            </p>
          </div>
        </div>
      ) : !failed ? (
        <p className="mt-6">{t('loading')}</p>
      ) : null}
      {data && data.sessions.length === 0 ? (
        <Scene image="paddle" data-testid="empty-dashboard" className="mt-8 px-6 py-10 sm:px-8">
          <h2 className="text-2xl font-semibold tracking-tight">{t('emptyTitle')}</h2>
          <p className="mt-3 max-w-xl leading-7">{t('emptyBody')}</p>
          <Link data-testid="start-first-session" to="/" className="mt-6 inline-flex min-h-12 items-center rounded-2xl bg-accent px-5 font-semibold text-white shadow-[0_10px_24px_rgb(15_118_110/0.22)]">
            {t('startFirstSession')}
          </Link>
        </Scene>
      ) : null}
      <ul className="mt-6 grid gap-3">
        {data?.sessions.map((session) => {
          const statusKey = {
            draft: 'statusDraft',
            recording: 'statusRecording',
            saving: 'statusSaving',
            ready: 'statusReady',
            failed: 'statusFailed',
          } as const;
          const unavailable =
            session.status === 'failed'
              ? t('failedNoVideo')
              : session.status === 'recording'
                ? t('recordingNoVideo')
                : session.status === 'saving'
                  ? t('savingNoVideo')
                  : session.videoSize
                    ? ''
                    : t('missingVideo');
          return (
            <li key={session.token} data-testid="session-card" className="panel min-w-0 p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="font-semibold">
                    {t('courtNumber', { n: courtNumberFromId(session.courtId) })} · {t(session.mode)}
                  </p>
                  <p className="mt-1 text-sm">
                    {session.teams.A.join(', ')} {t('versus')} {session.teams.B.join(', ')}
                  </p>
                  <p className="mt-1 text-sm text-muted">
                    {t('when')}: {formatWhen(session.createdAt, lang)}
                    {session.durationMs != null ? ` · ${formatSpoken(session.durationMs, lang)}` : ''}
                    {' · '}
                    {session.score.A}-{session.score.B}
                  </p>
                  <p className="mt-2 text-sm font-semibold">
                    {t('status')}: {t(statusKey[session.status])}
                  </p>
                  {unavailable ? <p className="mt-1 text-sm">{unavailable}</p> : null}
                  <div className="mt-2 text-sm" data-testid="session-contact">
                    {session.contact ? (
                      <>
                        <p className="font-semibold">{session.contact.playerNames}</p>
                        <p>
                          {channelName(session.contact.channel)} · {session.contact.phone}
                        </p>
                        <p>{session.contact.marketing ? t('marketingAgreed') : t('marketingDeclined')}</p>
                        {session.contact.optedOut ? <p>{t('optedOut')}</p> : null}
                      </>
                    ) : (
                      <p>{t('noContactSaved')}</p>
                    )}
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  {session.status === 'ready' ? (
                    <Link to={`/watch/${session.token}`} className="inline-flex min-h-12 items-center rounded-2xl bg-accent px-4 font-semibold text-white shadow-[0_10px_24px_rgb(15_118_110/0.22)]">
                      {t('openVideo')}
                    </Link>
                  ) : null}
                  <Button variant="danger" data-testid={`delete-${session.token}`} onClick={() => setPending(session)}>
                    {t('deleteSession')}
                  </Button>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
      {facility ? (
        <section className="mt-10" data-testid="facility-demo">
          <Scene image="court" className="px-6 py-8 sm:px-8">
            <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">{facility.name}</h2>
            <p className="mt-3 max-w-2xl leading-7">{t('facilityDemo')}</p>
            <Link
              to="/facility/setup"
              data-testid="open-club-setup"
              className="mt-6 inline-flex min-h-12 items-center rounded-2xl bg-accent px-5 font-semibold text-white shadow-[0_10px_24px_rgb(15_118_110/0.22)]"
            >
              {t('setupOpen')}
            </Link>
          </Scene>
          <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div className="panel p-5">
              <p className="text-sm text-muted">{t('activeSessions')}</p>
              <p className="mt-2 text-3xl font-semibold">{facility.activeSessions}</p>
            </div>
            <div className="panel p-5">
              <p className="text-sm text-muted">{t('completedMatches')}</p>
              <p className="mt-2 text-3xl font-semibold">{facility.completedMatches}</p>
            </div>
            <div className="panel p-5">
              <p className="text-sm text-muted">{t('playerList')}</p>
              <p className="mt-2 text-3xl font-semibold">{facility.players}</p>
            </div>
            <div className="panel p-5">
              <p className="text-sm text-muted">{t('participation')}</p>
              <p className="mt-2 text-3xl font-semibold">{facility.participation}</p>
            </div>
          </div>
          <p className="mt-4 text-sm text-muted">
            {t('recordingTime')}: {formatSpoken(facility.recordingTimeMs, lang)}
          </p>
          <ul className="mt-4 grid gap-3 sm:grid-cols-2">
            {facility.courts.map((court) => (
              <li key={court.id} className="panel p-4" data-testid={`facility-court-${court.id}`}>
                <p className="font-semibold">{t('courtNumber', { n: court.number })}</p>
                <p className="mt-1 text-sm">{court.records ? t('recordsHere') : t('simulatedCourt')}</p>
                <p className="mt-1 text-sm text-muted">{activityLabel(court.activity, t)}</p>
                <Link to={`/court/${court.id}`} className="mt-3 inline-flex min-h-10 items-center font-semibold text-accent-dark">
                  {t('openCourt')}
                </Link>
              </li>
            ))}
          </ul>
          <form
            className="mt-6 grid max-w-xl gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              void (async () => {
                try {
                  await resetDemoData();
                  setResetPhrase('');
                  setMessage(t('resetDone'));
                  await load();
                } catch {
                  setMessage(t('errorGeneric'));
                }
              })();
            }}
          >
            <p className="text-sm leading-6">{t('resetDemoHelp')}</p>
            <input
              value={resetPhrase}
              onChange={(event) => setResetPhrase(event.target.value)}
              className="min-h-12 rounded-xl border border-line bg-white px-3"
              data-testid="reset-phrase"
              aria-label={t('resetDemo')}
            />
            <Button type="submit" variant="danger" disabled={resetPhrase !== 'RESET DEMO'} data-testid="reset-demo">
              {t('resetDemo')}
            </Button>
          </form>
        </section>
      ) : null}
      {data ? (
        <section className="mt-10" data-testid="people-section">
          <Scene image="net" className="px-6 py-8 sm:px-8">
            <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">{t('peopleTitle')}</h2>
            <p className="mt-3 max-w-2xl leading-7">{t('peopleLead')}</p>
          </Scene>
          <p className="mt-4 max-w-2xl text-sm text-muted">{t('demoBalanceHelp')}</p>
          {data.people.length === 0 ? (
            <p className="mt-4" data-testid="people-empty">
              {t('peopleEmpty')}
            </p>
          ) : (
            <ul className="mt-4 grid gap-3">
              {data.people.map((person) => (
                <li key={person.id} data-testid="person-card" className="panel min-w-0 p-5">
                  <p className="font-semibold" data-testid="person-name">
                    {person.name}
                  </p>
                  <p className="mt-1 text-sm">
                    {channelName(person.channel)} · {person.phone}
                  </p>
                  <p className="mt-1 text-sm">{t('videosValue', { count: person.videoCount })}</p>
                  <p className="mt-1 text-sm" data-testid="person-balance">
                    {t('demoBalance')}: {person.balance}
                  </p>
                  <Link
                    to={`/people/${person.id}`}
                    data-testid={`open-person-${person.id}`}
                    className="mt-4 inline-flex min-h-12 items-center rounded-2xl bg-accent px-4 font-semibold text-white shadow-[0_10px_24px_rgb(15_118_110/0.22)]"
                  >
                    {t('openPerson')}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}
      <Dialog open={Boolean(pending)} title={t('deleteTitle')} testId="delete-dialog">
        <p>{t('deleteBody')}</p>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button data-testid="confirm-delete" variant="danger" onClick={() => void confirmDelete()}>
            {t('confirmDelete')}
          </Button>
          <Button data-testid="cancel-delete" variant="secondary" onClick={() => setPending(null)}>
            {t('cancel')}
          </Button>
        </div>
      </Dialog>
    </section>
  );
}
