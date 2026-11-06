import { useEffect, useState } from 'react';

import { workApi, type WorkConfig } from '@/modules/work/api';

// One request per project path for the page's lifetime; the header and the
// panel both ask, and the config only changes when projects.json is edited.
const configCache = new Map<string, Promise<WorkConfig | null>>();

function loadConfig(projectPath: string): Promise<WorkConfig | null> {
  let pending = configCache.get(projectPath);
  if (!pending) {
    pending = workApi.config(projectPath).catch(() => {
      configCache.delete(projectPath);
      return null;
    });
    configCache.set(projectPath, pending);
  }
  return pending;
}

/**
 * The project's Work config (null when the project has none), and whether the
 * answer for this project path has arrived yet.
 */
export function useWorkConfig(projectPath: string | null | undefined): { config: WorkConfig | null; isLoaded: boolean } {
  const [state, setState] = useState<{ path: string | null; config: WorkConfig | null }>({ path: null, config: null });

  useEffect(() => {
    let cancelled = false;
    if (!projectPath) return undefined;
    void loadConfig(projectPath).then((value) => {
      if (!cancelled) setState({ path: projectPath, config: value && value.enabled ? value : null });
    });
    return () => {
      cancelled = true;
    };
  }, [projectPath]);

  const isLoaded = !projectPath || state.path === projectPath;
  return { config: isLoaded && projectPath ? state.config : null, isLoaded };
}
