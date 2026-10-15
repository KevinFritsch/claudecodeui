import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '@/shared/api';
import { consumeSessionPlacement } from '@/shared/sessionPlacement';
import type {
  LLMProvider,
  Project,
  ProjectSession,
  ResolvedSplitPane,
  SessionDragPayload,
  SessionNavigationOptions,
  SplitDropTarget,
  SplitLayoutMode,
  SplitPaneTab,
} from '@/shared/types';

/**
 * The chat area is a 2×2 grid of cells numbered 0 = top left, 1 = top right,
 * 2 = bottom left, 3 = bottom right. Every pane covers a rectangle of cells:
 * all four, a half (left, right, top, bottom) or a single corner, and the
 * panes always tile the whole grid.
 */
type SplitPane = {
  /** Stable React key, so a pane keeps its mounted chat when it moves or resizes. */
  paneId: string;
  session: ProjectSession | null;
  project: Project | null;
  cells: number[];
  tab: SplitPaneTab;
  /** New Session counter for this pane's chat; bumped only when New Session targets this pane. */
  newSessionTrigger?: number;
};

type SplitLayoutState = {
  panes: SplitPane[];
  focusedPaneId: string;
  /**
   * Session the focused pane asked the router to open. Until the workspace's
   * selected session catches up, the pane keeps rendering its own copy so it
   * never flashes the previously focused pane's chat.
   */
  pendingSessionId: string | null;
};

/**
 * One project tab: its own split layout. Opening a session of another project
 * switches tab instead of replacing a pane in the current one.
 */
type WorkspaceTab = {
  /** The project this tab belongs to; null until the first session opens in it. */
  projectId: string | null;
  label: string;
  layout: SplitLayoutState;
};

type WorkspaceTabsState = {
  tabs: WorkspaceTab[];
  activeProjectId: string | null;
  /**
   * Tab the user just clicked, waiting for the router to reach its session;
   * like a pane's pendingSessionId, it stops a stale router update from
   * switching straight back.
   */
  pendingProjectId: string | null;
};

type UseSplitLayoutArgs = {
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  newSessionTrigger: number;
  onNavigateToSession: (targetSessionId: string, options?: SessionNavigationOptions) => void;
  isMobile: boolean;
};

const SPLIT_LAYOUT_STORAGE_KEY = 'cloudcli:split-layout';
const WORKSPACE_TABS_STORAGE_KEY = 'cloudcli:workspace-tabs';
const ALL_CELLS = [0, 1, 2, 3];
const SPLIT_PANE_TABS: SplitPaneTab[] = ['chat', 'shell', 'files', 'git'];
const LEFT_HALF = [0, 2];
const RIGHT_HALF = [1, 3];
const TOP_HALF = [0, 1];
const BOTTOM_HALF = [2, 3];
const RECTANGLES = new Set(['0', '1', '2', '3', '0,1', '2,3', '0,2', '1,3', '0,1,2,3']);

const cellKey = (cells: number[]) => [...cells].sort((a, b) => a - b).join(',');
const isRectangle = (cells: number[]) => RECTANGLES.has(cellKey(cells));
const sameCells = (a: number[], b: number[]) => cellKey(a) === cellKey(b);

const createPaneId = () => `pane-${Math.random().toString(36).slice(2, 10)}`;

const createPane = (
  cells: number[],
  session: ProjectSession | null = null,
  project: Project | null = null,
): SplitPane => ({ paneId: createPaneId(), session, project, cells, tab: 'chat', newSessionTrigger: 0 });

const stripProjectSessions = (project: Project | null): Project | null => {
  if (!project) return null;
  const { sessions: _sessions, ...rest } = project;
  return rest;
};

/**
 * Hands cells nobody covers to a neighbouring pane when the two together
 * still form a rectangle (closing a pane lets its neighbour grow); the rest
 * become empty drop targets. `excludedPaneId` keeps a just-dropped pane at
 * the size the user dropped it at.
 */
