// Message lookup (plan D7 i18n scaffolding). One locale, English, is shipped;
// the catalogue is typed so that a key that does not exist, or a placeholder
// that is not supplied, fails `tsc` and the tests rather than rendering blank.
//
// Rules (docs: apps/mochi-desktop/README.md "Messages"):
// - Only the catalogue's own templates are ever interpreted. Archive-supplied
//   strings (file names, labels, error messages from a foreign archive) are
//   *parameters*: they are inserted as plain text in a single pass and are
//   never scanned for `{placeholders}`, never used as a key, and never used
//   as a template (spec §23.3 #9).
// - Wording is the catalogue's; callers do not concatenate English around it.
import { en } from "./en";

export type MessageKey = keyof typeof en;

type Placeholders<S extends string> = S extends `${string}{${infer P}}${infer Rest}`
  ? P | Placeholders<Rest>
  : never;

type ParamsOf<K extends MessageKey> = Placeholders<(typeof en)[K]>;

/** `t(key)` for a template without placeholders, `t(key, { name })` for one with. */
export type MessageArgs<K extends MessageKey> = [ParamsOf<K>] extends [never]
  ? []
  : [params: { [P in ParamsOf<K>]: string | number }];

const PLACEHOLDER = /\{([A-Za-z0-9_]+)\}/g;

/**
 * Look up a message. The template comes from the catalogue; each placeholder
 * is replaced once, from `params`, and the replacement is not rescanned.
 */
export function t<K extends MessageKey>(key: K, ...args: MessageArgs<K>): string {
  const template: string = en[key];
  const params = (args[0] ?? {}) as Record<string, string | number>;
  return template.replace(PLACEHOLDER, (whole, name: string) => {
    const value = params[name];
    return value === undefined ? whole : String(value);
  });
}

/** The two keys of a count-dependent message: `one` when `n === 1`. */
export function tn<O extends MessageKey, M extends MessageKey>(
  n: number,
  one: O,
  many: M,
  ...args: MessageArgs<O> extends MessageArgs<M> ? MessageArgs<O> : never
): string {
  return (t as (key: MessageKey, ...a: unknown[]) => string)(n === 1 ? one : many, ...args);
}

/** Keys whose only placeholder is `{n}`: a count, formatted with grouping. */
export type CountKey = {
  [K in MessageKey]: [ParamsOf<K>] extends ["n"] ? K : never;
}[MessageKey];

/** "1 file" / "2 files": the count is formatted with thousands separators. */
export function tc(n: number, one: CountKey, many: CountKey): string {
  return (t as (key: MessageKey, ...a: unknown[]) => string)(n === 1 ? one : many, {
    n: n.toLocaleString("en-US"),
  });
}

/** Every template in the shipped catalogue, for tests over the whole wording. */
export function allMessages(): readonly string[] {
  return Object.values(en);
}

/** The shipped locale's language tag (the `lang` of the document). */
export const LOCALE = "en";
