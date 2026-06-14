// vitest configuration for the MCProbe test suite.
//
// Test files live in tests/ and follow the *.test.ts convention. The
// runtime config is intentionally minimal — pure Node, no jsdom, no
// globals, no coverage instrumentation (coverage is out of scope for
// the current ACs). The build tsconfig is separate (tsconfig.json)
// and excludes the tests/ directory so `npm run build` does not
// emit test artifacts; a dedicated tsconfig.test.json handles type
// checking for the test files when `npx tsc -p tsconfig.test.json`
// is run.

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // Deterministic, fast — one file at a time so a failing test
    // produces a clean stack trace.
    pool: "forks",
    poolOptions: {
      forks: { singleFork: true },
    },
    reporters: ["default"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
