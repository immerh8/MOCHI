// Small outline icons for the start screen and the file lists. Decorative: each
// is hidden from assistive technology (the button or the text beside it carries
// the name), draws with `currentColor`, and is plain SVG shapes, so no string
// from an archive or a disk can reach it. Which file-type icon a row gets is
// chosen in `browser/fileKind.ts` from a fixed table; nothing here reads a name.
import type { ReactNode } from "react";

function Icon({
  children,
  className = "icon",
  size = 20,
}: {
  children: ReactNode;
  className?: string;
  size?: number;
}) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export function FolderIcon() {
  return (
    <Icon>
      <path d="M3 7.5a2 2 0 0 1 2-2h4.2l2 2.3H19a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </Icon>
  );
}

export function PlusIcon() {
  return (
    <Icon>
      <path d="M12 5v14M5 12h14" />
    </Icon>
  );
}

export function ExtractIcon() {
  return (
    <Icon>
      <path d="M12 15V4M8.5 7.5 12 4l3.5 3.5" />
      <path d="M5 13v5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5" />
    </Icon>
  );
}

export function GearIcon() {
  return (
    <Icon>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3v2.2M12 18.8V21M3 12h2.2M18.8 12H21M5.6 5.6l1.6 1.6M16.8 16.8l1.6 1.6M18.4 5.6l-1.6 1.6M7.2 16.8l-1.6 1.6" />
      <circle cx="12" cy="12" r="6.6" />
    </Icon>
  );
}

export function BackIcon() {
  return (
    <Icon>
      <path d="M19 12H5M11 6l-6 6 6 6" />
    </Icon>
  );
}

export function SearchIcon() {
  return (
    <Icon>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m16 16 4.5 4.5" />
    </Icon>
  );
}

/** The caret beside a sorted column's name. */
export function CaretUpIcon() {
  return (
    <Icon className="icon caret" size={14}>
      <path d="m6 15 6-6 6 6" />
    </Icon>
  );
}

/**
 * The file-type icons of a listing row: a folder, an image, a spreadsheet, a
 * PDF, a text file, any other file, and a link. Each is an outline with a faint
 * fill; the colour is the row's (`.file-icon-*` in the stylesheet).
 */
export type FileIconKind = "folder" | "image" | "sheet" | "pdf" | "text" | "generic" | "link";

const PAGE = "M7 3h7l5 5v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z";
const FOLD = "M14 3v5h5";

export function FileTypeIcon({ kind }: { kind: FileIconKind }) {
  const cls = `icon file-icon file-icon-${kind}`;
  switch (kind) {
    case "folder":
      return (
        <Icon className={cls}>
          <path className="fill" d="M3 7.5a2 2 0 0 1 2-2h4.2l2 2.3H19a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
        </Icon>
      );
    case "image":
      return (
        <Icon className={cls}>
          <rect className="fill" x="4" y="4" width="16" height="16" rx="2.5" />
          <circle cx="9" cy="9.5" r="1.4" />
          <path d="m5 17 4.5-4.5 3 3L15 13l4 4" />
        </Icon>
      );
    case "sheet":
      return (
        <Icon className={cls}>
          <rect className="fill" x="4" y="4" width="16" height="16" rx="2.5" />
          <path d="M4 9.5h16M4 14.5h16M9.5 4v16M14.5 4v16" />
        </Icon>
      );
    case "pdf":
      return (
        <Icon className={cls}>
          <path className="fill" d={PAGE} />
          <path d={FOLD} />
          <path d="M9 17.5c1.5-1.2 3-3.6 3-5.8 0-.9-.9-.9-.9 0 0 1.9 2.2 3.8 3.9 4.2" />
        </Icon>
      );
    case "text":
      return (
        <Icon className={cls}>
          <path className="fill" d={PAGE} />
          <path d={FOLD} />
          <path d="M8.5 12.5h7M8.5 15.5h7M8.5 9.5h2.5" />
        </Icon>
      );
    case "link":
      return (
        <Icon className={cls}>
          <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" />
          <path d="M14 10a4 4 0 0 0-5.7 0l-3 3A4 4 0 0 0 11 18.7l1-1" />
        </Icon>
      );
    case "generic":
      return (
        <Icon className={cls}>
          <path className="fill" d={PAGE} />
          <path d={FOLD} />
        </Icon>
      );
  }
}
