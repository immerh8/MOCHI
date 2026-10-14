// WCAG 2.1 AA contrast for the theme (plan D7): 4.5:1 for text (1.4.3), 3:1
// for the focus ring and the borders that mark a control or a status (1.4.11).
// Every colour in styles.css is a token in `:root`, so this reads the real
// stylesheet and cannot drift from it.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

import { contrast } from "../test/contrast";

const css = readFileSync(join(process.cwd(), "src/styles.css"), "utf8");

function tokens(): Record<string, string> {
  const root = /:root\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
  const out: Record<string, string> = {};
  for (const m of root.matchAll(/--([a-z-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) out[m[1] ?? ""] = m[2] ?? "";
  return out;
}

const T = tokens();
const c = (name: string): string => {
  const v = T[name];
  if (!v) throw new Error(`no colour token --${name}`);
  return v;
};

/** The surfaces text can sit on: the page, a panel or list, a selected row. */
const SURFACES = ["bg", "surface", "accent-bg"];

test("the stylesheet defines the colour tokens it uses, and nothing else is a raw colour", () => {
  const outside = css.replace(/:root\s*\{[^}]*\}/, "");
  expect(outside.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [], "raw hex colour outside :root").toEqual([]);
  expect(outside.match(/\b(?:rgb|rgba|hsl|hsla)\(/g) ?? [], "raw colour function outside :root").toEqual([]);
  for (const used of outside.matchAll(/var\(--([a-z-]+)\)/g)) expect(T[used[1] ?? ""], `--${used[1]}`).toBeDefined();
});

test.each(["fg", "muted", "error", "accent"])("text colour --%s reaches 4.5:1 on every surface", (name) => {
  for (const surface of SURFACES) {
    const ratio = contrast(c(name), c(surface));
    expect(ratio, `--${name} on --${surface} is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
  }
});

test("the status badges' text reaches 4.5:1 on their own fill", () => {
  for (const fill of ["pass", "fail"]) {
    const ratio = contrast(c("on-strong"), c(fill));
    expect(ratio, `white on --${fill} is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
  }
});

test("the focus ring and the borders that mark a control reach 3:1", () => {
  for (const surface of SURFACES) {
    expect(contrast(c("focus"), c(surface)), `--focus on --${surface}`).toBeGreaterThanOrEqual(3);
    expect(contrast(c("muted"), c(surface)), `status border on --${surface}`).toBeGreaterThanOrEqual(3);
  }
  // The warning bar is a non-text cue next to text that says the same thing.
  for (const surface of ["bg", "surface"]) {
    expect(contrast(c("warning"), c(surface)), `--warning on --${surface}`).toBeGreaterThanOrEqual(3);
  }
  // A selected row is marked by its border, not by the fill alone.
  expect(contrast(c("accent"), c("surface"))).toBeGreaterThanOrEqual(3);
});

test("only PASS is green, and the failure fill is not the success fill", () => {
  expect(c("pass")).not.toBe(c("fail"));
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  for (const [, selector, body] of rules) {
    if (body?.includes("var(--pass)")) expect(selector?.trim()).toBe(".status-pass");
  }
});

test("a status never rests on colour: it has a glyph, a border, and (in the markup) its word", () => {
  expect(css).toMatch(/\.status::before\s*\{[^}]*attr\(data-mark\)/);
  expect(css).toMatch(/\.status-attention\s*\{[^}]*border-style:\s*dashed/);
  expect(css).toMatch(/\.status\s*\{[^}]*border:\s*1px solid/);
});

test("focus is always drawn, and nothing turns the outline off", () => {
  expect(css).toMatch(/:focus-visible\s*\{[^}]*outline:\s*3px solid var\(--focus\)/);
  expect(css).not.toMatch(/outline:\s*(none|0)\b/);
});
