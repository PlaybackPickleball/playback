import fs from 'node:fs';
import path from 'node:path';

export const MIN_VIDEO_BYTES = 1024;

export type Container = 'webm' | 'mp4';

export function detectContainer(buffer: Buffer): Container | null {
  if (
    buffer.length >= 4 &&
    buffer[0] === 0x1a &&
    buffer[1] === 0x45 &&
    buffer[2] === 0xdf &&
    buffer[3] === 0xa3
  ) {
    return 'webm';
  }
  if (buffer.length >= 12 && buffer.subarray(4, 8).toString('ascii') === 'ftyp') {
    return 'mp4';
  }
  return null;
}

export function mimeMatches(contentType: string, container: Container): boolean {
  const base = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  if (base === 'application/octet-stream' || base === '') return true;
  return base === `video/${container}`;
}

export function playbackMime(container: Container): string {
  return container === 'mp4' ? 'video/mp4' : 'video/webm';
}

export function assertInside(root: string, candidate: string): string {
  const dir = path.resolve(root);
  const file = path.resolve(candidate);
  if (file !== dir && !file.startsWith(dir + path.sep)) {
    throw new Error('path escapes storage');
  }
  return file;
}

export function videoPath(storageDir: string, token: string, ext: Container, end?: 1 | 2 | null): string {
  const suffix = end == null ? '' : `-e${end}`;
  return assertInside(storageDir, path.join(storageDir, `${token}${suffix}.${ext}`));
}

export function removeEndVideo(storageDir: string, token: string, end: 1 | 2 | null): void {
  for (const ext of ['webm', 'mp4'] as const) {
    fs.rmSync(videoPath(storageDir, token, ext, end), { force: true });
  }
}

export function removeVideos(storageDir: string, token: string): void {
  for (const end of [null, 1, 2] as const) {
    removeEndVideo(storageDir, token, end);
  }
}

export function dedupeHighlights<T extends { offsetMs: number }>(items: T[], gapMs = 1500): T[] {
  const kept: T[] = [];
  for (const item of items) {
    const previous = kept[kept.length - 1];
    if (previous && item.offsetMs - previous.offsetMs < gapMs) continue;
    kept.push(item);
  }
  return kept;
}
