// ESLint flat config. AGENTS.md "Tauri v2 rules": archive-supplied strings
// render as text only. `eslint-plugin-react`'s `react/no-danger` stops at
// ESLint 9 (out of support), so the maintained `@eslint-react` rules carry
// it, with a core-ESLint backstop that bans the attribute by name, and
// `ci/check-invariants.sh` greps for it as well.
import js from "@eslint/js";
import eslintReact from "@eslint-react/eslint-plugin";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist", "node_modules", "src/ipc/generated"] },
  {
    files: ["**/*.{ts,tsx}"],
    extends: [
      js.configs.recommended,
      ...tseslint.configs.strict,
      eslintReact.configs["recommended-typescript"],
    ],
    languageOptions: {
      ecmaVersion: 2023,
      globals: globals.browser,
    },
    plugins: { "react-hooks": reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "@eslint-react/dom-no-dangerously-set-innerhtml": "error",
      "@eslint-react/dom-no-dangerously-set-innerhtml-with-children": "error",
      "@eslint-react/dom-no-script-url": "error",
      "no-restricted-syntax": [
        "error",
        {
          selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
          message: "Render archive strings as text only (AGENTS.md, spec §23.3 #9).",
        },
        {
          selector: "AssignmentExpression[left.property.name=/^(innerHTML|outerHTML)$/]",
          message: "Never build HTML from strings (AGENTS.md).",
        },
        {
          selector: "CallExpression[callee.property.name='insertAdjacentHTML']",
          message: "Never build HTML from strings (AGENTS.md).",
        },
      ],
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-new-func": "error",
    },
  },
);
