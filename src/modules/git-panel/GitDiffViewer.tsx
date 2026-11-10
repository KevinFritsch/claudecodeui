import { useEffect, useMemo, useState, type ReactNode } from 'react';

import type * as HighlighterModule from '@/modules/git-panel/diffHighlight';
import type { RefractorNode } from '@/modules/git-panel/diffHighlight';

type Highlighter = typeof HighlighterModule;
let highlighterPromise: Promise<Highlighter> | null = null;

function renderTokens(nodes: RefractorNode[], keyPrefix: string): ReactNode[] {
  return nodes.map((node, index) => {
    const key = `${keyPrefix}.${index}`;
    if (node.type === 'text') return node.value;
    return (
      <span key={key} className={(node.properties.className ?? []).join(' ')}>
        {renderTokens(node.children, key)}
      </span>
    );
  });
}

/** "diff --git a/x b/src/y.ts" or "+++ b/src/y.ts" → "src/y.ts" (multi-file commit diffs). */
function pathFromHeader(line: string): string | null {
  const git = /^diff --git a\/.+ b\/(.+)$/.exec(line);
  if (git) return git[1];
  const plus = /^\+\+\+ (?:b\/)?(.+)$/.exec(line);
  return plus && plus[1] !== '/dev/null' ? plus[1] : null;
}

type GitDiffViewerProps = {
  diff: string | null;
  /** Picks the syntax colors; multi-file diffs use their own headers instead. */
  filePath?: string | null;
  isMobile: boolean;
  wrapText: boolean;
};

const PREVIEW_CHARACTER_LIMIT = 200_000;
const PREVIEW_LINE_LIMIT = 1_500;

type DiffPreview = {
  lines: string[];
  isCharacterTruncated: boolean;
  isLineTruncated: boolean;
};

function buildDiffPreview(diff: string): DiffPreview {
  const isCharacterTruncated = diff.length > PREVIEW_CHARACTER_LIMIT;
  const previewText = isCharacterTruncated ? diff.slice(0, PREVIEW_CHARACTER_LIMIT) : diff;
  const previewLines = previewText.split('\n');
  const isLineTruncated = previewLines.length > PREVIEW_LINE_LIMIT;

  return {
    lines: isLineTruncated ? previewLines.slice(0, PREVIEW_LINE_LIMIT) : previewLines,
    isCharacterTruncated,
    isLineTruncated,
  };
}

/** Rendered by the git panel's changes, compare and history views to display one file's diff. */
export default function GitDiffViewer({ diff, filePath = null, isMobile, wrapText }: GitDiffViewerProps) {
  // Render a bounded preview to keep huge commit diffs from freezing the UI thread.
  const preview = useMemo(() => buildDiffPreview(diff || ''), [diff]);
  const isPreviewTruncated = preview.isCharacterTruncated || preview.isLineTruncated;
  const [highlighter, setHighlighter] = useState<Highlighter | null>(null);

  useEffect(() => {
    let alive = true;
    highlighterPromise ??= import('@/modules/git-panel/diffHighlight');
    highlighterPromise.then((module) => alive && setHighlighter(module)).catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  // Old/new line numbers per line, from the "@@ -a,b +c,d @@" hunk headers.
  const lineNumbers = useMemo(() => {
    let oldLine = 1;
    let newLine = 1;
    let inHunk = false;
    return preview.lines.map((line) => {
      const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (hunk) {
        oldLine = Number(hunk[1]);
        newLine = Number(hunk[2]);
        inHunk = true;
        return null;
      }
      if (line.startsWith('diff --git')) inHunk = false;
      if (!inHunk || line.startsWith('\\')) return null;
      if (line.startsWith('+')) return { old: null, new: newLine++ };
      if (line.startsWith('-')) return { old: oldLine++, new: null };
      return { old: oldLine++, new: newLine++ };
    });
  }, [preview.lines]);

  // Syntax-colored code per line (null = plain), following file headers in multi-file diffs.
  const tokens = useMemo(() => {
    if (!highlighter) return null;
    let language = highlighter.languageForPath(filePath);
    let inHunk = false;
    return preview.lines.map((line) => {
      if (line.startsWith('@@')) {
        inHunk = true;
        return null;
      }
      if (line.startsWith('diff --git')) inHunk = false;
      const headerPath = inHunk ? null : pathFromHeader(line);
      if (headerPath) {
        language = highlighter.languageForPath(headerPath);
        return null;
      }
      if (!language || !inHunk || line.length > 2000) return null;
      const isCode = line.startsWith('+') || line.startsWith('-') || line.startsWith(' ');
      return isCode ? highlighter.highlightLine(line.slice(1), language) : null;
    });
  }, [filePath, highlighter, preview.lines]);

  if (!diff) {
    return (
      <div className="p-4 text-center text-sm text-muted-foreground">
        No diff available
      </div>
    );
  }

  const wraps = isMobile && wrapText;

  const renderDiffLine = (line: string, index: number) => {
    const numbers = lineNumbers[index];
    const isAddition = line.startsWith('+') && (numbers !== null || !line.startsWith('+++'));
    const isDeletion = line.startsWith('-') && (numbers !== null || !line.startsWith('---'));
    const isHeader = line.startsWith('@@');
    const lineTokens = tokens?.[index] ?? null;

    if (isHeader) {
      return (
        <div key={index} className="flex bg-primary/5 font-mono text-[11px] leading-5 text-primary/80">
          <span className="w-[4.5rem] shrink-0 select-none" />
          <span className={`px-2 ${wraps ? 'whitespace-pre-wrap break-all' : 'whitespace-pre'}`}>{line}</span>
        </div>
      );
    }

    return (
      <div
        key={index}
        className={`flex font-mono text-xs leading-5 ${
          isAddition ? 'bg-green-50 text-green-700 dark:bg-green-950/50 dark:text-green-300' :
            isDeletion ? 'bg-red-50 text-red-700 dark:bg-red-950/50 dark:text-red-300' :
              'text-muted-foreground/70'
        }`}
      >
        {/* Kvn: old / new line numbers, like Bitbucket's gutter. */}
        <span className={`flex w-[4.5rem] shrink-0 select-none border-r border-border/40 text-right text-[11px] text-muted-foreground/50 ${
          isAddition ? 'bg-green-100/60 dark:bg-green-900/30' : isDeletion ? 'bg-red-100/60 dark:bg-red-900/30' : ''
        }`}
        >
          <span className="w-9 pr-1.5">{numbers?.old ?? ''}</span>
          <span className="w-9 pr-1.5">{numbers?.new ?? ''}</span>
        </span>
        <span className={`flex-1 px-2 ${wraps ? 'whitespace-pre-wrap break-all' : 'whitespace-pre'}`}>
          {lineTokens ? (
            <>
              <span className="select-none">{line.slice(0, 1)}</span>
              <span className={`diff-code ${isAddition || isDeletion ? 'text-foreground' : 'text-foreground/70'}`}>
                {renderTokens(lineTokens, String(index))}
              </span>
            </>
          ) : line}
        </span>
      </div>
    );
  };

  return (
    <div className="diff-viewer">
      {isPreviewTruncated && (
        <div className="mb-2 rounded-md border border-border bg-card px-3 py-2 text-xs text-muted-foreground">
          Large diff preview: rendering is limited to keep the tab responsive.
        </div>
      )}
      <div className={wraps ? '' : 'overflow-x-auto'}>
        <div className={wraps ? '' : 'min-w-max'}>
          {preview.lines.map((line, index) => renderDiffLine(line, index))}
        </div>
      </div>
    </div>
  );
}
