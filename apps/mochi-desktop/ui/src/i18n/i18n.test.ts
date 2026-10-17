// The message catalogue as a whole (plan D7 i18n scaffolding; spec §23.3).
/// <reference types="vite/client" />
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

import { allMessages, LOCALE, t, tn } from "./index";
import { en } from "./en";

/**
 * Words the app never uses about an archive, a repair, or a passphrase
 * (§23.3 #4, #6; AGENTS.md "Encrypted profile"). Applies to every template in
 * the catalogue, so a new screen cannot add one by the back door.
 */
const BANNED = [
  "backed up",
  "backup",
  "safe",
  "preserved",
  "secure",
  "revoked",
  "repaired",
  "recovered completely",
  "fully recovered",
];

test("no catalogue entry uses a banned word (§23.3)", () => {
  for (const [key, text] of Object.entries(en)) {
    for (const word of BANNED) {
      expect(text.toLowerCase(), `"${word}" in ${key}: ${text}`).not.toContain(word);
    }
  }
});

test("the catalogue has English text and well-formed placeholders", () => {
  expect(allMessages().length).toBeGreaterThan(300);
  for (const [key, text] of Object.entries(en)) {
    expect(text.length, key).toBeGreaterThan(0);
    // Every brace belongs to a `{name}` placeholder.
    expect(text.replace(/\{[A-Za-z0-9_]+\}/g, ""), key).not.toMatch(/[{}]/);
  }
});

test("a placeholder is replaced once, and a value is never read as a template", () => {
  // File names are archive-supplied (§23.3 #9): braces in one stay braces.
  expect(t("browser.isEncrypted", { name: "{name} {x}" })).toBe("{name} {x} is encrypted");
  expect(t("browser.retentionError", { code: "{message}", message: "{code}" })).toBe(
    "Retention could not be determined ({message}): {code}",
  );
  // A lookup is by the catalogue's own key only: the translator takes no
  // archive string as a key or as a template.
  expect(t("common.errorPlain", { what: "common.cancel" })).toBe("common.cancel.");
});

test("counts pick the one or the many form", () => {
  expect(tn(1, "browser.metaCommitOne", "browser.metaCommitMany", { n: 1 })).toBe("1 version");
  expect(tn(2, "browser.metaCommitOne", "browser.metaCommitMany", { n: 2 })).toBe("2 versions");
});

test("a key that is not in the catalogue is a type error", () => {
  // These calls are never run: they exist so that `tsc` (pnpm typecheck)
  // fails if the lookup ever stops rejecting a missing key or a missing value.
  const neverCalled = () => {
    // @ts-expect-error  no such key
    t("no.such.key");
    // @ts-expect-error  the placeholder {seq} is not supplied
    t("browser.commit");
    // @ts-expect-error  and a misspelled one is not accepted either
    t("browser.commit", { sequence: 1 });
  };
  expect(typeof neverCalled).toBe("function");
});

// Every screen and helper (not tests, generated IPC types, or the catalogue).
const SOURCES = import.meta.glob(
  ["../**/*.{ts,tsx}", "!../**/*.test.{ts,tsx}", "!../ipc/generated/**", "!../i18n/**", "!../test/**"],
  { query: "?raw", import: "default", eager: true },
) as Record<string, string>;

test("every catalogue key is used, so the catalogue does not collect dead wording", () => {
  const text = Object.values(SOURCES).join("\n");
  expect(Object.keys(SOURCES).length).toBeGreaterThan(20);
  // Keys built from a value (`status.${s}`) are named by their prefix.
  const dynamic = ["status.", "status.meaning.", "status.mark.", "dimension.", "check.outcome."];
  const unused = Object.keys(en).filter(
    (k) => !text.includes(`"${k}"`) && !dynamic.some((p) => k.startsWith(p)),
  );
  expect(unused).toEqual([]);
});

test("the page declares the language of the shipped locale and has a title", () => {
  const html = readFileSync(join(process.cwd(), "index.html"), "utf8");
  expect(html).toContain(`<html lang="${LOCALE}">`);
  expect(html).toMatch(/<title>MOCHI<\/title>/);
});
