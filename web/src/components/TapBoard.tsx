import type { TapSide, TeamId } from '../lib/score';

export function TapBoard({
  sides,
  teams,
  points,
  teamLabel,
  flash,
  disabled,
  onTap,
  leftLabel,
  rightLabel,
  fill,
}: {
  sides: { left: TeamId; right: TeamId };
  teams: { A: string[]; B: string[] };
  points: { A: number; B: number };
  teamLabel: (team: TeamId) => string;
  flash: TapSide | null;
  disabled: boolean;
  onTap: (side: TapSide) => void;
  leftLabel: string;
  rightLabel: string;
  fill?: boolean;
}) {
  return (
    <div className={`grid min-h-0 grid-cols-2 gap-1 ${fill ? 'min-h-0 flex-1' : 'min-h-64 sm:min-h-80'}`}>
      {(['left', 'right'] as const).map((side) => {
        const team = sides[side];
        const names = teams[team].join(', ');
        const hot = flash === side;
        return (
          <button
            key={side}
            type="button"
            data-testid={`tap-${side}`}
            data-team={team}
            disabled={disabled}
            aria-label={side === 'left' ? leftLabel : rightLabel}
            onPointerDown={(event) => {
              if (disabled || event.button > 0) return;
              event.currentTarget.dataset.skipClick = '1';
              onTap(side);
            }}
            onClick={(event) => {
              if (event.currentTarget.dataset.skipClick === '1') {
                delete event.currentTarget.dataset.skipClick;
                return;
              }
              if (!disabled) onTap(side);
            }}
            className={`tap-target flex min-w-0 flex-col items-center justify-center gap-1 overflow-hidden rounded-2xl px-2 py-3 text-center transition-colors duration-150 active:bg-white active:text-black disabled:opacity-40 ${
              hot ? 'bg-white text-black' : team === 'A' ? 'bg-[#b91c1c] text-white' : 'bg-[#1d4ed8] text-white'
            }`}
          >
            <span className="max-w-full text-[clamp(0.8rem,3.4vw,1.05rem)] font-semibold tracking-wide">{teamLabel(team)}</span>
            <span data-testid={`tap-${side}-names`} className="max-w-full text-[clamp(0.95rem,4vw,1.35rem)] leading-tight [overflow-wrap:anywhere]">
              {names || '—'}
            </span>
            <span data-testid={`tap-${side}-points`} className="mt-1 text-[clamp(2.6rem,18vw,6rem)] font-semibold leading-none tabular-nums">
              {points[team]}
            </span>
          </button>
        );
      })}
    </div>
  );
}
