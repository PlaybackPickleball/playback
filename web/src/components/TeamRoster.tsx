import { useI18n } from '../i18n/context';
import { endForTeam } from '../lib/match';
import type { EndId } from '../types';

export function TeamRoster({
  teams,
  startingEnds,
  atMs,
  testId = 'team-roster',
}: {
  teams: { A: string[]; B: string[] };
  startingEnds: { A: EndId; B: EndId } | null;
  atMs: number;
  testId?: string;
}) {
  const { t } = useI18n();
  const fixed = startingEnds ?? { A: 1 as const, B: 2 as const };
  const order = (['A', 'B'] as const).slice().sort((left, right) => endForTeam(left, fixed, [], atMs) - endForTeam(right, fixed, [], atMs));

  return (
    <div data-testid={testId} className="grid gap-4 sm:grid-cols-2">
      {order.map((team) => {
        const end = endForTeam(team, fixed, [], atMs);
        return (
          <div
            key={team}
            data-testid={`roster-${team.toLowerCase()}`}
            className="min-w-0 rounded-2xl px-4 py-3 text-white"
            style={{ backgroundColor: team === 'A' ? '#b91c1c' : '#1d4ed8' }}
          >
            <p className="text-sm font-semibold">{t(team === 'A' ? 'teamARed' : 'teamBBlue')}</p>
            <p data-testid={`roster-${team.toLowerCase()}-names`} className="mt-1 text-lg">
              {teams[team].join(', ')}
            </p>
            <p className="mt-1 text-sm">{t('teamNowOnEnd', { team, n: end })}</p>
          </div>
        );
      })}
    </div>
  );
}
