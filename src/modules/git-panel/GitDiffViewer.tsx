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

  // Syntax-colored code per line (null = plain), following file headers in multi-file diffs.
  const tokens = useMemo(() => {
    if (!highlighter) return null;
    let language = highlighter.languageForPath(filePath);
    return preview.lines.map((line) => {
      const headerPath = pathFromHeader(line);
      if (headerPath) {
        language = highlighter.languageForPath(headerPath);
        return null;
      }
      if (!language || line.startsWith('@@') || line.startsWith('---') || line.length > 2000) return null;
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

  const renderDiffLine = (line: string, index: number) => {
    const isAddition = line.startsWith('+') && !line.startsWith('+++');
    const isDeletion = line.startsWith('-') && !line.startsWith('---');
    const isHeader = line.startsWith('@@');
    const lineTokens = tokens?.[index] ?? null;

    return (
      <div
        key={index}
        className={`px-3 py-0.5 font-mono text-xs ${isMobile && wrapText ? 'whitespace-pre-wrap break-all' : 'overflow-x-auto whitespace-pre'
          } ${isAddition ? 'bg-green-50 text-green-700 dark:bg-green-950/50 dark:text-green-300' :
            isDeletion ? 'bg-red-50 text-red-700 dark:bg-red-950/50 dark:text-red-300' :
              isHeader ? 'bg-primary/5 text-primary' :
                'text-muted-foreground/70'
          }`}
      >
        {lineTokens ? (
          <>
            <span className="select-none">{line.slice(0, 1)}</span>
            <span className={`diff-code ${isAddition || isDeletion ? 'text-foreground' : 'text-foreground/70'}`}>
              {renderTokens(lineTokens, String(index))}
            </span>
          </>
        ) : line}
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
      {preview.lines.map((line, index) => renderDiffLine(line, index))}
    </div>
  );
}
