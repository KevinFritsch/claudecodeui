/**
 * Kvn: the files a chat session produced or showed (screenshots, PDFs, CSVs,
 * documents it wrote), so the Work panel can list them on the Jira task / to-do
 * the session is linked to, instead of digging through the conversation.
 *
 * Transcripts are scanned incrementally (only bytes added since the last scan).
 * Media and office files count wherever they are mentioned; markdown/HTML only
 * when the session created them with Write (edits and reads of existing files would be noise).
 * Only existing files under the home folder are returned.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { getConnection } from '@/modules/database/index.js';

import type { WorkLink } from './links.service.js';

export type WorkAsset = {
  path: string;
  name: string;
  kind: 'image' | 'video' | 'pdf' | 'sheet' | 'doc' | 'archive' | 'text';
  size: number;
  modified: string;
  sessionId: string;
};

const HOME = os.homedir();
const MEDIA_EXT = 'png|jpe?g|gif|webp|svg|pdf|csv|xlsx?|docx?|pptx?|zip|mp4|webm|mov';
const MEDIA_RE = new RegExp(`(?:~|${HOME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})/[^\\s"'\`<>()\\[\\]\\\\|*]+?\\.(?:${MEDIA_EXT})(?![A-Za-z0-9])`, 'gi');
const WRITTEN_EXT = /\.(md|html?|txt|json|sql)$/i;
const EXCLUDED = /\/(node_modules|\.git|\.claude|\.cache|Android\/Sdk|\.gradle|build|dist)\//;
const MAX_PER_ITEM = 40;

type ScanState = { path: string; offset: number; found: Map<string, number> };
const scans = new Map<string, ScanState>();

function kindOf(file: string): WorkAsset['kind'] {
  const ext = path.extname(file).toLowerCase();
  if (/^\.(png|jpe?g|gif|webp|svg)$/.test(ext)) return 'image';
  if (/^\.(mp4|webm|mov)$/.test(ext)) return 'video';
  if (ext === '.pdf') return 'pdf';
  if (/^\.(csv|xlsx?)$/.test(ext)) return 'sheet';
  if (/^\.(docx?|pptx?)$/.test(ext)) return 'doc';
  if (ext === '.zip') return 'archive';
  return 'text';
}

function normalize(candidate: string): string | null {
  const expanded = candidate.startsWith('~/') ? path.join(HOME, candidate.slice(2)) : candidate;
  const resolved = path.resolve(expanded);
  if (!resolved.startsWith(`${HOME}/`) || EXCLUDED.test(resolved)) return null;
  return resolved;
}

function scanLines(text: string, found: Map<string, number>, order: { n: number }) {
  for (const line of text.split('\n')) {
    if (!line) continue;
    // JSON escapes slashes as plain "/" but quotes as \" ; unescape just enough for path matching.
    const plain = line.replace(/\\"/g, '"').replace(/\\n/g, ' ');
    for (const match of plain.matchAll(MEDIA_RE)) {
      const file = normalize(match[0]);
      if (file) found.set(file, (order.n += 1));
    }
    if (line.includes('"tool_use"') && line.includes('file_path')) {
      try {
        const entry = JSON.parse(line) as { message?: { content?: Array<{ type?: string; name?: string; input?: { file_path?: string } }> } };
        for (const block of entry.message?.content ?? []) {
          if (block.type !== 'tool_use' || block.name !== 'Write') continue;
          const filePath = block.input?.file_path;
          if (typeof filePath === 'string' && WRITTEN_EXT.test(filePath)) {
            const file = normalize(filePath);
            if (file) found.set(file, (order.n += 1));
          }
        }
      } catch {
        // half-written or non-JSON line
      }
    }
  }
}

function scanSession(sessionId: string, jsonlPath: string): Map<string, number> {
  let state = scans.get(sessionId);
  if (!state || state.path !== jsonlPath) {
    state = { path: jsonlPath, offset: 0, found: new Map() };
    scans.set(sessionId, state);
  }
  let size: number;
  try {
    size = fs.statSync(jsonlPath).size;
  } catch {
    return state.found;
  }
  if (size < state.offset) {
    state.offset = 0;
    state.found.clear();
  }
  if (size === state.offset) return state.found;

  const fd = fs.openSync(jsonlPath, 'r');
  try {
    const buffer = Buffer.alloc(size - state.offset);
    fs.readSync(fd, buffer, 0, buffer.length, state.offset);
    const text = buffer.toString('utf8');
    const lastNewline = text.lastIndexOf('\n');
    if (lastNewline < 0) return state.found;
    scanLines(text.slice(0, lastNewline), state.found, { n: state.found.size });
    state.offset += Buffer.byteLength(text.slice(0, lastNewline + 1));
  } finally {
    fs.closeSync(fd);
  }
  return state.found;
}

function transcriptPath(sessionId: string): string | null {
  const row = getConnection()
    .prepare('SELECT jsonl_path FROM sessions WHERE session_id = ?')
    .get(sessionId) as { jsonl_path: string | null } | undefined;
  return row?.jsonl_path ?? null;
}

/** Assets per linked item ("jira:GOL-3590"), newest file first. */
export function assetsForLinks(links: WorkLink[]): Record<string, WorkAsset[]> {
  const result: Record<string, WorkAsset[]> = {};
  for (const link of links) {
    const jsonl = transcriptPath(link.sessionId);
    if (!jsonl) continue;
    const key = `${link.itemType}:${link.itemKey}`;
    const list = (result[key] ??= []);
    for (const file of scanSession(link.sessionId, jsonl).keys()) {
      if (list.some((asset) => asset.path === file)) continue;
      let stats: fs.Stats;
      try {
        stats = fs.statSync(file);
      } catch {
        continue; // deleted since
      }
      if (!stats.isFile()) continue;
      list.push({
        path: file,
        name: path.basename(file),
        kind: kindOf(file),
        size: stats.size,
        modified: stats.mtime.toISOString(),
        sessionId: link.sessionId,
      });
    }
  }
  for (const key of Object.keys(result)) {
    result[key] = result[key].sort((a, b) => b.modified.localeCompare(a.modified)).slice(0, MAX_PER_ITEM);
    if (result[key].length === 0) delete result[key];
  }
  return result;
}
