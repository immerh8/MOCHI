// TODO(translate): replace every value with Thai text. Keep the keys, the {placeholders}, and
// the spec section 23.3 wording rules (see ../README.md). Do not translate error codes.
import type { Catalogue } from "../types";
import type { app as enApp } from "../en/app";
// The window itself: title and section navigation.
export const app = {
  "app.title": "MOCHI",
  "app.sectionPassphrases": "Passphrases",
  "app.sectionCheck": "Test, health, and repair",
  "app.sectionSettings": "Settings",
} satisfies Catalogue<typeof enApp>;
