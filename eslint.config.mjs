import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    // Per-agent dev dist dirs (NEXT_DIST_DIR=.next-foo).
    ".next-*/**",
    "src/generated/**",
    // Agent worktrees (each is a full checkout with its own .next output).
    ".claude/**",
    // Live-workload output (gitignored; may hold a CLI config dir).
    "live-output/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
