/**
 * Items the user has set aside on the Work dashboard ("resolved"): hidden from
 * the list without touching the source (no ✅, no reply in Slack). Stored per
 * project in a table this module owns; entries older than 60 days are pruned
 * since their items have long left the lookback window.
 */

import { getConnection } from '@/modules/database/index.js';

import type { WorkItemType } from './links.service.js';

let ensured = false;

function db() {
  const connection = getConnection();
  if (!ensured) {
    connection.exec(`
      CREATE TABLE IF NOT EXISTS work_resolved (
        project_path TEXT NOT NULL,
        item_type TEXT NOT NULL,
        item_key TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (project_path, item_type, item_key)
      );
    `);
    ensured = true;
  }
  return connection;
}

export const resolvedService = {
  keys(projectPath: string, itemType: WorkItemType): Set<string> {
    db().prepare("DELETE FROM work_resolved WHERE created_at < datetime('now', '-60 days')").run();
    const rows = db()
      .prepare('SELECT item_key FROM work_resolved WHERE project_path = ? AND item_type = ?')
      .all(projectPath, itemType) as Array<{ item_key: string }>;
    return new Set(rows.map((r) => r.item_key));
  },

  set(projectPath: string, itemType: WorkItemType, itemKeys: string[], resolved: boolean): void {
    const statement = resolved
      ? db().prepare('INSERT OR IGNORE INTO work_resolved (project_path, item_type, item_key) VALUES (?, ?, ?)')
      : db().prepare('DELETE FROM work_resolved WHERE project_path = ? AND item_type = ? AND item_key = ?');
    const run = db().transaction((keys: string[]) => {
      for (const key of keys) statement.run(projectPath, itemType, key);
    });
    run(itemKeys);
  },
};
