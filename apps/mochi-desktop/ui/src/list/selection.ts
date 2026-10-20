import { useCallback, useState } from "react";
import type { MouseEvent } from "react";

/** A row that can be selected: anything with a key the backend understands. */
export interface Keyed {
  key: string | null;
}

/** Most rows one selection holds (an extract or a remove names at most this many). */
export const MAX_SELECTED = 10_000;

export interface Selection<T extends Keyed> {
  /** The selected rows, in the order they were selected. */
  rows: readonly T[];
  /** The row clicked last (the Info panel shows it). */
  focus: T | null;
  has: (row: T) => boolean;
  /**
   * A click on row `index`: alone it selects the row, with Ctrl (or ⌘) it
   * toggles it, with Shift it selects the range from the last plain click.
   * The range is fetched with `load`, since most of it may not be on screen.
   */
  click: (row: T, index: number, e: Pick<MouseEvent, "ctrlKey" | "metaKey" | "shiftKey">) => void;
  /** Select only this row (keeps it if it is already part of the selection). */
  ensure: (row: T, index: number) => void;
  /** Select every row of the listing, up to `MAX_SELECTED`. */
  all: (total: number) => void;
  clear: () => void;
}

/**
 * Multiple selection for a file list, as in a desktop file manager. Rows
 * without a key (an entry whose name was refused) cannot be selected.
 */
export function useSelection<T extends Keyed>(
  load: (offset: number, limit: number) => Promise<T[]>,
  onError: (e: unknown) => void,
): Selection<T> {
  const [rows, setRows] = useState<readonly T[]>([]);
  const [focus, setFocus] = useState<T | null>(null);
  const [anchor, setAnchor] = useState<number | null>(null);

  const has = useCallback((row: T) => row.key !== null && rows.some((r) => r.key === row.key), [rows]);

  const range = useCallback(
    (from: number, to: number) => {
      const lo = Math.min(from, to);
      const hi = Math.min(Math.max(from, to), lo + MAX_SELECTED - 1);
      load(lo, hi - lo + 1).then((got) => setRows(got.filter((r) => r.key !== null)), onError);
    },
    [load, onError],
  );

  const click = useCallback(
    (row: T, index: number, e: Pick<MouseEvent, "ctrlKey" | "metaKey" | "shiftKey">) => {
      if (row.key === null) return;
      setFocus(row);
      if (e.shiftKey && anchor !== null) {
        range(anchor, index);
        return;
      }
      setAnchor(index);
      if (e.ctrlKey || e.metaKey) {
        setRows((prev) =>
          prev.some((r) => r.key === row.key)
            ? prev.filter((r) => r.key !== row.key)
            : prev.length < MAX_SELECTED
              ? [...prev, row]
              : prev,
        );
        return;
      }
      setRows([row]);
    },
    [anchor, range],
  );

  const ensure = useCallback(
    (row: T, index: number) => {
      if (row.key === null || rows.some((r) => r.key === row.key)) return;
      setFocus(row);
      setAnchor(index);
      setRows([row]);
    },
    [rows],
  );

  const all = useCallback(
    (total: number) => {
      if (total > 0) range(0, total - 1);
    },
    [range],
  );

  const clear = useCallback(() => {
    setRows((prev) => (prev.length === 0 ? prev : []));
    setFocus(null);
    setAnchor(null);
  }, []);

  return { rows, focus, has, click, ensure, all, clear };
}
