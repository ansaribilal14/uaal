import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    testTimeout: 30_000,
    hookTimeout: 30_000,
    globals: false,
    // Vitest 4: pools were reworked. Sequential file execution replaces the
    // old `pool: "forks" + poolOptions.forks.singleFork` (port/process-group
    // isolation for HTTP and subprocess tests depends on it).
    fileParallelism: false
  }
});
