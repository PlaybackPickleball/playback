export type EndId = 1 | 2;

export type EndAssignment = { 1: string | null; 2: string | null };

export function assignEnds(deviceIds: string[]): EndAssignment {
  const unique: string[] = [];
  for (const id of deviceIds) {
    if (!id || unique.includes(id)) continue;
    unique.push(id);
    if (unique.length === 2) break;
  }
  return { 1: unique[0] ?? null, 2: unique[1] ?? null };
}

export function moveCamera(slots: EndAssignment, end: EndId, deviceId: string | null): EndAssignment {
  const next: EndAssignment = { 1: slots[1], 2: slots[2] };
  if (!deviceId) {
    next[end] = null;
    return next;
  }
  const other: EndId = end === 1 ? 2 : 1;
  if (next[other] === deviceId) next[other] = next[end];
  next[end] = deviceId;
  if (next[1] && next[1] === next[2]) next[other] = null;
  return next;
}

export function assignedEnds(slots: EndAssignment): EndId[] {
  const ends: EndId[] = [];
  if (slots[1]) ends.push(1);
  if (slots[2] && slots[2] !== slots[1]) ends.push(2);
  return ends;
}
