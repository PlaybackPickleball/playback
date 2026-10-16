import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { CopyFallback, useCopy } from './Ui';
import { Button } from './Ui';
import { useI18n } from '../i18n/context';

export function QrCard({ url, courtLabel }: { url: string; courtLabel: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [failed, setFailed] = useState(false);
  const { t } = useI18n();
  const { note, fallback, copy } = useCopy();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !url) return;
    setFailed(false);
    QRCode.toCanvas(canvas, url, {
      width: 208,
      margin: 1,
      color: { dark: '#1c1917', light: '#fffcf8' },
    }).catch(() => setFailed(true));
  }, [url]);

  return (
    <div className="panel min-w-0 p-5">
      <p className="text-sm font-semibold">{t('scanQr')}</p>
      <div className="mx-auto mt-3 w-fit max-w-full rounded-2xl bg-white p-3">
        <canvas
          ref={canvasRef}
          data-testid="qr-canvas"
          role="img"
          aria-label={t('qrLabel', { court: courtLabel })}
          className="h-52 w-52 max-w-full"
        />
      </div>
      {failed ? <p className="mt-2 text-sm">{url}</p> : null}
      <label className="mt-4 block text-sm font-semibold" htmlFor="court-url">
        {t('courtUrl')}
      </label>
      <input id="court-url" data-testid="court-url" readOnly value={url} className="mt-1 w-full max-w-full rounded-xl border border-line bg-paper px-3 py-2 text-sm" />
      <Button className="mt-3 w-full" variant="secondary" data-testid="copy-court-url" onClick={() => void copy(url)}>
        {t('copyCourtLink')}
      </Button>
      {note ? <p className="mt-2 text-sm" role="status">{note}</p> : null}
      {fallback ? <CopyFallback value={fallback} label={t('copyFallback')} /> : null}
      <p className="mt-3 text-sm leading-6 text-muted">{t('phoneQrNotice')}</p>
    </div>
  );
}
