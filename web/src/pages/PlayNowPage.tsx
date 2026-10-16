import { useEffect, useState } from 'react';
import { ApiError } from '../api';
import { listClubPlayers, type ClubPlayer } from '../clubApi';
import { PlayMatchCard } from '../components/PlayMatchCard';
import { Button, Card } from '../components/Ui';
import { useI18n } from '../i18n/context';
import type { MessageKey } from '../i18n/en';
import { formatRating } from '../i18n/format';
import {
  DEMO_FACILITY_OPTIONS,
  PLAY_SEARCH_RADIUS_KM,
  confirmedDoubles,
  facilityOptions,
  holdableSlots,
  isDemoId,
  isVenueDate,
  perPlayerVnd,
  priceView,
  queueEntryHere,
  queueEstimateView,
  venueDate,
  visibleBuildSlots,
  visibleJoinGames,
  visibleQueues,
} from '../lib/playNow';
import {
  createOpenMatch,
  joinOpenMatch,
  joinPlayQueue,
  listMyGames,
  listPlaySlots,
  myPlayQueue,
  requestSmartFill,
  searchPlay,
  type PlayMatch,
  type PlayQueueEntry,
  type PlaySearch,
  type PlaySlot,
} from '../playApi';

const PLAYER_KEY = 'playback-player-id';

const TABS = [
  { id: 'join_existing', label: 'pnJoinExisting' },
  { id: 'build_my_game', label: 'pnBuildGame' },
  { id: 'join_queue', label: 'pnJoinQueue' },
] as const;

type TabId = (typeof TABS)[number]['id'];

function errorKey(code: string): MessageKey {
  if (code === 'format_not_supported_yet') return 'pnDoublesOnly';
  if (code === 'player_required' || code === 'player_not_found') return 'pnPickPlayer';
  if (code === 'location_required') return 'pnNoLocation';
  if (code === 'invalid_radius') return 'pnBadRadius';
  if (code === 'level_outside_range') return 'pnLevelBlocked';
  if (code === 'player_overlap') return 'pnBusy';
  if (code === 'match_full') return 'pnFull';
  if (code === 'match_closed') return 'pnClosed';
  if (code === 'already_in_queue') return 'pnAlreadyQueue';
  if (code === 'approval_required') return 'pnWaitingApproval';
  if (code === 'not_a_fill_game') return 'pnNotFill';
  if (code === 'smart_fill_disabled') return 'pnFillOff';
  if (code === 'request_closed') return 'pnRequestClosed';
  if (code === 'already_joined') return 'pnAlreadyIn';
  return 'errorGeneric';
}

function waitKey(playerId: string) {
  return `playback-fill-wait:${playerId}`;
}

function readWait(playerId: string): Record<string, true> {
  try {
    const raw = sessionStorage.getItem(waitKey(playerId));
    const ids = raw ? (JSON.parse(raw) as unknown) : [];
    if (!Array.isArray(ids)) return {};
    return Object.fromEntries(ids.filter((id): id is string => typeof id === 'string').map((id) => [id, true as const]));
  } catch {
    return {};
  }
}

function writeWait(playerId: string, waiting: Record<string, true>) {
  try {
    sessionStorage.setItem(waitKey(playerId), JSON.stringify(Object.keys(waiting)));
  } catch {
    /* private mode */
  }
}

function whenLabel(start: string, courtNumber: number | null | undefined, distanceKm: number | undefined, court: (n: number) => string, away: (n: number) => string) {
  return [courtNumber != null ? court(courtNumber) : null, start.replace('T', ' '), distanceKm != null ? away(distanceKm) : null].filter(Boolean).join(' · ');
}

