import { useCallback, useSyncExternalStore } from 'react';

import { readUserPreference, subscribeToUserPreferences, writeUserPreference } from '@/shared/userSettings';
import { colorFromText, isHexColor } from '@/shared/utils';

const NO_OVERRIDES: Record<string, string> = {};

const readOverrides = (): Record<string, string> => {
  const stored = readUserPreference<unknown>('projectColors', NO_OVERRIDES);
  return stored && typeof stored === 'object' ? (stored as Record<string, string>) : NO_OVERRIDES;
};

/**
 * Used by the sidebar (project rows, conversations) and the workspace split
 * view. Each project's colour: the one the user picked (a synced user preference,
 * keyed by projectId) or, by default, one derived from the project's name.
 */
export function useProjectColors() {
  const overrides = useSyncExternalStore(subscribeToUserPreferences, readOverrides, readOverrides);

  const getProjectColor = useCallback((projectId: string | null | undefined, projectName: string) => {
    const picked = projectId ? overrides[projectId] : undefined;
    return isHexColor(picked) ? picked : colorFromText(projectName || projectId || '');
  }, [overrides]);

  const isCustomColor = useCallback(
    (projectId: string) => isHexColor(overrides[projectId]),
    [overrides],
  );

  /** Saves a picked colour, or with `null` goes back to the name-derived one. */
  const setProjectColor = useCallback((projectId: string, color: string | null) => {
    const next = { ...readOverrides() };
    if (color && isHexColor(color)) {
      next[projectId] = color.toLowerCase();
    } else {
      delete next[projectId];
    }
    writeUserPreference('projectColors', next);
  }, []);

  return { getProjectColor, isCustomColor, setProjectColor };
}
