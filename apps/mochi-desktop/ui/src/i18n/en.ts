// The English message catalogue, assembled from one file per screen
// (apps/mochi-desktop/README.md "Messages"). Keys are `<screen>.<name>`;
// a key must exist here for `t()` to accept it.
import { browser } from "./en/browser";
import { common } from "./en/common";
import { crypt } from "./en/crypt";

export const en = {
  ...common,
  ...browser,
  ...crypt,
} as const;
