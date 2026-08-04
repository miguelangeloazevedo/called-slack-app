// Minimal, hand-rolled migration runner. No framework: this project is small
// enough that a single idempotent schema file, run on deploy, is easier to
// reason about than a migrations library. Re-running it is always safe.
//
// This is a standalone script, not part of the app's normal boot path, so
// it has to load .env itself. src/app.ts does this too, but importing it
// alone doesn't help a script that never imports app.ts.
import "dotenv/config";
import { pool } from "../src/pgPool";
import { schemaSql } from "../src/db";

async function main() {
  console.log("[migrate] applying schema...");
  await pool.query(schemaSql);
  console.log("[migrate] done.");
  await pool.end();
}

main().catch((err) => {
  console.error("[migrate] failed", err);
  process.exit(1);
});
