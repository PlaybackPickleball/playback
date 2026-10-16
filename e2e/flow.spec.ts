import { expect, test, type Page } from '@playwright/test';
import jsQR from 'jsqr';

async function decodeQr(page: Page) {
  const image = await page.locator('[data-testid="qr-canvas"]').evaluate((canvas: HTMLCanvasElement) => {
    const ctx = canvas.getContext('2d');
    if (!ctx || canvas.width === 0) return null;
    const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return { data: Array.from(data), width, height };
  });
  if (!image) return null;
  const code = jsQR(new Uint8ClampedArray(image.data), image.width, image.height);
  return code?.data ?? null;
}

async function waitElapsed(page: Page, ms: number) {
  await page.waitForFunction((target) => {
    const timer = document.querySelector('[data-testid="timer"]');
    return Number(timer?.getAttribute('data-ms') || 0) >= target;
  }, ms);
}

async function startSingles(page: Page, playerA: string, playerB: string) {
  await page.getByTestId('lang-en').click();
  await page.getByTestId('start-session').click();
  await page.getByTestId('player-name-0').fill(playerA);
  await page.getByTestId('player-name-1').fill(playerB);
  await expect(page.getByTestId('continue-setup')).toBeDisabled();
  await page.getByTestId('consent').check();
  await page.getByTestId('continue-setup').click();
  await expect(page).toHaveURL(/\/record\//);
}

test('court QR does not request a camera and decodes to the court URL', async ({ page }) => {
  await page.addInitScript(() => {
    const media = navigator.mediaDevices;
    const original = media.getUserMedia.bind(media);
    (window as unknown as { __gum: number }).__gum = 0;
    media.getUserMedia = async (constraints) => {
      (window as unknown as { __gum: number }).__gum += 1;
      return original(constraints);
    };
  });
  await page.goto('/');
  await expect(page.getByText('This demo records with the laptop camera.')).toBeVisible();
  await expect(page.getByTestId('court-url')).toHaveValue('http://127.0.0.1:5173/court/court-1');
  await expect.poll(() => decodeQr(page)).toBe('http://127.0.0.1:5173/court/court-1');
  await page.goto('/court/court-1');
  await expect(page.getByTestId('phone-notice')).toContainText('only');
  await expect(page.getByRole('heading', { name: 'A phone does not control the laptop camera' })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __gum: number }).__gum)).toBe(0);
});

