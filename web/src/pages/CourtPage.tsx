import { useEffect } from 'react';
import { Link, useParams } from 'react-router-dom';
import { CheckInPanel } from '../components/CheckInPanel';
import { useConfig } from '../components/Config';
import { Button, Notice, Scene } from '../components/Ui';
import { useI18n } from '../i18n/context';
import { courtNumberFromId } from '../i18n/format';

export function CourtPage() {
  const { courtId = '' } = useParams();
  const { t } = useI18n();
  const { config } = useConfig();
  const known = (config?.courts ?? ['court-1', 'court-2', 'court-3', 'court-4', 'court-5', 'court-6', 'court-7', 'court-8']).includes(courtId);
  const laptop = (config?.recordingCourt ?? 'court-1') === courtId;
  const label = t('courtNumber', { n: courtNumberFromId(courtId) });

  useEffect(() => {
    document.title = known ? `${label} · ${t('appName')}` : t('sessionNotFoundTitle');
  }, [known, label, t]);

  if (!known && config) {
    return (
      <Scene image="net" className="mx-auto max-w-xl px-6 py-12 sm:px-10">
        <section>
          <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">{t('invalidCourt')}</h1>
          <Link to="/" className="mt-8 inline-flex min-h-12 items-center font-semibold text-accent-dark">
            {t('backHome')}
          </Link>
        </section>
      </Scene>
    );
  }

  return (
    <Scene image="net" className="mx-auto max-w-xl px-6 py-12 sm:px-10 sm:py-14">
      <section>
        <p className="text-sm font-semibold text-accent-dark">{label}</p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight text-balance sm:text-4xl">{t('differentDeviceTitle')}</h1>
        <p className="mt-5 text-lg leading-8">{t('differentDeviceBody')}</p>
        <div className="mt-6">
          <Notice tone="warn" title={t('notRemoteControl')} />
        </div>
        <p className="mt-5 text-sm leading-6 text-muted" data-testid="phone-notice">
          {t('phoneQrNotice')}
        </p>
        {laptop ? (
          <Button className="mt-8 w-full sm:w-auto" data-testid="continue-here" onClick={() => { window.location.href = `/setup?court=${courtId}`; }}>
            {t('continueHere')}
          </Button>
        ) : (
          <div className="mt-6">
            <Notice tone="info" title={t('simulatedCourt')} />
          </div>
        )}
        <CheckInPanel courtId={courtId} />
      </section>
    </Scene>
  );
}
