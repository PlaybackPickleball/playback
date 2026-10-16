import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ApiError, getPerson, setBalance } from '../api';
import { Button, Notice, Scene } from '../components/Ui';
import { useI18n } from '../i18n/context';
import { courtNumberFromId, formatWhen } from '../i18n/format';
import type { FacilityPersonDetail } from '../types';

function channelName(channel: 'zalo' | 'whatsapp'): string {
  return channel === 'whatsapp' ? 'WhatsApp' : 'Zalo';
}

export function PersonPage() {
  const { personId = '' } = useParams();
  const { t, lang } = useI18n();
  const [person, setPerson] = useState<FacilityPersonDetail | null>(null);
  const [missing, setMissing] = useState(false);
  const [draft, setDraft] = useState('0');
  const [message, setMessage] = useState('');

  useEffect(() => {
    document.title = `${t('peopleTitle')} · ${t('appName')}`;
  }, [t]);

  useEffect(() => {
    let cancelled = false;
    getPerson(personId)
      .then((loaded) => {
        if (cancelled) return;
        setPerson(loaded);
        setDraft(String(loaded.balance));
      })
      .catch(() => {
        if (!cancelled) setMissing(true);
      });
    return () => {
      cancelled = true;
    };
  }, [personId]);

  async function save() {
    if (!/^-?\d+$/.test(draft.trim())) {
      setMessage(t('invalidBalance'));
      return;
    }
    const balance = Number(draft);
    if (!Number.isSafeInteger(balance) || balance < -1_000_000 || balance > 1_000_000) {
      setMessage(t('invalidBalance'));
      return;
    }
    try {
      const updated = await setBalance(personId, balance);
      setPerson(updated);
      setDraft(String(updated.balance));
      setMessage(t('demoBalanceHelp'));
    } catch (error) {
      setMessage(error instanceof ApiError ? t('invalidBalance') : t('loadFailed'));
    }
  }

  if (missing) {
    return (
      <Scene image="net" data-testid="person-missing" className="max-w-xl px-6 py-12 sm:px-10">
        <h1 className="text-3xl font-semibold tracking-tight">{t('personMissing')}</h1>
        <Link to="/dashboard" className="mt-8 inline-flex min-h-12 items-center font-semibold text-accent-dark">
          {t('returnDashboard')}
        </Link>
      </Scene>
    );
  }

  if (!person) return <p>{t('loading')}</p>;

  return (
    <section className="min-w-0">
      <Scene image="paddle" className="max-w-3xl px-6 py-10 sm:px-8">
        <p className="text-sm font-semibold text-accent-dark">{t('appName')}</p>
        <h1 data-testid="person-name" className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">
          {person.name}
        </h1>
        <p className="mt-3" data-testid="person-channel">
          {channelName(person.channel)} · {person.phone}
        </p>
        <p className="mt-1 text-sm text-muted">{t('videosValue', { count: person.videoCount })}</p>
      </Scene>
      <div className="mt-4">
        <Notice tone="info" title={t('demoAdminNote')}>
          {t('demoBalanceHelp')}
        </Notice>
      </div>
      <form
        className="panel mt-6 max-w-sm p-5"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <label className="text-sm font-semibold">
          {t('demoBalance')}
          <span className="mt-1 block font-normal text-muted">{t('balanceLabel')}</span>
          <input
            data-testid="balance-input"
            inputMode="numeric"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            className="mt-2 w-full max-w-full rounded-xl border border-line bg-white px-3 py-3 font-normal"
          />
        </label>
        <p data-testid="balance-value" className="mt-3 text-3xl font-semibold">
          {person.balance}
        </p>
        <Button data-testid="save-balance" type="submit" className="mt-3">
          {t('saveBalance')}
        </Button>
      </form>
      {message ? (
        <p className="mt-3 text-sm" role="status">
          {message}
        </p>
      ) : null}
      <h2 className="mt-8 text-xl font-semibold">{t('personVideos')}</h2>
      {person.videos.length === 0 ? (
        <p className="mt-2" data-testid="person-no-videos">
          {t('personNoVideos')}
        </p>
      ) : (
        <ul className="mt-3 grid gap-3" data-testid="person-videos">
          {person.videos.map((video) => (
            <li key={video.token} className="panel min-w-0 p-5">
              <p className="font-semibold">{video.playerNames}</p>
              <p className="mt-1 text-sm">
                {t('courtNumber', { n: courtNumberFromId(video.courtId) })} · {formatWhen(video.createdAt, lang)}
              </p>
              <p className="mt-1 text-sm">{video.marketing ? t('marketingAgreed') : t('marketingDeclined')}</p>
              {video.optedOut ? <p className="mt-1 text-sm">{t('optedOut')}</p> : null}
              <Link
                to={`/watch/${video.token}`}
                className="mt-4 inline-flex min-h-12 items-center rounded-2xl bg-accent px-4 font-semibold text-white shadow-[0_10px_24px_rgb(15_118_110/0.22)]"
              >
                {t('openVideo')}
              </Link>
            </li>
          ))}
        </ul>
      )}
      <Link to="/dashboard" className="mt-6 inline-flex min-h-12 items-center font-semibold text-accent-dark">
        {t('returnDashboard')}
      </Link>
    </section>
  );
}
