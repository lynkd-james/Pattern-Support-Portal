import type { Config } from "tailwindcss";

// Content globs cover the existing source so the already-implemented utility
// classes (including arbitrary brand-token colours) are generated.
const config: Config = {
  content: ["./src/**/*.{ts,tsx,mdx}"],
  theme: {
    extend: {},
  },
  plugins: [],
};

export default config;
