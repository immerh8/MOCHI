import { useEffect, useState } from "react";

import { listChildren } from "../ipc/browse";
import type { EntryRow } from "../ipc/browse";
import { Name } from "./Name";

/** Subdirectories fetched per "show more". */
const TREE_PAGE = 200;

/** A directory on the path from the root: its key and its name. */
export type Crumb = Pick<EntryRow, "key" | "name">;

type Ctx = {
  handle: number;
  seq: number;
  current: string | null;
  onOpen: (path: Crumb[]) => void;
  onError: (e: unknown) => void;
};

/** Subdirectories of one directory, a page at a time. */
function Subdirs({ dir, ancestors, ctx }: { dir: string | null; ancestors: Crumb[]; ctx: Ctx }) {
  const [rows, setRows] = useState<EntryRow[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const { handle, seq, onError } = ctx;

  useEffect(() => {
    let live = true;
    listChildren(handle, seq, dir, true, 0, TREE_PAGE).then(
      (p) => {
        if (!live) return;
        setRows(p.entries);
        setTotal(p.total);
      },
      (e: unknown) => {
        if (live) onError(e);
      },
    );
    return () => {
      live = false;
    };
  }, [handle, seq, dir, onError]);

  const more = () => {
    listChildren(handle, seq, dir, true, rows.length, TREE_PAGE).then(
      (p) => setRows((prev) => [...prev, ...p.entries]),
      onError,
    );
  };

  if (total === null) return null;
  return (
    <ul role="group">
      {rows.map((r) => (
        <TreeNode key={r.key} row={r} ancestors={ancestors} ctx={ctx} />
      ))}
      {rows.length < total && (
        <li>
          <button type="button" className="link" onClick={more}>
            Show more folders ({(total - rows.length).toLocaleString("en-US")} not shown)
          </button>
        </li>
      )}
    </ul>
  );
}

function TreeNode({ row, ancestors, ctx }: { row: EntryRow; ancestors: Crumb[]; ctx: Ctx }) {
  const [expanded, setExpanded] = useState(false);
  const path = [...ancestors, { key: row.key, name: row.name }];
  const hasDirs = row.child_dirs > 0;
  return (
    <li role="treeitem" aria-expanded={hasDirs ? expanded : undefined} aria-selected={ctx.current === row.key}>
      <span className="tree-row">
        <button
          type="button"
          className="twisty"
          aria-label={expanded ? "Collapse" : "Expand"}
          disabled={!hasDirs}
          onClick={() => setExpanded((x) => !x)}
        >
          {hasDirs ? (expanded ? "▾" : "▸") : " "}
        </button>
        <button
          type="button"
          className={ctx.current === row.key ? "tree-label current" : "tree-label"}
          onClick={() => ctx.onOpen(path)}
        >
          <Name name={row.name} />
        </button>
      </span>
      {expanded && <Subdirs dir={row.key} ancestors={path} ctx={ctx} />}
    </li>
  );
}

/** The folder tree of one snapshot, loaded lazily (directories only). */
export function Tree(props: Ctx) {
  return (
    <nav aria-label="Folders" className="tree" data-testid="tree">
      <button
        type="button"
        className={props.current === null ? "tree-label current" : "tree-label"}
        onClick={() => props.onOpen([])}
      >
        Archive root
      </button>
      <div role="tree" aria-label="Folders">
        <Subdirs dir={null} ancestors={[]} ctx={props} />
      </div>
    </nav>
  );
}
