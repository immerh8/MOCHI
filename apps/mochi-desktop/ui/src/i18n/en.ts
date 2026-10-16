// The English message catalogue, assembled from one file per screen
// (apps/mochi-desktop/README.md "Messages"). Keys are `<screen>.<name>`;
// a key must exist here for `t()` to accept it.
import { browser } from "./en/browser";
import { app } from "./en/app";
import { check } from "./en/check";
import { common } from "./en/common";
import { crypt } from "./en/crypt";
import { extract } from "./en/extract";
import { foreign } from "./en/foreign";
import { help } from "./en/help";
import { settings } from "./en/settings";
import { start } from "./en/start";
import { update } from "./en/update";
import { write } from "./en/write";

export const en = {
  ...app,
  ...common,
  ...check,
  ...browser,
  ...crypt,
  ...extract,
  ...foreign,
  ...help,
  ...settings,
  ...start,
  ...update,
  ...write,
} as const;
