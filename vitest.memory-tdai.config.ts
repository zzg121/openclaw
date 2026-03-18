import { defineConfig } from "vitest/config";
import baseConfig from "./vitest.config.ts";

const base = baseConfig as unknown as Record<string, unknown>;
const baseTest = (baseConfig as { test?: { exclude?: string[] } }).test ?? {};
const exclude = baseTest.exclude ?? [];

export default defineConfig({
  ...base,
  test: {
    ...baseTest,
    include: ["extensions/memory-tdai/src/**/*.test.ts"],
    exclude,
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov", "html"],
      include: ["extensions/memory-tdai/src/**/*.ts"],
      exclude: ["extensions/memory-tdai/src/**/*.test.ts"],
      thresholds: {
        lines: 70,
        functions: 70,
        branches: 55,
        statements: 70,
      },
    },
  },
});
