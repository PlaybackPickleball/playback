import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ApiError } from '../api';
import { getFacility, listClubPlayers, type FacilitySummary } from '../clubApi';
import { Button, Notice, Scene } from '../components/Ui';
import { useI18n, type Lang } from '../i18n/context';
import type { MessageKey } from '../i18n/en';
import { activityLabel, courtNumberFromId } from '../i18n/format';
import {
  cancelAdminBooking,
  createSlot,
  disableFill,
  getAdminQueue,
  getFillSettings,
  getFillSummary,
  getQueueSettings,
  listAdminBookings,
  listSlots,
  publishFill,
  putFillSettings,
  putQueueSettings,
  venueToday,
  type FillSettings,
  type FillSummary,
  type PlayBooking,
  type PlaySlot,
  type QueueMode,
} from '../playAdmin';

const TOKEN_KEY = 'playback-demo-admin-token';
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const CAN_CANCEL = new Set(['open', 'pending', 'held', 'confirmed']);

const ERROR_KEYS: Record<string, MessageKey> = {
  admin_required: 'setupErrAdmin',
  admin_disabled: 'setupErrAdminOff',
  invalid_price: 'setupErrPrice',
  invalid_slot_time: 'setupErrTime',
  slot_overlap: 'setupErrOverlap',
  court_not_found: 'setupErrCourt',
  invalid_settings: 'setupErrSettings',
  facility_not_found: 'setupErrFacility',
  not_found: 'setupErrNotFound',
  invalid_transition: 'setupErrTransition',
  network: 'setupErrNetwork',
  smart_fill_disabled: 'setupErrFillOff',
  outside_promotable_hours: 'setupErrHours',
  discount_exceeds_max: 'setupErrDiscount',
  slot_not_vacant: 'setupErrVacant',
  slot_not_found: 'setupErrSlotMissing',
  player_not_found: 'setupErrPlayer',
  player_required: 'setupErrPlayer',
  player_overlap: 'setupErrBusy',
  slot_in_past: 'setupErrPast',
  slot_unavailable: 'setupErrVacant',
  invalid_body: 'setupErrBody',
};

const BOOKING_STATUS: Record<string, MessageKey> = {
  open: 'setupStatusOpen',
  pending: 'setupStatusPending',
  held: 'setupStatusHeld',
  confirmed: 'setupStatusConfirmed',
  checked_in: 'setupStatusCheckedIn',
  completed: 'setupStatusCompleted',
  cancelled: 'setupStatusCancelled',
  expired: 'setupStatusExpired',
  no_show: 'setupStatusNoShow',
};

type FlashNote = { tone: 'good' | 'bad'; text: string };
type Explain = (key: MessageKey, vars?: Record<string, string | number>) => string;

function storedToken(): string {
  try {
    const saved = localStorage.getItem(TOKEN_KEY);
    return saved && saved.trim() ? saved : 'demo-admin';
  } catch {
    return 'demo-admin';
  }
}

function explain(t: Explain, error: unknown): string {
  if (!(error instanceof ApiError) || error.code === 'network') return t('setupErrNetwork');
  const key = ERROR_KEYS[error.code];
  return key ? t(key) : t('setupErrServer', { code: error.code });
}

function formatVnd(value: number, lang: Lang) {
  return new Intl.NumberFormat(lang === 'vi' ? 'vi-VN' : 'en-US', {
    style: 'currency',
    currency: 'VND',
    currencyDisplay: lang === 'vi' ? 'symbol' : 'code',
    maximumFractionDigits: 0,
  }).format(value);
}

function formatVenueDate(date: string, lang: Lang) {
  return new Intl.DateTimeFormat(lang === 'vi' ? 'vi-VN' : 'en-GB', {
    dateStyle: 'full',
    timeZone: 'Asia/Ho_Chi_Minh',
  }).format(new Date(`${date}T12:00:00+07:00`));
}

function bookingWhen(start: string, end: string) {
  const [startDate, startTime] = start.split('T');
  const [endDate, endTime] = end.split('T');
  if (startDate && startTime && startDate === endDate) return `${startDate} ${startTime}–${endTime}`;
  return `${start.replace('T', ' ')} – ${end.replace('T', ' ')}`;
}

