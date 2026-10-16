import type { Mode } from '../types';

export type SetupField = `name-${number}` | 'consent';
export type SetupIssueCode = 'name_required' | 'name_too_long' | 'consent_required';

export type SetupIssue = {
  field: SetupField;
  code: SetupIssueCode;
};

/** Singles needs 2 trimmed names, doubles needs 4, plus recording consent. */
export function validateSetup(input: { mode: Mode; names: string[]; consent: boolean }): SetupIssue[] {
  const needed = input.mode === 'singles' ? 2 : 4;
  const issues: SetupIssue[] = [];
  for (let index = 0; index < needed; index += 1) {
    const name = (input.names[index] ?? '').trim();
    if (!name) issues.push({ field: `name-${index}`, code: 'name_required' });
    else if (name.length > 40) issues.push({ field: `name-${index}`, code: 'name_too_long' });
  }
  if (!input.consent) issues.push({ field: 'consent', code: 'consent_required' });
  return issues;
}
