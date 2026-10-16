import { useEffect, useRef, useState } from 'react';
import { useBlocker, useNavigate, useParams } from 'react-router-dom';
import { ApiError, beatStation, failSession, getLive, getSession, startSession, syncLive, uploadVideo, type LiveAction } from '../api';
import { useConfig } from '../components/Config';
import { LastPointCallout, RallyPlayback } from '../components/LastPointReplay';
import { ScorekeeperCard } from '../components/ScorekeeperCard';
import { TapBoard } from '../components/TapBoard';
import { Button, Dialog, Notice, Scene } from '../components/Ui';
import { useI18n } from '../i18n/context';
import { courtNumberFromId, formatClock } from '../i18n/format';
import { assignedEnds, assignEnds, moveCamera, type EndAssignment } from '../lib/cameras';
import { endForTeam, GAME_TO, lastPointWindow, sidesAt, type LastPointWindow } from '../lib/match';
import {
  clearLiveTake,
  clearStationSession,
  getLiveTake,
  isStationSession,
  recordPageStillMounted,
  retainRecordPage,
} from '../lib/liveTake';
import { cameraBlockReason, cameraFailure, chooseMime, createRecorder, extensionFor, flushRecorder, openAssignedCameras, openCamera, stopStream, videoInputs, withDuration, type CameraBlock, type CameraFailure, type RecorderTake } from '../lib/media';
import { buildRallyClip, type RallyClip } from '../lib/replayClip';
import { canMarkHighlight, scoreTap, tally, undoLast, type HighlightMark, type ScoreEvent, type TapSide } from '../lib/score';
import type { EndId, PublicSession } from '../types';

type Phase = 'loading' | 'idle' | 'requesting' | 'preview' | 'recording' | 'finalizing' | 'saving' | 'save_failed' | 'interrupted' | 'missing';

type SavedBlob = { end: EndId; blob: Blob };

type LiveReplay =
  | { kind: 'missing'; range: LastPointWindow; end: EndId | null }
  | ({ kind: 'video'; range: LastPointWindow; end: EndId | null } & RallyClip);

function storedScoreMode(token: string): 'device' | 'taps' {
  try {
    return sessionStorage.getItem(`playback-score:${token}`) === 'taps' ? 'taps' : 'device';
  } catch {
    return 'device';
  }
}

const emptyAssignment: EndAssignment = { 1: null, 2: null };

