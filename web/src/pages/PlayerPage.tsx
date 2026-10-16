import QRCode from 'qrcode';
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ApiError } from '../api';
import { getClubPlayer, setStartRating, updateClubPlayer, type Equipment, type PlayerDetail } from '../clubApi';
import { RatingChart } from '../components/RatingChart';
import { Button, Card } from '../components/Ui';
import { useI18n } from '../i18n/context';
import { formatRating, formatRatingDelta } from '../i18n/format';

export function PlayerPage() {
  const { playerId = '' } = useParams();
  const { t, lang } = useI18n();
  const [player, setPlayer] = useState<PlayerDetail | null>(null);
  const [qr, setQr] = useState('');
  const [equipment, setEquipment] = useState<Equipment>({});
  const [consent, setConsent] = useState(false);
  const [message, setMessage] = useState('');
  const [startCategory, setStartCategory] = useState('intermediate');
  const [precise, setPrecise] = useState('');

  useEffect(() => {
    void getClubPlayer(playerId).then((detail) => {
      setPlayer(detail);
      setEquipment(detail.equipment ?? {});
      setConsent(Boolean(detail.equipmentConsentAt));
    }).catch(() => setMessage(t('loadFailed')));
  }, [playerId, t]);

  useEffect(() => {
    if (!player) return;
    void QRCode.toDataURL(player.checkInUrl, { margin: 1, width: 220 }).then(setQr);
  }, [player]);

  if (!player) return <main className="mx-auto max-w-3xl px-4 py-8">{message || '…'}</main>;

  const played = player.wins + player.losses;
  const winRate = player.winRate == null ? (played === 0 ? null : Math.round((player.wins / played) * 100)) : Math.round(player.winRate * 100);
  const chart = player.history.map((point) => ({ at: point.at, rating: point.ratingAfter }));
  const bandKey = player.confidence === 'high' ? 'pbConfidenceHigh' : player.confidence === 'medium' ? 'pbConfidenceMedium' : 'pbConfidenceLow';
  const categoryKey =
    player.category === 'expert' ? 'pbExpert' : player.category === 'advanced' ? 'pbAdvanced' : player.category === 'intermediate' ? 'pbIntermediate' : 'pbBeginner';
  const explainKey = (code: string | null) =>
    code === 'beat_stronger'
      ? 'pbExplainBeatStronger'
      : code === 'expected_win'
        ? 'pbExplainExpectedWin'
        : code === 'lost_to_weaker'
          ? 'pbExplainLostWeaker'
          : code === 'expected_loss'
            ? 'pbExplainExpectedLoss'
            : code === 'increased'
              ? 'pbExplainIncreased'
              : code === 'decreased'
                ? 'pbExplainDecreased'
                : code === 'unchanged'
                  ? 'pbExplainUnchanged'
                  : null;

  async function saveEquipment(next: Equipment | null) {
    setMessage('');
    try {
      const updated = await updateClubPlayer(player!.id, { equipment: next, equipmentConsent: next ? consent : false });
      const detail = await getClubPlayer(updated.id);
      setPlayer(detail);
      setEquipment(detail.equipment ?? {});
      setConsent(Boolean(detail.equipmentConsentAt));
    } catch (error) {
      setMessage(error instanceof ApiError && error.code === 'consent_required' ? t('equipmentConsent') : t('errorGeneric'));
    }
  }

  return (
    <main className="mx-auto grid w-full max-w-3xl gap-4 px-4 py-8">
      <header className="flex items-center gap-4">
        <span className="inline-flex h-16 w-16 items-center justify-center rounded-full bg-ink text-xl font-semibold text-white">{player.initials}</span>
        <div>
          <h1 className="text-3xl font-semibold">{player.displayName}</h1>
          <p className="text-sm text-muted">{player.demo ? t('demoPlayer') : t('guestPlayer')}</p>
        </div>
      </header>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        <Link to="/leaderboard" data-testid="profile-leaderboard" className="inline-flex min-h-11 items-center font-semibold text-accent-dark underline underline-offset-2">
          {t('pbLeaderboard')}
        </Link>
        <Link to="/play" data-testid="profile-play" className="inline-flex min-h-11 items-center font-semibold text-accent-dark underline underline-offset-2">
          {t('pnTitle')}
        </Link>
        <Link to="/players/sample-report" data-testid="profile-sample-report" className="inline-flex min-h-11 items-center font-semibold text-accent-dark underline underline-offset-2">
          {t('srNavLink')}
        </Link>
      </div>
      <Card>
        <p className="text-sm font-semibold">{t('pbRating')}</p>
        <p data-testid="player-rating" className="mt-1 text-4xl font-semibold tabular-nums">{formatRating(player.rating)}</p>
        <p className="mt-1 text-sm font-semibold">{player.provisional ? t('pbProvisional') : t('pbEstablished')}</p>
        <p className="mt-2 text-sm leading-6 text-muted">{t('pbScaleNote')}</p>
        <p className="mt-2">{t('pbCategory')}: {t(categoryKey)}</p>
        <p>{t('pbConfidence')}: {t(bandKey)}</p>
        <p>{t('pbVerifiedMatches')}: {player.matchesPlayed}</p>
        <p>{t('wins')}: {player.wins} · {t('losses')}: {player.losses}</p>
        <p>{t('pbWinRate')}: {winRate === null ? t('notAvailable') : `${winRate}%`}</p>
        <p>{t('pbLastMatch')}: {player.lastMatchAt ? new Date(player.lastMatchAt).toLocaleString(lang === 'vi' ? 'vi' : 'en') : t('notAvailable')}</p>
        <p className="mt-2 break-all text-xs text-muted">{t('pbPlayerId')}: {player.id}</p>
        {player.matchesPlayed === 0 ? (
          <form
            className="mt-4 grid gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              const rating = precise.trim() === '' ? undefined : Number(precise);
              void setStartRating(player.id, startCategory, rating).then((updated) => setPlayer({ ...player, ...updated })).catch(() => setMessage(t('errorGeneric')));
            }}
          >
            <label className="text-sm font-semibold">
              {t('pbCategory')}
              <select className="mt-1 min-h-11 w-full rounded-xl border border-line px-3" value={startCategory} onChange={(event) => setStartCategory(event.target.value)}>
                <option value="beginner">{t('pbBeginner')} 2.50</option>
                <option value="intermediate">{t('pbIntermediate')} 3.50</option>
                <option value="advanced">{t('pbAdvanced')} 4.50</option>
                <option value="expert">{t('pbExpert')} 5.00</option>
              </select>
            </label>
            <label className="text-sm font-semibold">
              {t('pbPreciseStart')}
              <input className="mt-1 min-h-11 w-full rounded-xl border border-line px-3" inputMode="decimal" value={precise} onChange={(event) => setPrecise(event.target.value)} placeholder="3.25" />
            </label>
            <Button type="submit">{t('pbStartSave')}</Button>
          </form>
        ) : null}
        <label className="mt-4 flex items-start gap-3 text-sm">
          <input
            type="checkbox"
            checked={player.leaderboardOptOut}
            onChange={(event) => {
              void updateClubPlayer(player.id, { leaderboardOptOut: event.target.checked }).then(() => setPlayer({ ...player, leaderboardOptOut: event.target.checked }));
            }}
          />
          <span>{t('pbOptOut')}</span>
        </label>
      </Card>
      <Card>
        <h2 className="text-xl font-semibold">{t('performance')}</h2>
        {chart.length > 0 ? <RatingChart points={chart} /> : <p className="mt-2 text-sm text-muted">{t('notAvailable')}</p>}
        <ul className="mt-3 text-sm leading-6 text-muted">
          <li>{t('serveSpeed')}: {t('notAvailable')}</li>
          <li>{t('shotPlacement')}: {t('notAvailable')}</li>
          <li>{t('movement')}: {t('notAvailable')}</li>
        </ul>
      </Card>
      <Card>
        <h2 className="text-xl font-semibold">{t('demoAnalytics')}</h2>
        <p className="mt-2 text-sm leading-6">{lang === 'vi' ? player.simulatedAnalytics.titleVi : player.simulatedAnalytics.titleEn}</p>
        <p className="mt-2 text-sm leading-6 text-muted">{lang === 'vi' ? player.simulatedAnalytics.bodyVi : player.simulatedAnalytics.bodyEn}</p>
      </Card>
      <Card>
        <h2 className="text-xl font-semibold">{t('pbHistory')}</h2>
        {player.ratedMatches.length === 0 ? <p className="mt-2 text-sm text-muted">{t('pbNoHistory')}</p> : (
          <ul className="mt-3 grid gap-3">
            {player.ratedMatches.map((match) => {
              const sentence = explainKey(match.explanation);
              return (
                <li key={match.id} className="rounded-xl border border-line px-3 py-3 text-sm">
                  <p className="font-semibold">
                    {match.scoreFor ?? '–'}–{match.scoreAgainst ?? '–'}
                    {match.ratingChange != null ? <span className="ml-2 tabular-nums">{match.ratingChange >= 0 ? t('pbRatingUp') : t('pbRatingDown')} {formatRatingDelta(match.ratingChange)}</span> : null}
                    {match.demo ? <span className="ml-2 rounded-full bg-line px-2 py-0.5 text-xs">{t('pbDemoRow')}</span> : null}
                  </p>
                  <p className="mt-1 text-muted">{t('pbTeammate')}: {match.teammate?.displayName ?? '—'}</p>
                  <p className="text-muted">{t('pbOpponents')}: {match.opponents.map((person) => person.displayName).join(', ') || '—'}</p>
                  {sentence ? <p className="mt-1">{t(sentence)}</p> : null}
                  {match.sessionToken ? <Link className="mt-1 inline-flex font-semibold text-accent-dark" to={`/watch/${match.sessionToken}`}>{t('pbRecording')}</Link> : null}
                </li>
              );
            })}
          </ul>
        )}
      </Card>
      <Card>
        <h2 className="text-xl font-semibold">{t('equipment')}</h2>
        <p className="mt-2 text-sm leading-6 text-muted">{t('equipmentHelp')}</p>
        <label className="mt-3 flex items-start gap-3">
          <input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} data-testid="equipment-consent" />
          <span>{t('equipmentConsent')}</span>
        </label>
        {(['paddle', 'shoes', 'apparel'] as const).map((kind) => (
          <label key={kind} className="mt-3 block text-sm font-semibold">
            {t(kind)}
            <input
              data-testid={`equipment-${kind}`}
              value={equipment[kind] ?? ''}
              onChange={(event) => setEquipment({ ...equipment, [kind]: event.target.value })}
              className="mt-1 min-h-11 w-full rounded-xl border border-line px-3 font-normal"
            />
          </label>
        ))}
        <div className="mt-4 flex flex-wrap gap-2">
          <Button data-testid="save-equipment" onClick={() => void saveEquipment(equipment)}>{t('saveEquipment')}</Button>
          <Button variant="secondary" onClick={() => void saveEquipment(null)}>{t('removeEquipment')}</Button>
        </div>
        {message ? <p className="mt-2 text-sm">{message}</p> : null}
      </Card>
      <Card>
        <h2 className="text-xl font-semibold">{t('playerQr')}</h2>
        <p className="mt-2 text-sm leading-6 text-muted">{t('playerQrHelp')}</p>
        {qr ? <img src={qr} alt="" className="mt-3 h-40 w-40" data-testid="player-qr" /> : null}
        <p className="mt-2 break-all text-xs text-muted">{player.checkInUrl}</p>
      </Card>
    </main>
  );
}
