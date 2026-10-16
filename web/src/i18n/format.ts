import type { MessageKey } from './en';

export function matchStatusLabel(status: string, t: (key: MessageKey) => string): string {
  const key =
    status === 'scheduled'
      ? 'statusScheduled'
      : status === 'ready'
        ? 'matchDeskReady'
        : status === 'recording'
          ? 'recording'
          : status === 'completed'
            ? 'statusCompleted'
            : status === 'verified'
              ? 'statusVerified'
              : null;
  return key ? t(key) : status;
}

export function activityLabel(activity: string, t: (key: MessageKey) => string): string {
  const key =
    activity === 'idle'
      ? 'activityIdle'
      : activity === 'in-use'
        ? 'activityInUse'
        : activity === 'between-games'
          ? 'activityBetween'
          : activity === 'reserved'
            ? 'activityReserved'
            : null;
  return key ? t(key) : matchStatusLabel(activity, t);
}

export function formatTemplate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (_, key: string) => String(vars[key] ?? `{${key}}`));
}

export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

export function formatSpoken(ms: number, lang: 'en' | 'vi'): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (lang === 'vi') {
    if (minutes === 0) return `${seconds} giây`;
    if (seconds === 0) return `${minutes} phút`;
    return `${minutes} phút ${seconds} giây`;
  }
  if (minutes === 0) return `${seconds} sec`;
  if (seconds === 0) return `${minutes} min`;
  return `${minutes} min ${seconds} sec`;
}

export function formatWhen(iso: string, lang: 'en' | 'vi'): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(lang === 'vi' ? 'vi-VN' : 'en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function isLocalUrl(value: string): boolean {
  try {
    const host = new URL(value).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
  } catch {
    return false;
  }
}

export function courtNumberFromId(courtId: string): number {
  const match = /^court-(\d+)$/.exec(courtId);
  return match ? Number(match[1]) : 0;
}
