export interface Timers {
  set(fn: () => void, ms: number): unknown;
  clear(h: unknown): void;
}
const real: Timers = { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) };

/** Collects changed node ids and hands the whole set over once, `ms` after the last change. */
export function collector(ms: number, onFlush: (ids: Set<string>) => void, timers: Timers = real) {
  let ids = new Set<string>();
  let handle: unknown;
  const flush = () => {
    handle = undefined;
    const out = ids;
    ids = new Set();
    if (out.size) onFlush(out);
  };
  return {
    add(id: string) {
      ids.add(id);
      if (handle !== undefined) timers.clear(handle);
      handle = timers.set(flush, ms);
    },
    flush() { if (handle !== undefined) timers.clear(handle); flush(); },
  };
}
