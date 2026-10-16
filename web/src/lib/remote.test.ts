import { describe, expect, it } from 'vitest';
import { remoteRecorderState } from './remote';

const offline = { online: false, ready: false, phase: 'offline' as const, command: null };

describe('phone recorder state', () => {
  it('does not claim the laptop is recording unless the station says so', () => {
    expect(remoteRecorderState(offline, null)).toBe('offline');
    expect(remoteRecorderState(offline, 'recording')).toBe('offline');
    expect(remoteRecorderState({ online: true, ready: false, phase: 'waiting', command: null }, 'draft')).toBe('waiting');
    expect(remoteRecorderState({ online: true, ready: true, phase: 'ready', command: null }, 'draft')).toBe('ready');
    expect(
      remoteRecorderState(
        { online: true, ready: true, phase: 'ready', command: { id: '1', action: 'start', token: 't' } },
        'draft',
      ),
    ).toBe('starting');
    expect(remoteRecorderState({ online: true, ready: true, phase: 'recording', command: null }, 'recording')).toBe('recording');
    expect(remoteRecorderState({ online: true, ready: true, phase: 'saving', command: null }, 'recording')).toBe('saving');
    expect(remoteRecorderState(offline, 'saving')).toBe('saving');
    expect(remoteRecorderState(offline, 'ready')).toBe('saved');
    expect(remoteRecorderState({ online: true, ready: true, phase: 'ready', command: null }, 'failed')).toBe('failed');
  });
});