test('records a session with scores, highlights, replay, download, and delete', async ({ page, context }) => {
  const consoleErrors: string[] = [];
  const notFoundUrls: string[] = [];
  page.on('pageerror', (error) => consoleErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('response', (response) => {
    if (response.status() === 404) notFoundUrls.push(response.url());
  });
  await page.addInitScript(() => {
    const media = navigator.mediaDevices;
    const original = media.getUserMedia.bind(media);
    (window as unknown as { __gum: number }).__gum = 0;
    media.getUserMedia = async (constraints) => {
      (window as unknown as { __gum: number }).__gum += 1;
      return original(constraints);
    };
  });

  await page.goto('/');
  await startSingles(page, 'Lan', 'Minh');
  expect(await page.evaluate(() => (window as unknown as { __gum: number }).__gum)).toBe(0);
  await page.getByTestId('enable-camera').click();
  await expect(page.getByTestId('end-2-unavailable')).toBeVisible();
  await expect(page.getByTestId('preview-end-2')).toHaveCount(0);
  await expect.poll(async () => page.getByTestId('preview').evaluate((video: HTMLVideoElement) => video.videoWidth)).toBeGreaterThan(0);
  await page.getByTestId('test-preview').click();
  await expect(page.getByTestId('status-message')).toContainText('Preview looks good');
  await page.getByTestId('start-recording').click();
  await expect(page.getByTestId('rec-status')).toHaveText('Recording');
  await waitElapsed(page, 3000);
  await page.getByTestId('mark-highlight').click();
  await waitElapsed(page, 8000);
  await page.getByTestId('score-a').click();
  await page.getByTestId('score-b').click();
  await page.getByTestId('score-a').click();
  await page.getByTestId('undo-score').click();
  await expect(page.getByTestId('score-a-value')).toHaveText('1');
  await expect(page.getByTestId('score-b-value')).toHaveText('1');
  const elapsedBeforeLanguage = Number(await page.getByTestId('timer').getAttribute('data-ms'));
  await page.getByTestId('lang-vi').click();
  await expect(page.getByTestId('rec-status')).toHaveText('Đang quay');
  await expect(page.getByTestId('score-a-value')).toHaveText('1');
  await expect(page.getByTestId('score-b-value')).toHaveText('1');
  await expect(page.getByText('Lan, Minh')).toBeVisible();
  await expect.poll(async () => Number(await page.getByTestId('timer').getAttribute('data-ms'))).toBeGreaterThan(elapsedBeforeLanguage);
  await waitElapsed(page, 15000);
  await page.getByTestId('mark-highlight').click();
  await page.evaluate(() => {
    const mark = () => {
      if (document.querySelector('[data-testid="tracks-released"]')) sessionStorage.setItem('tracks-stopped', '1');
    };
    mark();
    new MutationObserver(mark).observe(document.documentElement, { childList: true, subtree: true });
  });
  await page.getByTestId('stop-save').click();
  await expect(page).toHaveURL(/\/watch\//, { timeout: 30_000 });
  expect(await page.evaluate(() => sessionStorage.getItem('tracks-stopped'))).toBe('1');

  const token = page.url().split('/').pop() ?? '';
  const video = page.getByTestId('video-player');
  await expect.poll(async () =>
    video.evaluate((element: HTMLVideoElement) => (Number.isFinite(element.duration) ? element.duration : 0)),
  ).toBeGreaterThan(10);
  const frame = await video.evaluate(async (element: HTMLVideoElement) => {
    element.muted = true;
    try {
      await element.play();
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      });
      element.pause();
    } catch {
      /* sample whatever frame is already decoded */
    }
    const canvas = document.createElement('canvas');
    canvas.width = element.videoWidth;
    canvas.height = element.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return { lit: 0, width: 0, height: 0 };
    ctx.drawImage(element, 0, 0);
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let lit = 0;
    for (let index = 0; index < pixels.length; index += 16) {
      if (pixels[index] + pixels[index + 1] + pixels[index + 2] > 40) lit += 1;
    }
    return { lit, width: canvas.width, height: canvas.height };
  });
  expect(frame.width).toBeGreaterThan(0);
  expect(frame.height).toBeGreaterThan(0);
  expect(frame.lit).toBeGreaterThan(10);

  await expect(page.getByTestId('replay-full')).toBeVisible();
  await expect(page.getByTestId('replay-rallies')).toBeVisible();
  await expect(page.getByTestId('replay-starred')).toBeVisible();
  await expect(page.getByTestId('rally-0')).toHaveAttribute('data-starred', '1');
  await page.getByTestId('rally-0').click();
  await page.waitForFunction(() => {
    const player = document.querySelector('[data-testid="video-player"]') as HTMLVideoElement | null;
    const button = document.querySelector('[data-testid="rally-0"]');
    if (!player || !button) return false;
    const target = Number(button.getAttribute('data-start')) / 1000;
    return Math.abs(player.currentTime - target) < 1.5;
  });
  await page.getByTestId('replay-starred').click();
  await expect(page.getByTestId('rally-0')).toBeVisible();

  await page.reload();
  await expect(page.getByTestId('video-player')).toBeVisible();
  await expect(page.getByTestId('session-score')).toHaveText('1-1');
  await expect(page.getByText('Lan')).toBeVisible();

  const download = await page.request.get(`/api/sessions/${token}/video?download=1`);
  expect(download.status()).toBe(200);
  expect(download.headers()['content-type']).toContain('video/');
  expect((await download.body()).byteLength).toBeGreaterThan(1000);
  expect(download.headers()['content-disposition']).toContain('court-replay_court-1');

  await page.getByTestId('zalo-phone').fill('0901234567');
  await page.getByTestId('marketing-consent').check();
  await page.getByTestId('save-zalo-contact').click();
  await expect(page.getByTestId('zalo-saved')).toContainText('Chưa gửi tin Zalo');
  await page.getByTestId('opt-out-contact').click();
  await expect(page.getByTestId('zalo-opted-out')).toBeVisible();
  await expect(page.getByTestId('video-player')).toBeVisible();

  await page.getByTestId('copy-link').click();
  await expect(page.getByRole('status').filter({ hasText: 'Đã sao chép liên kết' })).toBeVisible();
  const watch = await context.newPage();
  await watch.goto(`/watch/${token}`);
  await expect(watch.getByTestId('session-score')).toHaveText('1-1');
  await watch.close();

  await page.getByTestId('return-dashboard').click();
  await expect(page.getByText('Lan')).toBeVisible();
  await expect(page.getByTestId('saved-count')).toContainText('1');
  await page.getByTestId(`delete-${token}`).click();
  await page.getByTestId('confirm-delete').click();
  await expect(page.getByText('Đã xóa phiên.')).toBeVisible();
  await page.goto(`/watch/${token}`);
  await expect(page.getByTestId('not-found')).toBeVisible();

  const unexpected = consoleErrors.filter(
    (entry) => !/favicon/i.test(entry) && !/404 \(Not Found\)/.test(entry),
  );
  expect(unexpected).toEqual([]);
  expect(notFoundUrls.length).toBeGreaterThan(0);
  expect(notFoundUrls.every((url) => url.includes(`/api/sessions/${token}`))).toBe(true);
});

