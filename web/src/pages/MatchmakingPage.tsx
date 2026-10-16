import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError } from '../api';
import { listClubPlayers, recommendPairings, type ClubPlayer, type MatchmakingResult } from '../clubApi';
import { Button, Card } from '../components/Ui';
import { useI18n } from '../i18n/context';

export function MatchmakingPage() {
  const { t } = useI18n();
  const [players, setPlayers] = useState<ClubPlayer[]>([]);
  const [picked, setPicked] = useState<string[]>([]);
  const [result, setResult] = useState<MatchmakingResult | null>(null);
  const [message, setMessage] = useState('');

  useEffect(() => {
    void listClubPlayers().then((list) => setPlayers(list.players));
  }, []);

  function toggle(id: string) {
    setPicked((current) => {
      if (current.includes(id)) return current.filter((item) => item !== id);
      if (current.length >= 4) return current;
      return [...current, id];
    });
  }

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-8">
      <h1 className="text-3xl font-semibold">{t('matchmaking')}</h1>
      <p className="mt-2 text-sm leading-6 text-muted">{t('matchmakingHelp')}</p>
      <ul className="mt-4 grid gap-2">
        {players.map((player) => (
          <li key={player.id}>
            <label className="flex items-center justify-between gap-3 rounded-2xl border border-line bg-card px-3 py-2">
              <span>
                <input data-testid={`pick-${player.id}`} type="checkbox" className="mr-2" checked={picked.includes(player.id)} onChange={() => toggle(player.id)} />
                {player.displayName}
              </span>
              <span className="text-sm">PIR {player.rating}</span>
            </label>
          </li>
        ))}
      </ul>
      <Button
        className="mt-4"
        data-testid="recommend"
        disabled={picked.length !== 4}
        onClick={() => {
          setMessage('');
          void recommendPairings(picked).then(setResult).catch((error: unknown) => {
            setResult(null);
            setMessage(error instanceof ApiError ? t('matchmakingHelp') : t('errorGeneric'));
          });
        }}
      >
        {t('recommend')}
      </Button>
      {message ? <p className="mt-3 text-sm">{message}</p> : null}
      {result ? (
        <div className="mt-4 grid gap-3">
          {result.pairings.map((pairing, index) => (
            <Card key={index}>
              <p className="font-semibold">
                {index === result.recommendedIndex ? t('recommended') : t('otherSplit')}
              </p>
              <p className="mt-2">{pairing.teamA.map((player) => player.displayName).join(', ')} ({pairing.strengthA})</p>
              <p>{pairing.teamB.map((player) => player.displayName).join(', ')} ({pairing.strengthB})</p>
              <p className="mt-2 text-sm">{t('strengthGap')}: {pairing.gap}</p>
              {index === result.recommendedIndex ? <p className="mt-2 text-sm leading-6 text-muted">{t('closestSplit')}</p> : null}
            </Card>
          ))}
          <Link className="font-semibold text-accent-dark" to="/court/court-1">{t('checkInTitle')}</Link>
        </div>
      ) : null}
    </main>
  );
}
