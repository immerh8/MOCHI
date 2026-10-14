import { useEffect, useId, useRef } from "react";
import type { ReactNode } from "react";

/**
 * Move focus into a panel the user just opened and give it back when the panel
 * goes away. The panels are inline (not modal), so there is no trap: Tab
 * continues through the page in reading order, and Escape is not needed to
 * leave. If the control that opened the panel is gone or disabled when the
 * panel closes, focus falls back to the element named by `fallbackId`.
 */
export function useFocusIn<T extends HTMLElement>(fallbackId?: string) {
  const ref = useRef<T>(null);
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    ref.current?.focus();
    return () => {
      const usable =
        opener !== null &&
        opener.isConnected &&
        !(opener as HTMLButtonElement).disabled &&
        opener !== document.body;
      if (usable) {
        opener.focus();
      } else if (fallbackId) {
        document.getElementById(fallbackId)?.focus();
      }
    };
  }, [fallbackId]);
  return ref;
}

export interface PanelProps {
  /** The panel's heading content; focus lands on it when the panel opens. */
  heading: ReactNode;
  /** The group's accessible name, when it differs from the heading's text. */
  label?: string;
  testId?: string;
  /** Section heading to focus when the opener cannot take focus back. */
  fallbackId?: string;
  className?: string;
  children: ReactNode;
}

/** An inline panel the user opened: a labelled group whose heading takes focus. */
export function Panel({ heading, label, testId, fallbackId, className, children }: PanelProps) {
  const headingId = useId();
  const ref = useFocusIn<HTMLHeadingElement>(fallbackId);
  return (
    <div
      className={className ? `panel ${className}` : "panel"}
      role="group"
      aria-label={label}
      aria-labelledby={label === undefined ? headingId : undefined}
      data-testid={testId}
    >
      <h3 id={headingId} ref={ref} tabIndex={-1}>
        {heading}
      </h3>
      {children}
    </div>
  );
}
