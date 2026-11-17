import { DomainError } from "../../../packages/domain/src/index.js";
import type { Sql } from "./db.js";

/** Coalesce only simultaneous identical reads. No completed or private data cache. */
export class SnapshotReads {
  private active = 0;
  private waiting: Array<() => void> = [];
  private pending = new Map<string, Promise<unknown>>();
  constructor(
    private concurrency = 4,
    private capacity = 200,
    private waitMs = 2500,
  ) {}
  get stats() {
    return {
      active: this.active,
      waiting: this.waiting.length,
      pending: this.pending.size,
    };
  }
  run<T>(key: string, read: () => Promise<T>): Promise<T> {
    const existing = this.pending.get(key);
    if (existing) return existing as Promise<T>;
    if (this.pending.size >= this.capacity)
      return Promise.reject(
        new DomainError(
          "room_busy",
          "The room is busy. Reconnecting shortly.",
          503,
        ),
      );
    const result = this.execute(read).finally(() => this.pending.delete(key));
    this.pending.set(key, result);
    return result;
  }
  private async execute<T>(read: () => Promise<T>) {
    if (this.active >= this.concurrency)
      await new Promise<void>((resolve, reject) => {
        const ready = () => {
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          const index = this.waiting.indexOf(ready);
          if (index >= 0) this.waiting.splice(index, 1);
          reject(
            new DomainError(
              "room_busy",
              "The room is busy. Reconnecting shortly.",
              503,
            ),
          );
        }, this.waitMs);
        this.waiting.push(ready);
      });
    else this.active++;
    try {
      return await read();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }
}

export type StreamWriter = {
  write(chunk: string): boolean;
  destroy(): unknown;
  end(): unknown;
};

/** An invalidation stream, never a queue of private snapshots or audio. */
export class RoomStreams {
  private rooms = new Map<string, Set<StreamWriter>>();
  private total = 0;
  constructor(
    // 1000 contributors plus listeners, the public screen and performer devices.
    private perRoom = 1500,
    private maximum = 3000,
  ) {}
  get stats() {
    return { rooms: this.rooms.size, connections: this.total };
  }
  activeRooms() {
    return [...this.rooms.keys()];
  }
  add(room: string, stream: StreamWriter) {
    let streams = this.rooms.get(room);
    // Re-registering the same writer must not consume another connection slot.
    if (streams?.has(stream)) return () => this.remove(room, stream);
    if ((streams?.size ?? 0) >= this.perRoom || this.total >= this.maximum)
      throw new DomainError(
        "stream_limit",
        "Event connection limit reached. Reconnecting shortly.",
        503,
      );
    if (!streams) this.rooms.set(room, (streams = new Set()));
    streams.add(stream);
    this.total++;
    return () => this.remove(room, stream);
  }
  private remove(room: string, stream: StreamWriter) {
    const streams = this.rooms.get(room);
    if (streams?.delete(stream)) this.total--;
    if (!streams?.size) this.rooms.delete(room);
  }
  send(room: string, stream: StreamWriter, text: string) {
    try {
      if (stream.write(text)) return;
    } catch {
      /* A closed socket is recovered by the client's snapshot refresh. */
    }
    this.remove(room, stream);
    stream.destroy();
  }
  update(room: string) {
    for (const stream of this.rooms.get(room) ?? [])
      this.send(room, stream, "event: update\ndata: {}\n\n");
  }
  reconnect() {
    for (const [room, streams] of this.rooms)
      for (const stream of streams)
        this.send(room, stream, "event: reconnect\ndata: {}\n\n");
  }
  close() {
    for (const streams of this.rooms.values())
      for (const stream of streams) stream.end();
    this.rooms.clear();
    this.total = 0;
  }
}

/** Poll committed room counters, not globally allocated event-log IDs: a
 * slower transaction may commit an older log ID after a newer one. */
export async function pollRoomChanges(db: Sql, streams: RoomStreams, seen: Map<string, string>) {
  const rooms = streams.activeRooms();
  const active = new Set(rooms);
  for (const room of seen.keys()) if (!active.has(room)) seen.delete(room);
  if (!rooms.length) return;
  const rows = (await db.query(
    "SELECT id::text,change_seq::text FROM events WHERE id=ANY($1::uuid[])",
    [rooms],
  )).rows;
  for (const row of rows) {
    const id = String(row.id), sequence = String(row.change_seq);
    if (seen.get(id) !== sequence) {
      seen.set(id, sequence);
      streams.update(id);
    }
  }
}

/**
 * OJ-040: one room-wide snapshot is shared by every listener for a short
 * window instead of rebuilding the whole room per listener after each update.
 * Listener-specific values (own votes, ballot revision, reactions, membership)
 * are always read fresh and overlaid by the caller.
 */
export class RoomSnapshotCache<T> {
  private entries = new Map<string, { at: number; value: Promise<T> }>();
  private dirtyAt = -Infinity;
  constructor(
    private maxAgeMs = 750,
    private maxRooms = 500,
    private minAgeAfterWriteMs = 0,
  ) {}
  get(room: string, build: () => Promise<T>, now = Date.now()): Promise<T> {
    const hit = this.entries.get(room);
    const stale = hit && hit.at < this.dirtyAt && now - hit.at >= this.minAgeAfterWriteMs;
    if (hit && !stale && now - hit.at < this.maxAgeMs) return hit.value;
    const value = build();
    this.entries.delete(room);
    this.entries.set(room, { at: now, value });
    if (this.entries.size > this.maxRooms)
      this.entries.delete(this.entries.keys().next().value!);
    // A failed build is never served to later readers.
    value.catch(() => {
      if (this.entries.get(room)?.value === value) this.entries.delete(room);
    });
    return value;
  }
  invalidate(room: string) {
    this.entries.delete(room);
  }
  /** After a write: the next read rebuilds (shared by concurrent readers). */
  markDirty(now = Date.now()) {
    this.dirtyAt = now;
  }
  clear() {
    this.entries.clear();
  }
}
