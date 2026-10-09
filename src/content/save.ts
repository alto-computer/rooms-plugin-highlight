/*
 * Writes the record after edits stop for a moment, one write at a time, always the latest state.
 * The app allows 20 writes a second; a burst of edits becomes one write, and a write refused for
 * the rate is tried once more after the limit's window.
 */
import type { PluginError } from "@alto-rooms/plugin-sdk";

export const SAVE_DEBOUNCE_MS = 300;
export const RATE_LIMIT_RETRY_MS = 1100;

export interface Saver {
  /** The record changed: write it soon. */
  changed(): void;
  /** Resolves once no change is waiting or being written. */
  settled(): Promise<void>;
}

/** `write` serializes the record when it is called, so each write carries the latest state. */
export function createSaver(write: () => Promise<void>): Saver {
  let dirty = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let writing = false;
  let waiters: (() => void)[] = [];

  const schedule = () => {
    if (!timer && !writing) timer = setTimeout(flush, SAVE_DEBOUNCE_MS);
  };
  const flush = async () => {
    timer = undefined;
    dirty = false;
    writing = true;
    await writeWithRetry(write);
    writing = false;
    if (dirty) return schedule();
    for (const resolve of waiters) resolve();
    waiters = [];
  };

  return {
    changed() {
      dirty = true;
      schedule();
    },
    settled: () => (dirty || timer || writing ? new Promise((resolve) => waiters.push(resolve)) : Promise.resolve()),
  };
}

const rateLimited = (e: unknown) => (e as Partial<PluginError> | null)?.code === "rate_limited";

async function writeWithRetry(write: () => Promise<void>): Promise<void> {
  try {
    await write();
  } catch (e) {
    if (!rateLimited(e)) return console.warn("[highlights] could not save", e);
    await new Promise((r) => setTimeout(r, RATE_LIMIT_RETRY_MS));
    await write().catch((e2) => console.warn("[highlights] could not save", e2));
  }
}
