import { Download, Loader2 } from 'lucide-react';
import { useState, type ReactNode } from 'react';

import { useMarkdownWorkspaceProjectId } from '@/modules/chat/context/MarkdownWorkspaceContext';
import { downloadWorkspaceFile, fileNameOf, viewWorkspaceFile, workspaceFileKind } from '@/modules/chat/utils/workspaceFiles';
import { usePaletteOps } from '@/modules/command-palette';

const lineFromRef = (value: string): number | null => {
  const match = value.match(/:(\d+)(?::\d+)?$/);
  return match ? Number(match[1]) : null;
};
const stripLineSuffix = (value: string): string => value.replace(/:\d+(?::\d+)?$/, '');

/**
 * Kvn: a file named in a chat message, as a link or an `inline/code/path`.
 * Click: text opens in the editor, images/PDFs open in a new tab, other files
 * download. The arrow next to it always downloads, so anything Claude writes
 * on the server is one click away.
 */
export function FileRefLink({
  reference,
  path: givenPath,
  line: givenLine,
  children,
  variant = 'link',
}: {
  /** Path as written (may carry `:line[:col]`, `~/` or be relative to the project). */
  reference?: string;
  /** Already-parsed path and line (links decode the href after stripping the line suffix). */
  path?: string;
  line?: number | null;
  children: ReactNode;
  variant?: 'link' | 'code';
}) {
  const projectId = useMarkdownWorkspaceProjectId();
  const { openFileInEditor, openDirectory } = usePaletteOps();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trimmed = (reference ?? '').trim();
  const path = givenPath ?? stripLineSuffix(trimmed);
  const line = givenPath !== undefined ? (givenLine ?? null) : lineFromRef(trimmed);
  const isDirectory = path.endsWith('/');
  const kind = workspaceFileKind(path);

  const run = async (action: 'open' | 'download') => {
    setError(null);
    if (action === 'open' && (isDirectory || kind === 'text' || !projectId)) {
      if (isDirectory) openDirectory(path);
      else openFileInEditor(path, line);
      return;
    }
    if (!projectId) return;
    setBusy(true);
    try {
      if (action === 'open' && (kind === 'image' || kind === 'viewable')) await viewWorkspaceFile(projectId, path);
      else await downloadWorkspaceFile(projectId, path);
    } catch (e) {
      setError((e as Error).message);
      window.setTimeout(() => setError(null), 5000);
    } finally {
      setBusy(false);
    }
  };

  const title = isDirectory
    ? `Open folder ${path}`
    : kind === 'text'
      ? `Open ${fileNameOf(path)} in the editor`
      : kind === 'binary'
        ? `Download ${fileNameOf(path)}`
        : `Open ${fileNameOf(path)} in a new tab`;

  return (
    <span className="inline-flex max-w-full items-baseline gap-0.5 align-baseline">
      <a
        href={path}
        title={title}
        onClick={(event) => {
          event.preventDefault();
          void run('open');
        }}
        className={variant === 'code'
          ? 'cursor-pointer break-all rounded-md border border-border/70 bg-muted px-1.5 py-0.5 font-mono text-[0.875em] text-blue-600 hover:underline dark:text-blue-400'
          : 'cursor-pointer text-blue-600 hover:underline dark:text-blue-400'}
      >
        {children}
      </a>
      {!isDirectory && projectId && (
        <button
          type="button"
          onClick={() => void run('download')}
          disabled={busy}
          title={`Download ${fileNameOf(path)}`}
          aria-label={`Download ${fileNameOf(path)}`}
          className="inline-flex translate-y-[2px] items-center rounded p-0.5 text-muted-foreground/70 hover:bg-accent hover:text-foreground disabled:opacity-60"
        >
          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />}
        </button>
      )}
      {error && <span className="text-[11px] text-destructive">{error}</span>}
    </span>
  );
}
