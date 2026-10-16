import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useI18n } from '../i18n/context';
import { formatRating } from '../i18n/format';
import { confirmedTeamSplit, courtStartHref, paymentLabel, priceParts, priceView, startOnCourtOne } from '../lib/playNow';
import type { PlayPerson, PlaySplit } from '../playApi';
import { Card } from './Ui';

type Person = PlayPerson & { demo?: boolean };

export function PlayMatchCard({
  facilityName,
  demo = false,
  whenLabel,
  seatsOpen,
  priceVnd,
  smartFill,
  levelRange,
  people,
  status,
  format,
  teamSplit,
  courtId,
  courtNumber,
  explanation,
  children,
}: {
  facilityName: string;
  demo?: boolean;
  whenLabel?: string;
  seatsOpen?: number;
  priceVnd?: number | null;
  smartFill?: unknown;
  levelRange?: { min: number; max: number } | null;
  people?: Person[];
  status?: string | null;
  format?: string | null;
  teamSplit?: PlaySplit | null;
  courtId?: string | null;
  courtNumber?: number | null;
  explanation?: string;
  children?: ReactNode;
}) {
  const { t } = useI18n();
  const pay = paymentLabel();
  const parts = priceParts(priceView(smartFill, priceVnd));
  const teams = confirmedTeamSplit({ status, format, teamSplit });
  const href = teams ? courtStartHref(courtId) : null;

  return (
    <Card>
      <p className="font-semibold">
        {facilityName}
        {demo ? <span className="ml-2 rounded-full bg-line px-2 py-0.5 text-xs font-semibold">{t('pbDemoRow')}</span> : null}
      </p>
      {whenLabel ? <p className="mt-1 text-sm">{whenLabel}</p> : null}
      {typeof seatsOpen === 'number' ? <p className="text-sm">{t('pnSeats', { n: seatsOpen })}</p> : null}
      {levelRange ? <p className="text-sm">{t('pnLevels', { min: levelRange.min, max: levelRange.max })}</p> : null}
      {parts.badge ? (
        <p className="mt-2 flex flex-wrap items-center gap-2 text-sm">
          <span data-testid="play-smart-fill" className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-950">
            {t('pnSmartFillPrice')}
          </span>
          <s className="text-muted">{parts.strike}</s>
          <span className="font-semibold">{parts.current}</span>
        </p>
      ) : parts.current ? (
        <p className="mt-2 text-sm font-semibold">
          {parts.current} <span className="font-normal text-muted">{t('pnPerPlayer')}</span>
        </p>
      ) : null}
      {teams ? (
        <div className="mt-3">
          <p className="text-sm font-semibold">{t('pnConfirmed')}</p>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            <div className="rounded-2xl px-3 py-2 text-white" style={{ backgroundColor: '#b91c1c' }}>
              <p className="text-sm font-semibold">{t('pnTeamA')}</p>
              <p>{teams.teamA.names.join(', ')}</p>
            </div>
            <div className="rounded-2xl px-3 py-2 text-white" style={{ backgroundColor: '#1d4ed8' }}>
              <p className="text-sm font-semibold">{t('pnTeamB')}</p>
              <p>{teams.teamB.names.join(', ')}</p>
            </div>
          </div>
          <p className="mt-2 text-sm leading-6 text-muted">{t('pnNoRating')}</p>
          {href ? (
            <Link data-testid="play-start-court" className="mt-2 inline-flex min-h-11 items-center font-semibold text-accent-dark underline underline-offset-2" to={href}>
              {startOnCourtOne(courtNumber, courtId) ? t('pnStartCourt1') : t('pnStartCourt', { n: courtNumber ?? '' })}
            </Link>
          ) : null}
        </div>
      ) : people && people.length > 0 ? (
        <ul className="mt-2 text-sm">
          {people.map((person) => (
            <li key={person.playerId}>
              <span className={person.provisional ? 'italic text-muted' : 'font-semibold'}>{person.displayName}</span>
              {person.demo ? <span className="ml-2 rounded-full bg-line px-2 py-0.5 text-xs font-semibold">{t('pbDemoRow')}</span> : null}
              {person.isHost ? <span className="ml-2 text-xs text-muted">{t('pnHost')}</span> : null}
              <span className="ml-2 tabular-nums">{formatRating(person.level)}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {explanation ? <p className="mt-2 text-sm leading-6 text-muted">{explanation}</p> : null}
      {children}
      <p className="mt-3 text-sm font-semibold" data-testid="play-pay" data-payment={pay.method} data-processed={pay.processed ? 'true' : 'false'}>
        {t('pnPayAtFacility')}
      </p>
    </Card>
  );
}