function fillUncoveredCells(panes: SplitPane[], excludedPaneId: string | null = null): SplitPane[] {
  let result = panes;
  const covered = () => new Set(result.flatMap((pane) => pane.cells));
  let uncovered = ALL_CELLS.filter((cell) => !covered().has(cell));

  // A whole uncovered half can go to one pane in a single step (e.g. closing
  // the right column of two lets the left column take the full width).
  if (uncovered.length > 1 && isRectangle(uncovered)) {
    const absorber = result.find((pane) => pane.paneId !== excludedPaneId && isRectangle([...pane.cells, ...uncovered]));
    if (absorber) {
      result = result.map((pane) => (pane === absorber ? { ...pane, cells: [...pane.cells, ...uncovered] } : pane));
      uncovered = [];
    }
  }

  for (const cell of uncovered) {
    // Prefer growing a pane that holds a chat over growing an empty one.
    const candidates = result
      .filter((pane) => pane.paneId !== excludedPaneId && isRectangle([...pane.cells, cell]))
      .sort((a, b) => Number(Boolean(b.session)) - Number(Boolean(a.session)));
    const absorber = candidates[0];
    result = absorber
      ? result.map((pane) => (pane === absorber ? { ...pane, cells: [...pane.cells, cell] } : pane))
      : [...result, createPane([cell])];
  }
  return result;
}

/** The named arrangement the header's layout buttons show; null for mixed layouts (e.g. one half + two corners). */
function describeLayout(panes: SplitPane[]): SplitLayoutMode | null {
  if (panes.length === 1) return 'single';
  if (panes.length === 4) return 'grid';
  if (panes.length === 2) {
    if (panes.some((pane) => sameCells(pane.cells, LEFT_HALF))) return 'columns';
    if (panes.some((pane) => sameCells(pane.cells, TOP_HALF))) return 'rows';
  }
  return null;
}

const createLayout = (): SplitLayoutState => {
  const pane = createPane(ALL_CELLS);
  return { panes: [pane], focusedPaneId: pane.paneId, pendingSessionId: null };
};

/** Rebuilds one stored layout, or a fresh single pane when it is missing or malformed. */
function parseStoredLayout(storedValue: unknown): SplitLayoutState {
  const fallback = createLayout();
  try {
    if (!storedValue || typeof storedValue !== 'object') return fallback;
    const stored = storedValue as { panes?: Array<Partial<SplitPane>>; focusedPaneId?: string; layout?: string };
    if (!Array.isArray(stored.panes) || stored.panes.length === 0 || stored.panes.length > 4) return fallback;

    // Layouts saved before panes carried cells used a fixed mode instead.
    const legacyCells: Record<string, number[][]> = {
      single: [ALL_CELLS],
      columns: [LEFT_HALF, RIGHT_HALF],
      grid: [[0], [1], [2], [3]],
    };
    const panes = stored.panes.map((pane, index) => ({
      paneId: typeof pane?.paneId === 'string' ? pane.paneId : createPaneId(),
      session: pane?.session && typeof pane.session.id === 'string' ? pane.session : null,
      project: pane?.project && typeof pane.project.projectId === 'string' ? pane.project : null,
      cells: Array.isArray(pane?.cells) ? pane.cells : legacyCells[stored.layout ?? '']?.[index] ?? [],
      tab: SPLIT_PANE_TABS.includes(pane?.tab as SplitPaneTab) ? (pane!.tab as SplitPaneTab) : 'chat',
      newSessionTrigger: 0,
    }));

    // Only accept a layout whose panes are rectangles that tile the grid exactly.
    const allCells = panes.flatMap((pane) => pane.cells);
    const tilesGrid = panes.every((pane) => isRectangle(pane.cells))
      && allCells.length === 4
      && cellKey(allCells) === cellKey(ALL_CELLS);
    if (!tilesGrid) return fallback;

    const focusedPaneId = panes.some((pane) => pane.paneId === stored.focusedPaneId)
      ? (stored.focusedPaneId as string)
      : panes[0].paneId;
    return { panes, focusedPaneId, pendingSessionId: null };
  } catch {
    return fallback;
  }
}