export function PlayNowPage() {
  const { t } = useI18n();
  const [players, setPlayers] = useState<ClubPlayer[]>([]);
  const [playerId, setPlayerId] = useState('');
  const [facilityId, setFacilityId] = useState<string>(DEMO_FACILITY_OPTIONS[0].id);
  const [date, setDate] = useState(venueDate);
  const [tab, setTab] = useState<TabId>('join_existing');
  const [board, setBoard] = useState<PlaySearch | null>(null);
  const [slots, setSlots] = useState<PlaySlot[]>([]);
  const [games, setGames] = useState<PlayMatch[]>([]);
  const [queueMine, setQueueMine] = useState<PlayQueueEntry | null>(null);
  const [waiting, setWaiting] = useState<Record<string, true>>({});
  const [flash, setFlash] = useState('');
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    void listClubPlayers()
      .then((list) => {
        const demo = list.players.filter((player) => player.demo);
        setPlayers(demo);
        let saved = '';
        try {
          saved = localStorage.getItem(PLAYER_KEY) ?? '';
        } catch {
          saved = '';
        }
        const next = demo.some((player) => player.id === saved) ? saved : (demo.find((player) => player.id === 'demo-minh')?.id ?? demo[0]?.id ?? '');
        setPlayerId(next);
      })
      .catch(() => setProblem(t('loadFailed')));
  }, [t]);

  useEffect(() => {
    if (!playerId) return;
    setWaiting(readWait(playerId));
  }, [playerId]);

  useEffect(() => {
    if (!playerId || !isVenueDate(date)) return;
    let cancelled = false;
    setBusy(true);
    void Promise.all([
      searchPlay(playerId, { format: 'doubles', radiusKm: PLAY_SEARCH_RADIUS_KM, start: { date } }),
      listPlaySlots(playerId, facilityId, date),
      listMyGames(playerId),
      myPlayQueue(playerId),
    ])
      .then(([nextBoard, nextSlots, mine, queue]) => {
        if (cancelled) return;
        setBoard(nextBoard);
        setSlots(nextSlots.slots);
        setGames(mine.games);
        setQueueMine(queue.entry);
        setProblem('');
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setBoard(null);
        setSlots([]);
        setProblem(t(errorKey(error instanceof ApiError ? error.code : '')));
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [playerId, facilityId, date, reload, t]);

  const you = players.find((player) => player.id === playerId);
  const facilities = facilityOptions(DEMO_FACILITY_OPTIONS, board?.categories.join_queue ?? []);
  const gamesHere = visibleJoinGames(board?.categories.join_existing ?? [], facilityId, date);
  const builds = visibleBuildSlots(board?.categories.build_my_game ?? [], facilityId, date);
  const queues = visibleQueues(board?.categories.join_queue ?? [], facilityId);
  const extraSlots = holdableSlots(slots, builds.map((row) => row.slot.id));
  const confirmed = confirmedDoubles(games, facilityId);
  const mineHere = queueEntryHere(queueMine, facilityId);

  function remember(id: string) {
    setPlayerId(id);
    setFlash('');
    try {
      localStorage.setItem(PLAYER_KEY, id);
    } catch {
      /* ignore */
    }
  }

  function markWaiting(matchId: string) {
    setWaiting((current) => {
      const next = { ...current, [matchId]: true as const };
      writeWait(playerId, next);
      return next;
    });
  }

  async function run(work: () => Promise<string>) {
    setBusy(true);
    setProblem('');
    try {
      setFlash(await work());
      setReload((value) => value + 1);
    } catch (error) {
      setFlash('');
      setProblem(t(errorKey(error instanceof ApiError ? error.code : '')));
    } finally {
      setBusy(false);
    }
  }

  function courtText(n: number) {
    return t('courtNumber', { n });
  }

  function awayText(n: number) {
    return t('pnAway', { n });
  }

  return (
    <div className="mx-auto grid w-full max-w-3xl gap-4" data-testid="play-now">
      <h1 className="text-3xl font-semibold">{t('pnTitle')}</h1>
      <p className="text-sm leading-6 text-muted">{t('pnHelp')}</p>
      <p className="text-sm leading-6 text-muted">{t('pnDisclaimer')}</p>
      <Card>
        <label className="text-sm font-semibold">
          {t('pnPlayingAs')}
          <span className="ml-2 rounded-full bg-line px-2 py-0.5 text-xs font-semibold">{t('pbDemoRow')}</span>
          <select data-testid="play-as" className="mt-1 min-h-11 w-full rounded-xl border border-line px-3" value={playerId} onChange={(event) => remember(event.target.value)}>
            {players.map((player) => (
              <option key={player.id} value={player.id}>
                {player.displayName} · {formatRating(player.rating)} · {t('pbDemoRow')}
              </option>
            ))}
          </select>
        </label>
        {you ? (
          <p className="mt-2 text-sm">
            {t('pbRating')}: <span className="tabular-nums">{formatRating(you.rating)}</span>
            <span className={`ml-2 ${you.provisional ? 'italic text-muted' : 'font-semibold'}`}>{you.provisional ? t('pbProvisional') : t('pbEstablished')}</span>
          </p>
        ) : null}
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <label className="text-sm font-semibold">
            {t('pnFacility')}
            <select data-testid="play-facility" className="mt-1 min-h-11 w-full rounded-xl border border-line px-3" value={facilityId} onChange={(event) => { setFacilityId(event.target.value); setFlash(''); }}>
              {facilities.map((facility) => (
                <option key={facility.id} value={facility.id}>
                  {facility.name}{facility.demo ? ` · ${t('pbDemoRow')}` : ''}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm font-semibold">
            {t('pnDate')}
            <input data-testid="play-date" className="mt-1 min-h-11 w-full rounded-xl border border-line px-3" type="date" value={date} onChange={(event) => { setDate(event.target.value); setFlash(''); }} />
          </label>
        </div>
        <Button className="mt-3" data-testid="play-search" disabled={busy || !playerId} onClick={() => setReload((value) => value + 1)}>
          {t('pnSearch')}
        </Button>
      </Card>
      {problem || flash ? <p className="text-sm" role="status">{problem || flash}</p> : null}
      {confirmed.length > 0 ? (
        <section className="grid gap-3">
          <h2 className="text-xl font-semibold">{t('pnConfirmed')}</h2>
          {confirmed.map((match) => (
            <PlayMatchCard
              key={match.id}
              facilityName={match.facilityName}
              demo={match.demo}
              whenLabel={whenLabel(match.start, match.courtNumber, undefined, courtText, awayText)}
              priceVnd={match.pricePerPlayerVnd}
              smartFill={match.smartFill}
              status={match.status}
              format={match.format}
              teamSplit={match.teamSplit}
              courtId={match.courtId}
              courtNumber={match.courtNumber}
            />
          ))}
        </section>
      ) : null}
      <div role="tablist" aria-label={t('pnTitle')} className="flex flex-wrap gap-2">
        {TABS.map((item) => (
          <button
            key={item.id}
            id={`play-tab-${item.id}`}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            aria-controls={`play-panel-${item.id}`}
            data-testid={`play-tab-${item.id}`}
            className={`min-h-11 rounded-xl px-4 text-sm font-semibold ${tab === item.id ? 'bg-ink text-white' : 'bg-paper'}`}
            onClick={() => setTab(item.id)}
          >
            {t(item.label)}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`play-panel-${tab}`} aria-labelledby={`play-tab-${tab}`} className="grid gap-3">
        {tab === 'join_existing' ? (
          gamesHere.length === 0 ? <p className="text-sm text-muted">{t('pnEmpty')}</p> : gamesHere.map((row) => {
            const fill = priceView(row.match.smartFill, row.match.pricePerPlayerVnd).kind === 'smart_fill' || Boolean(waiting[row.match.id]);
            return (
              <PlayMatchCard
                key={row.match.id}
                facilityName={row.match.facilityName}
                demo={row.match.demo}
                whenLabel={whenLabel(row.match.start, row.match.courtNumber, row.distanceKm, courtText, awayText)}
                seatsOpen={row.match.seatsOpen}
                priceVnd={row.match.pricePerPlayerVnd}
                smartFill={row.match.smartFill}
                levelRange={row.match.levelRange}
                people={row.match.participants.map((person) => ({ ...person, demo: isDemoId(person.playerId) }))}
                status={row.match.status}
                format={row.match.format}
                teamSplit={row.match.teamSplit}
                courtId={row.match.courtId}
                courtNumber={row.match.courtNumber}
                explanation={row.explanation}
              >
                {waiting[row.match.id] ? (
                  <p className="mt-3 text-sm font-semibold" data-testid="play-waiting">{t('pnWaitingApproval')}</p>
                ) : (
                  <Button
                    className="mt-3"
                    disabled={busy}
                    data-testid={fill ? 'play-request' : 'play-join'}
                    onClick={() => void run(async () => {
                      if (fill) {
                        const result = await requestSmartFill(playerId, row.match.id);
                        if (result.request.status === 'rejected') throw new ApiError('request_closed', 409);
                        if (result.request.status === 'approved') return t('pnJoined');
                        markWaiting(row.match.id);
                        return t('pnWaitingApproval');
                      }
                      try {
                        await joinOpenMatch(playerId, row.match.id);
                      } catch (error) {
                        if (error instanceof ApiError && error.code === 'approval_required') {
                          markWaiting(row.match.id);
                          return t('pnWaitingApproval');
                        }
                        throw error;
                      }
                      return t('pnJoined');
                    })}
                  >
                    {fill ? t('pnRequestJoin') : t('pnJoin')}
                  </Button>
                )}
              </PlayMatchCard>
            );
          })
        ) : null}
        {tab === 'build_my_game' ? (
          builds.length === 0 && extraSlots.length === 0 ? <p className="text-sm text-muted">{t('pnEmpty')}</p> : (
            <>
              {builds.map((row) => (
                <PlayMatchCard
                  key={row.slot.id}
                  facilityName={row.slot.facilityName}
                  demo={isDemoId(row.slot.id)}
                  whenLabel={whenLabel(row.slot.start, row.slot.courtNumber, row.distanceKm, courtText, awayText)}
                  seatsOpen={3}
                  priceVnd={row.suggestedMatch.pricePerPlayerVnd}
                  levelRange={row.suggestedMatch.levelRange}
                >
                  <p className="mt-3 text-sm font-semibold">{t('pnFillers')}</p>
                  <ul className="mt-1 grid gap-2">
                    {row.candidates.map((person) => (
                      <li key={person.playerId} className="text-sm">
                        <span className={person.provisional ? 'italic text-muted' : 'font-semibold'}>{person.displayName}</span>
                        {isDemoId(person.playerId) ? <span className="ml-2 rounded-full bg-line px-2 py-0.5 text-xs font-semibold">{t('pbDemoRow')}</span> : null}
                        <span className="ml-2 tabular-nums">{formatRating(person.level)}</span>
                        <span className="mt-1 block leading-6 text-muted">{person.explanation}</span>
                      </li>
                    ))}
                  </ul>
                  <Button className="mt-3" disabled={busy} onClick={() => void run(async () => {
                    await createOpenMatch(playerId, row.slot.id);
                    return t('pnJoined');
                  })}>
                    {t('pnHold')}
                  </Button>
                </PlayMatchCard>
              ))}
              {extraSlots.map((slot) => (
                <PlayMatchCard
                  key={slot.id}
                  facilityName={facilities.find((item) => item.id === slot.facilityId)?.name ?? slot.facilityId}
                  demo={slot.demo || isDemoId(slot.id)}
                  whenLabel={whenLabel(`${slot.date}T${slot.start}`, slot.courtNumber, undefined, courtText, awayText)}
                  priceVnd={perPlayerVnd(slot.priceVnd)}
                >
                  <Button className="mt-3" disabled={busy} onClick={() => void run(async () => {
                    await createOpenMatch(playerId, slot.id);
                    return t('pnJoined');
                  })}>
                    {t('pnHold')}
                  </Button>
                </PlayMatchCard>
              ))}
            </>
          )
        ) : null}
        {tab === 'join_queue' ? (
          queues.length === 0 ? <p className="text-sm text-muted">{t('pnEmpty')}</p> : queues.map((row) => {
            const estimate = queueEstimateView(row.estimate);
            return (
              <PlayMatchCard key={row.facilityId} facilityName={row.facilityName} demo={isDemoId(row.facilityId)} whenLabel={t('pnAway', { n: row.distanceKm })}>
                <p className="mt-2 text-sm">{t('pnWaiting', { n: row.activeQueueLength })}</p>
                <p className="mt-1 text-sm leading-6 text-muted" data-testid="play-estimate">
                  {estimate.available ? t('pnWaitRange', { low: estimate.low, high: estimate.high }) : t('pnEstimateUnavailable')}
                </p>
                {mineHere ? <p className="mt-2 text-sm">{t('pnQueued', { facility: mineHere.facilityName, position: mineHere.position ?? '—' })}</p> : null}
                <Button className="mt-3" disabled={busy} onClick={() => void run(async () => {
                  const result = await joinPlayQueue(playerId, row.facilityId);
                  return t('pnQueued', { facility: result.entry.facilityName, position: result.entry.position ?? '—' });
                })}>
                  {t('pnQueueIn')}
                </Button>
              </PlayMatchCard>
            );
          })
        ) : null}
      </div>
    </div>
  );
}
