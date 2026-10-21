// The th message catalogue, assembled from one file per screen (mirrors en.ts).
// A key missing here, or not in English, fails `pnpm typecheck`.
import type { Catalogue } from "./types";
import type { en } from "./en";
import { app } from "./th/app";
import { browser } from "./th/browser";
import { check } from "./th/check";
import { common } from "./th/common";
import { crypt } from "./th/crypt";
import { extract } from "./th/extract";
import { foreign } from "./th/foreign";
import { help } from "./th/help";
import { quick } from "./th/quick";
import { result } from "./th/result";
import { settings } from "./th/settings";
import { start } from "./th/start";
import { toolbar } from "./th/toolbar";
import { update } from "./th/update";
import { write } from "./th/write";

export const th = {
  ...app,
  ...browser,
  ...check,
  ...common,
  ...crypt,
  ...extract,
  ...foreign,
  ...help,
  ...quick,
  ...result,
  ...settings,
  ...start,
  ...toolbar,
  ...update,
  ...write,
} satisfies Catalogue<typeof en>;