/** Restores the project tabs; a layout saved before tabs existed becomes the first tab. */
function readStoredTabs(): WorkspaceTabsState {
  const single = (layout: SplitLayoutState): WorkspaceTabsState => {
    const project = layout.panes.find((pane) => pane.project)?.project ?? null;
    return {
      tabs: [{ projectId: project?.projectId ?? null, label: project?.displayName ?? '', layout }],
      activeProjectId: project?.projectId ?? null,
      pendingProjectId: null,
    };
  };
  try {
    const raw = window.localStorage.getItem(WORKSPACE_TABS_STORAGE_KEY);
    if (raw) {
      const stored = JSON.parse(raw) as { tabs?: Array<{ projectId?: unknown; label?: unknown; layout?: unknown }>; activeProjectId?: unknown };
      const tabs = (Array.isArray(stored.tabs) ? stored.tabs : []).map((tab) => ({
        projectId: typeof tab.projectId === 'string' ? tab.projectId : null,
        label: typeof tab.label === 'string' ? tab.label : '',
        layout: parseStoredLayout(tab.layout),
      }));
      if (tabs.length > 0) {
        const activeProjectId = typeof stored.activeProjectId === 'string'
          && tabs.some((tab) => tab.projectId === stored.activeProjectId)
          ? stored.activeProjectId
          : tabs[0].projectId;
        return normalizeTabs({ tabs, activeProjectId, pendingProjectId: null });
      }
    }
    const legacy = window.localStorage.getItem(SPLIT_LAYOUT_STORAGE_KEY);
    return normalizeTabs(single(legacy ? parseStoredLayout(JSON.parse(legacy)) : createLayout()));
  } catch {
    return single(createLayout());
  }
}

/** Resolves a dragged recent-conversation row, which only carries a session id, to a session and project. */
async function resolveDraggedSession(
  payload: SessionDragPayload,
): Promise<{ session: ProjectSession; project: Project } | null> {
  if (payload.session && payload.project) {
    return { session: payload.session, project: payload.project };
  }

  try {
    const response = await api.sessionDetails(payload.sessionId);
    if (!response.ok) return null;
    const details = (await response.json())?.data;
    const projectDetails = details?.project;
    if (!projectDetails?.projectId) return null;

    const project: Project = {
      projectId: projectDetails.projectId,
      path: projectDetails.path ?? projectDetails.fullPath ?? '',
      fullPath: projectDetails.fullPath ?? projectDetails.path ?? '',
      displayName: projectDetails.displayName ?? '',
      isStarred: Boolean(projectDetails.isStarred),
    };
    const session: ProjectSession = {
      id: typeof details.sessionId === 'string' && details.sessionId ? details.sessionId : payload.sessionId,
      summary: details.summary ?? '',
      createdAt: details.createdAt ?? undefined,
      lastActivity: details.lastActivity ?? undefined,
      __provider: (typeof details.provider === 'string' ? details.provider : 'claude') as LLMProvider,
      __projectId: project.projectId,
    };
    return { session, project };
  } catch (error) {
    console.error('Error resolving dropped session:', error);
    return null;
  }
}

/**
 * Places a pane on `targetCells`: overlapped panes shrink to what is left of
 * them, panes covered entirely are closed, and leftover cells are refilled.
 */
function placePane(panes: SplitPane[], placed: SplitPane, targetCells: number[]): SplitPane[] {
  const others = panes.flatMap((pane): SplitPane[] => {
    if (pane.paneId === placed.paneId) return [];
    const remaining = pane.cells.filter((cell) => !targetCells.includes(cell));
    if (remaining.length === 0) return [];
    if (isRectangle(remaining)) return [{ ...pane, cells: remaining }];
    // Full grid minus one corner is an L: keep the column away from the
    // corner, and the corner's vertical neighbour becomes free.
    const targetColumn = targetCells[0] % 2;
    return [{ ...pane, cells: remaining.filter((cell) => cell % 2 !== targetColumn) }];
  });
  return fillUncoveredCells([...others, { ...placed, cells: targetCells }], placed.paneId);
}

/**
 * Makes room for one more pane next to the focused one and focuses it (empty;
 * the caller fills it). Splits the focused pane along its longer side; a
 * single-cell pane in a full grid gives way to an empty pane if there is one,
 * otherwise the next pane is reused.
 */
function addPaneBeside(layout: SplitLayoutState): SplitLayoutState {
  const focused = layout.panes.find((pane) => pane.paneId === layout.focusedPaneId) ?? layout.panes[0];
  const empty = layout.panes.find((pane) => !pane.session && pane.paneId !== focused.paneId);
  if (empty) {
    return { ...layout, focusedPaneId: empty.paneId, pendingSessionId: null };
  }
  const columns = new Set(focused.cells.map((cell) => cell % 2));
  const rows = new Set(focused.cells.map((cell) => Math.floor(cell / 2)));
  let target: number[] | null = null;
  if (columns.size === 2) {
    // Spans both columns (full screen or a top/bottom half): take its right side.
    target = focused.cells.filter((cell) => cell % 2 === 1);
  } else if (rows.size === 2) {
    // A left/right half: take its bottom.
    target = focused.cells.filter((cell) => Math.floor(cell / 2) === 1);
  }
  if (target) {
    const added = createPane(target);
    return { ...layout, panes: placePane(layout.panes, added, target), focusedPaneId: added.paneId, pendingSessionId: null };
  }
  // Four chats already: reuse the pane after the focused one.
  const index = layout.panes.findIndex((pane) => pane.paneId === focused.paneId);
  const next = layout.panes[(index + 1) % layout.panes.length];
  return { ...layout, focusedPaneId: next.paneId, pendingSessionId: null };
}

