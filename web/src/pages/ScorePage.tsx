import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { ApiError, getLive, postLive, type LiveBoard } from '../api';
import { TapBoard } from '../components/TapBoard';
import { useI18n } from '../i18n/context';
import { sidesAt } from '../lib/match';
import { scoreTap, tally, undoLast, type ScoreEvent, type TapSide } from '../lib/score';

function liveId(): string {
  return `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

function eventNow(scores: ScoreEvent[], switches: { offsetMs: number }[]): number {
  return Math.max(0, ...scores.map((item) => item.offsetMs), ...switches.map((item) => item.offsetMs));
}

export function ScorePage() {
  const { token = '' } = useParams();
  const { t, lang, setLang } = useI18n();
  const [board, setBoard] = useState<LiveBoard | null>(null);
  const [missing, setMissing] = useState(false);
  const [scores, setScores] = useState<ScoreEvent[]>([]);
  const [flash, setFlash] = useState<TapSide | null>(null);
  const lastTapAt = useRef<number | null>(null);
  const quietUntil = useRef(0);
  const flashTimer = useRef(0);

  useEffect(() => {
    document.title = `${t('scorekeeperOpen')} · ${t('appName')}`;
  }, [t]);

  useEffect(() => {
    let cancel = false;
    const pull = async () => {
      try {
        const live = await getLive(token);
        if (cancel) return;
        setBoard(live);
        setMissing(false);
        if (Date.now() >= quietUntil.current) {
          setScores(live.scores);
        }
      } catch (error) {
        if (!cancel && error instanceof ApiError && error.status === 404) setMissing(true);
      }
    };
    void pull();
    const id = window.setInterval(() => void pull(), 400);
    return () => {
      cancel = true;
      window.clearInterval(id);
      window.clearTimeout(flashTimer.current);
    };
  }, [token]);

  const starting = { A: 1 as const, B: 2 as const };
  const atMs = eventNow(scores, []);
  const sides = sidesAt(starting, [], atMs);
  const points = tally(scores);
  const recording = Boolean(board?.recording);

  function flashSide(side: TapSide) {
    setFlash(side);
    window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setFlash(null), 180);
  }

  function tap(side: TapSide) {
    if (!recording || !board) return;
    const now = Date.now();
    const current = { scores, lastTapAt: lastTapAt.current };
    const next = scoreTap(current, side, sides, now, atMs);
    if (next === current) return;
    lastTapAt.current = next.lastTapAt;
    quietUntil.current = now + 1000;
    setScores(next.scores);
    flashSide(side);
    void postLive(token, { id: liveId(), action: 'point', team: sides[side] }).catch(() => undefined);
  }

  function undo() {
    if (!recording || scores.length === 0) return;
    quietUntil.current = Date.now() + 1000;
    setScores(undoLast(scores));
    void postLive(token, { id: liveId(), action: 'undo' }).catch(() => undefined);
  }

  if (missing) {
    return (
      <div className="tap-screen grid min-h-dvh place-items-center bg-[#050807] px-4 text-center text-white">
        <p className="text-lg">{t('sessionNotFoundTitle')}</p>
      </div>
    );
  }

  return (
    <div className="tap-screen fixed inset-0 flex w-full max-w-full flex-col overflow-hidden bg-[#050807] text-white">
      <header className="flex min-w-0 items-center justify-between gap-2 px-2 py-1">
        <p className="text-xs font-semibold tracking-tight">{t('appName')}</p>
        <div role="group" aria-label={t('languageLabel')} className="flex shrink-0 gap-1">
          <button type="button" aria-label={t('langEnglish')} className={`min-h-8 rounded-lg px-2 text-xs font-semibold ${lang === 'en' ? 'bg-white text-black' : 'text-white'}`} onClick={() => setLang('en')}>
            EN
          </button>
          <button type="button" aria-label={t('langVietnamese')} className={`min-h-8 rounded-lg px-2 text-xs font-semibold ${lang === 'vi' ? 'bg-white text-black' : 'text-white'}`} onClick={() => setLang('vi')}>
            VI
          </button>
        </div>
      </header>
      {!recording ? <p className="px-2 pb-1 text-center text-xs text-stone-300">{board ? t('scorekeeperWaiting') : t('loading')}</p> : null}
      <TapBoard
        fill
        sides={sides}
        teams={board?.teams ?? { A: [], B: [] }}
        points={points}
        teamLabel={(team) => t(team === 'A' ? 'teamA' : 'teamB')}
        flash={flash}
        disabled={!recording}
        onTap={tap}
        leftLabel={t('tapLeft')}
        rightLabel={t('tapRight')}
      />
      <footer className="flex min-w-0 justify-end px-2 py-1 pb-[max(0.25rem,env(safe-area-inset-bottom))]">
        <button
          type="button"
          data-testid="tap-undo"
          disabled={!recording || scores.length === 0}
          onClick={undo}
          className="max-w-full truncate rounded-full px-3 py-1 text-xs font-semibold text-stone-300 disabled:opacity-40"
        >
          {scores.length === 0 ? t('undoUnavailable') : t('undoPoint')}
        </button>
      </footer>
    </div>
  );
}
