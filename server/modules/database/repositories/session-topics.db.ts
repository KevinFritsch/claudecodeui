import { getConnection } from '@/modules/database/connection.js';

type TopicRow = {
  topic: string;
  source_hash: string | null;
  updated_at: string;
};

export type SessionTopicRecord = {
  topic: string;
  sourceHash: string | null;
  updatedAt: string;
};

export const sessionTopicsDb = {
  /** The session's current subject line, or null when none was generated yet. */
  getTopic(sessionId: string): string | null {
    const row = getConnection()
      .prepare('SELECT topic FROM session_topics WHERE session_id = ?')
      .get(sessionId) as Pick<TopicRow, 'topic'> | undefined;
    return row?.topic ?? null;
  },

  getRecord(sessionId: string): SessionTopicRecord | null {
    const row = getConnection()
      .prepare('SELECT topic, source_hash, updated_at FROM session_topics WHERE session_id = ?')
      .get(sessionId) as TopicRow | undefined;
    return row ? { topic: row.topic, sourceHash: row.source_hash, updatedAt: row.updated_at } : null;
  },

  setTopic(sessionId: string, topic: string, sourceHash: string | null): void {
    getConnection()
      .prepare(
        `INSERT INTO session_topics (session_id, topic, source_hash, updated_at)
         VALUES (?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(session_id) DO UPDATE SET
           topic = excluded.topic,
           source_hash = excluded.source_hash,
           updated_at = CURRENT_TIMESTAMP`,
      )
      .run(sessionId, topic, sourceHash);
  },
};
