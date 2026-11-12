import { Download, FileArchive, FileImage, FileSpreadsheet, FileText, FileVideo, Loader2, Paperclip } from 'lucide-react';
import { useEffect, useState } from 'react';

import { downloadWorkspaceFile, viewWorkspaceFile } from '@/modules/chat';
import { usePaletteOps } from '@/modules/command-palette';
import { api } from '@/shared/api';
import { cn } from '@/shared/utils';
import type { WorkAsset } from '@/modules/work/api';

const ICONS = {
  image: FileImage,
  video: FileVideo,
  pdf: FileText,
  sheet: FileSpreadsheet,
  doc: FileText,
  archive: FileArchive,
  text: FileText,
} as const;

function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function shortFolder(path: string): string {
  const folder = path.replace(/\/[^/]+$/, '').replace(/^\/home\/[^/]+/, '~');
  return folder.length > 48 ? `…${folder.slice(-46)}` : folder;
}

/** Thumbnail fetched through the authenticated content route (a bare <img src> cannot send the token). */
function Thumbnail({ projectId, asset, onOpen }: { projectId: string; asset: WorkAsset; onOpen: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let objectUrl: string | null = null;
    const controller = new AbortController();
    api.readFileBlob(projectId, asset.path, { signal: controller.signal })
      .then((response) => (response.ok ? response.blob() : null))
      .then((blob) => {
        if (!blob) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => undefined);
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [asset.path, projectId]);

  return (
    <button
      type="button"
      onClick={onOpen}
      title={`${asset.name} · ${shortFolder(asset.path)}`}
      className="group/thumb relative h-24 w-14 shrink-0 overflow-hidden rounded-md border border-border/70 bg-muted/40 hover:border-primary/60"
    >
      {url ? (
        <img src={url} alt={asset.name} className="h-full w-full object-cover object-top" />
      ) : (
        <Loader2 className="absolute inset-0 m-auto h-3.5 w-3.5 animate-spin text-muted-foreground" />
      )}
    </button>
  );
}

/**
 * Kvn: the files a Work item's linked sessions produced (screenshots from app
 * tests, PDFs, docs the session wrote). A "N files" chip on the row opens a
 * strip of thumbnails and a file list: click to view/open, arrow to download.
 */
export default function WorkAssets({ assets, projectId }: { assets: WorkAsset[]; projectId: string }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { openFileInEditor } = usePaletteOps();
  if (assets.length === 0) return null;

  const images = assets.filter((asset) => asset.kind === 'image');
  const files = assets.filter((asset) => asset.kind !== 'image');

  const run = async (asset: WorkAsset, action: 'open' | 'download') => {
    setError(null);
    if (action === 'open' && asset.kind === 'text') {
      openFileInEditor(asset.path, null);
      return;
    }
    setBusy(asset.path);
    try {
      if (action === 'open' && (asset.kind === 'image' || asset.kind === 'pdf' || asset.kind === 'video')) {
        await viewWorkspaceFile(projectId, asset.path);
      } else {
        await downloadWorkspaceFile(projectId, asset.path);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const summary = [
    images.length ? `${images.length} screenshot${images.length > 1 ? 's' : ''}` : null,
    files.length ? `${files.length} file${files.length > 1 ? 's' : ''}` : null,
  ].filter(Boolean).join(' · ');

  return (
    <div className="mt-1.5">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className={cn(
          'inline-flex h-6 items-center gap-1 rounded border border-border/70 px-2 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
          open && 'bg-accent text-foreground',
        )}
        title="Files the linked session produced"
      >
        <Paperclip className="h-3 w-3" /> {summary}
      </button>
      {open && (
        <div className="mt-1.5 space-y-1.5 rounded-md border border-border/60 bg-muted/20 p-2">
          {images.length > 0 && (
            <div className="flex gap-1.5 overflow-x-auto pb-1">
              {images.map((asset) => (
                <Thumbnail key={asset.path} projectId={projectId} asset={asset} onOpen={() => void run(asset, 'open')} />
              ))}
            </div>
          )}
          {files.length > 0 && (
            <ul className="space-y-0.5">
              {files.map((asset) => {
                const Icon = ICONS[asset.kind];
                return (
                  <li key={asset.path} className="flex items-center gap-1.5 text-xs">
                    <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <button
                      type="button"
                      onClick={() => void run(asset, 'open')}
                      title={asset.path}
                      className="min-w-0 truncate text-left text-blue-600 hover:underline dark:text-blue-400"
                    >
                      {asset.name}
                    </button>
                    <span className="min-w-0 truncate text-[10px] text-muted-foreground/80">{shortFolder(asset.path)}</span>
                    <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">{sizeLabel(asset.size)}</span>
                    <button
                      type="button"
                      onClick={() => void run(asset, 'download')}
                      aria-label={`Download ${asset.name}`}
                      title={`Download ${asset.name}`}
                      className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                    >
                      {busy === asset.path ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {error && <p className="text-[11px] text-destructive">{error}</p>}
        </div>
      )}
    </div>
  );
}