test('refusing the microphone still records video, and a failed save can be retried once', async ({ page }) => {
  await page.addInitScript(() => {
    const media = navigator.mediaDevices;
    const original = media.getUserMedia.bind(media);
    media.getUserMedia = async (constraints) => {
      const requested = constraints as MediaStreamConstraints | undefined;
      if (requested?.audio && (window as unknown as { __denyMic?: boolean }).__denyMic) {
        throw new DOMException('Permission denied', 'NotAllowedError');
      }
      return original(constraints);
    };
  });
  await page.goto('/');
  await startSingles(page, 'Hoa', 'An');
  await page.evaluate(() => {
    (window as unknown as { __denyMic: boolean }).__denyMic = true;
  });
  await page.getByTestId('include-mic').check();
  await page.getByTestId('enable-camera').click();
  await expect(page.getByTestId('status-message')).toContainText('Microphone refused');
  await expect.poll(async () => page.getByTestId('preview').evaluate((video: HTMLVideoElement) => video.videoWidth)).toBeGreaterThan(0);

  let failedOnce = false;
  await page.route('**/api/sessions/*/video', async (route) => {
    if (!failedOnce) {
      failedOnce = true;
      await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'server_error' }) });
      return;
    }
    await route.continue();
  });

  await page.getByTestId('start-recording').click();
  await waitElapsed(page, 2000);
  await page.getByTestId('stop-save').click();
  await expect(page.getByTestId('retry-save')).toBeVisible();
  await page.getByTestId('retry-save').click();
  await expect(page).toHaveURL(/\/watch\//, { timeout: 30_000 });
  const dashboard = await page.request.get('/api/dashboard');
  const body = (await dashboard.json()) as { sessions: { teams: { A: string[] }; status: string }[] };
  const matches = body.sessions.filter((session) => session.teams.A.includes('Hoa') && session.status === 'ready');
  expect(matches).toHaveLength(1);
});

