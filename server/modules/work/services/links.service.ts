/**
 * Links between Work items (a Jira task, a to-do) and chat sessions, so an item
 * can reopen the session working on it. Stored in the app's SQLite database in
 * a table this module owns.
 */

import { getConnection } from '@/modules/database/index.js';

export type WorkItemType = 'jira' | 'todo' | 'slack';

export type WorkLink = {
  itemType: WorkItemType;
  itemKey: string;
  sessionId: string;
  /** The session's current name, when it still exists. */
  sessionName: string | null;
  createdAt: string;
};

type Row = {
  item_type: WorkItemType;
  item_key: string;
  session_id: string;
  created_at: string;
  custom_name: string | null;
};

let ensured = false;

function db() {
  const connection = getConnection();
  if (!ensured) {
    connection.exec(`
      CREATE TABLE IF NOT EXISTS work_links (
        project_path TEXT NOT NULL,
        item_type TEXT NOT NULL,
        item_key TEXT NOT NULL,
        session_id TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (project_path, item_type, item_key, session_id)
      );
    `);
    ensured = true;
  }
  return connection;
}

export const linksService = {
  /** Links of a project whose session still exists and is not archived, newest first. */
  list(projectPath: string): WorkLink[] {
    // Sessions deleted for good take their links with them (archived ones keep
    // theirs, hidden, so restoring a session restores its link).
    db()
      .prepare('DELETE FROM work_links WHERE project_path = ? AND session_id NOT IN (SELECT session_id FROM sessions)')
      .run(projectPath);
    const rows = db()
      .prepare(
        `SELECT l.item_type, l.item_key, l.session_id, l.created_at, s.custom_name
         FROM work_links l
         JOIN sessions s ON s.session_id = l.session_id
         WHERE l.project_path = ? AND COALESCE(s.isArchived, 0) = 0
         ORDER BY l.created_at DESC`,
      )
      .all(projectPath) as Row[];
    return rows.map((row) => ({
      itemType: row.item_type,
      itemKey: row.item_key,
      sessionId: row.session_id,
      sessionName: row.custom_name,
      createdAt: row.created_at,
    }));
  },

  add(projectPath: string, itemType: WorkItemType, itemKey: string, sessionId: string): void {
    db()
      .prepare(
        `INSERT OR IGNORE INTO work_links (project_path, item_type, item_key, session_id)
         VALUES (?, ?, ?, ?)`,
      )
      .run(projectPath, itemType, itemKey, sessionId);
  },

  remove(projectPath: string, itemType: WorkItemType, itemKey: string, sessionId: string): boolean {
    return db()
      .prepare('DELETE FROM work_links WHERE project_path = ? AND item_type = ? AND item_key = ? AND session_id = ?')
      .run(projectPath, itemType, itemKey, sessionId).changes > 0;
  },
};
