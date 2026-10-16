export type LiveTeam = 'A' | 'B';

export type LiveAction =
  | { id: string; action: 'point'; team: LiveTeam }
  | { id: string; action: 'undo' }
  | { id: string; action: 'switch' };

export type LiveSnapshot = {
  scores: { team: LiveTeam; offsetMs: number }[];
  switches: { offsetMs: number }[];
};

type LiveRoom = {
  snapshot: LiveSnapshot;
  inbox: LiveAction[];
  seen: Set<string>;
};

const emptySnapshot = (): LiveSnapshot => ({ scores: [], switches: [] });

function emptyRoom(): LiveRoom {
  return { snapshot: emptySnapshot(), inbox: [], seen: new Set() };
}

export class LiveBook {
  private rooms = new Map<string, LiveRoom>();

  read(token: string): { snapshot: LiveSnapshot; inbox: LiveAction[] } {
    const room = this.rooms.get(token) ?? emptyRoom();
    return { snapshot: room.snapshot, inbox: [...room.inbox] };
  }

  push(token: string, action: LiveAction): { ok: true } | { ok: false; error: 'busy' } {
    const room = this.rooms.get(token) ?? emptyRoom();
    if (room.seen.has(action.id)) return { ok: true };
    if (room.inbox.length >= 100) return { ok: false, error: 'busy' };
    room.seen.add(action.id);
    room.inbox.push(action);
    this.rooms.set(token, room);
    return { ok: true };
  }

  sync(token: string, snapshot: LiveSnapshot, applied: string[]): LiveSnapshot {
    const room = this.rooms.get(token) ?? emptyRoom();
    const drop = new Set(applied);
    room.snapshot = snapshot;
    room.inbox = room.inbox.filter((item) => !drop.has(item.id));
    this.rooms.set(token, room);
    return room.snapshot;
  }
}