/** The project a pane's session belongs to, or null when unknown. */
const paneProjectId = (pane: SplitPane): string | null => {
  if (!pane.session) return null;
  const fromProject = pane.project?.projectId;
  if (fromProject) return fromProject;
  const tagged = pane.session.__projectId;
  return typeof tagged === 'string' && tagged ? tagged : null;
};

/**
 * Enforces "a tab only holds sessions of its own project": any session found
 * in another project's tab moves to its own project's tab (created if needed,
 * placed in an empty pane or beside the focused one). Run after every change,
 * so no path (drag and drop, open beside, layouts saved before tabs) can mix
 * projects in one tab.
 */
function normalizeTabs(state: WorkspaceTabsState): WorkspaceTabsState {
  const strays: SplitPane[] = [];
  let tabs = state.tabs.map((tab) => {
    if (!tab.projectId) return tab;
    const misplaced = tab.layout.panes.filter((pane) => {
      const projectId = paneProjectId(pane);
      return projectId !== null && projectId !== tab.projectId;
    });
    if (misplaced.length === 0) return tab;
    strays.push(...misplaced);
    let panes = tab.layout.panes.filter((pane) => !misplaced.includes(pane));
    if (panes.length === 0) return { ...tab, layout: createLayout() };
    panes = fillUncoveredCells(panes);
    if (panes.filter((pane) => pane.session).length <= 1) {
      const survivor = panes.find((pane) => pane.session) ?? panes[0];
      panes = [{ ...survivor, cells: ALL_CELLS }];
    }
    const focusedPaneId = panes.some((pane) => pane.paneId === tab.layout.focusedPaneId)
      ? tab.layout.focusedPaneId
      : (panes.find((pane) => pane.session) ?? panes[0]).paneId;
    return { ...tab, layout: { ...tab.layout, panes, focusedPaneId } };
  });
  if (strays.length === 0) return state;

  for (const stray of strays) {
    const projectId = paneProjectId(stray)!;
    const index = tabs.findIndex((tab) => tab.projectId === projectId);
    const alone: SplitLayoutState = {
      panes: [{ ...stray, cells: ALL_CELLS }], focusedPaneId: stray.paneId, pendingSessionId: null,
    };
    if (index < 0) {
      tabs = [...tabs, { projectId, label: stray.project?.displayName ?? '', layout: alone }];
      continue;
    }
    const target = tabs[index];
    if (target.layout.panes.some((pane) => pane.session?.id === stray.session!.id)) continue;
    let layout: SplitLayoutState;
    if (!target.layout.panes.some((pane) => pane.session)) {
      layout = alone;
    } else {
      const roomy = addPaneBeside(target.layout);
      layout = {
        ...roomy,
        panes: roomy.panes.map((pane) => (
          pane.paneId === roomy.focusedPaneId ? { ...pane, session: stray.session, project: stray.project, tab: stray.tab } : pane
        )),
      };
    }
    tabs = tabs.map((tab, tabIndex) => (tabIndex === index ? { ...tab, layout } : tab));
  }
  return { ...state, tabs };
}

/**
 * Owns the chat split view: which sessions are open side by side, stacked or
 * in corners, and which pane is focused. The focused pane always mirrors the
 * router's session, so the sidebar, header and URL keep following it.
 */
