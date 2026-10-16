import { Link, Outlet, useLocation } from 'react-router-dom';
import { useI18n } from '../i18n/context';
import { useConfig } from './Config';

const tiles = [
  { to: '/play', label: 'navPlayNow', image: '/images/nav-play.jpg', testId: 'nav-play' },
  { to: '/setup?court=court-1', label: 'navRecord', image: '/images/nav-record.jpg', testId: 'nav-record' },
  { to: '/leaderboard', label: 'navLeaderboard', image: '/images/nav-leaderboard.jpg', testId: 'nav-leaderboard' },
  { to: '/players', label: 'navPlayers', image: '/images/nav-players.jpg', testId: 'nav-players' },
  { to: '/dashboard', label: 'navFacility', image: '/images/nav-facility.jpg', testId: 'facility-dashboard' },
  { to: '/players/sample-report', label: 'navSampleReport', image: '/images/nav-stats.jpg', testId: 'nav-sample-report' },
] as const;

function tileActive(pathname: string, to: string) {
  if (to.startsWith('/setup')) return pathname === '/setup';
  if (to === '/players') {
    return pathname === '/players' || (pathname.startsWith('/players/') && !pathname.startsWith('/players/sample-report'));
  }
  return pathname === to;
}

export function Layout() {
  const { t, lang, setLang } = useI18n();
  const { config } = useConfig();
  const { pathname } = useLocation();
  return (
    <div className="flex min-h-screen min-w-0 flex-col">
      <a href="#content" className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-xl focus:bg-white focus:px-3 focus:py-2">
        {t('skipToContent')}
      </a>
      <header className="border-b border-line bg-card">
        <div className="mx-auto w-full max-w-6xl min-w-0 px-4 py-4 sm:px-6">
          <div className="flex min-w-0 items-center justify-between gap-3">
            <Link to="/" className="flex min-w-0 items-center gap-3">
              <span className="grid h-11 w-11 shrink-0 overflow-hidden rounded-2xl bg-accent">
                <img src="/images/paddle-ball.jpg" alt="" className="h-full w-full object-cover" />
              </span>
              <span className="min-w-0">
                <span className="block truncate text-lg font-semibold tracking-tight">{t('appName')}</span>
                <span className="block truncate text-sm text-muted">{t('headerTag')}</span>
              </span>
            </Link>
            <div role="group" aria-label={t('languageLabel')} className="flex shrink-0 rounded-xl border border-line bg-paper p-1">
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
          </div>
          <nav aria-label={t('navLabel')} className="mt-4 grid min-w-0 grid-cols-3 gap-2 sm:gap-3">
            {tiles.map((tile) => {
              const current = tileActive(pathname, tile.to);
              return (
                <Link
                  key={tile.to}
                  to={tile.to}
                  data-testid={tile.testId}
                  aria-current={current ? 'page' : undefined}
                  className={`nav-tile relative flex min-h-32 min-w-0 items-end justify-center rounded-2xl px-2 pb-3 text-center text-sm font-semibold leading-tight text-white focus-visible:z-10 sm:min-h-40 sm:px-3 sm:text-base ${current ? 'ring-2 ring-inset ring-accent' : ''}`}
                >
                  <span className="pointer-events-none absolute inset-0 overflow-hidden rounded-2xl" aria-hidden="true">
                    <img src={tile.image} alt="" className="absolute inset-0 h-full w-full max-w-none object-cover" />
                    <span className="absolute inset-0 bg-gradient-to-t from-[rgb(12_28_26/0.92)] via-[rgb(12_28_26/0.5)] to-[rgb(12_28_26/0.08)]" />
                  </span>
                  <span className="relative z-10 w-full text-balance">{t(tile.label)}</span>
                </Link>
              );
            })}
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
