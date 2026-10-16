import type { TimedChunk } from './media';

export type RallyClip = {
  blob: Blob;
  seekSeconds: number;
  stopSeconds: number;
  absolute: boolean;
};

const CLUSTER = [0x1f, 0x43, 0xb6, 0x75] as const;

function readVint(bytes: Uint8Array, offset: number): { length: number; value: number } | null {
  if (offset < 0 || offset >= bytes.length) return null;
  const lead = bytes[offset];
  let length = 1;
  let mask = 0x80;
  while (length <= 8 && (lead & mask) === 0) {
    length += 1;
    mask >>= 1;
  }
  if (length > 8 || offset + length > bytes.length) return null;
  let value = lead & (mask - 1);
  for (let index = 1; index < length; index += 1) value = value * 256 + bytes[offset + index];
  return { length, value };
}

function findCluster(bytes: Uint8Array, from = 0): number {
  for (let index = Math.max(0, from); index <= bytes.length - 4; index += 1) {
    if (
      bytes[index] === CLUSTER[0] &&
      bytes[index + 1] === CLUSTER[1] &&
      bytes[index + 2] === CLUSTER[2] &&
      bytes[index + 3] === CLUSTER[3]
    ) {
      return index;
    }
  }
  return -1;
}

function readTimecodeScale(bytes: Uint8Array): number {
  for (let index = 0; index <= bytes.length - 3; index += 1) {
    if (bytes[index] !== 0x2a || bytes[index + 1] !== 0xd7 || bytes[index + 2] !== 0xb1) continue;
    const size = readVint(bytes, index + 3);
    if (!size || size.value <= 0 || size.value > 8) return 1_000_000;
    const start = index + 3 + size.length;
    if (start + size.value > bytes.length) return 1_000_000;
    let value = 0;
    for (let step = 0; step < size.value; step += 1) value = value * 256 + bytes[start + step];
    return value > 0 ? value : 1_000_000;
  }
  return 1_000_000;
}

function clusterTimecode(bytes: Uint8Array, clusterAt: number): { value: number; offset: number; width: number } | null {
  const size = readVint(bytes, clusterAt + 4);
  if (!size) return null;
  const pos = clusterAt + 4 + size.length;
  if (pos >= bytes.length || bytes[pos] !== 0xe7) return null;
  const width = readVint(bytes, pos + 1);
  if (!width || width.value <= 0 || width.value > 8) return null;
  const offset = pos + 1 + width.length;
  if (offset + width.value > bytes.length) return null;
  let value = 0;
  for (let step = 0; step < width.value; step += 1) value = value * 256 + bytes[offset + step];
  return { value, offset, width: width.value };
}

function writeUint(bytes: Uint8Array, offset: number, width: number, value: number) {
  let rest = Math.max(0, Math.floor(value));
  for (let step = width - 1; step >= 0; step -= 1) {
    bytes[offset + step] = rest % 256;
    rest = Math.floor(rest / 256);
  }
}

export function shiftClusterTimecodes(input: Uint8Array, scale = 1_000_000): { bytes: Uint8Array; originMs: number } | null {
  const bytes = new Uint8Array(input);
  const firstAt = findCluster(bytes, 0);
  if (firstAt < 0) return null;
  const first = clusterTimecode(bytes, firstAt);
  if (!first) return null;
  const base = first.value;
  let at = firstAt;
  while (at >= 0) {
    const mark = clusterTimecode(bytes, at);
    if (!mark) return null;
    const next = mark.value - base;
    if (next >= 256 ** mark.width) return null;
    writeUint(bytes, mark.offset, mark.width, next);
    at = findCluster(bytes, at + 4);
  }
  return { bytes, originMs: (base * scale) / 1_000_000 };
}

function chunksCovering(chunks: TimedChunk[], startMs: number, endMs: number): { selected: TimedChunk[]; clipStartMs: number } {
  let previous = 0;
  const selected: TimedChunk[] = [];
  let clipStartMs = 0;
  for (const chunk of chunks) {
    const chunkStart = previous;
    if (chunk.endMs > startMs && chunkStart < endMs) {
      if (selected.length === 0) clipStartMs = chunkStart;
      selected.push(chunk);
    }
    previous = Math.max(previous, chunk.endMs);
  }
  return { selected, clipStartMs };
}

function asBlobPart(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

export async function buildRallyClip(chunks: TimedChunk[], startMs: number, endMs: number, mime: string): Promise<RallyClip | null> {
  if (chunks.length === 0 || endMs <= startMs) return null;
  const { selected, clipStartMs } = chunksCovering(chunks, startMs, endMs);
  if (selected.length === 0) return null;
  const type = mime || 'video/webm';
  if (!type.includes('webm')) {
    const parts = selected[0] === chunks[0] ? selected : [chunks[0], ...selected];
    return {
      blob: new Blob(parts.map((chunk) => chunk.data), { type }),
      seekSeconds: startMs / 1000,
      stopSeconds: endMs / 1000,
      absolute: true,
    };
  }
  const firstBytes = new Uint8Array(await chunks[0].data.arrayBuffer());
  const headerAt = findCluster(firstBytes, 0);
  const init = headerAt >= 0 ? firstBytes.subarray(0, headerAt) : firstBytes;
  const scale = readTimecodeScale(init);
  const clusters: Uint8Array[] = [];
  for (const chunk of selected) {
    const bytes = chunk === chunks[0] ? firstBytes : new Uint8Array(await chunk.data.arrayBuffer());
    const at = findCluster(bytes, 0);
    clusters.push(at >= 0 ? bytes.subarray(at) : bytes);
  }
  const joined = concat(clusters);
  const shifted = shiftClusterTimecodes(joined, scale);
  if (!shifted) {
    return {
      blob: new Blob([asBlobPart(init), asBlobPart(joined)], { type }),
      seekSeconds: startMs / 1000,
      stopSeconds: Math.max(startMs / 1000 + 0.2, endMs / 1000),
      absolute: true,
    };
  }
  const origin = Number.isFinite(shifted.originMs) ? shifted.originMs : clipStartMs;
  return {
    blob: new Blob([asBlobPart(init), asBlobPart(shifted.bytes)], { type }),
    seekSeconds: Math.max(0, (startMs - origin) / 1000),
    stopSeconds: Math.max(0.25, (endMs - origin) / 1000),
    absolute: false,
  };
}
