import { useMemo, useRef } from "react";

/**
 * Whether the job that is running (or about to start) extracts into a new
 * Desktop folder. Read by the job's event handler, never by rendering, so it
 * is kept outside state; `take` reads it and clears it in one step. The
 * returned object is stable.
 */
export function useDesktopRun(): { set: () => void; take: () => boolean } {
  const ref = useRef(false);
  return useMemo(
    () => ({
      set: () => {
        ref.current = true;
      },
      take: () => {
        const was = ref.current;
        ref.current = false;
        return was;
      },
    }),
    [],
  );
}
