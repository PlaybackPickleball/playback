import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { useI18n } from '../i18n/context';
import { Button, CopyFallback, useCopy } from './Ui';

export function ScorekeeperCard({ url, token }: { url: string; token: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [failed, setFailed] = useState(false);
  const { t } = useI18n();
  const { note, fallback, copy } = useCopy();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !url) return;
    setFailed(false);
    QRCode.toCanvas(canvas, url, { width: 160, margin: 1, color: { dark: '#14211c', light: '#fffcf8' } }).catch(() => setFailed(true));
  }, [url]);

  return (
    <div className="mt-4 border-t border-line pt-4" data-testid="scorekeeper-card">
      <p className="text-sm font-semibold">{t('scorekeeperOpen')}</p>
      <p className="mt-1 text-sm text-muted">{t('scorekeeperHelp')}</p>
      <div className="mx-auto mt-3 w-fit max-w-full rounded-2xl bg-white p-2">
        <canvas ref={canvasRef} data-testid="scorekeeper-qr" role="img" aria-label={t('scorekeeperLink')} className="h-40 w-40 max-w-full" />
      </div>
      {failed ? <p className="mt-2 text-sm [overflow-wrap:anywhere]">{url}</p> : null}
      <label className="mt-3 block text-sm font-semibold" htmlFor="scorekeeper-url">
        {t('scorekeeperLink')}
      </label>
      <input id="scorekeeper-url" data-testid="scorekeeper-url" readOnly value={url} className="mt-1 w-full rounded-xl border border-line bg-white px-3 py-2 text-sm" />
      <Button className="mt-3 w-full" variant="secondary" data-testid="copy-scorekeeper" onClick={() => void copy(url)}>
        {t('copyLink')}
      </Button>
      {note ? (
        <p className="mt-2 text-sm" role="status">
          {note}
        </p>
      ) : null}
      {fallback ? <CopyFallback value={fallback} label={t('copyFallback')} /> : null}
      <a data-testid="open-score-screen" className="mt-3 inline-flex min-h-12 items-center font-semibold text-accent-dark" href={`/score/${token}`} target="_blank" rel="noopener">
        {t('scorekeeperOpen')}
      </a>
    </div>
  );
}
