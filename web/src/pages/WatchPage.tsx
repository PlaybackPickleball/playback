import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ApiError, getSession } from '../api';
import { matchForSession } from '../clubApi';
import { ContactScreen } from '../components/ContactScreen';
import { ReplayPanel } from '../components/ReplayPanel';
import { useConfig } from '../components/Config';
import { Button, CopyFallback, Notice, Scene, useCopy } from '../components/Ui';
import { useI18n } from '../i18n/context';
import { courtNumberFromId, formatBytes, formatSpoken, formatWhen, isLocalUrl } from '../i18n/format';
import type { PublicSession, PublicVideo } from '../types';

function downloadHref(clip: PublicVideo): string {
  return `${clip.url}${clip.url.includes('?') ? '&' : '?'}download=1`;
}

export function WatchPage() {
  const { token = '' } = useParams();
  const { t, lang } = useI18n();
  const { config } = useConfig();
  const [session, setSession] = useState<PublicSession | null>(null);
  const [missing, setMissing] = useState(false);
  const [skipped, setSkipped] = useState(false);
  const [matchId, setMatchId] = useState<string | null>(null);
  const { note, fallback, copy } = useCopy();

  useEffect(() => {
    document.title = `${t('watchTitle')} · ${t('appName')}`;
  }, [t]);

  useEffect(() => {
    let cancelled = false;
    getSession(token)
      .then((loaded) => {
        if (!cancelled) setSession(loaded);
      })
      .catch((error: unknown) => {
        if (!cancelled && (error instanceof ApiError || error instanceof Error)) setMissing(true);
      });
    matchForSession(token)
      .then((loaded) => {
        if (!cancelled) setMatchId(loaded.match?.id ?? null);
      })
      .catch(() => {
        if (!cancelled) setMatchId(null);
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  if (missing) {
    return (
      <Scene image="net" data-testid="not-found" className="mx-auto max-w-xl px-6 py-12 sm:px-10">
        <h1 className="text-3xl font-semibold tracking-tight">{t('sessionNotFoundTitle')}</h1>
        <p className="mt-4 leading-7">{t('sessionNotFoundBody')}</p>
        <Link to="/" className="mt-8 inline-flex min-h-12 items-center font-semibold text-accent-dark">
          {t('goHome')}
        </Link>
      </Scene>
    );
  }
  if (!session) return <p>{t('loadingSession')}</p>;

  const sessionUrl = config ? `${config.publicBaseUrl}/watch/${session.token}` : '';
  const local = sessionUrl ? isLocalUrl(sessionUrl) : false;
  const totalSize = session.videos.reduce((sum, clip) => sum + clip.size, 0);
  const statusKey = {
    draft: 'statusDraft',
    recording: 'statusRecording',
    saving: 'statusSaving',
    ready: 'statusReady',
    failed: 'statusFailed',
  } as const;

  const showContact = session.status === 'ready' && (!skipped || Boolean(session.contact));

  return (
    <article className="grid min-w-0 gap-8">
      {showContact ? (
        <ContactScreen session={session} onSaved={setSession} onSkip={() => setSkipped(true)} />
      ) : null}
      <div id="replay" className="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,1.5fr)_22rem]">
      <section className="min-w-0">
        <Scene image="court" className="px-6 py-8 sm:px-8">
          <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">{t('watchReplay')}</h1>
          <p className="mt-3">
            {t('courtNumber', { n: courtNumberFromId(session.courtId) })} · {t(session.mode)}
          </p>
        </Scene>
        {session.videos.length > 0 ? (
          <ReplayPanel session={session} />
        ) : (
          <div className="mt-4">
            <Notice tone="bad" title={t('missingVideo')} />
          </div>
        )}
      </section>
      <aside className="grid min-w-0 content-start gap-4">
        <dl className="panel min-w-0 p-5 text-sm [&_dd]:min-w-0 [&_dd]:break-words">
          <div className="grid gap-1 py-2 sm:grid-cols-[7.5rem_minmax(0,1fr)] sm:gap-2">
            <dt>{t('sessionDate')}</dt>
            <dd>{formatWhen(session.createdAt, lang)}</dd>
          </div>
          <div className="grid min-w-0 gap-1 py-2 sm:grid-cols-[7.5rem_minmax(0,1fr)] sm:gap-2">
            <dt>{t('duration')}</dt>
            <dd data-testid="session-duration">{session.durationMs != null ? formatSpoken(session.durationMs, lang) : '—'}</dd>
          </div>
          <div className="grid min-w-0 gap-1 py-2 sm:grid-cols-[7.5rem_minmax(0,1fr)] sm:gap-2">
            <dt>{t('players')}</dt>
            <dd>
              <p>
                <span className="font-semibold">{t('teamA')}</span> {session.teams.A.join(', ')}
              </p>
              <p>
                <span className="font-semibold">{t('teamB')}</span> {session.teams.B.join(', ')}
              </p>
            </dd>
          </div>
          <div className="grid min-w-0 gap-1 py-2 sm:grid-cols-[7.5rem_minmax(0,1fr)] sm:gap-2">
            <dt>{t('score')}</dt>
            <dd data-testid="session-score">
              {session.score.A}-{session.score.B}
            </dd>
          </div>
          <div className="grid min-w-0 gap-1 py-2 sm:grid-cols-[7.5rem_minmax(0,1fr)] sm:gap-2">
            <dt>{t('manualScore')}</dt>
            <dd>{t('notOfficialRules')}</dd>
          </div>
          <div className="grid min-w-0 gap-1 py-2 sm:grid-cols-[7.5rem_minmax(0,1fr)] sm:gap-2">
            <dt>{t('status')}</dt>
            <dd>{t(statusKey[session.status])}</dd>
          </div>
          <div className="grid min-w-0 gap-1 py-2 sm:grid-cols-[7.5rem_minmax(0,1fr)] sm:gap-2">
            <dt>{t('fileSize')}</dt>
            <dd>{totalSize > 0 ? formatBytes(totalSize) : '—'}</dd>
          </div>
        </dl>
        <Notice tone="info" title={t('manualNotAi')} />
        <Notice tone="info" title={t('storedLocally')} />
        <p className="text-sm text-muted">{t('fullFilesNote')}</p>
        {local ? (
          <div data-testid="local-only-notice">
            <Notice tone="warn" title={t('localOnlyTitle')}>
              {t('localOnlyNotice')} {t('notInternetShareable')}
            </Notice>
          </div>
        ) : null}
        <p className="text-sm text-muted">{t('tokenAccessNote')}</p>
        {session.videos.map((clip) => (
          <a
            key={clip.url}
            data-testid={clip.end === 2 ? 'download-end-2' : 'download-video'}
            className="inline-flex min-h-12 max-w-full items-center justify-center rounded-2xl bg-accent px-4 font-semibold text-white shadow-[0_10px_24px_rgb(15_118_110/0.22)]"
            href={downloadHref(clip)}
          >
            {clip.end == null ? t('downloadVideo') : t('downloadEnd', { n: clip.end })}
          </a>
        ))}
        <Button
          variant="secondary"
          data-testid="copy-link"
          disabled={!sessionUrl}
          onClick={() => void copy(sessionUrl)}
        >
          {t('copyLink')}
        </Button>
        {note ? <p role="status" className="text-sm">{note}</p> : null}
        {fallback ? <CopyFallback value={fallback} label={t('copyFallback')} /> : null}
        {matchId ? (
          <Link data-testid="enter-result" to={`/matches/${matchId}`} className="text-center text-sm font-semibold text-accent-dark">
            {t('enterResult')}
          </Link>
        ) : null}
        <Link data-testid="return-dashboard" to="/dashboard" className="text-center text-sm font-semibold text-accent-dark">
          {t('returnDashboard')}
        </Link>
        <Link data-testid="record-another" to="/" className="text-center text-sm font-semibold">
          {t('recordAnother')}
        </Link>
      </aside>
      </div>
    </article>
  );
}
