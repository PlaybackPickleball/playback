import { useState } from 'react';
import { ApiError } from '../api';
import { resetDemoData } from '../clubApi';
import { Button, Card } from '../components/Ui';
import { useI18n } from '../i18n/context';

export function SettingsPage() {
  const { t, lang, setLang } = useI18n();
  const [confirm, setConfirm] = useState('');
  const [message, setMessage] = useState('');

  return (
    <main className="mx-auto grid w-full max-w-3xl gap-4 px-4 py-8">
      <h1 className="text-3xl font-semibold">{t('settings')}</h1>
      <Card>
        <h2 className="text-xl font-semibold">{t('language')}</h2>
        <div className="mt-3 flex gap-2">
          <button type="button" className={`min-h-11 rounded-xl px-4 font-semibold ${lang === 'en' ? 'bg-ink text-white' : 'border border-line'}`} onClick={() => setLang('en')}>{t('langEnglish')}</button>
          <button type="button" className={`min-h-11 rounded-xl px-4 font-semibold ${lang === 'vi' ? 'bg-ink text-white' : 'border border-line'}`} onClick={() => setLang('vi')}>{t('langVietnamese')}</button>
        </div>
      </Card>
      <Card>
        <h2 className="text-xl font-semibold">{t('privacyTitle')}</h2>
        <p className="mt-2 text-sm leading-6 text-muted">{t('privacyBody')}</p>
        <p className="mt-2 text-sm leading-6 text-muted">{t('possessionLink')}</p>
        <p className="mt-2 text-sm leading-6 text-muted">{t('noBiometrics')}</p>
      </Card>
      <Card>
        <h2 className="text-xl font-semibold">{t('resetDemo')}</h2>
        <p className="mt-2 text-sm leading-6 text-muted">{t('resetDemoHelp')}</p>
        <input data-testid="reset-confirm" value={confirm} onChange={(event) => setConfirm(event.target.value)} className="mt-3 min-h-12 w-full rounded-xl border border-line px-3" />
        <Button
          className="mt-3"
          variant="secondary"
          data-testid="reset-demo"
          disabled={confirm !== 'RESET DEMO'}
          onClick={() => {
            void resetDemoData()
              .then(() => setMessage(t('resetDone')))
              .catch((error: unknown) => setMessage(error instanceof ApiError ? t('resetDemoHelp') : t('errorGeneric')));
          }}
        >
          {t('resetDemo')}
        </Button>
        {message ? <p className="mt-2 text-sm">{message}</p> : null}
      </Card>
    </main>
  );
}
