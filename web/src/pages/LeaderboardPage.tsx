import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getLeaderboard, type LeaderRow } from '../clubApi';
import { Card } from '../components/Ui';
import { useI18n } from '../i18n/context';
import { formatRating, formatRatingDelta } from '../i18n/format';

const bandKey = {
  low: 'pbConfidenceLow',
  medium: 'pbConfidenceMedium',
  high: 'pbConfidenceHigh',
} as const;

export function LeaderboardPage() {
  const { t } = useI18n();
  const [scope, setScope] = useState<'overall' | 'facility'>('overall');
  const [sort, setSort] = useState<'rating' | 'improved' | 'matches'>('rating');
  const [facilityId, setFacilityId] = useState('demo-facility');
  const [facilities, setFacilities] = useState<{ id: string; name: string }[]>([]);
  const [competitive, setCompetitive] = useState<LeaderRow[]>([]);
  const [provisional, setProvisional] = useState<LeaderRow[]>([]);
  const [minimum, setMinimum] = useState(5);

  useEffect(() => {
    void getLeaderboard(scope, sort, scope === 'facility' ? facilityId : undefined).then((board) => {
      setFacilities(board.facilities);
      setCompetitive(board.competitive);
      setProvisional(board.provisional);
      setMinimum(board.minimumMatches);
      if (!board.facilities.some((item) => item.id === facilityId) && board.facilities[0]) setFacilityId(board.facilities[0].id);
    });
  }, [scope, sort, facilityId]);

  function table(rows: LeaderRow[], ranked: boolean) {
    return (
      <table className="mt-3 w-full text-left text-sm">
        <thead>
          <tr className="text-muted">
            <th className="py-2 pr-2">{t('pbRank')}</th>
            <th className="py-2 pr-2">{t('playerList')}</th>
            <th className="py-2 pr-2">{t('pbRating')}</th>
            <th className="py-2 pr-2">{t('pbConfidence')}</th>
            <th className="py-2">{t('pbVerifiedMatches')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} className="border-t border-line">
              <td className="py-2 pr-2 tabular-nums">{ranked ? row.rank : '—'}</td>
              <td className="py-2 pr-2">
                <Link className="font-semibold" to={`/players/${row.id}`}>{row.displayName}</Link>
                {row.demo ? <span className="ml-2 rounded-full bg-line px-2 py-0.5 text-xs">{t('pbDemoRow')}</span> : null}
                <span className={`ml-2 text-xs ${row.provisional ? 'italic text-muted' : 'font-semibold'}`}>
                  {row.provisional ? t('pbProvisional') : t('pbEstablished')}
                </span>
              </td>
              <td className="py-2 pr-2 tabular-nums">
                {formatRating(row.rating)}
                {sort === 'improved' ? <span className="ml-1 text-muted">{formatRatingDelta(row.improvement)}</span> : null}
              </td>
              <td className="py-2 pr-2">{t(bandKey[row.confidence])}</td>
              <td className="py-2 tabular-nums">{row.matchesPlayed}</td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }

  return (
    <main className="mx-auto grid w-full max-w-3xl gap-4 px-4 py-8">
      <h1 className="text-3xl font-semibold">{t('pbLeaderboard')}</h1>
      <p className="text-sm leading-6 text-muted">{t('pbCompetitiveNote').replace('5', String(minimum))}</p>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={`min-h-11 rounded-xl px-3 text-sm font-semibold ${scope === 'overall' ? 'bg-accent text-white' : 'border border-line'}`} onClick={() => setScope('overall')}>{t('pbOverall')}</button>
        <button type="button" className={`min-h-11 rounded-xl px-3 text-sm font-semibold ${scope === 'facility' ? 'bg-accent text-white' : 'border border-line'}`} onClick={() => setScope('facility')}>{t('pbFacilityBoard')}</button>
        <button type="button" className={`min-h-11 rounded-xl px-3 text-sm font-semibold ${sort === 'rating' ? 'bg-ink text-white' : 'border border-line'}`} onClick={() => setSort('rating')}>{t('pbRating')}</button>
        <button type="button" className={`min-h-11 rounded-xl px-3 text-sm font-semibold ${sort === 'improved' ? 'bg-ink text-white' : 'border border-line'}`} onClick={() => setSort('improved')}>{t('pbMostImproved')}</button>
        <button type="button" className={`min-h-11 rounded-xl px-3 text-sm font-semibold ${sort === 'matches' ? 'bg-ink text-white' : 'border border-line'}`} onClick={() => setSort('matches')}>{t('pbMostMatches')}</button>
      </div>
      {scope === 'facility' ? (
        <label className="text-sm font-semibold">
          {t('pbFacilityBoard')}
          <select className="mt-1 min-h-11 w-full rounded-xl border border-line px-3" value={facilityId} onChange={(event) => setFacilityId(event.target.value)}>
            {facilities.map((item) => (
              <option key={item.id} value={item.id}>{item.name}</option>
            ))}
          </select>
        </label>
      ) : null}
      <Card>
        <h2 className="text-xl font-semibold">{t('pbEstablished')}</h2>
        {competitive.length === 0 ? <p className="mt-2 text-sm text-muted">{t('notAvailable')}</p> : table(competitive, true)}
      </Card>
      <Card>
        <h2 className="text-xl font-semibold italic">{t('pbProvisionalList')}</h2>
        {provisional.length === 0 ? <p className="mt-2 text-sm text-muted">{t('notAvailable')}</p> : table(provisional, false)}
      </Card>
    </main>
  );
}
