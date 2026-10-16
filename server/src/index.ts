import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import dotenv from 'dotenv';
import { createApp } from './app.js';
import { loadConfig, repoRoot, type AppConfig } from './config.js';

dotenv.config({ path: path.join(repoRoot, '.env') });

const config = loadConfig(process.env);
resetStorage(config);
const running = createApp(config);
const server = http.createServer(running.app);

server.listen(config.port, config.host, () => {
  const origin = `http://${config.host}:${config.port}`;
  console.log(`Court Replay API listening on ${origin}`);
  console.log(`Public base URL for QR and session links: ${config.publicBaseUrl}`);
  if (config.serveStatic && !config.publicBaseUrl.endsWith(`:${config.port}`)) {
    console.warn(
      `PUBLIC_BASE_URL (${config.publicBaseUrl}) does not use the server port ${config.port}. QR codes and session links will use the configured base URL as-is.`,
    );
  }
  console.log(`Recordings: ${config.storageDir}`);
  console.log(`Database: ${config.databasePath}`);
  if (config.lanMode) {
    console.log(`LAN mode is on. This is a demo with no production login. Phones on this Wi-Fi should open ${config.publicBaseUrl}`);
    console.log(`Court QR uses ${config.publicBaseUrl}/court/court-1`);
  }
});

function resetStorage(config: AppConfig) {
  if (process.env.RESET_STORAGE !== 'true') return;
  fs.rmSync(config.storageDir, { recursive: true, force: true });
  for (const suffix of ['', '-wal', '-shm']) {
    fs.rmSync(`${config.databasePath}${suffix}`, { force: true });
  }
}

function shutdown() {
  server.close(() => {
    running.close();
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