test('a game to 11 keeps both teams on their starting ends', async ({ page }) => {
  await page.goto('/');
  await startSingles(page, 'End', 'Stay');
  await expect(page.getByTestId('end-switch-at6')).toHaveCount(0);
  await page.getByTestId('enable-camera').click();
  await expect(page.getByTestId('end-2-unavailable')).toBeVisible();
  await page.getByTestId('start-recording').click();
  for (let point = 0; point < 6; point += 1) await page.getByTestId('score-a').click();
  await expect(page.getByTestId('switch-dialog')).toHaveCount(0);
  await expect(page.getByText('Confirm end switch')).toHaveCount(0);
  await expect(page.getByTestId('team-a-end')).toContainText('1');
  await expect(page.getByTestId('team-b-end')).toContainText('2');
  await expect(page.getByTestId('team-a-names')).toContainText('End');
  await expect(page.getByTestId('team-b-names')).toContainText('Stay');
  await waitElapsed(page, 2000);
  await page.getByTestId('stop-save').click();
  await expect(page).toHaveURL(/\/watch\//, { timeout: 30_000 });
  const token = page.url().split('/').pop() ?? '';
  const body = (await (await page.request.get(`/api/sessions/${token}`)).json()) as {
    switches: { offsetMs: number }[];
    videos: { end: number | null }[];
    score: { A: number };
    endSwitch: string;
  };
  expect(body.switches).toEqual([]);
  expect(body.endSwitch).toBe('none');
  expect(body.videos).toHaveLength(1);
  expect(body.videos[0]?.end).toBe(1);
  expect(body.score.A).toBe(6);
  await expect(page.getByTestId('switch-offset')).toHaveCount(0);
  await expect(page.getByTestId('watch-end-2')).toContainText('Unavailable');
});

test('opens two labeled cameras from two device ids without reusing one id', async ({ page }) => {
  await page.addInitScript(() => {
    const calls: string[] = [];
    (window as unknown as { __camCalls: string[] }).__camCalls = calls;
    function stream(color: string) {
      const canvas = document.createElement('canvas');
      canvas.width = 160;
      canvas.height = 120;
      const ctx = canvas.getContext('2d');
      const paint = () => {
        if (!ctx) return;
        ctx.fillStyle = color;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      };
      paint();
      const media = canvas.captureStream(10);
      const timer = window.setInterval(paint, 100);
      media.getTracks()[0]?.addEventListener('ended', () => window.clearInterval(timer));
      return media;
    }
    navigator.mediaDevices.enumerateDevices = async () =>
      [
        { deviceId: 'cam-a', kind: 'videoinput', label: 'Camera A', groupId: 'g1', toJSON() { return this; } },
        { deviceId: 'cam-b', kind: 'videoinput', label: 'Camera B', groupId: 'g2', toJSON() { return this; } },
      ] as unknown as MediaDeviceInfo[];
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      const video = constraints?.video;
      let id = 'default';
      if (video && typeof video === 'object' && 'deviceId' in video) {
        const deviceId = (video as MediaTrackConstraints).deviceId;
        if (deviceId && typeof deviceId === 'object' && 'exact' in deviceId && deviceId.exact) id = String(deviceId.exact);
      }
      calls.push(id);
      return stream(id === 'cam-b' ? '#2244aa' : '#228855');
    };
  });
  await page.goto('/');
  await startSingles(page, 'Cam', 'Era');
  await page.getByTestId('enable-camera').click();
  await expect(page.getByTestId('preview')).toBeVisible();
  await expect(page.getByTestId('preview-end-2')).toBeVisible();
  await expect(page.getByTestId('end-2-unavailable')).toHaveCount(0);
  const calls = await page.evaluate(() => (window as unknown as { __camCalls: string[] }).__camCalls);
  expect(calls.filter((id) => id === 'cam-a')).toEqual(['cam-a']);
  expect(calls.filter((id) => id === 'cam-b')).toEqual(['cam-b']);
  await page.getByTestId('start-recording').click();
  await waitElapsed(page, 2500);
  await page.getByTestId('stop-save').click();
  await expect(page).toHaveURL(/\/watch\//, { timeout: 30_000 });
  const token = page.url().split('/').pop() ?? '';
  const saved = (await (await page.request.get(`/api/sessions/${token}`)).json()) as {
    videos: { end: number; size: number }[];
  };
  expect(saved.videos.map((clip) => clip.end).sort()).toEqual([1, 2]);
  expect(saved.videos.every((clip) => clip.size > 1000)).toBe(true);
});

test('camera permission denial offers a retry that can succeed', async ({ page }) => {
  await page.addInitScript(() => {
    const media = navigator.mediaDevices;
    const original = media.getUserMedia.bind(media);
    media.getUserMedia = async (constraints) => {
      if ((window as unknown as { __denyCamera?: boolean }).__denyCamera) {
        throw new DOMException('Permission denied', 'NotAllowedError');
      }
      return original(constraints);
    };
  });
  await page.goto('/');
  await startSingles(page, 'Chi', 'Dung');
  await page.evaluate(() => {
    (window as unknown as { __denyCamera: boolean }).__denyCamera = true;
  });
  await page.getByTestId('enable-camera').click();
  await expect(page.getByText('The browser blocked the camera.')).toBeVisible();
  await expect(page.getByTestId('retry-permission')).toBeVisible();
  await page.evaluate(() => {
    (window as unknown as { __denyCamera: boolean }).__denyCamera = false;
  });
  await page.getByTestId('retry-permission').click();
  await expect.poll(async () => page.getByTestId('preview').evaluate((video: HTMLVideoElement) => video.videoWidth)).toBeGreaterThan(0);
});

test('language follows the browser, then an explicit choice wins', async ({ browser, page }) => {
  const vietnamese = await browser.newContext({ locale: 'vi-VN' });
  const viPage = await vietnamese.newPage();
  await viPage.goto('/');
  await expect(viPage.locator('html')).toHaveAttribute('lang', 'vi');
  await expect(viPage.getByTestId('start-session')).toHaveText('Bắt đầu phiên chơi');
  await vietnamese.close();

  await page.goto('/');
  await expect(page.getByTestId('start-session')).toHaveText('Start a session');
  await page.getByTestId('lang-vi').click();
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('lang', 'vi');
  await expect(page.getByTestId('start-session')).toHaveText('Bắt đầu phiên chơi');
});

test('invalid links and narrow layouts stay usable', async ({ page }) => {
  await page.goto('/watch/this-token-is-not-valid-0001');
  await expect(page.getByTestId('not-found')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Session not found' })).toBeVisible();

  for (const viewport of [
    { width: 390, height: 844 },
    { width: 1440, height: 900 },
  ]) {
    await page.setViewportSize(viewport);
    for (const path of ['/', '/setup?court=court-1', '/dashboard']) {
      await page.goto(path);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBeLessThanOrEqual(1);
    }
  }

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await page.getByTestId('start-session').focus();
  await expect(page.getByTestId('start-session')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/setup/);
});
