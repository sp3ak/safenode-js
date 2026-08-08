import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "examples/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: {
        console: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        AbortController: "readonly",
        AbortSignal: "readonly",
        TextEncoder: "readonly",
        fetch: "readonly",
        Response: "readonly",
        Headers: "readonly",
        globalThis: "readonly",
        process: "readonly",
      },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "no-console": "error",
    },
  },
  {
    files: ["src/client.ts"],
    // The default logger is `console`, deliberately: a security SDK should not require a logging
    // dependency to tell you it is failing open.
    rules: { "no-console": "off" },
  },
  {
    files: ["test/**"],
    rules: { "no-console": "off", "@typescript-eslint/no-explicit-any": "off" },
  },
);
