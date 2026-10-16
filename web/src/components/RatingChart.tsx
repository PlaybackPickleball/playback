export function RatingChart({ points, label }: { points: { at: string; rating: number }[]; label?: string }) {
  if (points.length === 0) return null;
  const width = 320;
  const height = 140;
  const pad = 16;
  const ratings = points.map((point) => point.rating);
  const min = Math.min(...ratings) - 10;
  const max = Math.max(...ratings) + 10;
  const span = Math.max(1, max - min);
  const coords = points.map((point, index) => {
    const x = pad + (points.length === 1 ? (width - pad * 2) / 2 : (index / (points.length - 1)) * (width - pad * 2));
    const y = height - pad - ((point.rating - min) / span) * (height - pad * 2);
    return `${x},${y}`;
  });
  return (
    <svg data-testid="rating-chart" viewBox={`0 0 ${width} ${height}`} className="mt-3 h-36 w-full max-w-md" role="img" aria-label={label}>
      <polyline fill="none" stroke="#0f766e" strokeWidth="3" points={coords.join(' ')} />
      {coords.map((pair) => {
        const [x, y] = pair.split(',');
        return <circle key={pair} cx={x} cy={y} r="4" fill="#14211c" />;
      })}
    </svg>
  );
}