export function RecordPage() {
  const { token = '' } = useParams();
  const { t } = useI18n();
  const { config } = useConfig();
  const navigate = useNavigate();
  const video1Ref = useRef<HTMLVideoElement>(null);
  const video2Ref = useRef<HTMLVideoElement>(null);
  const slotsRef = useRef<{ 1: MediaStream | null; 2: MediaStream | null }>({ 1: null, 2: null });
  const recordersRef = useRef<RecorderTake[]>([]);
  const startedAtRef = useRef<number | null>(null);
  const timerRef = useRef<number | null>(null);
  const scoresRef = useRef<ScoreEvent[]>([]);
  const highlightsRef = useRef<HighlightMark[]>([]);
  const switchesRef = useRef<{ offsetMs: number }[]>([]);
  const blobsRef = useRef<SavedBlob[]>([]);
  const guardRef = useRef(false);
  const durationRef = useRef(0);
  const stoppingRef = useRef(false);
  const stopRef = useRef<(reason: 'user' | 'limit') => Promise<void>>(async () => {});

  const [session, setSession] = useState<PublicSession | null>(null);
  const [phase, setPhase] = useState<Phase>(() => (getLiveTake()?.token === token ? 'recording' : 'loading'));
  const [includeMic, setIncludeMic] = useState(false);
  const [micState, setMicState] = useState<'on' | 'off' | 'fallback'>(() => (getLiveTake()?.token === token ? getLiveTake()!.mic : 'off'));
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>(() => (getLiveTake()?.token === token ? getLiveTake()!.cameras : []));
  const [assignment, setAssignment] = useState<EndAssignment>(() => (getLiveTake()?.token === token ? getLiveTake()!.assignment : emptyAssignment));
  const startingEnds = { A: 1 as const, B: 2 as const };
  const [elapsed, setElapsed] = useState(0);
  const [scores, setScores] = useState<ScoreEvent[]>([]);
  const [ack, setAck] = useState('');
  const [cameraMessage, setCameraMessage] = useState('');
  const [cameraHelp, setCameraHelp] = useState('');
  const [failure, setFailure] = useState<CameraFailure | ''>('');
  const [tracksReleased, setTracksReleased] = useState(false);
  const [guard, setGuard] = useState(() => getLiveTake()?.token === token);
  const [scoreMode] = useState<'device' | 'taps'>(() => storedScoreMode(token));
  const [flashSide, setFlashSide] = useState<TapSide | null>(null);
  const [liveReplay, setLiveReplay] = useState<LiveReplay | null>(null);
  const [replayBusy, setReplayBusy] = useState(false);
  const [replayNote, setReplayNote] = useState('');
  const phaseRef = useRef<Phase>(phase);
  const scoreModeRef = useRef(scoreMode);
  const lastTapAtRef = useRef<number | null>(null);
  const replayRequest = useRef(0);
  const replayAnchor = useRef<HTMLDivElement>(null);
  const applyRemoteRef = useRef<(inbox: LiveAction[]) => string[]>(() => []);
  const pullingRef = useRef(false);
  const limitRef = useRef(0);
  const live = getLiveTake();
  if (live?.token === token && recordersRef.current.length === 0) {
    slotsRef.current = live.slots;
    recordersRef.current = live.takes;
    startedAtRef.current = live.startedAt;
    guardRef.current = true;
  }

  const limitMs = (config?.recordingLimitSeconds ?? 600) * 1000;
  phaseRef.current = phase;
  scoreModeRef.current = scoreMode;
  limitRef.current = limitMs;
  const score = tally(scores);
  const blocker = useBlocker(() => guardRef.current);
  const showSlots = phase === 'preview' || phase === 'recording';

  function elapsedNow() {
    if (startedAtRef.current == null) return 0;
    return Math.max(0, Math.round(performance.now() - startedAtRef.current));
  }

  function explain(error: unknown) {
    if (error instanceof ApiError) {
      if (error.code === 'network') return t('networkError');
      if (error.code === 'upload_too_large') return t('uploadTooLarge', { limit: config?.uploadLimitMb ?? 512 });
      if (error.code === 'invalid_media') return t('uploadInvalid');
      if (error.code === 'empty_media') return t('emptyMedia');
    }
    return t('errorGeneric');
  }

  function pageCameraBlock(): CameraBlock | null {
    return cameraBlockReason({
      protocol: window.location.protocol,
      hostname: window.location.hostname,
      userAgent: navigator.userAgent,
    });
  }

  function showBlockedCamera(block: CameraBlock) {
    setFailure(block === 'phone' ? 'phone' : 'insecure');
    if (block === 'phone') {
      setCameraMessage(t('phoneRecordingTitle'));
      setCameraHelp(t('phoneRecordingHelp'));
      return;
    }
    setCameraMessage(t('insecureOrigin'));
    setCameraHelp(t('insecureOriginHelp'));
  }

  function showCameraError(error: unknown) {
    const block = pageCameraBlock();
    if (block) {
      showBlockedCamera(block);
      return;
    }
    const kind = cameraFailure(error);
    setFailure(kind);
    const title = {
      permission: t('permissionDenied'),
      missing: t('noCamera'),
      busy: t('cameraInUse'),
      insecure: t('insecureOrigin'),
      phone: t('phoneRecordingTitle'),
      generic: t('cameraErrorGeneric'),
    }[kind];
    const help = {
      permission: t('permissionDeniedHelp'),
      missing: t('noCameraHelp'),
      busy: t('cameraInUseHelp'),
      insecure: t('insecureOriginHelp'),
      phone: t('phoneRecordingHelp'),
      generic: t('unsupportedBrowserHelp'),
    }[kind];
    setCameraMessage(title);
    setCameraHelp(help);
  }

  function stopSlots() {
    stopStream(slotsRef.current[1]);
    stopStream(slotsRef.current[2]);
    slotsRef.current = { 1: null, 2: null };
    if (video1Ref.current) video1Ref.current.srcObject = null;
    if (video2Ref.current) video2Ref.current.srcObject = null;
  }

  function stopRecorders() {
    for (const take of recordersRef.current) {
      if (take.recorder.state !== 'inactive') take.recorder.stop();
    }
  }

  async function enableCamera(requested?: EndAssignment) {
    const block = pageCameraBlock();
    if (block) {
      showBlockedCamera(block);
      return;
    }
    setCameraMessage('');
    setCameraHelp('');
    setFailure('');
    if (!chooseMime(includeMic) && !chooseMime(false)) {
      setCameraMessage(t('unsupportedBrowser'));
      setCameraHelp(t('unsupportedBrowserHelp'));
      return;
    }
    setPhase('requesting');
    try {
      const explicit = requested !== undefined;
      let next = requested ?? assignment;
      if (!next[1] && !next[2]) {
        if (explicit) {
          stopSlots();
          setPhase('preview');
          return;
        }
        const probe = await openCamera(false, '');
        stopStream(probe.stream);
        const devices = await videoInputs();
        setCameras(devices);
        if (devices.length === 0) throw new DOMException('No camera', 'NotFoundError');
        next = assignEnds(devices.map((device) => device.deviceId));
        setAssignment(next);
      } else {
        const devices = await videoInputs();
        if (devices.length) setCameras(devices);
      }
      stopSlots();
      const opened = await openAssignedCameras(includeMic, next);
      if (opened.streams.length === 0) throw new DOMException('No camera', 'NotFoundError');
      for (const item of opened.streams) slotsRef.current[item.end] = item.stream;
      const withAudio = opened.streams.some((item) => item.stream.getAudioTracks().length > 0);
      if (!chooseMime(withAudio) && !chooseMime(false)) throw new Error('unsupported');
      setMicState(opened.mic);
      setPhase('preview');
      if (opened.mic === 'fallback') setAck(t('micDeniedVideoOnly'));
    } catch (error) {
      stopSlots();
      setPhase('idle');
      showCameraError(error);
    }
  }

  function testPreview() {
    const videos = [video1Ref.current, video2Ref.current];
    const good = videos.some((video) => video && video.srcObject && video.readyState >= 2 && video.videoWidth > 0);
    setAck(good ? t('previewGood') : t('previewBad'));
  }

  function startTake(end: EndId, stream: MediaStream): RecorderTake {
    return createRecorder(end, stream, () => performance.now() - (startedAtRef.current ?? performance.now()));
  }

  async function beginRecording() {
    const active = assignedEnds(assignment).filter((end) => slotsRef.current[end]);
    if (active.length === 0 || phase !== 'preview') return;
    setAck('');
    try {
      await startSession(token, startingEnds);
    } catch (error) {
      setAck(explain(error));
      return;
    }
    try {
      startedAtRef.current = performance.now();
      const takes = active.map((end) => startTake(end, slotsRef.current[end]!));
      recordersRef.current = takes;
      setElapsed(0);
      stoppingRef.current = false;
      guardRef.current = true;
      setGuard(true);
      setPhase('recording');
      if (timerRef.current) window.clearInterval(timerRef.current);
      timerRef.current = window.setInterval(() => {
        const ms = elapsedNow();
        setElapsed(ms);
        if (ms >= limitMs) void stopRef.current('limit');
      }, 200);
    } catch (error) {
      stopRecorders();
      setAck(explain(error));
      await failSession(token).catch(() => undefined);
    }
  }

  async function finishRecording(reason: 'user' | 'limit') {
    if (stoppingRef.current) return;
    const takes = recordersRef.current;
    if (takes.length === 0 || takes.every((take) => take.recorder.state === 'inactive')) return;
    stoppingRef.current = true;
    setPhase('finalizing');
    if (reason === 'limit') setAck(t('limitReached'));
    const durationMs = elapsedNow();
    durationRef.current = durationMs;
    if (timerRef.current) window.clearInterval(timerRef.current);
    for (const take of takes) {
      if (take.recorder.state === 'recording') take.recorder.stop();
    }
    const saved: SavedBlob[] = [];
    for (const take of takes) {
      const blob = await take.stopped;
      if (blob && blob.size >= 32) saved.push({ end: take.end, blob });
    }
    stopSlots();
    clearLiveTake();
    setTracksReleased(true);
    if (saved.length === 0) {
      setPhase('save_failed');
      setAck(t('emptyMedia'));
      stoppingRef.current = false;
      return;
    }
    blobsRef.current = saved;
    await saveBlobs(saved, durationMs);
  }

  async function saveBlobs(items: SavedBlob[], durationMs: number) {
    setPhase('saving');
    setAck(t('uploading'));
    switchesRef.current = [];
    const expected = items.map((item) => item.end);
    try {
      const fixed: SavedBlob[] = [];
      for (const item of items) {
        const blob = await withDuration(item.blob, durationMs);
        fixed.push({ end: item.end, blob });
        await uploadVideo(token, blob, {
          durationMs,
          scores: scoresRef.current,
          highlights: highlightsRef.current,
          switches: [],
          cameraEnd: item.end,
          expectedEnds: expected,
        });
      }
      blobsRef.current = fixed;
      guardRef.current = false;
      setGuard(false);
      navigate(`/watch/${token}`);
    } catch (error) {
      setPhase('save_failed');
      setAck(explain(error));
      stoppingRef.current = false;
    }
  }

  stopRef.current = finishRecording;

  applyRemoteRef.current = (inbox) => {
    if (inbox.length === 0 || phaseRef.current !== 'recording') return [];
    let scores = scoresRef.current;
    for (const action of inbox) {
      if (action.action === 'point') scores = [...scores, { team: action.team, offsetMs: elapsedNow() }];
      else if (action.action === 'undo') scores = undoLast(scores);
    }
    syncScore(scores);
    return inbox.map((action) => action.id);
  };

  function syncScore(next: ScoreEvent[]) {
    scoresRef.current = next;
    setScores(next);
    switchesRef.current = [];
  }

  function tapSide(side: TapSide) {
    if (phase !== 'recording') return;
    const now = Date.now();
    const sides = sidesAt(startingEnds, [], elapsedNow());
    const current = { scores: scoresRef.current, lastTapAt: lastTapAtRef.current };
    const next = scoreTap(current, side, sides, now, elapsedNow());
    if (next === current) return;
    lastTapAtRef.current = next.lastTapAt;
    syncScore(next.scores);
    setFlashSide(side);
    window.setTimeout(() => setFlashSide((currentSide) => (currentSide === side ? null : currentSide)), 180);
  }

  function addPoint(team: 'A' | 'B') {
    if (phase !== 'recording') return;
    syncScore([...scoresRef.current, { team, offsetMs: elapsedNow() }]);
    setAck(t('pointAdded', { team }));
  }

  function undoPoint() {
    if (phase !== 'recording' || scoresRef.current.length === 0) return;
    syncScore(undoLast(scoresRef.current));
    setAck(t('pointUndone'));
  }

  async function watchLastPoint() {
    if (phaseRef.current !== 'recording') return;
    const range = lastPointWindow(scoresRef.current);
    if (!range) return;
    const request = replayRequest.current + 1;
    replayRequest.current = request;
    const end = endForTeam(range.scoringTeam, startingEnds, [], range.pointOffsetMs);
    const take = recordersRef.current.find((item) => item.end === end);
    if (!take || take.recorder.state !== 'recording') {
      setReplayNote('');
      setLiveReplay({ kind: 'missing', range, end });
      return;
    }
    setReplayBusy(true);
    setReplayNote('');
    try {
      await flushRecorder(take.recorder);
      if (replayRequest.current !== request) return;
      const clip = await buildRallyClip(take.chunks.slice(), range.playStartMs, range.endMs, take.mime);
      if (replayRequest.current !== request) return;
      if (!clip) {
        setReplayNote(t('lastPointNotReady'));
        return;
      }
      setLiveReplay({ kind: 'video', range, end, ...clip });
    } finally {
      if (replayRequest.current === request) setReplayBusy(false);
    }
  }

  function closeLastPoint() {
    replayRequest.current += 1;
    setLiveReplay(null);
    setReplayNote('');
    setReplayBusy(false);
  }

  function markHighlight() {
    if (phase !== 'recording') return;
    const offsetMs = elapsedNow();
    if (!canMarkHighlight(highlightsRef.current, offsetMs)) {
      setAck(t('highlightTooSoon'));
      return;
    }
    highlightsRef.current = [...highlightsRef.current, { offsetMs }];
    setAck(t('highlightMarked', { time: formatClock(offsetMs) }));
  }

  function downloadLocal() {
    for (const item of blobsRef.current) {
      const url = URL.createObjectURL(item.blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `playback-unsaved-end${item.end}.${extensionFor(item.blob.type)}`;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 4000);
    }
  }

  useEffect(() => {
    document.title = `${t('startRecording')} · ${t('appName')}`;
  }, [t]);

  useEffect(() => {
    let cancelled = false;
    getSession(token)
      .then((loaded) => {
        if (cancelled) return;
        setSession(loaded);
        if (isStationSession(token) && getLiveTake()?.token === token) {
          const current = getLiveTake();
          if (current && recordersRef.current.length === 0) {
            slotsRef.current = current.slots;
            recordersRef.current = current.takes;
            startedAtRef.current = current.startedAt;
          }
          guardRef.current = true;
          setGuard(true);
          setPhase('recording');
          return;
        }
        if (loaded.status === 'ready') {
          navigate(`/watch/${token}`, { replace: true });
          return;
        }
        if (loaded.status === 'recording' || loaded.status === 'failed' || loaded.status === 'saving') {
          setPhase('interrupted');
          return;
        }
        setPhase('idle');
      })
      .catch(() => {
        if (!cancelled) setPhase('missing');
      });
    return () => {
      cancelled = true;
    };
  }, [navigate, token]);

  useEffect(() => {
    const onLeave = (event: BeforeUnloadEvent) => {
      if (!guardRef.current) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onLeave);
    return () => window.removeEventListener('beforeunload', onLeave);
  }, []);

  useEffect(() => {
    if (!liveReplay) return;
    replayAnchor.current?.scrollIntoView({ block: 'nearest' });
  }, [liveReplay]);

  useEffect(() => {
    if (phase !== 'recording' || scoreMode !== 'taps') return;
    let cancel = false;
    const tick = async () => {
      if (pullingRef.current || cancel) return;
      pullingRef.current = true;
      try {
        const live = await getLive(token);
        if (cancel) return;
        const applied = applyRemoteRef.current(live.inbox);
        await syncLive(token, { scores: scoresRef.current, switches: switchesRef.current, applied });
      } catch {
        /* the next pull retries */
      } finally {
        pullingRef.current = false;
      }
    };
    void tick();
    const id = window.setInterval(() => void tick(), 400);
    return () => {
      cancel = true;
      window.clearInterval(id);
    };
  }, [phase, scoreMode, token]);

  useEffect(() => {
    if (phase !== 'recording' || timerRef.current) return;
    timerRef.current = window.setInterval(() => {
      const ms = elapsedNow();
      setElapsed(ms);
      if (ms >= limitRef.current) void stopRef.current('limit');
    }, 200);
    return () => {
      if (timerRef.current) window.clearInterval(timerRef.current);
      timerRef.current = null;
    };
  }, [phase]);

  useEffect(() => {
    if (!isStationSession(token) || !session?.courtId) return;
    const courtId = session.courtId;
    let cancel = false;
    const send = async () => {
      const current = phaseRef.current;
      const reporting = current === 'saving' || current === 'finalizing' ? 'saving' : current === 'recording' ? 'recording' : 'armed';
      try {
        const status = await beatStation(courtId, {
          ready: true,
          phase: reporting,
          sessionToken: reporting === 'armed' ? null : token,
        });
        if (!cancel && status.command?.action === 'stop' && status.command.token === token && phaseRef.current === 'recording') {
          void stopRef.current('user');
        }
      } catch {
        /* the next heartbeat retries */
      }
    };
    void send();
    const id = window.setInterval(() => void send(), 1000);
    return () => {
      cancel = true;
      window.clearInterval(id);
    };
  }, [session?.courtId, token]);

  useEffect(() => {
    const release = retainRecordPage();
    return () => {
      release();
      if (timerRef.current) {
        window.clearInterval(timerRef.current);
        timerRef.current = null;
      }
      queueMicrotask(() => {
        if (recordPageStillMounted()) return;
        stopRecorders();
        stopSlots();
        clearLiveTake();
        clearStationSession();
      });
    };
  }, []);

  useEffect(() => {
    if (video1Ref.current) video1Ref.current.srcObject = slotsRef.current[1];
    if (video2Ref.current) video2Ref.current.srcObject = slotsRef.current[2];
  });

  if (phase === 'loading') return <p className="text-lg">{t('loadingSession')}</p>;
  if (phase === 'missing') {
    return (
      <Scene image="net" className="max-w-xl px-6 py-12 sm:px-10">
        <section>
          <h1 className="text-3xl font-semibold tracking-tight">{t('sessionNotFoundTitle')}</h1>
          <p className="mt-4 leading-7">{t('sessionNotFoundBody')}</p>
          <Button className="mt-8" onClick={() => navigate('/')}>{t('goHome')}</Button>
        </section>
      </Scene>
    );
  }

  const names = session ? [...session.teams.A, ...session.teams.B].join(', ') : '';
  const cameraBlock = pageCameraBlock();
  const blockedTitle = cameraBlock === 'phone' ? t('phoneRecordingTitle') : cameraBlock === 'insecure' ? t('insecureOrigin') : '';
  const blockedHelp = cameraBlock === 'phone' ? t('phoneRecordingHelp') : cameraBlock === 'insecure' ? t('insecureOriginHelp') : '';
  const recording = phase === 'recording';
  const teamOrder = ['A', 'B'] as const;

  return (
    <div data-testid="record-root" data-phase={phase} className="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,1.6fr)_22rem]">
      <section className="min-w-0">
        <Scene image="court" className="px-6 py-8 sm:px-8">
          <p className="text-sm font-semibold text-accent-dark">
            {session ? t('courtNumber', { n: courtNumberFromId(session.courtId) }) : t('court')}
          </p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">{recording ? t('recording') : t('cameraSection')}</h1>
          <p className="mt-3">{names}</p>
        </Scene>
        {showSlots ? (
          <Scene image="court" tone="dark" className={`mt-4 p-4 sm:p-5 ${liveReplay ? 'hidden' : ''}`}>
            <div className="grid gap-3 sm:grid-cols-2">
              {([1, 2] as const).map((end) => {
                const live = Boolean(assignment[end]);
                return (
                  <div key={end} className="min-w-0">
                    <p className="mb-2">
                      <span className="inline-flex rounded-full bg-stone-950/80 px-3 py-1 text-sm font-semibold text-white">{t('endLabel', { n: end })}</span>
                    </p>
                    {live ? (
                      <video
                        ref={end === 1 ? video1Ref : video2Ref}
                        data-testid={end === 1 ? 'preview' : 'preview-end-2'}
                        autoPlay
                        muted
                        playsInline
                        aria-label={recording ? t('recordingRegion') : t('previewRegion')}
                        className="aspect-video w-full rounded-2xl bg-black object-contain"
                      />
                    ) : (
                      <div
                        data-testid={`end-${end}-unavailable`}
                        className="flex aspect-video flex-col justify-end rounded-2xl bg-black px-4 py-3 text-sm text-white"
                      >
                        <p className="font-semibold">{t('endUnavailable')}</p>
                        <p className="mt-1 text-stone-200">{t('endUnavailableHelp')}</p>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </Scene>
        ) : liveReplay ? null : (
          <Scene image="court" tone="dark" className="mt-4 p-4 sm:p-5">
            <div className="relative overflow-hidden rounded-2xl bg-black">
              <div className="aspect-video w-full bg-black" />
              {phase === 'idle' || phase === 'interrupted' ? (
                <p className="absolute inset-x-0 bottom-0 bg-black/80 px-4 py-3 text-sm text-white">{t('cameraNotRequested')}</p>
              ) : null}
            </div>
          </Scene>
        )}
        {liveReplay ? (
          <div ref={replayAnchor} data-testid="last-point-replay" className="mt-4 grid gap-3">
            <LastPointCallout
              teams={{ A: session?.teams.A ?? [], B: session?.teams.B ?? [] }}
              scoringTeam={liveReplay.range.scoringTeam}
              closeLabel={t('backToLive')}
              onClose={closeLastPoint}
            />
            {liveReplay.kind === 'video' ? (
              <RallyPlayback
                blob={liveReplay.blob}
                seekSeconds={liveReplay.seekSeconds}
                stopSeconds={liveReplay.stopSeconds}
                absolute={liveReplay.absolute}
                label={t('lastPointVideoLabel')}
              />
            ) : (
              <p className="text-sm font-semibold" data-testid="end-missing" role="status">
                {t('endMissingPlayback')}
              </p>
            )}
          </div>
        ) : null}
        {scoreMode === 'taps' && (phase === 'preview' || recording) ? (
          <div className="mt-4 overflow-hidden rounded-3xl bg-[#050807] p-2 text-white" data-testid="laptop-tap-board">
            <TapBoard
              sides={sidesAt(startingEnds, [], elapsed)}
              teams={{ A: session?.teams.A ?? [], B: session?.teams.B ?? [] }}
              points={score}
              teamLabel={(team) => t(team === 'A' ? 'teamA' : 'teamB')}
              flash={flashSide}
              disabled={!recording}
              onTap={tapSide}
              leftLabel={t('tapLeft')}
              rightLabel={t('tapRight')}
            />
            <div className="flex justify-end px-1 py-1">
              <button type="button" data-testid="tap-undo" className="min-h-8 rounded-full px-3 text-xs font-semibold text-stone-300 disabled:opacity-40" disabled={!recording || scores.length === 0} onClick={undoPoint}>
                {scores.length === 0 ? t('undoUnavailable') : t('undoPoint')}
              </button>
            </div>
          </div>
        ) : null}
        <div className="mt-4 flex flex-wrap items-center gap-3" aria-live="polite">
          <p data-testid="rec-status" className="inline-flex items-center gap-2 rounded-full border border-line bg-card px-3 py-1 text-sm font-semibold">
            <span className={`h-2.5 w-2.5 rounded-full ${recording ? 'rec-dot bg-rose-600' : 'bg-stone-400'}`} aria-hidden="true" />
            {recording ? t('recording') : phase === 'preview' ? t('readyToRecord') : phase === 'saving' ? t('savingVideo') : phase === 'finalizing' ? t('finalizing') : t('cameraSection')}
          </p>
          <p data-testid="timer" data-ms={elapsed} className="text-2xl font-semibold tabular-nums">
            {formatClock(elapsed)}
          </p>
          <p className="text-sm text-muted">{t('elapsed', { time: formatClock(elapsed) })}</p>
        </div>
        <p className="mt-2 text-sm text-muted">{t('demoLimit', { time: formatClock(limitMs) })}</p>
        {showSlots ? (
          <p className="mt-2 text-sm text-muted">{cameras.length >= 2 ? t('twoCamerasNote') : t('oneCameraNote')}</p>
        ) : null}
        {recording ? (
          <div className="mt-3">
            <Notice tone="warn" title={t('closeTabWarning')}>
              {t('noRecovery')}
            </Notice>
          </div>
        ) : null}
        {tracksReleased ? (
          <p className="mt-3 text-sm" data-testid="tracks-released">
            {t('tracksReleased')}
          </p>
        ) : null}
        {ack ? (
          <p className="mt-3 text-sm font-medium" data-testid="status-message" role="status">
            {ack}
          </p>
        ) : null}
        {cameraBlock || cameraMessage ? (
          <div className="mt-3">
            <Notice tone={cameraBlock ? 'warn' : 'bad'} title={cameraBlock ? blockedTitle : cameraMessage}>
              {cameraBlock ? blockedHelp : cameraHelp}
            </Notice>
          </div>
        ) : null}
        {micState === 'on' ? <p className="mt-2 text-sm">{t('micOn')}</p> : null}
        {micState === 'off' && phase === 'preview' ? <p className="mt-2 text-sm">{t('micOff')}</p> : null}
      </section>

      <aside className="grid min-w-0 content-start gap-4">
        {phase === 'interrupted' ? (
          <Notice tone="warn" title={t('sessionInterruptedTitle')}>
            {t('sessionInterruptedBody')}
            <div className="mt-3 flex flex-col gap-2">
              <Button
                variant="secondary"
                onClick={() => {
                  void failSession(token).finally(() => navigate('/'));
                }}
              >
                {t('markFailed')}
              </Button>
              <Button onClick={() => navigate('/')}>{t('newSession')}</Button>
            </div>
          </Notice>
        ) : null}

        {!cameraBlock && (phase === 'idle' || phase === 'requesting' || failure) ? (
          <div className="panel p-5">
            <p className="text-sm">{t('consentRecorded')}</p>
            <p className="mt-2 text-sm text-muted">{t('cameraNotRequested')}</p>
            <label className="mt-4 flex items-start gap-3 text-sm">
              <input data-testid="include-mic" type="checkbox" checked={includeMic} onChange={(event) => setIncludeMic(event.target.checked)} className="mt-1 h-5 w-5" />
              <span>
                <span className="font-semibold">{t('includeMicrophone')}</span>
                <span className="mt-1 block text-muted">{t('audioOptionalNote')}</span>
              </span>
            </label>
            <Button data-testid="enable-camera" className="mt-4 w-full" onClick={() => void enableCamera()} disabled={phase === 'requesting'}>
              {phase === 'requesting' ? t('pleaseWait') : t('enableCamera')}
            </Button>
            {failure && failure !== 'insecure' && failure !== 'phone' ? (
              <Button data-testid="retry-permission" variant="secondary" className="mt-2 w-full" onClick={() => void enableCamera()}>
                {t('retryPermission')}
              </Button>
            ) : null}
          </div>
        ) : null}

        {phase === 'preview' || recording ? (
          <div className="panel p-5">
            <div className="mb-3 grid gap-3">
              {([1, 2] as const).map((end) => (
                <label key={end} className="block text-sm font-semibold">
                  {t('endLabel', { n: end })}
                  <span className="mt-1 block font-normal text-muted">{t('assignEnd')}</span>
                  <select
                    data-testid={`camera-end-${end}`}
                    className="mt-1 w-full max-w-full rounded-xl border border-line bg-white px-3 py-2"
                    value={assignment[end] ?? ''}
                    disabled={recording}
                    onChange={(event) => {
                      const next = moveCamera(assignment, end, event.target.value || null);
                      setAssignment(next);
                      if (!recording) void enableCamera(next);
                    }}
                  >
                    <option value="">{t('noCameraOnEnd')}</option>
                    {cameras.map((camera) => (
                      <option key={camera.deviceId} value={camera.deviceId}>
                        {camera.label || t('defaultCamera')}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
              <p className="text-sm text-muted">{t('noSecondAngle')}</p>
              {recording ? <p className="text-sm text-muted">{t('cannotChangeWhileRecording')}</p> : null}
            </div>
            <div className="mb-3 text-sm">
              <p>{t('teamStartsOnEnd', { team: 'A', n: startingEnds.A })}</p>
              <p>{t('teamStartsOnEnd', { team: 'B', n: startingEnds.B })}</p>
            </div>
            {phase === 'preview' ? (
              <div className="grid gap-2">
                <Button data-testid="test-preview" variant="secondary" onClick={testPreview}>
                  {t('testPreview')}
                </Button>
                <Button data-testid="start-recording" disabled={!assignment[1] && !assignment[2]} onClick={() => void beginRecording()}>
                  {t('startRecording')}
                </Button>
                <Button data-testid="retry-permission" variant="quiet" onClick={() => void enableCamera()}>
                  {t('retryPermission')}
                </Button>
              </div>
            ) : null}
            <div className="mt-4" aria-label={t('manualScore')}>
              <p className="text-sm font-semibold">{t('manualScore')}</p>
              <p className="mt-1 text-sm text-muted">{t('manualScoreNone')}</p>
              <p className="mt-1 text-sm text-muted">{t('gameToNone', { to: GAME_TO })}</p>
              {recording ? (
                <Button
                  data-testid="watch-last-point"
                  className="mt-3 w-full"
                  disabled={scores.length === 0 || replayBusy}
                  onClick={() => void watchLastPoint()}
                >
                  {scores.length === 0 ? t('lastPointNeedsScore') : replayBusy ? t('pleaseWait') : t('watchLastPoint')}
                </Button>
              ) : null}
              {replayNote ? (
                <p className="mt-2 text-sm" role="status">
                  {replayNote}
                </p>
              ) : null}
              {scoreMode === 'device' ? (
              <div className="mt-3 grid grid-cols-2 gap-3">
                {teamOrder.map((team) => (
                  <div key={team} className="rounded-2xl p-3 text-white" style={{ backgroundColor: team === 'A' ? '#b91c1c' : '#1d4ed8' }}>
                    <p className="text-sm font-semibold">{t(team === 'A' ? 'teamARed' : 'teamBBlue')}</p>
                    <p data-testid={`team-${team.toLowerCase()}-names`} className="mt-1 text-base">
                      {session?.teams[team].join(', ')}
                    </p>
                    <p data-testid={`team-${team.toLowerCase()}-end`} className="text-sm">
                      {t('teamNowOnEnd', { team, n: endForTeam(team, startingEnds, [], elapsed) })}
                    </p>
                    <p data-testid={`score-${team.toLowerCase()}-value`} className="mt-2 text-4xl font-semibold tabular-nums">
                      {score[team]}
                    </p>
                    <Button data-testid={`score-${team.toLowerCase()}`} className="mt-3 w-full" disabled={!recording} onClick={() => addPoint(team)}>
                      {t(team === 'A' ? 'addPointA' : 'addPointB')}
                    </Button>
                  </div>
                ))}
              </div>
              ) : (
                <p className="mt-3 text-sm text-muted">{t('scorekeeperHelp')}</p>
              )}
              <div className="mt-3 grid gap-2">
                {scoreMode === 'device' ? (
                <Button data-testid="undo-score" variant="secondary" disabled={!recording || scores.length === 0} onClick={undoPoint}>
                  {scores.length === 0 ? t('undoUnavailable') : t('undoPoint')}
                </Button>
                ) : null}
                <Button data-testid="mark-highlight" variant="secondary" disabled={!recording} onClick={markHighlight}>
                  {t('markHighlight')}
                </Button>
                <p className="text-sm text-muted">{t('highlightStarsOnly')}</p>
              </div>
              <p className="mt-2 text-sm text-muted">{t('notOfficialRules')}</p>
            </div>
            {scoreMode === 'taps' && config ? <ScorekeeperCard url={`${config.publicBaseUrl}/score/${token}`} token={token} /> : null}
            {recording ? (
              <Button data-testid="stop-save" variant="danger" className="mt-4 w-full" onClick={() => void finishRecording('user')}>
                {t('stopAndSave')}
              </Button>
            ) : null}
          </div>
        ) : null}

        {phase === 'finalizing' || phase === 'saving' ? (
          <Notice tone="info" title={phase === 'saving' ? t('savingVideo') : t('finalizing')}>
            {t('savingWait')}
          </Notice>
        ) : null}

        {phase === 'save_failed' ? (
          <Notice tone="bad" title={t('saveFailedTitle')}>
            {t('saveFailedBody')}
            <div className="mt-3 flex flex-col gap-2">
              <Button data-testid="retry-save" onClick={() => blobsRef.current.length && void saveBlobs(blobsRef.current, durationRef.current)}>
                {t('retrySave')}
              </Button>
              <Button data-testid="download-local" variant="secondary" onClick={downloadLocal}>
                {t('downloadLocally')}
              </Button>
              <p className="text-sm">{t('retryNoDuplicate')}</p>
            </div>
          </Notice>
        ) : null}
      </aside>

      <Dialog open={blocker.state === 'blocked'} title={t('leaveTitle')} testId="leave-dialog">
        <p>{t('leaveBody')}</p>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button
            onClick={() => {
              if (blocker.state === 'blocked') blocker.reset();
            }}
          >
            {t('stay')}
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              guardRef.current = false;
              setGuard(false);
              if (timerRef.current) window.clearInterval(timerRef.current);
              stopRecorders();
              stopSlots();
              clearLiveTake();
              clearStationSession();
              if (blocker.state === 'blocked') blocker.proceed();
            }}
          >
            {t('leave')}
          </Button>
        </div>
      </Dialog>
      <span className="sr-only">{guard ? t('recording') : ''}</span>
    </div>
  );
}
