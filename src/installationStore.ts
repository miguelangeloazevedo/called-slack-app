import type { Installation, InstallationQuery, InstallationStore } from "@slack/bolt";
import { pool } from "./pgPool";

// Bolt's default installation store keeps everything in memory (or, in some
// setups, a flat file) -- fine for a single dev box, useless for a real
// multi-workspace app that gets restarted by pm2. This backs installs with
// the same Postgres instance everything else uses, keyed by team id.
//
// Ledger's version of this file is the reference; this one is a from-scratch
// rewrite rather than a copy, but follows the same shape deliberately, since
// that pattern is what's actually been proven in production on this VPS.
export const pgInstallationStore: InstallationStore = {
  storeInstallation: async (installation: Installation) => {
    const teamId = installation.team?.id ?? installation.enterprise?.id;
    if (!teamId) {
      throw new Error("storeInstallation: no team or enterprise id on installation payload");
    }
    await pool.query(
      `INSERT INTO slack_installations (team_id, installation, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (team_id) DO UPDATE SET installation = EXCLUDED.installation, updated_at = now()`,
      [teamId, installation],
    );
  },

  fetchInstallation: async (query: InstallationQuery<boolean>) => {
    const teamId = query.teamId ?? query.enterpriseId;
    if (!teamId) {
      throw new Error("fetchInstallation: no team or enterprise id on query");
    }
    const { rows } = await pool.query(
      `SELECT installation FROM slack_installations WHERE team_id = $1`,
      [teamId],
    );
    if (!rows[0]) {
      throw new Error(`No installation found for team ${teamId}`);
    }
    return rows[0].installation as Installation;
  },

  deleteInstallation: async (query: InstallationQuery<boolean>) => {
    const teamId = query.teamId ?? query.enterpriseId;
    if (!teamId) return;
    await pool.query(`DELETE FROM slack_installations WHERE team_id = $1`, [teamId]);
    // Uninstall also drops any billing entitlement tied to the workspace,
    // since there's no longer a Slack team to apply it to.
    await pool.query(`DELETE FROM billing_entitlements WHERE workspace_id = $1`, [teamId]);
  },
};
