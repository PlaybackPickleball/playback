import { describe, expect, it } from 'vitest';
import { lanIPv4, loadConfig } from '../src/config.js';

const root = '/tmp/court-replay-config';

describe('LAN address', () => {
  it('prefers the Wi-Fi adapter over tunnels and loopback', () => {
    expect(
      lanIPv4({
        lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
        utun4: [{ address: '10.8.0.2', family: 'IPv4', internal: false }],
        en0: [{ address: '192.168.1.42', family: 'IPv4', internal: false }],
        en1: [{ address: '10.0.0.5', family: 'IPv4', internal: false }],
      }),
    ).toBe('192.168.1.42');
  });
});

describe('LAN mode config', () => {
  it('stays on localhost when LAN mode is off', () => {
    const config = loadConfig({ LAN_MODE: 'false', HOST: '127.0.0.1' }, root, () => '192.168.1.42');
    expect(config.lanMode).toBe(false);
    expect(config.host).toBe('127.0.0.1');
    expect(config.publicBaseUrl).toBe('http://127.0.0.1:5173');
  });

  it('binds every interface and replaces a localhost URL with the detected address', () => {
    const config = loadConfig(
      { LAN_MODE: 'true', HOST: '127.0.0.1', PUBLIC_BASE_URL: 'http://127.0.0.1:5173' },
      root,
      () => '192.168.1.42',
    );
    expect(config.lanMode).toBe(true);
    expect(config.host).toBe('0.0.0.0');
    expect(config.publicBaseUrl).toBe('http://192.168.1.42:5173');
  });

  it('keeps an explicit non-localhost PUBLIC_BASE_URL', () => {
    const config = loadConfig(
      { LAN_MODE: 'true', PUBLIC_BASE_URL: 'http://10.0.0.8:5173' },
      root,
      () => '192.168.1.42',
    );
    expect(config.host).toBe('0.0.0.0');
    expect(config.publicBaseUrl).toBe('http://10.0.0.8:5173');
  });

  it('uses the server port when LAN mode is on in production', () => {
    const config = loadConfig({ LAN_MODE: 'true', NODE_ENV: 'production', PORT: '8787' }, root, () => '192.168.1.42');
    expect(config.publicBaseUrl).toBe('http://192.168.1.42:8787');
    expect(config.serveStatic).toBe(true);
  });

  it('refuses to publish a localhost QR code when no LAN address exists', () => {
    expect(() => loadConfig({ LAN_MODE: 'true' }, root, () => null)).toThrow(/LAN IPv4/);
  });
});
