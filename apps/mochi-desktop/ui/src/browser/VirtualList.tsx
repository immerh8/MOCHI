import { useEffect, useRef, useState } from "react";
import type { ReactNode, UIEvent } from "react";

/** Rows fetched per request. */
export const PAGE = 200;
/** Rows rendered beyond the viewport on each side. */
const OVERSCAN = 10;
/** Rows assumed visible before the viewport has been measured (tests, first paint). */
const FALLBACK_VISIBLE = 30;

type Props<T> = {
  /** How many rows the listing has (the backend's `total`). */
  total: number;
  /** Fixed row height in pixels; the list is a spacer of `total` rows. */
  rowHeight: number;
  /** Fetch rows `offset .. offset + limit`. */
  loadPage: (offset: number, limit: number) => Promise<T[]>;
  renderRow: (row: T, index: number) => ReactNode;
  label: string;
  testId?: string;
  onError: (e: unknown) => void;
};

/**
 * A virtualized list (plan D1 exit): only the rows in view, plus a margin,
 * are in the DOM, and rows are fetched from the backend a page at a time as
 * they scroll into view, so a directory of 100,000 entries never crosses IPC
 * or enters the DOM whole. Remount it (React `key`) when the listing changes.
 */
export function VirtualList<T>({
  total,
  rowHeight,
  loadPage,
  renderRow,
  label,
  testId,
  onError,
}: Props<T>) {
  const viewportRef = useRef<HTMLDivElement>(null);
  // Loaded pages by page number; copied per page, never per row.
  const [pages, setPages] = useState<ReadonlyMap<number, T[]>>(() => new Map());
  const requestedRef = useRef(new Set<number>());
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(0);
  // Rows that arrive after a scroll still re-render; only unmounting stops it.
  const mountedRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const measure = () => setHeight(el.clientHeight);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const visible = height > 0 ? Math.ceil(height / rowHeight) : FALLBACK_VISIBLE;
  const first = Math.max(0, Math.floor(scrollTop / rowHeight) - OVERSCAN);
  const last = Math.min(total, Math.floor(scrollTop / rowHeight) + visible + OVERSCAN);

  useEffect(() => {
    for (let page = Math.floor(first / PAGE); page * PAGE < last; page++) {
      if (requestedRef.current.has(page)) continue;
      requestedRef.current.add(page);
      const offset = page * PAGE;
      loadPage(offset, Math.min(PAGE, total - offset)).then(
        (got) => {
          if (mountedRef.current) setPages((prev) => new Map(prev).set(page, got));
        },
        (e: unknown) => {
          requestedRef.current.delete(page);
          if (mountedRef.current) onError(e);
        },
      );
    }
  }, [first, last, total, loadPage, onError]);

  const items: ReactNode[] = [];
  for (let i = first; i < last; i++) {
    const row = pages.get(Math.floor(i / PAGE))?.[i % PAGE];
    items.push(
      <div
        key={i}
        role="listitem"
        className="vrow"
        style={{ top: i * rowHeight, height: rowHeight }}
        aria-posinset={i + 1}
        aria-setsize={total}
      >
        {row === undefined ? <span className="loading">Loading…</span> : renderRow(row, i)}
      </div>,
    );
  }

  return (
    <div
      ref={viewportRef}
      className="vlist"
      data-testid={testId}
      data-total={total}
      onScroll={(e: UIEvent<HTMLDivElement>) => setScrollTop(e.currentTarget.scrollTop)}
    >
      <div role="list" aria-label={label} className="vspacer" style={{ height: total * rowHeight }}>
        {items}
      </div>
    </div>
  );
}
