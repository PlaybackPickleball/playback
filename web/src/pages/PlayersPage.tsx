import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { listClubPlayers, type ClubPlayer } from '../clubApi';
import { useI18n } from '../i18n/context';

export function PlayersPage() {
  const { t } = useI18n();
  const [players, setPlayers] = useState<ClubPlayer[]>([]);
  useEffect(() => {
    void listClubPlayers().then((result) => setPlayers(result.players));
  }, []);
  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-8">
      <h1 className="text-3xl font-semibold">{t('playerList')}</h1>
      <p className="mt-2 text-sm leading-6 text-muted">{t('playerQrHelp')}</p>
      <Link to="/players/sample-report" data-testid="players-sample-report" className="mt-3 inline-flex min-h-11 items-center font-semibold text-accent-dark underline underline-offset-2">
        {t('srNavLink')}
      </Link>
      <ul className="mt-6 grid gap-3">
        {players.map((player) => (
          <li key={player.id}>
            <Link data-testid={`player-${player.id}`} to={`/players/${player.id}`} className="flex items-center justify-between gap-3 rounded-2xl border border-line bg-card px-4 py-3">
              <span>
                <span className="mr-3 inline-flex h-10 w-10 items-center justify-center rounded-full bg-ink font-semibold text-white">{player.initials}</span>
                <span className="font-semibold">{player.displayName}</span>
              </span>
              <span className="text-sm">PIR {player.rating}</span>
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
}
