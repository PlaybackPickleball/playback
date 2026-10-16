import { useEffect, useMemo, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { RatingChart } from '../components/RatingChart';
import { Card, Scene } from '../components/Ui';
import {
  NOT_AVAILABLE_STATS,
  SAMPLE_EQUIPMENT,
  SAMPLE_MATCHES,
  SAMPLE_PLAYER,
  SAMPLE_UPCOMING,
  type NotAvailableStat,
} from '../demo/samplePlayerReport';
import { isWin, sampleSummary } from '../demo/samplePlayerStats';
import { useI18n, type Lang } from '../i18n/context';
import type { MessageKey } from '../i18n/en';

const TEAM_A_RED = '#b91c1c';
const TEAM_B_BLUE = '#1d4ed8';
const TIME_ZONE = 'Asia/Ho_Chi_Minh';

const locale = (lang: Lang) => (lang === 'vi' ? 'vi-VN' : 'en-GB');

function formatDate(iso: string, lang: Lang) {
  return new Intl.DateTimeFormat(locale(lang), { dateStyle: 'medium', timeZone: TIME_ZONE }).format(new Date(iso));
}

function formatDateTime(iso: string, lang: Lang) {
  return new Intl.DateTimeFormat(locale(lang), { dateStyle: 'medium', timeStyle: 'short', timeZone: TIME_ZONE }).format(new Date(iso));
}

function formatSigned(value: number, lang: Lang) {
  return new Intl.NumberFormat(locale(lang), { signDisplay: 'exceptZero' }).format(value).replace('-', '\u2212');
}

function formatVnd(value: number, lang: Lang) {
  return new Intl.NumberFormat(lang === 'vi' ? 'vi-VN' : 'en-US', {
    style: 'currency',
    currency: 'VND',
    currencyDisplay: lang === 'vi' ? 'symbol' : 'code',
    maximumFractionDigits: 0,
  }).format(value);
}

const naLabels: Record<NotAvailableStat, MessageKey> = {
  serveConsistency: 'srNaServe',
  shotPlacement: 'shotPlacement',
  unforcedErrors: 'srNaUnforced',
  courtPositioning: 'srNaPositioning',
  movement: 'movement',
  ballSpeed: 'srNaBallSpeed',
};

function DemoBadge({ className = '' }: { className?: string }) {
  const { t } = useI18n();
  return (
    <span
      data-testid="demo-badge"
      className={`inline-flex items-center rounded-full border border-amber-400 bg-amber-100 px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wide text-amber-950 ${className}`}
    >
      {t('demoBadge')}
    </span>
  );
}

function Stat({ label, value, note }: { label: string; value: ReactNode; note?: string }) {
  return (
    <div className="min-w-0 rounded-xl border border-line bg-paper/60 px-3 py-2">
      <dt className="text-xs font-semibold text-muted">{label}</dt>
      <dd className="mt-0.5 text-2xl font-semibold tabular-nums">{value}</dd>
      {note ? <dd className="text-xs text-muted">{note}</dd> : null}
    </div>
  );
}

function LockIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="h-5 w-5 shrink-0" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </svg>
  );
}

