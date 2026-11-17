import { defineConfig, configDefaults } from "vitest/config";

export default defineConfig({
  esbuild: { target: "node22", tsconfigRaw: { compilerOptions: { target: "ESNext" } } },
  test: { exclude: [...configDefaults.exclude, "tests/tui/framework/**"] },
});
