import { useState, type FormEvent } from 'react';
import { ApiError, optOutContact, saveContact } from '../api';
import { Button, Scene } from './Ui';
import { useI18n } from '../i18n/context';
import { formatWhen } from '../i18n/format';
import { normalizePhone } from '../lib/match';
import type { ContactChannel, PublicSession } from '../types';

export function ContactScreen({
  session,
  onSaved,
  onSkip,
}: {
  session: PublicSession;
  onSaved: (session: PublicSession) => void;
  onSkip: () => void;
}) {
  const { t, lang } = useI18n();
  const contact = session.contact;
  const showForm = !contact || contact.optedOutAt != null;
  const players = [...session.teams.A, ...session.teams.B].join(', ');
  const [name, setName] = useState(contact?.playerNames || players);
  const [channel, setChannel] = useState<ContactChannel>(contact?.channel ?? 'zalo');
  const [phone, setPhone] = useState('');
  const [marketing, setMarketing] = useState(false);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const cleaned = name.trim().replace(/\s+/g, ' ');
    if (cleaned.length < 1 || cleaned.length > 80) {
      setError(t('contactNameRequired'));
      return;
    }
    if (!normalizePhone(phone)) {
      setError(t('invalidPhone'));
      return;
    }
    setPending(true);
    setError('');
    try {
      const updated = await saveContact(session.token, {
        phone,
        language: lang,
        marketingConsent: marketing,
        channel,
        name: cleaned,
      });
      onSaved(updated);
    } catch (caught) {
      const code = caught instanceof ApiError ? caught.code : '';
      setError(code === 'invalid_phone' ? t('invalidPhone') : code === 'network' ? t('networkError') : t('errorGeneric'));
    } finally {
      setPending(false);
    }
  }

  async function onOptOut() {
    setPending(true);
    try {
      onSaved(await optOutContact(session.token));
      setError('');
    } catch {
      setError(t('errorGeneric'));
    } finally {
      setPending(false);
    }
  }

  if (!showForm && contact) {
    return (
      <Scene image="paddle" data-testid="contact-screen" className="px-6 py-10 sm:px-10">
        <h2 className="text-3xl font-semibold tracking-tight sm:text-4xl">{t('contactTitle')}</h2>
        <div className="panel mt-6 max-w-xl p-5 text-sm sm:p-6" data-testid="zalo-saved">
          <p className="font-semibold">{t('contactSavedFor')}</p>
          <p className="mt-2">{contact.playerNames}</p>
          <p className="mt-1">{contact.channel === 'whatsapp' ? 'WhatsApp' : 'Zalo'} · {contact.phone}</p>
          <p className="mt-2">{t('zaloSaved')}</p>
          <p className="mt-1">
            {contact.marketingConsentAt ? formatWhen(contact.marketingConsentAt, lang) : t('marketingOptional')}
          </p>
          <p className="mt-1">{t('zaloNotSent')}</p>
          <Button data-testid="opt-out-contact" variant="secondary" className="mt-4" disabled={pending} onClick={() => void onOptOut()}>
            {t('optOut')}
          </Button>
        </div>
        {error ? <p className="mt-3 text-sm" role="alert">{error}</p> : null}
      </Scene>
    );
  }

  return (
    <Scene image="paddle" data-testid="contact-screen" className="px-6 py-10 sm:px-10 sm:py-12">
      <p className="text-sm font-semibold text-accent-dark">PlayBack</p>
      <h1 className="mt-3 max-w-xl text-4xl font-semibold tracking-tight text-balance">{t('contactTitle')}</h1>
      <p className="mt-4 max-w-xl text-lg leading-8">{t('contactLead')}</p>
      <form onSubmit={onSubmit} data-testid="zalo-form" className="panel mt-8 grid max-w-xl gap-5 p-5 sm:p-6" noValidate>
        <label className="text-sm font-semibold">
          {t('contactNameLabel')}
          <input
            data-testid="contact-name"
            value={name}
            maxLength={80}
            required
            onChange={(event) => setName(event.target.value)}
            className="mt-1 w-full max-w-full rounded-2xl border border-line bg-white px-3 py-3 text-base font-normal"
          />
        </label>
        <fieldset>
          <legend className="text-sm font-semibold">{t('channelLabel')}</legend>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            {(['zalo', 'whatsapp'] as const).map((option) => (
              <label key={option} className={`rounded-2xl border px-4 py-3 ${channel === option ? 'border-accent bg-white ring-2 ring-accent/25' : 'border-line bg-paper'}`}>
                <input
                  type="radio"
                  name="channel"
                  value={option}
                  data-testid={option === 'zalo' ? 'channel-zalo' : 'channel-whatsapp'}
                  checked={channel === option}
                  onChange={() => setChannel(option)}
                  className="mr-2"
                />
                <span className="font-semibold">{t(option === 'zalo' ? 'channelZalo' : 'channelWhatsApp')}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <label className="text-sm font-semibold">
          {channel === 'zalo' ? t('zaloPhoneLabel') : t('whatsappPhoneLabel')}
          <input
            data-testid="zalo-phone"
            value={phone}
            inputMode="tel"
            autoComplete="tel"
            required
            onChange={(event) => setPhone(event.target.value)}
            className="mt-1 w-full max-w-full rounded-2xl border border-line bg-white px-3 py-3 text-base font-normal"
          />
        </label>
        <label className="flex items-start gap-3 text-sm">
          <input
            data-testid="marketing-consent"
            type="checkbox"
            checked={marketing}
            onChange={(event) => setMarketing(event.target.checked)}
            className="mt-1 h-5 w-5"
          />
          <span>
            <span className="font-semibold">{t('marketingConsent')}</span>
            <span className="mt-1 block text-muted">{t('marketingOptional')}</span>
          </span>
        </label>
        {contact?.optedOutAt ? (
          <p className="text-sm font-semibold" data-testid="zalo-opted-out">
            {t('optedOut')}
          </p>
        ) : null}
        {error ? <p className="text-sm" role="alert">{error}</p> : null}
        <Button data-testid="save-zalo-contact" type="submit" disabled={pending}>
          {pending ? t('pleaseWait') : t('contactSave')}
        </Button>
        <Button data-testid="skip-contact" type="button" variant="quiet" onClick={onSkip}>
          {t('contactSkip')}
        </Button>
      </form>
    </Scene>
  );
}
