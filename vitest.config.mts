import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    env: {
      NODE_ENV: "test",
      ENCRYPTION_KEY: "MxC8P03PpxrJ5T9qTKCsCdAJZdWp8bw6HqZ7XdKMtAU=",
      SESSION_SECRET: "test-session-secret-test-session-secret-123",
      REDIS_URL: "",
    },
  },
});
