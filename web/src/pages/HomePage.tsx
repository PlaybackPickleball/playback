import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { QrCard } from '../components/QrCard';
import { useConfig } from '../components/Config';
import { Button, Notice, Scene } from '../components/Ui';
import { useI18n } from '../i18n/context';
import { courtNumberFromId } from '../i18n/format';

export function HomePage() {
  const { t } = useI18n();
  const { config, failed } = useConfig();
  const navigate = useNavigate();
  const courts = config?.courts ?? ['court-1'];
  const recordingCourt = config?.recordingCourt ?? 'court-1';
  const [courtId, setCourtId] = useState('court-1');

  useEffect(() => {
    document.title = t('appName');
  }, [t]);

  const courtLabel = t('courtNumber', { n: courtNumberFromId(courtId) });
  const courtUrl = config ? `${config.publicBaseUrl}/court/${courtId}` : '';

  return (
    <div className="grid min-w-0 items-start gap-8 lg:grid-cols-[minmax(0,1.2fr)_20rem]">
      <Scene image="court" className="min-w-0 px-6 py-10 sm:px-10 sm:py-14">
        <section className="max-w-2xl">
          <h1 className="text-4xl font-semibold tracking-tight text-balance sm:text-5xl">{t('homeTitle')}</h1>
          <p className="mt-5 max-w-xl text-lg leading-8">{t('laptopDemoNote')}</p>
          <div className="mt-6">
            <Notice tone="info" title={t('footageNote')} />
          </div>
          <div className="mt-8">
            <label htmlFor="court-select" className="text-sm font-semibold">
              {t('chooseCourt')}
            </label>
            <select
              id="court-select"
              data-testid="court-select"
              className="mt-2 w-full max-w-xs rounded-2xl border border-line bg-card px-3 py-3 text-base"
              value={courtId}
              onChange={(event) => setCourtId(event.target.value)}
            >
              {courts.map((id) => (
                <option key={id} value={id}>
                  {t('courtNumber', { n: courtNumberFromId(id) })}
                </option>
              ))}
            </select>
          </div>
          <div className="mt-8">
            {courtId === recordingCourt ? (
              <Button data-testid="start-session" className="w-full sm:w-auto sm:min-w-52" onClick={() => navigate(`/setup?court=${courtId}`)}>
                {t('startSession')}
              </Button>
            ) : (
              <div className="grid gap-3">
                <Notice tone="info" title={t('simulatedCourt')} />
                <Link to={`/court/${courtId}`} className="inline-flex min-h-12 items-center font-semibold text-accent-dark">
                  {t('openCourt')}
                </Link>
              </div>
            )}
            <Link to="/dashboard" className="mt-4 inline-flex min-h-12 items-center font-semibold text-accent-dark">
              {t('facilityDashboard')}
            </Link>
            <Link to="/players/sample-report" data-testid="home-sample-report" className="mt-1 flex min-h-12 items-center font-semibold text-accent-dark">
              {t('srNavLink')}
            </Link>
          </div>
          <p className="mt-4 max-w-xl text-sm leading-6 text-muted">{t('demoAdminNote')}</p>
          {failed ? (
            <div className="mt-4">
              <Notice tone="bad" title={t('loadFailed')} />
            </div>
          ) : null}
        </section>
      </Scene>
      {courtUrl ? (
        <div className="grid min-w-0 gap-4">
          <Scene image="paddle" tone="band" aria-hidden="true" className="h-40 sm:h-44" />
          {config?.lanMode ? (
            <p className="text-sm leading-6" data-testid="lan-qr-note">
              {t('lanQrNote')}
            </p>
          ) : null}
          <QrCard url={courtUrl} courtLabel={courtLabel} />
        </div>
      ) : (
        <p>{t('loading')}</p>
      )}
    </div>
  );
}
