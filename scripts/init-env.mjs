// Creates .env from .env.example with freshly generated secrets (does nothing if .env exists).
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

if (existsSync(".env")) {
  console.log(".env already exists - leaving it untouched");
  process.exit(0);
}
let text = readFileSync(".env.example", "utf8");
const set = (key, value) => {
  text = text.replace(new RegExp(`^${key}=[^\\n#]*`, "m"), `${key}=${value} `);
};
set("SESSION_SECRET", randomBytes(48).toString("base64url"));
set("ENCRYPTION_KEY", randomBytes(32).toString("base64"));
set("CRON_SECRET", randomBytes(24).toString("hex"));
set("ADMIN_PASSWORD", "admin-password-123");
writeFileSync(".env", text);
console.log("Wrote .env with generated secrets (admin@example.com / admin-password-123)");
