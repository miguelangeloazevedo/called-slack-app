// Minimal, hand-rolled migration runner. No framework: this project is small
// enough that a single idempotent schema file, run on deploy, is easier to
// reason about than a migrations library. Re-running it is always safe.
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
