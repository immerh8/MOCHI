import type { KeyboardEvent, MouseEvent, PointerEvent as ReactPointerEvent } from "react";

import type { DragOut } from "./dragOut";
import type { Selection } from "./selection";

/** The handlers a row of a file list shares: select, open, drag out. */
export function rowHandlers<T extends { key: string | null }>(
  sel: Selection<T>,
  row: T,
  index: number,
  open: () => void,
  drag: DragOut<T>,
) {
  return {
    onClick: (e: MouseEvent) => sel.click(row, index, e),
    onDoubleClick: open,
    onKeyDown: (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        open();
      }
    },
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => drag.onPointerDown(e, row),
    onPointerMove: drag.onPointerMove,
    onPointerUp: drag.onPointerUp,
  };
}

/** Ctrl+A selects the folder, Backspace goes up, Delete removes (MOCHI only). */
export function listKeys(
  e: KeyboardEvent,
  handlers: { all: () => void; up: () => void; remove?: () => void },
) {
  if (e.target instanceof HTMLInputElement) return;
  if ((e.ctrlKey || e.metaKey) && (e.key === "a" || e.key === "A")) {
    e.preventDefault();
    handlers.all();
  } else if (e.key === "Backspace" && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    handlers.up();
  } else if (e.key === "Delete" && handlers.remove) {
    e.preventDefault();
    handlers.remove();
  }
}
