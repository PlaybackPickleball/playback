import { useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type HTMLAttributes, type ReactNode } from 'react';
import { useI18n } from '../i18n/context';

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'quiet' | 'danger';
};

export function Button({ variant = 'primary', className = '', type = 'button', ...props }: ButtonProps) {
  const styles = {
    primary: 'bg-accent text-white shadow-[0_10px_24px_rgb(15_118_110/0.22)] hover:bg-accent-dark',
    secondary: 'border border-line bg-card text-ink hover:bg-white',
    quiet: 'border border-line bg-card/80 text-ink hover:bg-card',
    danger: 'border border-rose-300 bg-white text-rose-900 hover:bg-rose-50',
  }[variant];
  return (
    <button
      type={type}
      className={`inline-flex min-h-12 max-w-full items-center justify-center rounded-2xl px-5 py-3 text-base font-semibold disabled:cursor-not-allowed disabled:opacity-50 ${styles} ${className}`}
      {...props}
    />
  );
}

const sceneImage = {
  court: '/images/court-empty.jpg',
  net: '/images/court-net.jpg',
  paddle: '/images/paddle-ball.jpg',
} as const;

export function Scene({
  image,
  tone = 'light',
  className = '',
  children,
  ...props
}: HTMLAttributes<HTMLDivElement> & {
  image: keyof typeof sceneImage;
  tone?: 'light' | 'dark' | 'band';
}) {
  return (
    <div className={`scene scene-${tone} ${className}`} {...props}>
      <img src={sceneImage[image]} alt="" className="scene-photo" />
      <div className="scene-scrim" aria-hidden="true" />
      {children}
    </div>
  );
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <section className={`rounded-2xl border border-line bg-card p-4 ${className}`}>{children}</section>;
}

export function Notice({
  tone,
  title,
  children,
}: {
  tone: 'info' | 'warn' | 'bad' | 'good';
  title: string;
  children?: ReactNode;
}) {
  const styles = {
    info: 'border-line bg-card',
    warn: 'border-amber-300 bg-amber-50',
    bad: 'border-rose-300 bg-rose-50',
    good: 'border-emerald-300 bg-emerald-50',
  }[tone];
  return (
    <div className={`rounded-2xl border px-4 py-3 ${styles}`} role={tone === 'bad' ? 'alert' : 'status'}>
      <p className="font-semibold">{title}</p>
      {children ? <div className="mt-1 text-sm leading-6 text-stone-700">{children}</div> : null}
    </div>
  );
}

export function useCopy() {
  const { t } = useI18n();
  const [note, setNote] = useState('');
  const [fallback, setFallback] = useState('');

  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setFallback('');
      setNote(t('linkCopied'));
      return true;
    } catch {
      setFallback(value);
      setNote(t('copyFailed'));
      return false;
    }
  }

  return { note, fallback, copy, clear: () => setNote('') };
}

export function CopyFallback({ value, label }: { value: string; label: string }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, [value]);
  return (
    <label className="mt-3 block text-sm">
      {label}
      <input ref={ref} readOnly value={value} className="mt-1 w-full rounded-xl border border-line bg-white px-3 py-2" />
    </label>
  );
}

export function Dialog({
  open,
  title,
  children,
  testId,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  testId?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      data-testid={testId}
      className="w-[min(32rem,calc(100%-2rem))] max-w-full rounded-3xl border border-line bg-card p-6 text-ink shadow-xl"
    >
      <h2 id={titleId} className="text-xl font-semibold">
        {title}
      </h2>
      <div className="mt-3">{children}</div>
    </dialog>
  );
}