export function SamplePlayerReportPage() {
  const { t, lang } = useI18n();
  const summary = useMemo(() => sampleSummary(), []);
  const { record, streak, rating, series, confidence, partner, opponent } = summary;
  const nf = useMemo(() => new Intl.NumberFormat(locale(lang)), [lang]);
  const pct = new Intl.NumberFormat(locale(lang), { style: 'percent', maximumFractionDigits: 0 });

  useEffect(() => {
    document.title = `${t('srTitle')} · ${t('srDemoData')} · ${t('appName')}`;
  }, [t]);

  const first = SAMPLE_PLAYER.startRating;
  const delta = rating - first;
  const confLevel = t(confidence.level === 'low' ? 'srConfLow' : confidence.level === 'medium' ? 'srConfMedium' : 'srConfHigh');
  const recent = [...SAMPLE_MATCHES].sort((x, y) => Date.parse(y.playedAt) - Date.parse(x.playedAt)).slice(0, 6);
  const winShare = record.played === 0 ? 0 : (record.wins / record.played) * 100;
  const equipmentKinds = ['paddle', 'shoes', 'apparel'] as const;

  return (
    <div data-testid="sample-player-report" className="grid min-w-0 gap-4">
      <div role="note" className="rounded-2xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-950">
        {t('srDemoBanner')}
      </div>

      <Scene image="court" className="min-w-0 px-4 py-6 sm:px-8 sm:py-8">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-3xl font-semibold tracking-tight text-balance sm:text-4xl">{t('srTitle')}</h1>
            <span data-testid="demo-data-label" className="rounded-full bg-amber-100 px-3 py-1 text-sm font-semibold text-amber-950 ring-1 ring-amber-400">
              {t('srDemoData')}
            </span>
          </div>
          <p className="mt-3 max-w-2xl text-base leading-7">{t('srIntro')}</p>
        </div>
      </Scene>

      <Card>
        <div className="flex min-w-0 flex-wrap items-center gap-4">
          <span aria-hidden="true" className="inline-flex h-16 w-16 shrink-0 items-center justify-center rounded-full bg-ink text-xl font-semibold text-white">
            {SAMPLE_PLAYER.initials}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="break-words text-2xl font-semibold">{SAMPLE_PLAYER.displayName}</h2>
              <DemoBadge />
            </div>
            <dl className="mt-1 grid gap-x-6 gap-y-1 text-sm text-muted sm:grid-cols-2">
              <div>
                <dt className="inline font-semibold">{t('srHandLabel')}: </dt>
                <dd className="inline">{t(SAMPLE_PLAYER.hand === 'right' ? 'srHandRight' : 'srHandLeft')}</dd>
              </div>
              <div className="min-w-0">
                <dt className="inline font-semibold">{t('srHomeFacility')}: </dt>
                <dd className="inline break-words">{SAMPLE_PLAYER.homeFacility}</dd>
              </div>
            </dl>
          </div>
        </div>
      </Card>

      <div className="grid min-w-0 gap-4 lg:grid-cols-2">
        <Card className="min-w-0">
          <h2 className="text-xl font-semibold">{t('ratingLabel')}</h2>
          <p data-testid="sample-rating" className="mt-1 text-5xl font-semibold tabular-nums">{nf.format(rating)}</p>
          <p className="mt-2 text-sm leading-6 text-muted">{t('srRatingNote')}</p>
          <p className="mt-3 text-sm">
            <span className="font-semibold">{t('srConfidenceTitle')}: </span>
            {t('srConfBasis', { level: confLevel, n: nf.format(SAMPLE_MATCHES.length) })}
          </p>
          <div className="mt-2 h-2 w-full max-w-xs overflow-hidden rounded-full bg-paper" aria-hidden="true">
            <div className="h-full rounded-full bg-accent" style={{ width: `${Math.round(confidence.value * 100)}%` }} />
          </div>
          <h3 className="mt-5 text-sm font-semibold">{t('srChartTitle', { n: nf.format(series.length) })}</h3>
          <RatingChart
            points={series}
            label={t('srChartAlt', { from: nf.format(first), to: nf.format(rating), n: nf.format(series.length) })}
          />
          <p className="mt-1 text-sm text-muted">{t('srRatingChangeTotal', { delta: formatSigned(delta, lang) })}</p>
        </Card>

        <Card className="min-w-0">
          <h2 className="text-xl font-semibold">{t('srRecordTitle')}</h2>
          <dl className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
            <Stat label={t('wins')} value={nf.format(record.wins)} />
            <Stat label={t('losses')} value={nf.format(record.losses)} />
            <Stat label={t('winRate')} value={record.winRatePercent === null ? t('notAvailable') : pct.format(record.winRatePercent / 100)} />
            <Stat
              label={t('srStreak')}
              value={streak === 0 ? '–' : `${streak > 0 ? t('srWinShort') : t('srLossShort')}${nf.format(Math.abs(streak))}`}
              note={streak === 0 ? undefined : t(streak > 0 ? 'srStreakWins' : 'srStreakLosses', { n: nf.format(Math.abs(streak)) })}
            />
            <Stat label={t('srPlayed')} value={nf.format(record.played)} />
          </dl>
          <div
            role="img"
            aria-label={t('srRecordBarLabel', { wins: nf.format(record.wins), losses: nf.format(record.losses) })}
            className="mt-4 flex h-9 w-full overflow-hidden rounded-xl border border-line text-sm font-semibold"
          >
            <div className="flex items-center justify-center bg-accent text-white" style={{ width: `${winShare}%` }}>
              {record.wins > 0 ? `${t('srWinShort')} ${nf.format(record.wins)}` : null}
            </div>
            <div className="flex flex-1 items-center justify-center bg-white text-ink">
              {record.losses > 0 ? `${t('srLossShort')} ${nf.format(record.losses)}` : null}
            </div>
          </div>
        </Card>
      </div>

      <Card>
        <h2 className="text-xl font-semibold">{t('srRecentTitle')}</h2>
        <p className="mt-1 text-sm text-muted">{t('srScoreLegend')}</p>
        <ul className="mt-3 grid gap-2">
          {recent.map((match) => {
            const won = isWin(match);
            return (
              <li key={match.id} data-testid="sample-match" className="grid min-w-0 gap-2 rounded-xl border border-line px-3 py-3 text-sm sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:items-center sm:gap-4">
                <div className="flex items-center gap-3">
                  <span
                    className={`inline-flex min-h-9 min-w-9 items-center justify-center rounded-lg px-2 text-sm font-bold ${won ? 'bg-accent text-white' : 'border-2 border-ink bg-white text-ink'}`}
                    aria-label={t(won ? 'srWinWord' : 'srLossWord')}
                  >
                    {t(won ? 'srWinShort' : 'srLossShort')}
                  </span>
                  <span
                    className="text-lg font-semibold tabular-nums"
                    aria-label={t('srScoreLabel', { a: match.scoreFor, b: match.scoreAgainst })}
                  >
                    <span style={{ color: TEAM_A_RED }}>{match.scoreFor}</span>
                    <span aria-hidden="true"> – </span>
                    <span style={{ color: TEAM_B_BLUE }}>{match.scoreAgainst}</span>
                  </span>
                </div>
                <div className="min-w-0">
                  <p className="font-semibold">
                    {formatDate(match.playedAt, lang)} · <span className="break-words">{match.facility}</span> · {t('courtNumber', { n: match.court })}
                  </p>
                  <p className="text-muted break-words">
                    {t('srWithPartner', { name: match.partner })} · {t('srVersus', { names: match.opponents.map((o) => o.name).join(', ') })}
                  </p>
                  <p className="mt-1 text-xs text-muted" data-testid="sample-replay-example">
                    <span className="font-semibold text-accent-dark underline decoration-dotted underline-offset-2">{t('srWatchReplay')}</span> · {t('srExampleOnly')}
                  </p>
                </div>
                <p className="font-semibold tabular-nums sm:text-right">
                  <span className="block text-xs font-semibold text-muted">{t('srRatingChange')}</span>
                  <span className="text-lg">{formatSigned(match.ratingChange, lang)}</span>
                </p>
              </li>
            );
          })}
        </ul>
      </Card>

      <div className="grid min-w-0 gap-4 lg:grid-cols-2">
        <Card className="min-w-0">
          <h2 className="text-xl font-semibold">{t('srPartnersTitle')}</h2>
          <dl className="mt-3 grid gap-3">
            {partner ? (
              <div className="rounded-xl border border-line px-3 py-2">
                <dt className="text-xs font-semibold text-muted">{t('srBestPartner')}</dt>
                <dd className="text-lg font-semibold">{partner.name}</dd>
                <dd className="text-sm text-muted">
                  {t('srBestPartnerStats', { rate: pct.format(partner.winRatePercent / 100), wins: nf.format(partner.wins), n: nf.format(partner.played) })}
                </dd>
              </div>
            ) : null}
            {opponent ? (
              <div className="rounded-xl border border-line px-3 py-2">
                <dt className="text-xs font-semibold text-muted">{t('srToughestOpponent')}</dt>
                <dd className="text-lg font-semibold">{opponent.name}</dd>
                <dd className="text-sm text-muted">
                  {t('srToughestStats', { rating: nf.format(opponent.rating), n: nf.format(opponent.played), wins: nf.format(opponent.wins) })}
                </dd>
              </div>
            ) : null}
          </dl>
        </Card>

        <Card className="min-w-0">
          <h2 className="text-xl font-semibold">{t('equipment')}</h2>
          <p className="mt-1 text-sm text-muted">{t('srEquipmentHelp')}</p>
          <dl className="mt-3 grid gap-2">
            {equipmentKinds.map((kind) => (
              <div key={kind} className="rounded-xl border border-line px-3 py-2">
                <dt className="text-xs font-semibold text-muted">{t(kind)}</dt>
                <dd className={`break-words ${SAMPLE_EQUIPMENT[kind] ? 'font-semibold' : 'text-muted'}`}>
                  {SAMPLE_EQUIPMENT[kind] ?? t('srEquipmentNone')}
                </dd>
              </div>
            ))}
          </dl>
        </Card>
      </div>

      <Card>
        <h2 className="text-xl font-semibold">{t('srUpcomingTitle')}</h2>
        <div className="mt-3 grid min-w-0 gap-3 md:grid-cols-3">
          <div className="min-w-0 rounded-xl border border-line px-3 py-3">
            <h3 className="text-sm font-semibold text-muted">{t('srBooking')}</h3>
            <p className="mt-1 font-semibold">{formatDateTime(SAMPLE_UPCOMING.booking.startsAt, lang)}</p>
            <p className="break-words text-sm">
              {SAMPLE_UPCOMING.booking.facility} · {t('courtNumber', { n: SAMPLE_UPCOMING.booking.court })}
            </p>
            <p className="mt-1 text-sm text-muted">{t('srBookingPay', { price: formatVnd(SAMPLE_UPCOMING.booking.priceVnd, lang) })}</p>
          </div>
          <div className="min-w-0 rounded-xl border border-line px-3 py-3">
            <h3 className="text-sm font-semibold text-muted">{t('srInvite')}</h3>
            <p className="mt-1 font-semibold">{formatDateTime(SAMPLE_UPCOMING.invitation.startsAt, lang)}</p>
            <p className="break-words text-sm">{SAMPLE_UPCOMING.invitation.facility}</p>
            <p className="mt-1 text-sm text-muted">
              {t('srInviteText', {
                from: SAMPLE_UPCOMING.invitation.from,
                n: nf.format(SAMPLE_UPCOMING.invitation.spotsOpen),
                level: SAMPLE_UPCOMING.invitation.level,
                price: formatVnd(SAMPLE_UPCOMING.invitation.priceVnd, lang),
              })}
            </p>
          </div>
          <div className="min-w-0 rounded-xl border border-line px-3 py-3">
            <h3 className="text-sm font-semibold text-muted">{t('srQueue')}</h3>
            <p className="mt-1 text-sm">
              {t('srQueueText', {
                position: nf.format(SAMPLE_UPCOMING.queue.position),
                facility: SAMPLE_UPCOMING.queue.facility,
                minutes: nf.format(SAMPLE_UPCOMING.queue.waitMinutes),
              })}
            </p>
          </div>
        </div>
      </Card>

      <Card>
        <h2 className="text-xl font-semibold">{t('notAvailable')}</h2>
        <p className="mt-1 text-sm leading-6 text-muted">{t('srNaHelp')}</p>
        <ul className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {NOT_AVAILABLE_STATS.map((stat) => (
            <li
              key={stat}
              data-testid="locked-stat"
              className="flex min-w-0 items-center gap-3 rounded-xl border border-dashed border-stone-400 bg-paper/60 px-3 py-3 text-muted"
            >
              <LockIcon />
              <span className="min-w-0">
                <span className="block font-semibold text-ink">{t(naLabels[stat])}</span>
                <span className="block text-sm">{t('notAvailable')} · {t('srLocked')}</span>
              </span>
            </li>
          ))}
        </ul>
      </Card>

      <p className="px-1 text-center text-sm text-muted" data-testid="sample-footer">{t('srFooter')}</p>
      <p className="text-center">
        <Link to="/players" className="inline-flex min-h-11 items-center font-semibold text-accent-dark underline underline-offset-2">
          {t('playerList')}
        </Link>
      </p>
    </div>
  );
}
