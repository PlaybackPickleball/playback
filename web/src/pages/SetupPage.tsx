import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ApiError, createSession } from '../api';
import { useConfig } from '../components/Config';
import { Button, Notice, Scene } from '../components/Ui';
import { useI18n } from '../i18n/context';
import { courtNumberFromId } from '../i18n/format';
import { validateSetup, type SetupIssue } from '../lib/setup';
import type { Mode } from '../types';

const empty = ['', '', '', ''];

export function SetupPage() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { config } = useConfig();
  const requested = params.get('court') || 'court-1';
  const courts = config?.courts ?? ['court-1', 'court-2', 'court-3'];
  const courtId = courts.includes(requested) ? requested : '';
  const [mode, setMode] = useState<Mode>('singles');
  const [scoreMode, setScoreMode] = useState<'device' | 'taps'>('device');
  const [names, setNames] = useState(empty);
  const [consent, setConsent] = useState(false);
  const [issues, setIssues] = useState<SetupIssue[]>([]);
  const [submitError, setSubmitError] = useState('');
  const [pending, setPending] = useState(false);

  useEffect(() => {
    document.title = `${t('sessionSetup')} · ${t('appName')}`;
  }, [t]);

  const count = mode === 'singles' ? 2 : 4;
  const slots = useMemo(() => {
    return Array.from({ length: count }, (_, index) => {
      const team = index < count / 2 ? 'A' : 'B';
      const n = team === 'A' ? index + 1 : index - count / 2 + 1;
      return { index, team, n };
    });
  }, [count]);

  function updateName(index: number, value: string) {
    setNames((current) => current.map((name, i) => (i === index ? value : name)));
    setIssues([]);
    setSubmitError('');
  }

  function invalid(field: SetupIssue['field']) {
    return issues.some((issue) => issue.field === field);
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const nextIssues = validateSetup({ mode, names, consent });
    setIssues(nextIssues);
    setSubmitError('');
    if (nextIssues.length) return;
    const activeCourt = courtId || 'court-1';

    const perTeam = mode === 'singles' ? 1 : 2;
    const cleaned = names.slice(0, count).map((name) => name.trim().replace(/\s+/g, ' '));
    setPending(true);
    try {
      const session = await createSession({
        courtId: activeCourt,
        mode,
        consent: true,
        teams: { A: cleaned.slice(0, perTeam), B: cleaned.slice(perTeam) },
        startingEnds: { A: 1, B: 2 },
        endSwitch: 'none',
      });
      try {
        sessionStorage.setItem(`playback-score:${session.token}`, scoreMode);
      } catch {
        /* private mode still opens the recording screen */
      }
      navigate(`/record/${session.token}`);
    } catch (error) {
      const code = error instanceof ApiError ? error.code : 'server_error';
      setIssues([]);
      setSubmitError(code === 'network' ? t('networkError') : code === 'consent_required' ? t('consentError') : t('couldNotCreate'));
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="mx-auto grid min-w-0 max-w-2xl gap-6" noValidate>
      <Scene image="court" className="px-6 py-10 sm:px-8">
        <p className="text-sm font-semibold text-accent-dark">
          {courtId ? t('courtNumber', { n: courtNumberFromId(courtId) }) : t('court')}
        </p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight text-balance sm:text-4xl">{t('sessionSetup')}</h1>
        <p className="mt-4 max-w-xl leading-7">{t('setupHint')}</p>
      </Scene>
      <div className="panel min-w-0 p-5 sm:p-8">
      {issues.length ? (
        <div className="mb-6">
          <Notice tone="bad" title={t('fixErrors')}>
            <ul className="list-disc pl-5">
              {[...new Set(issues.map((issue) => t(issue.code === 'name_required' ? 'nameRequired' : issue.code === 'name_too_long' ? 'nameTooLong' : 'consentError')))].map((error) => (
                <li key={error}>{error}</li>
              ))}
            </ul>
          </Notice>
        </div>
      ) : null}
      {submitError ? (
        <div className="mb-6">
          <Notice tone="bad" title={submitError} />
        </div>
      ) : null}
      <fieldset>
        <legend className="text-sm font-semibold">{t('chooseFormat')}</legend>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {(['singles', 'doubles'] as const).map((option) => (
            <label key={option} className={`rounded-2xl border p-4 ${mode === option ? 'border-accent bg-white ring-2 ring-accent/25' : 'border-line bg-paper'}`}>
              <input
                type="radio"
                name="mode"
                value={option}
                data-testid={`mode-${option}`}
                checked={mode === option}
                onChange={() => {
                  setMode(option);
                  setIssues([]);
                  setSubmitError('');
                }}
                className="mr-2"
              />
              <span className="font-semibold">{t(option)}</span>
              <span className="mt-1 block text-sm text-muted">{t(option === 'singles' ? 'singlesHelp' : 'doublesHelp')}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset className="mt-8">
        <legend className="text-sm font-semibold">{t('scoreWhere')}</legend>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {([
            ['device', 'scoreOnDevice', 'scoreOnDeviceHelp'],
            ['taps', 'scoreOnWatch', 'scoreOnWatchHelp'],
          ] as const).map(([option, label, help]) => (
            <label key={option} className={`rounded-2xl border p-4 ${scoreMode === option ? 'border-accent bg-white ring-2 ring-accent/25' : 'border-line bg-paper'}`}>
              <input
                type="radio"
                name="score-mode"
                value={option}
                data-testid={`score-mode-${option}`}
                checked={scoreMode === option}
                onChange={() => setScoreMode(option)}
                className="mr-2"
              />
              <span className="font-semibold">{t(label)}</span>
              <span className="mt-1 block text-sm text-muted">{t(help)}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <div className="mt-8 grid gap-6 sm:grid-cols-2">
        {(['A', 'B'] as const).map((team) => (
          <fieldset key={team} className="min-w-0 rounded-3xl border border-line bg-paper p-4">
            <legend className="px-1 font-semibold">{t(team === 'A' ? 'teamA' : 'teamB')}</legend>
            <p data-testid={`setup-team-${team.toLowerCase()}-names`} className="mt-2 text-lg">
              {slots
                .filter((slot) => slot.team === team)
                .map((slot) => names[slot.index].trim())
                .filter(Boolean)
                .join(', ') || '—'}
            </p>
            <div className="mt-3 grid gap-3">
              {slots
                .filter((slot) => slot.team === team)
                .map((slot) => (
                  <label key={slot.index} className="block text-sm font-semibold">
                    {t('playerLabel', { n: slot.n })}
                    <input
                      data-testid={`player-name-${slot.index}`}
                      value={names[slot.index]}
                      maxLength={40}
                      required
                      aria-invalid={invalid(`name-${slot.index}`) || undefined}
                      placeholder={t('playerPlaceholder')}
                      onChange={(event) => updateName(slot.index, event.target.value)}
                      className={`mt-1 w-full max-w-full rounded-xl border bg-white px-3 py-3 text-base font-normal ${invalid(`name-${slot.index}`) ? 'border-rose-500 ring-2 ring-rose-200' : 'border-line'}`}
                    />
                  </label>
                ))}
            </div>
          </fieldset>
        ))}
      </div>
      <label className={`mt-6 flex items-start gap-3 rounded-2xl border bg-paper p-4 ${invalid('consent') ? 'border-rose-500 ring-2 ring-rose-200' : 'border-line'}`}>
        <input
          data-testid="consent"
          type="checkbox"
          checked={consent}
          aria-invalid={invalid('consent') || undefined}
          onChange={(event) => {
            setConsent(event.target.checked);
            setIssues([]);
            setSubmitError('');
          }}
          className="mt-1 h-5 w-5"
          required
        />
        <span>
          <span className="font-semibold">{t('consentLabel')}</span>
          <span className="mt-1 block text-sm text-muted">{t('required')}</span>
        </span>
      </label>
      <Button type="submit" data-testid="continue-setup" className="mt-6 w-full sm:w-auto" disabled={pending || !consent}>
        {pending ? t('creatingSession') : t('continue')}
      </Button>
      </div>
    </form>
  );
}
