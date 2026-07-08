import { defineConfig } from "vitest/config";
import { resolve } from "node:path";
import { config as loadEnv } from "dotenv";

// Integration tests hit a real Postgres (scratch DB); load .env like the tsx
// scripts do. Unit tests never touch a DB, so their config does not load this.
loadEnv();

// Integration tier: workflow tests against an isolated scratch database
// (created/migrated/seeded/dropped per file). Longer hooks, single-threaded so
// scratch-DB lifecycle is deterministic. Run with: npm run test:integration.
export default defineConfig({
  resolve: { alias: { "@": resolve(__dirname, "src") } },
  test: {
    include: ["tests/integration/**/*.test.ts"],
    environment: "node",
    hookTimeout: 120_000,
    testTimeout: 120_000,
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
  },
});
