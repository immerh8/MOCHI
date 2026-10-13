// Presentation helpers. Sizes arrive as decimal strings (an archive may
// claim values above 2^53), so they are handled as BigInt.
import { isIpcError } from "../ipc/jobs";

const UNITS = ["KiB", "MiB", "GiB", "TiB", "PiB", "EiB"];

/** "1,234 bytes", or "1.5 MiB (1,572,864 bytes)" from 1 KiB up. */
export function formatSize(decimal: string): string {
  let n: bigint;
  try {
    n = BigInt(decimal);
  } catch {
    return decimal;
  }
  const exact = `${n.toLocaleString("en-US")} ${n === 1n ? "byte" : "bytes"}`;
  if (n < 1024n) return exact;
  let unit = 0;
  let base = 1024n;
  while (unit < UNITS.length - 1 && n >= base * 1024n) {
    base *= 1024n;
    unit += 1;
  }
  // Tenths of the unit, rounded down, in integers.
  const tenths = (n * 10n) / base;
  return `${(tenths / 10n).toString()}.${(tenths % 10n).toString()} ${UNITS[unit]} (${exact})`;
}

/** Compact size for a list column. */
export function shortSize(decimal: string): string {
  const s = formatSize(decimal);
  const paren = s.indexOf(" (");
  return paren === -1 ? s : s.slice(0, paren);
}

/** `-rw-r--r--`-style permission bits plus the octal mode. */
export function formatMode(mode: number): string {
  const bits = ["r", "w", "x"];
  let s = "";
  for (let i = 8; i >= 0; i--) {
    s += mode & (1 << i) ? bits[(8 - i) % 3] : "-";
  }
  return `${s} (${(mode & 0o7777).toString(8).padStart(4, "0")})`;
}

/** An IPC error as one sentence; anything else as a generic failure. */
export function errorText(what: string, e: unknown): string {
  return isIpcError(e) ? `${what} (${e.code}): ${e.message}` : `${what}.`;
}
