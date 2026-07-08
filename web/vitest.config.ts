import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

// Two-tier suite (docs/shared-tickets.md §7):
//   npm test              -> tests/unit/**       pure, no DB, seconds
//   npm run test:integration -> tests/integration/**  scratch database
// Integration is opt-in (separate script) so the default `npm test` never
// touches a database.
export default defineConfig({
  resolve: { alias: { "@": resolve(__dirname, "src") } },
  test: {
    include: ["tests/unit/**/*.test.ts"],
    environment: "node",
  },
});
