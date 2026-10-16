import { Link, Outlet } from 'react-router-dom';
import { useI18n } from '../i18n/context';
import { useConfig } from './Config';

export function Layout() {
  const { t, lang, setLang } = useI18n();
  const { config } = useConfig();
  return (
    <div className="flex min-h-screen min-w-0 flex-col">
      <a href="#content" className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-xl focus:bg-white focus:px-3 focus:py-2">
        {t('skipToContent')}
      </a>
      <header className="border-b border-line bg-card">
        <div className="mx-auto flex w-full max-w-6xl min-w-0 flex-wrap items-center justify-between gap-4 px-4 py-4 sm:px-6">
          <Link to="/" className="flex min-w-0 items-center gap-3">
            <span className="grid h-11 w-11 shrink-0 overflow-hidden rounded-2xl bg-accent">
              <img src="/images/paddle-ball.jpg" alt="" className="h-full w-full object-cover" />
            </span>
            <span className="min-w-0">
              <span className="block truncate text-lg font-semibold tracking-tight">{t('appName')}</span>
              <span className="block truncate text-sm text-muted">{t('headerTag')}</span>
            </span>
          </Link>
          <nav aria-label={t('navLabel')} className="flex max-w-full flex-wrap items-center gap-2">
            <Link to="/" className="inline-flex min-h-10 items-center rounded-xl px-3 py-2 text-sm font-semibold hover:bg-paper">
              {t('home')}
            </Link>
            <Link to="/dashboard" data-testid="facility-dashboard" className="inline-flex min-h-10 items-center rounded-xl px-3 py-2 text-sm font-semibold hover:bg-paper">
              {t('facilityDashboard')}
            </Link>
            <Link to="/players" data-testid="nav-players" className="inline-flex min-h-10 items-center rounded-xl px-3 py-2 text-sm font-semibold hover:bg-paper">
              {t('navPlayers')}
            </Link>
            <Link to="/matchmaking" data-testid="nav-matchmaking" className="inline-flex min-h-10 items-center rounded-xl px-3 py-2 text-sm font-semibold hover:bg-paper">
              {t('navMatchmaking')}
            </Link>
            <Link to="/settings" data-testid="nav-settings" className="inline-flex min-h-10 items-center rounded-xl px-3 py-2 text-sm font-semibold hover:bg-paper">
              {t('navSettings')}
            </Link>
            <div role="group" aria-label={t('languageLabel')} className="flex rounded-xl border border-line bg-paper p-1">
              <button
                type="button"
                data-testid="lang-en"
                aria-pressed={lang === 'en'}
                className={`min-h-10 rounded-lg px-3 text-sm font-semibold ${lang === 'en' ? 'bg-accent text-white' : ''}`}
                onClick={() => setLang('en')}
              >
                {t('langEnglish')}
              </button>
              <button
                type="button"
                data-testid="lang-vi"
                aria-pressed={lang === 'vi'}
                className={`min-h-10 rounded-lg px-3 text-sm font-semibold ${lang === 'vi' ? 'bg-accent text-white' : ''}`}
                onClick={() => setLang('vi')}
              >
                {t('langVietnamese')}
              </button>
            </div>
          </nav>
        </div>
      </header>
      {config?.lanMode ? (
        <div className="bg-amber-100 px-4 py-2 text-center text-sm text-amber-950" role="status">
          {t('lanModeNotice')}
        </div>
      ) : null}
      <main id="content" className="mx-auto w-full min-w-0 max-w-6xl flex-1 px-4 py-8 sm:px-6 sm:py-12">
        <Outlet />
      </main>
      <footer className="border-t border-line px-4 py-8 text-center text-sm text-muted">{t('footerNote')}</footer>
    </div>
  );
}
