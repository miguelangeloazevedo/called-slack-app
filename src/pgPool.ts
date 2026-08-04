import { Pool } from "pg";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set. Copy .env.example to .env and fill it in.");
}

// One shared pool for the whole process. Bolt handlers, the installation
// store, and the reminders cron job all import this rather than opening
// their own connections.
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
});

pool.on("error", (err) => {
  // A background, idle client dying (network blip, etc.) should not crash
  // the whole process. Log it and let the pool recycle the connection.
  console.error("[pg] unexpected error on idle client", err);
});
