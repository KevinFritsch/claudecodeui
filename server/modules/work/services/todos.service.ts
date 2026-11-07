/**
 * Personal to-dos for the Work dashboard, kept per project in the app's
 * SQLite database. The table is created by this module (not the shared
 * schema) so the feature stays self-contained in the fork.
 */

import { getConnection } from '@/modules/database/index.js';

export type TodoStatus = 'open' | 'done' | 'cancelled';

export type Todo = {
  id: number;
  projectPath: string;
  text: string;
  status: TodoStatus;
  createdAt: string;
  closedAt: string | null;
};

type Row = {
  id: number;
  project_path: string;
  text: string;
  status: TodoStatus;
  created_at: string;
  closed_at: string | null;
};

let ensured = false;

function db() {
  const connection = getConnection();
  if (!ensured) {
    connection.exec(`
      CREATE TABLE IF NOT EXISTS work_todos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_path TEXT NOT NULL,
        text TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        closed_at DATETIME
      );
      CREATE INDEX IF NOT EXISTS idx_work_todos_project ON work_todos(project_path, status);
    `);
    ensured = true;
  }
  return connection;
}

const toTodo = (row: Row): Todo => ({
  id: row.id,
  projectPath: row.project_path,
  text: row.text,
  status: row.status,
  createdAt: row.created_at,
  closedAt: row.closed_at,
});

export const todosService = {
  /** Open to-dos, plus the ones closed in the last 24 hours (so they can be undone). */
  list(projectPath: string): Todo[] {
    const rows = db()
      .prepare(
        `SELECT * FROM work_todos
         WHERE project_path = ?
           AND (status = 'open' OR closed_at >= datetime('now', '-1 day'))
         ORDER BY CASE status WHEN 'open' THEN 0 ELSE 1 END, created_at DESC, id DESC`,
      )
      .all(projectPath) as Row[];
    return rows.map(toTodo);
  },

  get(id: number): Todo | null {
    const row = db().prepare('SELECT * FROM work_todos WHERE id = ?').get(id) as Row | undefined;
    return row ? toTodo(row) : null;
  },

  create(projectPath: string, text: string): Todo {
    const info = db()
      .prepare('INSERT INTO work_todos (project_path, text) VALUES (?, ?)')
      .run(projectPath, text);
    return toTodo(db().prepare('SELECT * FROM work_todos WHERE id = ?').get(info.lastInsertRowid) as Row);
  },

  update(id: number, changes: { text?: string; status?: TodoStatus }): Todo | null {
    const current = db().prepare('SELECT * FROM work_todos WHERE id = ?').get(id) as Row | undefined;
    if (!current) return null;
    const text = changes.text ?? current.text;
    const status = changes.status ?? current.status;
    const closedAt = status === 'open' ? null : (current.status === status ? current.closed_at : new Date().toISOString().replace('T', ' ').slice(0, 19));
    db()
      .prepare('UPDATE work_todos SET text = ?, status = ?, closed_at = ? WHERE id = ?')
      .run(text, status, closedAt, id);
    return toTodo(db().prepare('SELECT * FROM work_todos WHERE id = ?').get(id) as Row);
  },

  remove(id: number): boolean {
    return db().prepare('DELETE FROM work_todos WHERE id = ?').run(id).changes > 0;
  },
};
