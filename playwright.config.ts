import { defineConfig, devices } from '@playwright/test';

const e2eEnv = {
  ...process.env,
  HOST: '127.0.0.1',
  PORT: '8787',
  PUBLIC_BASE_URL: 'http://127.0.0.1:5173',
  DATABASE_PATH: 'data/e2e/court-replay.db',
  STORAGE_DIR: 'data/e2e/recordings',
  RECORDING_LIMIT_SECONDS: '600',
  UPLOAD_LIMIT_MB: '512',
  LAN_MODE: 'false',
  NODE_ENV: 'development',
  RESET_STORAGE: 'true',
};

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 180_000,
  expect: { timeout: 20_000 },
  use: {
    baseURL: 'http://127.0.0.1:5173',
    locale: 'en-US',
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    permissions: ['camera', 'microphone', 'clipboard-read', 'clipboard-write'],
    launchOptions: {
      args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
    },
  },
  webServer: [
    {
      command: 'npm run dev:once -w server',
      url: 'http://127.0.0.1:8787/api/health',
      reuseExistingServer: false,
      timeout: 120_000,
      env: e2eEnv,
    },
    {
      command: 'npm run dev -w web',
      url: 'http://127.0.0.1:5173',
      reuseExistingServer: false,
      timeout: 120_000,
      env: e2eEnv,
    },
  ],
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
