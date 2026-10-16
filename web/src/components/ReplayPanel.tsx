import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n/context';
import { formatClock } from '../i18n/format';
import { Button, Scene } from './Ui';
import { LastPointCallout } from './LastPointReplay';
import { TeamRoster } from './TeamRoster';
import { endForTeam, lastPointWindow, type LastPointWindow } from '../lib/match';
import type { EndId, PublicSession, PublicVideo, RallyView } from '../types';

type ReplayMode = 'full' | 'rallies' | 'starred';

function queueFor(session: PublicSession, mode: ReplayMode): RallyView[] {
  if (mode === 'full') return [];
  const source = mode === 'starred' ? session.rallies.filter((rally) => rally.starred) : session.rallies;
  return source.filter((rally) => rally.endMs > rally.startMs);
}

export function ReplayPanel({ session }: { session: PublicSession }) {
  const { t } = useI18n();
  const videoRef = useRef<HTMLVideoElement>(null);
  const activeUrl = useRef('');
  const spanIndexRef = useRef(0);
  const legacy = session.videos.some((clip) => clip.end == null) || !session.startingEnds;
  const [mode, setMode] = useState<ReplayMode>('full');
  const [spanIndex, setSpanIndex] = useState(0);
  const [missingEnd, setMissingEnd] = useState<EndId | null>(null);
  const [playError, setPlayError] = useState(false);
  const [activeEnd, setActiveEnd] = useState<EndId | null>(session.videos.find((clip) => clip.end != null)?.end ?? null);
  const [review, setReview] = useState<LastPointWindow | null>(null);
  const queue = queueFor(session, mode);
  const lastPoint = lastPointWindow(session.scores);
  spanIndexRef.current = spanIndex;

  function clipFor(end: EndId | null): PublicVideo | undefined {
    if (legacy) return session.videos[0];
    if (end == null) return undefined;
    return session.videos.find((clip) => clip.end === end);
  }

  function endAt(rally: RallyView): EndId | null {
    if (legacy || !session.startingEnds) return session.videos[0]?.end ?? null;
    return endForTeam(rally.scoringTeam, { A: 1, B: 2 }, [], rally.pointOffsetMs);
  }

  function seek(clip: PublicVideo, seconds: number, autoplay: boolean) {
    const video = videoRef.current;
    if (!video) return;
    setMissingEnd(null);
    setPlayError(false);
    setActiveEnd(clip.end);
    const apply = () => {
      const max = Number.isFinite(video.duration) ? Math.max(0, video.duration - 0.05) : seconds;
      video.currentTime = Math.min(Math.max(0, seconds), max);
      if (autoplay) void video.play().catch(() => undefined);
    };
    if (activeUrl.current === clip.url && video.readyState >= 1) {
      apply();
      return;
    }
    activeUrl.current = clip.url;
    const onReady = () => apply();
    video.addEventListener('loadedmetadata', onReady, { once: true });
    video.src = clip.url;
  }

  function showRally(rally: RallyView, autoplay: boolean) {
    const end = endAt(rally);
    const clip = clipFor(end);
    if (!clip) {
      setMissingEnd(end);
      setActiveEnd(end);
      videoRef.current?.pause();
      return;
    }
    seek(clip, rally.startMs / 1000, autoplay);
  }

  useEffect(() => {
    if (mode !== 'full') return;
    const clip = (activeEnd != null ? clipFor(activeEnd) : undefined) ?? session.videos[0];
    const video = videoRef.current;
    if (!clip || !video || missingEnd) return;
    if (activeUrl.current === clip.url) return;
    activeUrl.current = clip.url;
    video.src = clip.url;
  }, [activeEnd, legacy, missingEnd, mode, session.startingEnds, session.videos]);

  useEffect(() => {
    if (mode === 'full') return;
    const rally = queue[spanIndex];
    if (!rally) return;
    showRally(rally, true);
    // The queue identity changes with mode. spanIndex selects the rally to open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, spanIndex, session.token]);

  useEffect(() => {
    if (mode === 'full') return;
    const timer = window.setInterval(() => {
      const video = videoRef.current;
      const rally = queue[spanIndexRef.current];
      if (!video || !rally || video.paused || missingEnd) return;
      if (video.currentTime * 1000 + 80 >= rally.endMs) {
        const next = spanIndexRef.current + 1;
        if (next >= queue.length) {
          video.pause();
          return;
        }
        setSpanIndex(next);
      }
    }, 120);
    return () => window.clearInterval(timer);
  }, [mode, missingEnd, queue]);

  useEffect(() => {
    if (!review) return;
    const timer = window.setInterval(() => {
      const video = videoRef.current;
      if (!video || video.paused || missingEnd) return;
      if (video.currentTime * 1000 + 80 >= review.endMs) video.pause();
    }, 120);
    return () => window.clearInterval(timer);
  }, [missingEnd, review]);

  function chooseMode(next: ReplayMode) {
    setReview(null);
    setMode(next);
    setSpanIndex(0);
    setMissingEnd(null);
  }

  function playLastPoint() {
    if (!lastPoint) return;
    setReview(lastPoint);
    setMode('full');
    setMissingEnd(null);
    const rally: RallyView = {
      index: Math.max(0, session.scores.length - 1),
      startMs: lastPoint.playStartMs,
      endMs: lastPoint.endMs,
      pointOffsetMs: lastPoint.pointOffsetMs,
      scoringTeam: lastPoint.scoringTeam,
      starred: false,
    };
    showRally(rally, true);
  }

  function chooseEnd(end: EndId) {
    setReview(null);
    setMode('full');
    setMissingEnd(null);
    const clip = clipFor(end);
    if (!clip) {
      setMissingEnd(end);
      setActiveEnd(end);
      videoRef.current?.pause();
      return;
    }
    const current = videoRef.current?.currentTime ?? 0;
    seek(clip, current, false);
  }

  const listed = mode === 'starred' ? session.rallies.filter((rally) => rally.starred) : session.rallies;

  return (
    <div>
      <div className="mt-4">
        <Button data-testid="watch-last-point" className="w-full sm:w-auto" disabled={lastPoint == null} onClick={playLastPoint}>
          {lastPoint ? t('watchLastPoint') : t('lastPointNeedsScore')}
        </Button>
      </div>
      <div className="mt-4 flex flex-wrap gap-2" role="group" aria-label={t('replayModeLabel')}>
        {([
          ['full', 'replayFull'],
          ['rallies', 'replayRallies'],
          ['starred', 'replayStarred'],
        ] as const).map(([value, key]) => (
          <button
            key={value}
            type="button"
            data-testid={`replay-${value}`}
            aria-pressed={mode === value}
            className={`min-h-12 max-w-full rounded-2xl px-4 font-semibold ${mode === value ? 'bg-accent text-white' : 'border border-line bg-card'}`}
            onClick={() => chooseMode(value)}
          >
            {t(key)}
          </button>
        ))}
      </div>
      {!legacy ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {([1, 2] as const).map((end) => {
            const clip = session.videos.find((item) => item.end === end);
            return (
              <button
                key={end}
                type="button"
                data-testid={`watch-end-${end}`}
                aria-pressed={activeEnd === end}
                className={`min-h-12 max-w-full rounded-2xl px-4 text-sm font-semibold ${activeEnd === end ? 'bg-stone-900 text-white' : 'border border-line bg-card'}`}
                onClick={() => chooseEnd(end)}
              >
                {t('endLabel', { n: end })}
                {clip ? '' : ` · ${t('noCameraOnEnd')}`}
              </button>
            );
          })}
        </div>
      ) : (
        <p className="mt-3 text-sm text-muted" data-testid="legacy-camera">
          {t('legacyCamera')}
        </p>
      )}
      <p className="mt-2 text-sm text-muted">{t('rallyTrimNote')}</p>
      {activeEnd != null ? (
        <p className="mt-1 text-sm font-semibold" data-testid="playing-end">
          {t('playingEnd', { n: activeEnd })}
        </p>
      ) : null}
      <div className="mt-4">
        <TeamRoster
          teams={session.teams}
          startingEnds={{ A: 1, B: 2 }}
          atMs={session.durationMs ?? 0}
          testId="replay-teams"
        />
      </div>
      {review ? (
        <div className="mt-4" data-testid="last-point-replay">
          <LastPointCallout
            teams={session.teams}
            scoringTeam={review.scoringTeam}
            closeLabel={t('closeLastPoint')}
            onClose={() => {
              setReview(null);
              videoRef.current?.pause();
            }}
          />
        </div>
      ) : null}
      {session.videos.length > 0 ? (
        <Scene image="court" tone="dark" className="mt-4 p-4 sm:p-5">
          <video
            ref={videoRef}
            data-testid="video-player"
            controls
            playsInline
            preload="metadata"
            aria-label={review ? t('lastPointVideoLabel') : t('videoPlayerLabel')}
            className="aspect-video w-full rounded-2xl bg-black object-contain"
            onError={() => setPlayError(true)}
          />
        </Scene>
      ) : null}
      {missingEnd ? (
        <p className="mt-3 text-sm font-semibold" data-testid="end-missing" role="status">
          {t('endMissingPlayback')}
        </p>
      ) : null}
      {playError ? (
        <p className="mt-3 text-sm">
          {t('playbackFailed')}{' '}
          <a className="font-semibold underline" href={`${session.videos[0]?.url ?? ''}${session.videos[0]?.url.includes('?') ? '&' : '?'}download=1`}>
            {t('tryDownload')}
          </a>
        </p>
      ) : null}
      <div className="mt-4">
        <h2 className="text-lg font-semibold">{t('highlights')}</h2>
        <p className="text-sm text-muted">{t('seekHint')}</p>
        {listed.length === 0 ? <p className="mt-2">{mode === 'starred' ? t('noStarredRallies') : t('noRallies')}</p> : null}
        <ol className="mt-3 grid gap-2">
          {listed.map((rally) => {
            const end = endAt(rally);
            return (
              <li key={rally.index}>
                <button
                  type="button"
                  data-testid={`rally-${rally.index}`}
                  data-start={rally.startMs}
                  data-end={end ?? ''}
                  data-starred={rally.starred ? '1' : '0'}
                  className="min-h-12 w-full max-w-full rounded-2xl border border-line bg-card px-4 text-left font-semibold"
                  onClick={() => {
                    setReview(null);
                    if (mode === 'full') {
                      showRally(rally, false);
                      return;
                    }
                    const index = queue.findIndex((item) => item.index === rally.index);
                    if (index < 0) return;
                    if (index === spanIndex) showRally(rally, true);
                    else setSpanIndex(index);
                  }}
                >
                  {t('rallyNumber', { n: rally.index + 1 })}
                  {end != null ? ` · ${t('endLabel', { n: end })}` : ''}
                  {` · ${t('followsTeam', { team: rally.scoringTeam })}`}
                  {rally.starred ? ` · ${t('starred')}` : ''}
                  {` · ${formatClock(rally.startMs)}`}
                </button>
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}
