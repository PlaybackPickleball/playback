import { parentPort, workerData } from 'node:worker_threads';
import { Store } from '../src/db.js';
import { confirmResult } from '../src/results.js';

const data = (workerData ?? {
  dbPath: process.env.DB_PATH,
  matchId: process.env.MATCH_ID,
  playerId: process.env.PLAYER_ID,
}) as { dbPath: string; matchId: string; playerId: string };

const store = new Store(data.dbPath);
try {
  const outcome = confirmResult(store.db, data.matchId, data.playerId);
  const message = { ok: true, replayed: outcome.replayed };
  if (parentPort) parentPort.postMessage(message);
  else process.stdout.write(`${JSON.stringify(message)}\n`);
} catch (error) {
  const message = { ok: false, code: error instanceof Error ? error.message : 'error' };
  if (parentPort) parentPort.postMessage(message);
  else process.stdout.write(`${JSON.stringify(message)}\n`);
} finally {
  store.close();
}
