import { api } from '@/shared/api';

/**
 * Kvn: files named in chat (links or `inline/code/paths`) live on the server.
 * Text opens in the editor; images and PDFs open in a browser tab; anything
 * else downloads. All reads go through the authenticated file-content route,
 * which accepts absolute and `~/` paths anywhere in the workspace root.
 */
const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/i;
const BROWSER_VIEWABLE = /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif|pdf|mp4|webm|mov|mp3|wav)$/i;
const BINARY_EXTENSIONS = /\.(zip|gz|tgz|tar|7z|rar|apk|aab|ipa|docx?|xlsx?|pptx?|odt|ods|key|numbers|pages|bin|exe|dmg|jar|woff2?|ttf|otf|sqlite|db|mp4|webm|mov|mp3|wav|pdf|png|jpe?g|gif|webp|bmp|ico|avif)$/i;

export type WorkspaceFileKind = 'image' | 'viewable' | 'binary' | 'text';

export function workspaceFileKind(path: string): WorkspaceFileKind {
  if (IMAGE_EXTENSIONS.test(path)) return 'image';
  if (BROWSER_VIEWABLE.test(path)) return 'viewable';
  if (BINARY_EXTENSIONS.test(path)) return 'binary';
  return 'text';
}

/** `~/x/y.md`, `/home/kvn/x.png` (with an extension or a trailing slash): worth turning into a link. */
export function looksLikeServerPath(value: string): boolean {
  const text = value.trim();
  if (text.length < 3 || text.length > 400 || /\s/.test(text)) return false;
  if (!/^(~\/|\/[A-Za-z0-9._-])/.test(text)) return false;
  if (/^\/(api|v\d)\//.test(text)) return false; // API routes, not files
  return /\.[A-Za-z0-9]{1,8}(:\d+(:\d+)?)?$/.test(text) || text.endsWith('/');
}

export function fileNameOf(path: string): string {
  return path.replace(/\/+$/, '').split('/').pop() || 'file';
}

async function fetchBlob(projectId: string, path: string): Promise<Blob> {
  const response = await api.readFileBlob(projectId, path);
  if (!response.ok) {
    let message = `Could not open ${fileNameOf(path)} (${response.status})`;
    try {
      const body = (await response.json()) as { error?: string };
      if (body?.error) message = body.error;
    } catch {
      // keep the generic message
    }
    throw new Error(message);
  }
  return response.blob();
}

export async function downloadWorkspaceFile(projectId: string, path: string): Promise<void> {
  const blob = await fetchBlob(projectId, path);
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileNameOf(path);
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** Opens an image/PDF/video in a new tab (the tab is opened first so popup blockers allow it). */
export async function viewWorkspaceFile(projectId: string, path: string): Promise<void> {
  const tab = window.open('', '_blank');
  try {
    const blob = await fetchBlob(projectId, path);
    const url = URL.createObjectURL(blob);
    if (tab) tab.location.href = url;
    else window.location.assign(url);
    window.setTimeout(() => URL.revokeObjectURL(url), 5 * 60_000);
  } catch (error) {
    tab?.close();
    throw error;
  }
}
