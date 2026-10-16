import { Link } from 'react-router-dom';
import { Scene } from '../components/Ui';
import { useI18n } from '../i18n/context';

export function NotFoundPage() {
  const { t } = useI18n();
  return (
    <Scene image="net" data-testid="not-found" className="max-w-xl px-6 py-12 sm:px-10">
      <h1 className="text-3xl font-semibold tracking-tight">{t('sessionNotFoundTitle')}</h1>
      <p className="mt-4 leading-7">{t('sessionNotFoundBody')}</p>
      <Link to="/" className="mt-8 inline-flex min-h-12 items-center font-semibold text-accent-dark">
        {t('goHome')}
      </Link>
    </Scene>
  );
}
