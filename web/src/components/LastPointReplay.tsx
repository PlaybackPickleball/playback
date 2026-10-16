import { useEffect, useRef } from 'react';
import { useI18n } from '../i18n/context';
import { withDuration } from '../lib/media';
import { Button, Scene } from './Ui';

export function LastPointCallout({
  teams,
  scoringTeam,
  onClose,
  closeLabel,
}: {
  teams: { A: string[]; B: string[] };
  scoringTeam: 'A' | 'B';
  onClose: () => void;
  closeLabel: string;
}) {
  const { t } = useI18n();
  return (
    <div data-testid="last-point-banner" className="grid gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="inline-flex rounded-full bg-accent px-3 py-1 text-sm font-semibold text-white">{t('lastPointReplay')}</p>
        <Button variant="secondary" data-testid="close-last-point" onClick={onClose}>
          {closeLabel}
        </Button>
      </div>
      <p className="text-sm leading-6">{t('lastPointLookAgain')}</p>
      <div className="grid gap-2 sm:grid-cols-2">
        {(['A', 'B'] as const).map((team) => {
          const awarded = team === scoringTeam;
          return (
            <div
              key={team}
              data-testid={`last-point-team-${team.toLowerCase()}`}
              className={`min-w-0 rounded-2xl border px-4 py-3 ${awarded ? 'border-accent bg-white ring-2 ring-accent' : 'border-line bg-card'}`}
            >
              <p className="text-sm font-semibold">{t(team === 'A' ? 'teamA' : 'teamB')}</p>
              <p className="mt-1 text-lg">{teams[team].join(', ')}</p>
              {awarded ? (
                <p data-testid="last-point-awarded" className="mt-1 text-sm font-semibold text-accent-dark">
                  {t('lastPointAwarded', { team })}
                </p>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function waitFor(target: EventTarget, type: string): Promise<void> {
  return new Promise((resolve) => {
    target.addEventListener(type, () => resolve(), { once: true });
  });
}

export function RallyPlayback({
  blob,
  seekSeconds,
  stopSeconds,
  absolute,
  label,
}: {
  blob: Blob;
  seekSeconds: number;
  stopSeconds: number;
  absolute: boolean;
  label: string;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const holder = { url: '' };
    let cancel = false;
    const onTime = () => {
      if (video.currentTime + 0.08 >= stopSeconds) video.pause();
    };
    const start = async () => {
      const source = blob.type.includes('webm') ? await withDuration(blob, Math.round(stopSeconds * 1000)) : blob;
      if (cancel) return;
      const nextUrl = URL.createObjectURL(source);
      if (cancel) {
        URL.revokeObjectURL(nextUrl);
        return;
      }
      holder.url = nextUrl;
      video.src = nextUrl;
      await waitFor(video, 'loadedmetadata');
      if (cancel) return;
      const finite = Number.isFinite(video.duration) && video.duration > 0;
      let followStop = !absolute;
      if (seekSeconds > 0.05 && finite) {
        const target = Math.min(seekSeconds, Math.max(0, video.duration - 0.05));
        video.currentTime = target;
        await Promise.race([waitFor(video, 'seeked'), new Promise((resolve) => window.setTimeout(resolve, 500))]);
        const landed = Math.abs(video.currentTime - target) < 0.75;
        if (!landed) followStop = !absolute && video.currentTime < 0.5;
        else followStop = true;
      }
      if (cancel) return;
      if (followStop) video.addEventListener('timeupdate', onTime);
      await video.play().catch(() => undefined);
    };
    void start();
    return () => {
      cancel = true;
      video.removeEventListener('timeupdate', onTime);
      video.pause();
      video.removeAttribute('src');
      video.load();
      if (holder.url) URL.revokeObjectURL(holder.url);
    };
  }, [absolute, blob, seekSeconds, stopSeconds]);

  return (
    <Scene image="court" tone="dark" className="p-3 sm:p-5">
      <video
        ref={videoRef}
        data-testid="last-point-video"
        controls
        muted
        playsInline
        autoPlay
        aria-label={label}
        className="aspect-video w-full rounded-2xl bg-black object-contain"
      />
    </Scene>
  );
}
