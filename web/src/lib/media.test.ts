import { describe, expect, it } from 'vitest';
import { en } from '../i18n/en';
import { vi } from '../i18n/vi';
import { cameraBlockReason, cameraFailure, openAssignedCameras, openCamera } from './media';

const laptop = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';
const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

describe('insecure LAN camera origin', () => {
  it('blocks a LAN http host and still allows localhost', () => {
    expect(cameraBlockReason({ protocol: 'http:', hostname: '192.168.1.20', userAgent: laptop })).toBe('insecure');
    expect(cameraBlockReason({ protocol: 'http:', hostname: '10.0.0.8', userAgent: laptop })).toBe('insecure');
    expect(cameraBlockReason({ protocol: 'http:', hostname: '172.16.4.2', userAgent: laptop })).toBe('insecure');
    expect(cameraBlockReason({ protocol: 'http:', hostname: '127.0.0.1', userAgent: laptop })).toBeNull();
    expect(cameraBlockReason({ protocol: 'http:', hostname: 'localhost', userAgent: laptop })).toBeNull();
    expect(cameraBlockReason({ protocol: 'http:', hostname: '::1', userAgent: laptop })).toBeNull();
    expect(cameraBlockReason({ protocol: 'https:', hostname: '192.168.1.20', userAgent: laptop })).toBeNull();
  });

  it('does not call getUserMedia for an insecure LAN origin', async () => {
    let calls = 0;
    const requestUserMedia = async () => {
      calls += 1;
      return {} as MediaStream;
    };
    await expect(
      openCamera(false, 'facetime', {
        protocol: 'http:',
        hostname: '192.168.0.12',
        userAgent: laptop,
        requestUserMedia,
      }),
    ).rejects.toMatchObject({ name: 'SecurityError' });
    await expect(
      openAssignedCameras(true, { 1: 'facetime', 2: 'other' }, {
        protocol: 'http:',
        hostname: '192.168.0.12',
        userAgent: laptop,
        requestUserMedia,
      }),
    ).rejects.toMatchObject({ name: 'SecurityError' });
    expect(calls).toBe(0);
  });

  it('still opens a named camera on http://127.0.0.1', async () => {
    let calls = 0;
    const stream = {} as MediaStream;
    const opened = await openCamera(false, 'facetime', {
      protocol: 'http:',
      hostname: '127.0.0.1',
      userAgent: laptop,
      requestUserMedia: async (constraints) => {
        calls += 1;
        expect(constraints).toEqual({ video: { deviceId: { exact: 'facetime' } }, audio: false });
        return stream;
      },
    });
    expect(calls).toBe(1);
    expect(opened.stream).toBe(stream);
    expect(opened.mic).toBe('off');
  });

  it('keeps a phone off the camera, including on a LAN address', async () => {
    let calls = 0;
    expect(cameraBlockReason({ protocol: 'http:', hostname: '192.168.1.20', userAgent: iphone })).toBe('phone');
    expect(cameraBlockReason({ protocol: 'http:', hostname: '127.0.0.1', userAgent: iphone })).toBe('phone');
    await expect(
      openCamera(false, '', {
        protocol: 'http:',
        hostname: '192.168.1.20',
        userAgent: iphone,
        requestUserMedia: async () => {
          calls += 1;
          return {} as MediaStream;
        },
      }),
    ).rejects.toMatchObject({ name: 'PhoneRecordingError' });
    expect(calls).toBe(0);
    expect(en.phoneRecordingTitle).toBe('Recording stays on the laptop.');
    expect(en.phoneRecordingHelp).not.toMatch(/Chrome|Edge/);
    expect(vi.phoneRecordingHelp).not.toMatch(/Chrome|Edge/);
  });

  it('tells the laptop to open http://127.0.0.1:5173 in English and Vietnamese', () => {
    expect(en.insecureOrigin).toContain('http://127.0.0.1:5173');
    expect(vi.insecureOrigin).toContain('http://127.0.0.1:5173');
    expect(en.insecureOrigin).not.toBe(vi.insecureOrigin);
  });

  it('keeps permission, missing, and busy camera errors distinct', () => {
    expect(cameraFailure(new DOMException('no', 'NotAllowedError'))).toBe('permission');
    expect(cameraFailure(new DOMException('no', 'NotFoundError'))).toBe('missing');
    expect(cameraFailure(new DOMException('no', 'NotReadableError'))).toBe('busy');
    expect(cameraFailure(new DOMException('no', 'SecurityError'))).toBe('insecure');
    expect(cameraFailure(new TypeError('mediaDevices'))).toBe('generic');
  });
});
