/**
 * Which Work items the user has already seen, so the Work tab can show a count
 * of new ones (a new Slack mention, a newly assigned Jira task). Keys look like
 * "slack:C123:1700000000.000100" or "jira:GOL-123". The first time a project is
 * checked, everything already there is recorded as seen, so only genuinely new
 * items count.
 */

import { getConnection } from '@/modules/database/index.js';

let ensured = false;

function db() {
  const connection = getConnection();
  if (!ensured) {
    connection.exec(`
      CREATE TABLE IF NOT EXISTS work_seen (
        project_path TEXT NOT NULL,
        item_key TEXT NOT NULL,
        seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (project_path, item_key)
      );
    `);
    ensured = true;
  }
  return connection;
}

function insertAll(projectPath: string, keys: string[]): void {
  const statement = db().prepare('INSERT OR IGNORE INTO work_seen (project_path, item_key) VALUES (?, ?)');
  db().transaction((list: string[]) => {
    for (const key of list) statement.run(projectPath, key);
  })(keys);
}

export const seenService = {
  /** Keys among `current` the user has not seen yet. */
  unseen(projectPath: string, current: string[]): string[] {
    const { count } = db()
      .prepare('SELECT COUNT(*) AS count FROM work_seen WHERE project_path = ?')
      .get(projectPath) as { count: number };
    if (count === 0) {
      insertAll(projectPath, current);
      return [];
    }
    const seen = new Set(
      (db().prepare('SELECT item_key FROM work_seen WHERE project_path = ?').all(projectPath) as Array<{ item_key: string }>)
        .map((row) => row.item_key),
    );
    return current.filter((key) => !seen.has(key));
  },

  markSeen(projectPath: string, keys: string[]): void {
    insertAll(projectPath, keys);
    db().prepare("DELETE FROM work_seen WHERE project_path = ? AND seen_at < datetime('now', '-90 days')").run(projectPath);
  },
};