export function useSplitLayout({
  selectedProject,
  selectedSession,
  newSessionTrigger,
  onNavigateToSession,
  isMobile,
}: UseSplitLayoutArgs) {
  // Project tabs, each with its own panes and focus; persisted across reloads.
  const [tabsState, setRawTabsState] = useState<WorkspaceTabsState>(readStoredTabs);
  // Every change is normalized, so a tab can never end up holding another project's session.
  const setTabsState = useCallback((update: WorkspaceTabsState | ((previous: WorkspaceTabsState) => WorkspaceTabsState)) => {
    setRawTabsState((previous) => normalizeTabs(typeof update === 'function' ? update(previous) : update));
  }, []);

  const activeTab = tabsState.tabs.find((tab) => tab.projectId === tabsState.activeProjectId) ?? tabsState.tabs[0];
  const state = activeTab.layout;
  const tabsStateRef = useRef(tabsState);
  tabsStateRef.current = tabsState;
  const stateRef = useRef(state);
  stateRef.current = state;

  /** Updates the active tab's layout; the pane-level actions below all go through this. */
  const setState = useCallback((update: SplitLayoutState | ((previous: SplitLayoutState) => SplitLayoutState)) => {
    setTabsState((previous) => {
      const activeIndex = Math.max(0, previous.tabs.findIndex((tab) => tab.projectId === previous.activeProjectId));
      const tabs = [...previous.tabs];
      const layout = typeof update === 'function' ? update(tabs[activeIndex].layout) : update;
      tabs[activeIndex] = { ...tabs[activeIndex], layout };
      return { ...previous, tabs };
    });
  }, [setTabsState]);

  const previousPrimaryIdRef = useRef<string | null>(selectedSession?.id ?? null);
  const previousPrimaryProjectIdRef = useRef<string | null>(selectedProject?.projectId ?? null);
  const previousNewSessionTriggerRef = useRef(newSessionTrigger);

  useEffect(() => {
    try {
      const persisted = {
        activeProjectId: tabsState.activeProjectId,
        tabs: tabsState.tabs.map((tab) => ({
          projectId: tab.projectId,
          label: tab.label,
          layout: { panes: tab.layout.panes, focusedPaneId: tab.layout.focusedPaneId },
        })),
      };
      window.localStorage.setItem(WORKSPACE_TABS_STORAGE_KEY, JSON.stringify(persisted));
    } catch {
      // Storage full or disabled: the layout just won't survive a reload.
    }
  }, [tabsState]);

  // Keep the workspace in step with the router's session (sidebar clicks,
  // New Session, forks):
  //  1. a session already open in some tab gets focus there;
  //  2. a session of another project opens in that project's tab (created if
  //     needed), so the current tab's split stays as it is;
  //  3. otherwise it replaces the focused pane, or goes beside it when the
  //     sidebar asked for that ("Open beside", Alt+click).
  useEffect(() => {
    const primaryId = selectedSession?.id ?? null;
    const primaryProjectId = selectedProject?.projectId ?? null;
    const previousPrimaryId = previousPrimaryIdRef.current;
    const navigationChanged = primaryId !== previousPrimaryId
      || primaryProjectId !== previousPrimaryProjectIdRef.current;
    previousPrimaryIdRef.current = primaryId;
    previousPrimaryProjectIdRef.current = primaryProjectId;
    const primaryProject = stripProjectSessions(selectedProject);
    // Read outside the updater: a hint applies to this navigation only.
    const placement = navigationChanged ? consumeSessionPlacement() : null;

    setTabsState((previous) => {
      const applyToLayout = (layout: SplitLayoutState, besideIfNew: boolean): SplitLayoutState => {
        const updatePaneObjects = (base: SplitLayoutState, paneIndex: number, extra: Partial<SplitLayoutState> = {}) => {
          const panes = [...base.panes];
          panes[paneIndex] = { ...panes[paneIndex], session: selectedSession, project: primaryProject };
          return { ...base, panes, ...extra };
        };
        const matchIndex = primaryId ? layout.panes.findIndex((pane) => pane.session?.id === primaryId) : -1;

        if (layout.pendingSessionId && primaryId !== layout.pendingSessionId && primaryId === previousPrimaryId) {
          // The router has not caught up with a pane click yet; only refresh the
          // copy of the still-selected session wherever it is shown.
          return matchIndex >= 0 ? updatePaneObjects(layout, matchIndex) : layout;
        }
        if (matchIndex >= 0) {
          return updatePaneObjects(layout, matchIndex, { focusedPaneId: layout.panes[matchIndex].paneId, pendingSessionId: null });
        }
        const base = besideIfNew && layout.panes.some((pane) => pane.session) ? addPaneBeside(layout) : layout;
        const focusedIndex = Math.max(0, base.panes.findIndex((pane) => pane.paneId === base.focusedPaneId));
        return updatePaneObjects(base, focusedIndex, { pendingSessionId: null });
      };

      const tabs = [...previous.tabs];
      const activeIndex = Math.max(0, tabs.findIndex((tab) => tab.projectId === previous.activeProjectId));
      const withLabel = (tab: WorkspaceTab): WorkspaceTab => (
        tab.projectId && tab.projectId === primaryProjectId && selectedProject?.displayName && tab.label !== selectedProject.displayName
          ? { ...tab, label: selectedProject.displayName }
          : tab
      );

      // A tab click is still waiting for the router: only refresh objects.
      if (previous.pendingProjectId) {
        const pendingTab = tabs.find((tab) => tab.projectId === previous.pendingProjectId);
        const arrived = !pendingTab?.layout.pendingSessionId || primaryId === pendingTab.layout.pendingSessionId;
        if (!arrived && primaryId === previousPrimaryId) {
          return previous;
        }
      }

      // The session's project decides the tab: its own project's tab (created
      // if needed). A first-run tab nobody has claimed yet is adopted.
      let targetIndex = activeIndex;
      if (primaryProjectId && tabs[activeIndex].projectId !== primaryProjectId) {
        const existing = tabs.findIndex((tab) => tab.projectId === primaryProjectId);
        if (existing >= 0) {
          targetIndex = existing;
        } else if (tabs[activeIndex].projectId === null) {
          tabs[activeIndex] = { ...tabs[activeIndex], projectId: primaryProjectId };
        } else {
          tabs.push({ projectId: primaryProjectId, label: selectedProject?.displayName ?? '', layout: createLayout() });
          targetIndex = tabs.length - 1;
        }
      }
      // A copy of this session left in another tab (opened there before the
      // project was known) is dropped, so it is shown in one place only.
      if (primaryId) {
        tabs.forEach((tab, index) => {
          if (index === targetIndex || !tab.layout.panes.some((pane) => pane.session?.id === primaryId)) return;
          tabs[index] = {
            ...tab,
            layout: {
              ...tab.layout,
              panes: tab.layout.panes.map((pane) => (pane.session?.id === primaryId ? { ...pane, session: null } : pane)),
            },
          };
        });
      }

      const switched = targetIndex !== activeIndex;
      tabs[targetIndex] = withLabel({
        ...tabs[targetIndex],
        layout: applyToLayout(tabs[targetIndex].layout, placement === 'beside' && !switched),
      });
      // A tab left behind with no session in it (an unused New Session) goes away.
      const pruned = switched && !tabs[activeIndex].layout.panes.some((pane) => pane.session)
        ? tabs.filter((_, index) => index !== activeIndex)
        : tabs;
      return {
        tabs: pruned,
        activeProjectId: tabs[targetIndex].projectId,
        pendingProjectId: null,
      };
    });
  }, [selectedProject, selectedSession]);

  // New Session resets only the focused pane of the active tab. Done inside
  // the state update so it lands on the pane chosen by the sync effect above
  // (which may have just switched tab or opened a pane beside).
  useEffect(() => {
    if (newSessionTrigger === previousNewSessionTriggerRef.current) return;
    previousNewSessionTriggerRef.current = newSessionTrigger;
    setState((previous) => ({
      ...previous,
      panes: previous.panes.map((pane) => (
        pane.paneId === previous.focusedPaneId
          ? { ...pane, newSessionTrigger: (pane.newSessionTrigger ?? 0) + 1 }
          : pane
      )),
    }));
  }, [newSessionTrigger, setState]);

  /** Switches to a project tab and points the router at its focused session. */
  const selectTab = useCallback((projectId: string | null) => {
    const current = tabsStateRef.current;
    if (current.activeProjectId === projectId) return;
    const tab = current.tabs.find((candidate) => candidate.projectId === projectId);
    if (!tab) return;
    const focused = tab.layout.panes.find((pane) => pane.paneId === tab.layout.focusedPaneId);
    const target = focused?.session ? focused : tab.layout.panes.find((pane) => pane.session) ?? null;
    if (!target?.session) return;
    const sessionId = target.session.id;
    setTabsState((previous) => ({
      ...previous,
      activeProjectId: projectId,
      pendingProjectId: projectId,
      tabs: previous.tabs.map((candidate) => (
        candidate.projectId === projectId
          ? { ...candidate, layout: { ...candidate.layout, focusedPaneId: target.paneId, pendingSessionId: sessionId } }
          : candidate
      )),
    }));
    onNavigateToSession(sessionId);
  }, [onNavigateToSession]);

  /** Closes a project tab; closing the active one moves to a neighbour. */
  const closeTab = useCallback((projectId: string | null) => {
    const current = tabsStateRef.current;
    if (current.tabs.length <= 1) return;
    const index = current.tabs.findIndex((tab) => tab.projectId === projectId);
    if (index < 0) return;
    const remaining = current.tabs.filter((_, tabIndex) => tabIndex !== index);
    if (current.activeProjectId !== projectId) {
      setTabsState((previous) => ({ ...previous, tabs: previous.tabs.filter((tab) => tab.projectId !== projectId) }));
      return;
    }
    const next = remaining[Math.min(index, remaining.length - 1)];
    const focused = next.layout.panes.find((pane) => pane.paneId === next.layout.focusedPaneId);
    const target = focused?.session ? focused : next.layout.panes.find((pane) => pane.session) ?? null;
    const sessionId = target?.session?.id ?? null;
    setTabsState({
      tabs: remaining.map((tab) => (
        tab === next && target && sessionId
          ? { ...tab, layout: { ...tab.layout, focusedPaneId: target.paneId, pendingSessionId: sessionId } }
          : tab
      )),
      activeProjectId: next.projectId,
      pendingProjectId: sessionId ? next.projectId : null,
    });
    if (sessionId) onNavigateToSession(sessionId);
  }, [onNavigateToSession]);

  /** Makes a pane the focused one and points the router at its session. */
  const focusPane = useCallback((paneId: string) => {
    const current = stateRef.current;
    const pane = current.panes.find((candidate) => candidate.paneId === paneId);
    if (!pane?.session || current.focusedPaneId === paneId) return;
    setState((previous) => ({ ...previous, focusedPaneId: paneId, pendingSessionId: pane.session!.id }));
    onNavigateToSession(pane.session.id);
  }, [onNavigateToSession, setState]);

  /** Switches one pane between its chat, shell, files and source control tabs. */
  const setPaneTab = useCallback((paneId: string, tab: SplitPaneTab) => {
    setState((previous) => {
      const pane = previous.panes.find((candidate) => candidate.paneId === paneId);
      if (!pane || pane.tab === tab) return previous;
      return {
        ...previous,
        panes: previous.panes.map((candidate) => (candidate.paneId === paneId ? { ...candidate, tab } : candidate)),
      };
    });
  }, [setState]);

  const setLayout = useCallback((nextLayout: SplitLayoutMode) => {
    setState((previous) => {
      if (describeLayout(previous.panes) === nextLayout) return previous;
      const focusedPane = previous.panes.find((pane) => pane.paneId === previous.focusedPaneId) ?? previous.panes[0];

      if (nextLayout === 'single') {
        return { ...previous, panes: [{ ...focusedPane, cells: ALL_CELLS }], focusedPaneId: focusedPane.paneId };
      }

      if (nextLayout === 'columns' || nextLayout === 'rows') {
        // Keep the focused pane plus the first other open one, in screen order.
        const companion = previous.panes.find((pane) => pane.paneId !== focusedPane.paneId && pane.session)
          ?? previous.panes.find((pane) => pane.paneId !== focusedPane.paneId)
          ?? createPane([]);
        const focusedFirst = Math.min(...focusedPane.cells) <= Math.min(...(companion.cells.length ? companion.cells : [4]));
        const [firstHalf, secondHalf] = nextLayout === 'columns' ? [LEFT_HALF, RIGHT_HALF] : [TOP_HALF, BOTTOM_HALF];
        const panes = focusedFirst
          ? [{ ...focusedPane, cells: firstHalf }, { ...companion, cells: secondHalf }]
          : [{ ...companion, cells: firstHalf }, { ...focusedPane, cells: secondHalf }];
        return { ...previous, panes };
      }

      // Grid: every pane shrinks to the first corner it covers; the rest open empty.
      // Panes tile the grid, so no two share a first corner.
      const corners = ALL_CELLS.map((cell) => {
        const pane = previous.panes.find((candidate) => Math.min(...candidate.cells) === cell);
        return pane ? { ...pane, cells: [cell] } : createPane([cell]);
      });
      return { ...previous, panes: corners };
    });
  }, [setState]);

  /** Opens a session dragged from the sidebar where it was dropped: a half, a corner, or over an existing pane. */
  const dropSession = useCallback(async (payload: SessionDragPayload, target: SplitDropTarget) => {
    const resolved = await resolveDraggedSession(payload);
    if (!resolved) return;
    const { session } = resolved;
    const project = stripProjectSessions(resolved.project);
    const current = stateRef.current;
    const existingPane = current.panes.find((pane) => pane.session?.id === session.id) ?? null;
    let panes: SplitPane[];
    let targetPaneId: string;

    if (target.kind === 'pane') {
      const targetPane = current.panes.find((pane) => pane.paneId === target.paneId);
      if (!targetPane) return;
      if (existingPane?.paneId === targetPane.paneId) {
        panes = current.panes;
        targetPaneId = targetPane.paneId;
      } else if (existingPane) {
        // Already open elsewhere: swap the two panes' places rather than show it twice.
        panes = current.panes.map((pane) => {
          if (pane.paneId === existingPane.paneId) return { ...pane, cells: targetPane.cells };
          if (pane.paneId === targetPane.paneId) return { ...pane, cells: existingPane.cells };
          return pane;
        });
        targetPaneId = existingPane.paneId;
      } else {
        panes = current.panes.map((pane) => (
          pane.paneId === targetPane.paneId ? { ...pane, session, project, tab: 'chat' as const } : pane
        ));
        targetPaneId = targetPane.paneId;
      }
    } else {
      // Dropping the only open chat onto a part of the screen would just leave empty space beside it.
      const openPanes = current.panes.filter((pane) => pane.session);
      if (existingPane && openPanes.length === 1) return;
      // A session already open moves (keeping its mounted chat) rather than opening twice.
      const placed = existingPane ?? createPane(target.cells, session, project);
      panes = placePane(current.panes, placed, target.cells);
      targetPaneId = placed.paneId;
    }

    setState({ panes, focusedPaneId: targetPaneId, pendingSessionId: session.id });
    onNavigateToSession(session.id);
  }, [onNavigateToSession, setState]);

  const closePane = useCallback((paneId: string) => {
    const current = stateRef.current;
    const closingPane = current.panes.find((pane) => pane.paneId === paneId);
    if (!closingPane || current.panes.length === 1) return;

    const isClosingFocused = current.focusedPaneId === paneId;
    const remaining = current.panes.filter((pane) => pane.paneId !== paneId);
    const nextFocusedPane = isClosingFocused
      ? remaining.find((pane) => pane.session) ?? null
      : current.panes.find((pane) => pane.paneId === current.focusedPaneId) ?? null;

    // Closing the only open chat collapses to a single pane that keeps it: an
    // empty focused pane would otherwise mirror the router's session anyway.
    if (!nextFocusedPane) {
      setState({
        panes: [{ ...closingPane, cells: ALL_CELLS }],
        focusedPaneId: paneId,
        pendingSessionId: null,
      });
      return;
    }

    let panes = fillUncoveredCells(remaining);
    // Once only one chat is left, let it take the whole area.
    if (panes.filter((pane) => pane.session).length === 1) {
      const survivor = panes.find((pane) => pane.session)!;
      panes = [{ ...survivor, cells: ALL_CELLS }];
    }

    const navigateTo = isClosingFocused ? nextFocusedPane.session?.id ?? null : null;
    setState({ panes, focusedPaneId: nextFocusedPane.paneId, pendingSessionId: navigateTo });
    if (navigateTo) onNavigateToSession(navigateTo);
  }, [onNavigateToSession, setState]);

  const visiblePanes = isMobile
    ? state.panes.filter((pane) => pane.paneId === state.focusedPaneId).map((pane) => ({ ...pane, cells: ALL_CELLS }))
    : state.panes;

  const panes: ResolvedSplitPane[] = visiblePanes.map((pane) => {
    const isFocused = pane.paneId === state.focusedPaneId;
    // The focused pane shows the router's live session objects, except while
    // a pane click is still waiting for the router to switch sessions.
    const usesPrimary = isFocused && (!state.pendingSessionId || selectedSession?.id === state.pendingSessionId);
    return {
      paneId: pane.paneId,
      session: usesPrimary ? selectedSession : pane.session,
      project: usesPrimary ? selectedProject : pane.project,
      cells: pane.cells,
      tab: pane.tab,
      isFocused,
      newSessionTrigger: pane.newSessionTrigger ?? 0,
    };
  });

  const tabs = tabsState.tabs.map((tab) => ({
    projectId: tab.projectId,
    label: tab.label || 'Project',
    sessionCount: tab.layout.panes.filter((pane) => pane.session).length,
    isActive: tab === activeTab,
  }));

  return {
    layout: isMobile ? ('single' as const) : describeLayout(state.panes),
    panes,
    tabs,
    selectTab,
    closeTab,
    focusPane,
    setPaneTab,
    setLayout,
    dropSession,
    closePane,
  };
}