function wholeDong(value: string) {
  return /^\d+$/.test(value) && Number(value) <= 100_000_000;
}

function windowSeconds(value: string) {
  if (!/^\d+$/.test(value)) return null;
  const n = Number(value);
  return n >= 15 && n <= 900 ? n : null;
}

function wholePercent(value: string) {
  return /^\d+$/.test(value) && Number(value) <= 100;
}

function venueClock(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Ho_Chi_Minh',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  let hour = parts.find((part) => part.type === 'hour')?.value ?? '00';
  const minute = parts.find((part) => part.type === 'minute')?.value ?? '00';
  if (hour === '24') hour = '00';
  return `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`;
}

function plusOneHour(time: string): string {
  const [hour, minute] = time.split(':').map(Number);
  const total = hour * 60 + minute + 60;
  if (total >= 24 * 60) return '23:59';
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

/** Demo prices stay inside a 20% cap. The window includes this slot and the current hour. */
function fillDefaults(slotStart: string, now = new Date()) {
  const currentHour = `${venueClock(now).slice(0, 2)}:00`;
  const promotableStart = ['17:00', slotStart, currentHour].sort()[0];
  let promotableEnd = ['21:00', plusOneHour(slotStart), plusOneHour(currentHour)].sort().at(-1) ?? '21:00';
  if (promotableEnd <= promotableStart) promotableEnd = plusOneHour(promotableStart);
  return { normalPriceVnd: 150_000, promoPriceVnd: 120_000, maxDiscountPercent: 20, promotableStart, promotableEnd };
}

function discountExceeds(reference: number, promo: number, maxPercent: number) {
  if (promo >= reference) return false;
  return (reference - promo) * 100 > reference * maxPercent;
}

function rulesAllow(settings: FillSettings, slot: PlaySlot) {
  if (
    settings.normalPriceVnd == null ||
    settings.promoPriceVnd == null ||
    settings.maxDiscountPercent == null ||
    !settings.promotableStart ||
    !settings.promotableEnd
  ) {
    return false;
  }
  if (slot.start < settings.promotableStart || slot.start >= settings.promotableEnd) return false;
  if (discountExceeds(settings.normalPriceVnd, settings.promoPriceVnd, settings.maxDiscountPercent)) return false;
  return !discountExceeds(slot.priceVnd, settings.promoPriceVnd, settings.maxDiscountPercent);
}

function rulesMissing(settings: FillSettings) {
  return (
    settings.normalPriceVnd == null ||
    settings.promoPriceVnd == null ||
    settings.maxDiscountPercent == null ||
    !settings.promotableStart ||
    !settings.promotableEnd
  );
}

function Flash({ note }: { note: FlashNote | null }) {
  if (!note) return null;
  return (
    <div className="mt-3">
      <Notice tone={note.tone === 'good' ? 'good' : 'bad'} title={note.text} />
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block min-w-0 text-sm font-semibold">
      {label}
      <div className="mt-2 font-normal">{children}</div>
    </label>
  );
}

const controlClass = 'w-full min-w-0 max-w-full rounded-2xl border border-line bg-white px-3 py-3 text-base';

export function FacilitySetupPage() {
  const { t, lang } = useI18n();
  const [token, setToken] = useState(storedToken);
  const [facility, setFacility] = useState<FacilitySummary | null>(null);
  const [today, setToday] = useState(venueToday);
  const [slots, setSlots] = useState<PlaySlot[]>([]);
  const [bookings, setBookings] = useState<PlayBooking[]>([]);
  const [waiting, setWaiting] = useState<number | null>(null);
  const [confirmed, setConfirmed] = useState<number | null>(null);
  const [mode, setMode] = useState<QueueMode>('hybrid');
  const [windowText, setWindowText] = useState('120');
  const [courtId, setCourtId] = useState('court-1');
  const [start, setStart] = useState('21:00');
  const [end, setEnd] = useState('22:00');
  const [priceText, setPriceText] = useState('150000');
  const [failed, setFailed] = useState(false);
  const [adminLoaded, setAdminLoaded] = useState(false);
  const [adminNote, setAdminNote] = useState('');
  const [tokenNote, setTokenNote] = useState<FlashNote | null>(null);
  const [slotNote, setSlotNote] = useState<FlashNote | null>(null);
  const [bookingNote, setBookingNote] = useState<FlashNote | null>(null);
  const [queueNote, setQueueNote] = useState<FlashNote | null>(null);
  const [promoteNote, setPromoteNote] = useState<FlashNote | null>(null);
  const [fillEnabled, setFillEnabled] = useState(false);
  const [normalText, setNormalText] = useState('');
  const [promoText, setPromoText] = useState('');
  const [discountText, setDiscountText] = useState('');
  const [promoStart, setPromoStart] = useState('17:00');
  const [promoEnd, setPromoEnd] = useState('21:00');
  const [fillDemo, setFillDemo] = useState(false);
  const [fillNote, setFillNote] = useState<FlashNote | null>(null);
  const [summary, setSummary] = useState<FillSummary | null>(null);
  const [busy, setBusy] = useState('');
  const tokenRef = useRef(token);
  const hostRef = useRef('demo-minh');
  const loadGen = useRef(0);
  tokenRef.current = token;

  const load = useCallback(
    async (activeToken: string) => {
      const applyFill = (settings: FillSettings) => {
        setFillEnabled(settings.enabled);
        setNormalText(settings.normalPriceVnd == null ? '' : String(settings.normalPriceVnd));
        setPromoText(settings.promoPriceVnd == null ? '' : String(settings.promoPriceVnd));
        setDiscountText(settings.maxDiscountPercent == null ? '' : String(settings.maxDiscountPercent));
        setPromoStart(settings.promotableStart ?? '17:00');
        setPromoEnd(settings.promotableEnd ?? '21:00');
        setFillDemo(settings.demo);
      };
      const gen = ++loadGen.current;
      setFailed(false);
      try {
        const nextFacility = await getFacility();
        const date = venueToday();
        const [slotRes, playerRes] = await Promise.all([listSlots(nextFacility.id, date), listClubPlayers().catch(() => ({ players: [] }))]);
        const host = playerRes.players.find((player) => player.id === 'demo-minh') ?? playerRes.players.find((player) => player.demo) ?? playerRes.players[0];
        if (host) hostRef.current = host.id;
        if (gen !== loadGen.current) return;
        setFacility(nextFacility);
        setToday(date);
        setSlots(slotRes.slots.filter((slot) => slot.status === 'available'));
        setCourtId((current) => (nextFacility.courts.some((court) => court.id === current) ? current : nextFacility.courts[0]?.id ?? current));
        try {
          const [bookingRes, settingsRes, queueRes, fillRes, summaryRes] = await Promise.all([
            listAdminBookings(activeToken, nextFacility.id),
            getQueueSettings(activeToken, nextFacility.id),
            getAdminQueue(activeToken, nextFacility.id),
            getFillSettings(activeToken, nextFacility.id),
            getFillSummary(activeToken, nextFacility.id),
          ]);
          if (gen !== loadGen.current) return;
          setBookings(bookingRes.bookings);
          setMode(settingsRes.settings.mode);
          setWindowText(String(settingsRes.settings.acceptanceWindowSeconds));
          setWaiting(queueRes.entries.filter((entry) => entry.status === 'waiting').reduce((sum, entry) => sum + entry.partySize, 0));
          setConfirmed(bookingRes.bookings.filter((booking) => booking.status === 'confirmed').length);
          applyFill(fillRes.settings);
          setSummary(summaryRes.summary);
          setAdminLoaded(true);
          setAdminNote('');
        } catch (error) {
          if (gen !== loadGen.current) return;
          setBookings([]);
          setWaiting(null);
          setConfirmed(null);
          setSummary(null);
          setAdminLoaded(false);
          setAdminNote(explain(t, error));
        }
      } catch (error) {
        if (gen !== loadGen.current) return;
        setFailed(true);
        setAdminNote(explain(t, error));
      }
    },
    [t],
  );

  useEffect(() => {
    document.title = `${t('setupTitle')} · ${t('appName')}`;
    void load(tokenRef.current);
  }, [t, load]);

  function saveToken(event: FormEvent) {
    event.preventDefault();
    const next = token.trim();
    if (!next) {
      setTokenNote({ tone: 'bad', text: t('setupTokenMissing') });
      return;
    }
    try {
      localStorage.setItem(TOKEN_KEY, next);
    } catch {
      setTokenNote({ tone: 'bad', text: t('errorGeneric') });
      return;
    }
    setToken(next);
    setTokenNote({ tone: 'good', text: t('setupTokenSaved') });
    void load(next);
  }

  async function addSlot(event: FormEvent) {
    event.preventDefault();
    if (!facility) return;
    const price = priceText.trim();
    if (!wholeDong(price)) {
      setSlotNote({ tone: 'bad', text: t('setupErrPrice') });
      return;
    }
    if (!TIME_RE.test(start) || !TIME_RE.test(end) || end <= start) {
      setSlotNote({ tone: 'bad', text: t('setupErrTime') });
      return;
    }
    setBusy('slot');
    setSlotNote(null);
    try {
      await createSlot(token.trim(), {
        facilityId: facility.id,
        courtId,
        date: today,
        start,
        end,
        priceVnd: Number(price),
      });
      setSlotNote({ tone: 'good', text: t('setupSlotAdded') });
      await load(token.trim());
    } catch (error) {
      setSlotNote({ tone: 'bad', text: explain(t, error) });
    } finally {
      setBusy('');
    }
  }

  async function cancelOne(id: string) {
    setBusy(id);
    setBookingNote(null);
    try {
      await cancelAdminBooking(token.trim(), id);
      setBookingNote({ tone: 'good', text: t('setupBookingCancelled') });
      await load(token.trim());
    } catch (error) {
      setBookingNote({ tone: 'bad', text: explain(t, error) });
    } finally {
      setBusy('');
    }
  }

  async function saveQueue(event: FormEvent) {
    event.preventDefault();
    if (!facility) return;
    const seconds = windowSeconds(windowText.trim());
    if (!seconds) {
      setQueueNote({ tone: 'bad', text: t('setupErrSettings') });
      return;
    }
    setBusy('queue');
    setQueueNote(null);
    try {
      const result = await putQueueSettings(token.trim(), {
        facilityId: facility.id,
        mode,
        acceptanceWindowSeconds: seconds,
      });
      setMode(result.settings.mode);
      setWindowText(String(result.settings.acceptanceWindowSeconds));
      setQueueNote({ tone: 'good', text: t('setupQueueSaved') });
    } catch (error) {
      setQueueNote({ tone: 'bad', text: explain(t, error) });
    } finally {
      setBusy('');
    }
  }

  async function promote(slot: PlaySlot) {
    if (!facility) return;
    const auth = token.trim();
    setBusy(slot.id);
    setPromoteNote(null);
    let turnedOn = false;
    let published = false;
    try {
      let settings = (await getFillSettings(auth, facility.id)).settings;
      if (rulesMissing(settings)) {
        settings = (
          await putFillSettings(auth, { facilityId: facility.id, enabled: true, ...fillDefaults(slot.start) })
        ).settings;
        turnedOn = true;
      } else if (!settings.enabled && rulesAllow(settings, slot)) {
        settings = (
          await putFillSettings(auth, {
            facilityId: facility.id,
            enabled: true,
            normalPriceVnd: settings.normalPriceVnd as number,
            promoPriceVnd: settings.promoPriceVnd as number,
            maxDiscountPercent: settings.maxDiscountPercent as number,
            promotableStart: settings.promotableStart as string,
            promotableEnd: settings.promotableEnd as string,
          })
        ).settings;
        turnedOn = true;
      }
      const result = await publishFill(auth, { slotId: slot.id, hostPlayerId: hostRef.current });
      published = true;
      if (turnedOn) {
        try {
          await disableFill(auth, facility.id);
        } catch {
          /* The open game is already published. */
        }
      }
      const price = formatVnd(result.promoPriceVnd, lang);
      setPromoteNote({
        tone: 'good',
        text: t('setupPromoted', {
          court: t('courtNumber', { n: slot.courtNumber }),
          time: `${slot.start}–${slot.end}`,
          price,
        }),
      });
      try {
        await load(auth);
      } catch {
        /* The slot was published. A failed refresh does not undo that. */
      }
    } catch (error) {
      if (turnedOn && !published) {
        try {
          await disableFill(auth, facility.id);
        } catch {
          /* The publish error is the one to show. */
        }
      }
      setPromoteNote({ tone: 'bad', text: explain(t, error) });
    } finally {
      setBusy('');
    }
  }

  async function saveFill(event: FormEvent) {
    event.preventDefault();
    if (!facility) return;
    const normal = normalText.trim();
    const promo = promoText.trim();
    const discount = discountText.trim();
    if (!wholeDong(normal) || !wholeDong(promo)) {
      setFillNote({ tone: 'bad', text: t('setupErrPrice') });
      return;
    }
    if (!wholePercent(discount)) {
      setFillNote({ tone: 'bad', text: t('setupErrBody') });
      return;
    }
    if (!TIME_RE.test(promoStart) || !TIME_RE.test(promoEnd) || promoEnd <= promoStart) {
      setFillNote({ tone: 'bad', text: t('setupErrTime') });
      return;
    }
    setBusy('fill');
    setFillNote(null);
    try {
      const result = await putFillSettings(token.trim(), {
        facilityId: facility.id,
        enabled: fillEnabled,
        normalPriceVnd: Number(normal),
        promoPriceVnd: Number(promo),
        maxDiscountPercent: Number(discount),
        promotableStart: promoStart,
        promotableEnd: promoEnd,
      });
      setFillEnabled(result.settings.enabled);
      setFillDemo(result.settings.demo);
      setFillNote({ tone: 'good', text: t('setupFillSaved') });
    } catch (error) {
      setFillNote({ tone: 'bad', text: explain(t, error) });
    } finally {
      setBusy('');
    }
  }

  const pricePreview = wholeDong(priceText.trim()) ? formatVnd(Number(priceText.trim()), lang) : '';

  return (
    <section className="min-w-0 overflow-x-clip" data-testid="club-setup">
      <Scene image="court" tone="band" aria-hidden="true" className="h-24 sm:h-28" />
      <p className="mt-4 text-sm font-semibold text-accent-dark">{t('setupTitle')}</p>
      <h1 className="mt-1 text-3xl font-semibold tracking-tight text-balance sm:text-4xl">{t('setupEmptyTitle')}</h1>
      <p className="mt-2 max-w-2xl text-sm leading-6">{t('setupDemoNote')}</p>
      <p className="mt-1 text-sm text-muted">{t('setupVacantDate', { date: formatVenueDate(today, lang) })}</p>
      <p className="mt-2 max-w-2xl text-sm leading-6 text-muted">{t('setupEmptyLead')}</p>
      <Flash note={promoteNote} />

      {failed ? (
        <div className="mt-4">
          <Notice tone="bad" title={adminNote || t('loadFailed')}>
            <Button className="mt-2" onClick={() => void load(token.trim())}>
              {t('refresh')}
            </Button>
          </Notice>
        </div>
      ) : null}

      {!facility && !failed ? <p className="mt-6">{t('loading')}</p> : null}

      {facility ? (
        <>
          {slots.length === 0 ? (
            <p className="mt-4">{t('setupVacantEmpty')}</p>
          ) : (
            <ul className="mt-4 grid gap-3 sm:grid-cols-2" data-testid="promote-list">
              {slots.map((slot) => (
                <li key={slot.id} className="panel min-w-0 p-4" data-testid={`slot-${slot.id}`}>
                  <p className="text-lg font-semibold">
                    {t('courtNumber', { n: slot.courtNumber })} · {slot.start}–{slot.end}
                  </p>
                  <p className="mt-1 text-sm">{formatVnd(slot.priceVnd, lang)}</p>
                  <p className="mt-1 text-sm text-muted">{t('setupPayNote')}</p>
                  {slot.demo ? <p className="mt-1 text-sm font-semibold text-accent-dark">{t('setupDemoSlot')}</p> : null}
                  {!slot.availabilityVerified ? <p className="mt-1 text-sm">{t('setupUnverified')}</p> : null}
                  <Button
                    className="mt-4 w-full text-lg"
                    style={{ minHeight: '4.5rem' }}
                    disabled={busy !== ''}
                    data-testid={`promote-${slot.id}`}
                    onClick={() => void promote(slot)}
                  >
                    {t('setupPromote')}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        <div className="mt-12 grid min-w-0 gap-10">
          <section data-testid="setup-summary">
            <h2 className="text-2xl font-semibold tracking-tight">{t('setupSummaryTitle')}</h2>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-muted">{t('setupSummaryDemo')}</p>
            {adminNote ? (
              <div className="mt-3">
                <Notice tone="bad" title={adminNote} />
              </div>
            ) : null}
            <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <div className="panel min-w-0 p-5">
                <p className="text-sm text-muted">{t('setupWaiting')}</p>
                <p className="mt-2 text-4xl font-semibold tracking-tight" data-testid="waiting-players">
                  {waiting ?? '—'}
                </p>
              </div>
              <div className="panel min-w-0 p-5">
                <p className="text-sm text-muted">{t('setupConfirmed')}</p>
                <p className="mt-2 text-4xl font-semibold tracking-tight" data-testid="confirmed-bookings">
                  {confirmed ?? '—'}
                </p>
              </div>
              <div className="panel min-w-0 p-5">
                <p className="text-sm text-muted">{t('setupGrossValue')}</p>
                <p className="mt-2 break-words text-2xl font-semibold tracking-tight" data-testid="gross-value">
                  {summary ? formatVnd(summary.grossBookingValueVnd, lang) : '—'}
                </p>
              </div>
              <div className="panel min-w-0 p-5">
                <p className="text-sm text-muted">{t('setupPlaybackTotal')}</p>
                <p className="mt-2 break-words text-2xl font-semibold tracking-tight" data-testid="playback-total">
                  {summary ? formatVnd(summary.playbackOriginatedVnd, lang) : '—'}
                </p>
              </div>
              <div className="panel min-w-0 p-5">
                <p className="text-sm text-muted">{t('setupIncremental')}</p>
                <p className="mt-2 break-words text-2xl font-semibold tracking-tight" data-testid="incremental-value">
                  {summary ? formatVnd(summary.estimatedIncrementalVnd, lang) : '—'}
                </p>
              </div>
            </div>
          </section>

          <section data-testid="setup-courts">
            <h2 className="text-2xl font-semibold tracking-tight">
              {facility.name} <span className="text-base font-semibold text-accent-dark">{t('demoBadge')}</span>
            </h2>
            <p className="mt-2 text-sm text-muted">{t('setupCourtsTitle')}</p>
            <ul className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {facility.courts.map((court) => (
                <li key={court.id} className="panel min-w-0 p-4" data-testid={`setup-court-${court.id}`}>
                  <p className="font-semibold">{t('courtNumber', { n: court.number })}</p>
                  <p className="mt-1 text-sm">{court.records ? t('recordsHere') : t('simulatedCourt')}</p>
                  <p className="mt-1 break-words text-sm text-muted">{activityLabel(court.activity, t)}</p>
                </li>
              ))}
            </ul>
          </section>

          <section data-testid="setup-slots">
            <form className="panel grid min-w-0 gap-4 p-5" onSubmit={(event) => void addSlot(event)}>
              <h3 className="text-xl font-semibold">{t('setupAddSlotTitle')}</h3>
              <p className="text-sm leading-6 text-muted">{t('setupPriceNote')}</p>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label={t('setupCourt')}>
                  <select className={controlClass} value={courtId} onChange={(event) => setCourtId(event.target.value)} data-testid="slot-court">
                    {facility.courts.map((court) => (
                      <option key={court.id} value={court.id}>
                        {t('courtNumber', { n: court.number })}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label={t('setupPrice')}>
                  <input
                    className={controlClass}
                    inputMode="numeric"
                    value={priceText}
                    onChange={(event) => setPriceText(event.target.value)}
                    data-testid="slot-price"
                  />
                  {pricePreview ? <p className="mt-2 text-sm text-muted">{pricePreview}</p> : null}
                </Field>
                <Field label={t('setupStart')}>
                  <input className={controlClass} type="time" step={60} value={start} onChange={(event) => setStart(event.target.value)} data-testid="slot-start" required />
                </Field>
                <Field label={t('setupEnd')}>
                  <input className={controlClass} type="time" step={60} value={end} onChange={(event) => setEnd(event.target.value)} data-testid="slot-end" required />
                </Field>
              </div>
              <Button type="submit" className="w-full sm:w-auto" disabled={busy === 'slot'} data-testid="add-slot">
                {t('setupAddSlot')}
              </Button>
              <Flash note={slotNote} />
            </form>
          </section>

          <section data-testid="setup-bookings">
            <h2 className="text-2xl font-semibold tracking-tight">{t('setupBookingsTitle')}</h2>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-muted">{t('setupPayNote')}</p>
            <Flash note={bookingNote} />
            {adminLoaded && bookings.length === 0 ? <p className="mt-4">{t('setupBookingsEmpty')}</p> : null}
            <ul className="mt-4 grid gap-3">
              {bookings.map((booking) => {
                const names = booking.participants.map((person) => person.displayName).filter(Boolean);
                const statusKey = BOOKING_STATUS[booking.status];
                return (
                  <li key={booking.id} className="panel min-w-0 p-4" data-testid={`booking-${booking.id}`}>
                    <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="font-semibold">
                          {t('courtNumber', { n: courtNumberFromId(booking.courtId) })} · {bookingWhen(booking.start, booking.end)}
                        </p>
                        <p className="mt-1 text-sm">
                          {t('setupStatus')}: {statusKey ? t(statusKey) : booking.status}
                        </p>
                        <p className="mt-1 text-sm">{formatVnd(booking.priceVnd, lang)}</p>
                        <p className="mt-1 break-words text-sm">
                          {t('setupPlayers')}: {names.length ? names.join(', ') : t('setupNoPlayers')}
                        </p>
                      </div>
                      {CAN_CANCEL.has(booking.status) ? (
                        <Button
                          variant="danger"
                          className="w-full sm:w-auto"
                          disabled={busy === booking.id}
                          data-testid={`cancel-booking-${booking.id}`}
                          onClick={() => void cancelOne(booking.id)}
                        >
                          {t('setupCancelBooking')}
                        </Button>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>

          <section data-testid="setup-queue">
            <h2 className="text-2xl font-semibold tracking-tight">{t('setupQueueTitle')}</h2>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-muted">{t('setupQueueHelp')}</p>
            <form className="panel mt-4 grid min-w-0 max-w-xl gap-4 p-5" onSubmit={(event) => void saveQueue(event)}>
              <fieldset className="min-w-0">
                <legend className="text-sm font-semibold">{t('setupQueueMode')}</legend>
                <div className="mt-2 grid gap-2">
                  {(
                    [
                      ['fifo', 'setupModeFifo'],
                      ['skill', 'setupModeSkill'],
                      ['hybrid', 'setupModeHybrid'],
                    ] as const
                  ).map(([value, label]) => (
                    <label key={value} className="flex min-h-12 items-center gap-3 rounded-2xl border border-line bg-white px-3">
                      <input
                        type="radio"
                        name="queue-mode"
                        value={value}
                        checked={mode === value}
                        onChange={() => setMode(value)}
                        data-testid={`queue-mode-${value}`}
                      />
                      <span>{t(label)}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
              <Field label={t('setupWindow')}>
                <input
                  className={controlClass}
                  inputMode="numeric"
                  value={windowText}
                  onChange={(event) => setWindowText(event.target.value)}
                  data-testid="queue-window"
                  aria-describedby="queue-window-help"
                />
              </Field>
              <p id="queue-window-help" className="text-sm leading-6 text-muted">
                {t('setupWindowHelp')}
              </p>
              <Button type="submit" className="w-full sm:w-auto" disabled={busy === 'queue'} data-testid="save-queue">
                {t('setupSaveQueue')}
              </Button>
              <Flash note={queueNote} />
            </form>
          </section>

          <section data-testid="smart-fill">
            <h2 className="text-2xl font-semibold tracking-tight">{t('setupSmartFillTitle')}</h2>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-muted">{t('setupFillHelp')}</p>
            {fillDemo ? <p className="mt-2 text-sm font-semibold text-accent-dark">{t('setupFillDemo')}</p> : null}
            <form className="panel mt-4 grid min-w-0 max-w-xl gap-4 p-5" onSubmit={(event) => void saveFill(event)}>
              <fieldset className="min-w-0">
                <legend className="text-sm font-semibold">{t('setupFillEnabled')}</legend>
                <div className="mt-2 grid gap-2">
                  <label className="flex min-h-12 items-center gap-3 rounded-2xl border border-line bg-white px-3">
                    <input type="radio" name="fill-enabled" checked={fillEnabled} onChange={() => setFillEnabled(true)} data-testid="fill-on" />
                    <span>{t('setupFillOn')}</span>
                  </label>
                  <label className="flex min-h-12 items-center gap-3 rounded-2xl border border-line bg-white px-3">
                    <input type="radio" name="fill-enabled" checked={!fillEnabled} onChange={() => setFillEnabled(false)} data-testid="fill-off" />
                    <span>{t('setupFillOff')}</span>
                  </label>
                </div>
              </fieldset>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label={t('setupNormalPrice')}>
                  <input className={controlClass} inputMode="numeric" value={normalText} onChange={(event) => setNormalText(event.target.value)} data-testid="fill-normal" />
                </Field>
                <Field label={t('setupPromoPrice')}>
                  <input className={controlClass} inputMode="numeric" value={promoText} onChange={(event) => setPromoText(event.target.value)} data-testid="fill-promo" />
                </Field>
                <Field label={t('setupMaxDiscount')}>
                  <input className={controlClass} inputMode="numeric" value={discountText} onChange={(event) => setDiscountText(event.target.value)} data-testid="fill-discount" />
                </Field>
                <Field label={t('setupPromotableHours')}>
                  <div className="grid grid-cols-2 gap-2">
                    <input className={controlClass} type="time" step={60} value={promoStart} onChange={(event) => setPromoStart(event.target.value)} aria-label={t('setupStart')} data-testid="fill-start" />
                    <input className={controlClass} type="time" step={60} value={promoEnd} onChange={(event) => setPromoEnd(event.target.value)} aria-label={t('setupEnd')} data-testid="fill-end" />
                  </div>
                </Field>
              </div>
              <Button type="submit" className="w-full sm:w-auto" disabled={busy === 'fill'} data-testid="save-fill">
                {t('setupSaveFill')}
              </Button>
              <Flash note={fillNote} />
            </form>
          </section>

          <form className="grid max-w-xl gap-3" onSubmit={saveToken}>
            <Field label={t('setupTokenLabel')}>
              <input
                value={token}
                onChange={(event) => setToken(event.target.value)}
                className={controlClass}
                autoComplete="off"
                spellCheck={false}
                data-testid="admin-token"
                aria-describedby="admin-token-help"
              />
            </Field>
            <p id="admin-token-help" className="text-sm leading-6 text-muted">
              {t('setupTokenHelp')}
            </p>
            <Button type="submit" variant="secondary" className="w-full sm:w-auto" data-testid="save-admin-token">
              {t('setupTokenSave')}
            </Button>
            <Flash note={tokenNote} />
          </form>

          <Link to="/dashboard" className="inline-flex min-h-12 items-center font-semibold text-accent-dark">
            {t('returnDashboard')}
          </Link>
        </div>
        </>
      ) : null}
    </section>
  );
}
