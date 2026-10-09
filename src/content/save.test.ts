import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSaver, RATE_LIMIT_RETRY_MS, SAVE_DEBOUNCE_MS } from "./save";

describe("the saver", () => {
  let state: number;
  let disk: number[];
  beforeEach(() => {
    vi.useFakeTimers();
    state = 0;
    disk = [];
  });
  afterEach(() => vi.useRealTimers());

  const edit = (saver: ReturnType<typeof createSaver>) => {
    state++;
    saver.changed();
  };

  it("writes a burst of edits once, with the latest state", async () => {
    const saver = createSaver(async () => void disk.push(state));
    for (let i = 0; i < 5; i++) edit(saver);
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);
    expect(disk).toEqual([5]);
  });

  it("writes edits made during a write after it settles, and settles only then", async () => {
    let land!: () => void;
    const saver = createSaver(() => new Promise<void>((r) => ((land = r), disk.push(state))));
    edit(saver);
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);
    edit(saver);
    edit(saver);
    let settled = false;
    void saver.settled().then(() => (settled = true));
    land();
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);
    expect(disk).toEqual([1, 3]);
    expect(settled).toBe(false);
    land();
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(true);
  });

  it("tries a rate-limited write once more, with the latest state", async () => {
    const write = vi.fn(async () => void disk.push(state));
    write.mockRejectedValueOnce(Object.assign(new Error("rate_limited"), { code: "rate_limited" }));
    const saver = createSaver(write);
    edit(saver);
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);
    state = 7;
    await vi.advanceTimersByTimeAsync(RATE_LIMIT_RETRY_MS);
    expect(disk).toEqual([7]);
    expect(write).toHaveBeenCalledTimes(2);
  });
});
