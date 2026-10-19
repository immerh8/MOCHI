import { createContext, use, useCallback } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";

/** Which archive the window is showing: a MOCHI one, or a ZIP/7z/RAR/tar one. */
export type Owner = "mochi" | "foreign";

/**
 * The places the toolbar and the window offer to the components that own an
 * action. A component keeps its own state, test ids and focus handling and
 * only draws its button into the toolbar through `ToolSlot`; the toolbar
 * itself (in `Browser`) has no idea what the buttons do.
 */
export type SlotName =
  | "add"
  | "remove"
  | "extract"
  | "test"
  | "find"
  | "info"
  | "primary"
  | "new"
  | "extractOpen"
  | "stage";

export interface Shell {
  /** Whose archive is on screen; a slot only shows what its owner draws. */
  active: Owner;
  register: (name: SlotName, el: HTMLElement | null) => void;
  slots: Partial<Record<SlotName, HTMLElement>>;
  /** The foreign browser tells the window when it has an archive open. */
  setForeignOpen: (open: boolean) => void;
  /** Changes when a MOCHI archive is shown, so an open foreign archive closes. */
  closeForeignToken: number;
  /** Changes when the toolbar asks the foreign browser to pick an archive. */
  openForeignToken: number;
  /** Whether the toolbar's Info panel is open. */
  infoOpen: boolean;
}

export const ShellContext = createContext<Shell | null>(null);

export function useShell(): Shell | null {
  return use(ShellContext);
}

/**
 * Draw `children` into a toolbar (or window) slot. Outside a window, as in a
 * component's own tests, they are drawn in place.
 */
export function ToolSlot({
  name,
  owner = "mochi",
  children,
}: {
  name: SlotName;
  owner?: Owner | "any";
  children: ReactNode;
}) {
  const shell = useShell();
  if (shell === null) return <>{children}</>;
  if (owner !== "any" && owner !== shell.active) return null;
  const el = shell.slots[name];
  return el ? createPortal(children, el) : null;
}

/** The empty element a `ToolSlot` draws into. Its ref is stable per name. */
export function SlotHost({ name, className }: { name: SlotName; className?: string }) {
  const shell = useShell();
  const register = shell?.register;
  const ref = useCallback(
    (el: HTMLElement | null) => {
      register?.(name, el);
    },
    [register, name],
  );
  return <span ref={ref} className={className ?? "tool-cell"} data-slot={name} />;
}

/**
 * One toolbar button: an icon over a short label. The label is the accessible
 * name; `title` holds the longer explanation (or why the button is off).
 */
export function ToolButton({
  icon,
  label,
  title,
  testId,
  disabled,
  onClick,
  expanded,
  pressed,
  primary,
}: {
  icon: ReactNode;
  label: string;
  title?: string;
  testId?: string;
  disabled?: boolean;
  onClick: () => void;
  expanded?: boolean;
  pressed?: boolean;
  primary?: boolean;
}) {
  return (
    <button
      type="button"
      className={primary ? "tool primary" : "tool"}
      data-testid={testId}
      title={title}
      disabled={disabled}
      aria-expanded={expanded}
      aria-pressed={pressed}
      onClick={onClick}
    >
      {icon}
      <span className="tool-label">{label}</span>
    </button>
  );
}
