import { BriefcaseBusiness } from 'lucide-react';

import { cn } from '@/shared/utils';
import { useWorkBadge } from '@/modules/work/useWorkBadge';
import { useWorkConfig } from '@/modules/work/useWorkConfig';

/** Fired with `{ project }` to select a project and show its Work tab. */
export const OPEN_WORK_EVENT = 'work:open';

export function openWorkFor(project: unknown) {
  window.dispatchEvent(new CustomEvent(OPEN_WORK_EVENT, { detail: { project } }));
}

/**
 * Kvn: one-click Work button on a sidebar project row (only for projects with
 * Work set up), with the new-items count, so Work no longer needs a session
 * opened first.
 */
export default function WorkShortcut({
  project,
  projectPath,
  size = 'sm',
}: {
  project: unknown;
  projectPath: string | null | undefined;
  size?: 'sm' | 'lg';
}) {
  const { config } = useWorkConfig(projectPath);
  const count = useWorkBadge(projectPath, Boolean(config), false);
  if (!config) return null;
  const isLarge = size === 'lg';
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        openWorkFor(project);
      }}
      title={count > 0 ? `Work · ${count} new` : 'Work'}
      aria-label="Open Work"
      className={cn(
        'relative flex flex-shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-primary',
        isLarge ? 'h-8 w-8 rounded-lg active:scale-90 active:bg-accent' : 'h-6 w-6',
      )}
    >
      <BriefcaseBusiness className={isLarge ? 'h-4 w-4' : 'h-3.5 w-3.5'} />
      {count > 0 && (
        <span className="absolute -right-1 -top-1 min-w-[14px] rounded-full bg-red-500 px-1 text-center text-[9px] font-semibold leading-[14px] text-white">
          {count > 9 ? '9+' : count}
        </span>
      )}
    </button>
  );
}
