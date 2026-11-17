import eslint from "@eslint/js";
import prettier from "eslint-config-prettier";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["node_modules", "dist", "coverage"],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/tui/framework/native/**/*.mjs"],
    languageOptions: { globals: { process: "readonly", console: "readonly" } },
  },
  {
    files: ["tests/tui/framework/fixtures/**/*.cjs"],
    languageOptions: {
      sourceType: "commonjs",
      globals: {
        process: "readonly",
        console: "readonly",
        Buffer: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        performance: "readonly",
        __dirname: "readonly",
        __filename: "readonly",
      },
    },
  },
  {
    files: ["src/**/*.ts", "src/**/*.tsx", "tests/**/*.ts", "tests/**/*.tsx"],
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  // 层边界：固化实测依赖矩阵（架构 §2/§10）。每个块只列禁止的目标目录，未列即放行；
  // type-only 反向边用 allowTypeImports 放行类型、拦截运行时。
  {
    files: ["src/core/**/*.ts"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [{ group: ["**/tui/**"], message: "架构红线：core 不得依赖 TUI（含内置框架）。" }],
        },
      ],
    },
  },
  {
    files: ["src/llm/**/*.ts"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/core/**", "**/tools/**", "**/security/**", "**/tui/**"],
              message: "llm 是底层，不得依赖 core/tools/security/tui。",
            },
            {
              group: ["**/sessions/**"],
              allowTypeImports: true,
              message: "llm→sessions 仅允许 import type。",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/tools/**/*.ts"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [{ group: ["**/core/**", "**/tui/**"], message: "tools 不得依赖 core/tui。" }],
        },
      ],
    },
  },
  {
    files: ["src/security/**/*.ts"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: ["**/sessions/**", "**/tui/**"], message: "security 不得依赖 sessions/tui。" },
            { group: ["**/core/**"], allowTypeImports: true, message: "security→core 仅允许 import type。" },
            { group: ["**/llm/**"], allowTypeImports: true, message: "security→llm 仅允许 import type。" },
          ],
        },
      ],
    },
  },
  {
    files: ["src/sessions/**/*.ts"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/tools/**", "**/security/**", "**/tui/**"],
              message: "sessions 不得依赖 tools/security/tui。",
            },
          ],
        },
      ],
    },
  },
  prettier,
);
