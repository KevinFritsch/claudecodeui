import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '@/shared/api';
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

type UseSplitLayoutArgs = {
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  newSessionTrigger: number;
  onNavigateToSession: (targetSessionId: string, options?: SessionNavigationOptions) => void;
  isMobile: boolean;
};

const SPLIT_LAYOUT_STORAGE_KEY = 'cloudcli:split-layout';
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
): SplitPane => ({ paneId: createPaneId(), session, project, cells, tab: 'chat' });

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

function readStoredLayout(): SplitLayoutState {
  const fallbackPane = createPane(ALL_CELLS);
  const fallback: SplitLayoutState = { panes: [fallbackPane], focusedPaneId: fallbackPane.paneId, pendingSessionId: null };

  try {
    const raw = window.localStorage.getItem(SPLIT_LAYOUT_STORAGE_KEY);
    if (!raw) return fallback;
    const stored = JSON.parse(raw) as { panes?: Array<Partial<SplitPane>>; focusedPaneId?: string; layout?: string };
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
  // The panes, the cells each covers and the session it holds, plus focus; persisted across reloads.
  const [state, setState] = useState<SplitLayoutState>(readStoredLayout);
  // Per-pane New Session counters, so New Session only resets the focused pane's chat.
  const [paneNewSessionTriggers, setPaneNewSessionTriggers] = useState<Record<string, number>>({});

  const stateRef = useRef(state);
  stateRef.current = state;
  const previousPrimaryIdRef = useRef<string | null>(selectedSession?.id ?? null);
  const previousNewSessionTriggerRef = useRef(newSessionTrigger);

  useEffect(() => {
    try {
      const { pendingSessionId: _pending, ...persisted } = state;
      window.localStorage.setItem(SPLIT_LAYOUT_STORAGE_KEY, JSON.stringify(persisted));
    } catch {
      // Storage full or disabled: the layout just won't survive a reload.
    }
  }, [state]);

  // Keep the focused pane in step with the router's session (sidebar clicks,
  // New Session, forks). A session already open in another pane moves focus
  // there instead of being opened twice.
  useEffect(() => {
    const primaryId = selectedSession?.id ?? null;
    const previousPrimaryId = previousPrimaryIdRef.current;
    previousPrimaryIdRef.current = primaryId;
    const primaryProject = stripProjectSessions(selectedProject);

    setState((previous) => {
      const updatePaneObjects = (paneIndex: number, extra: Partial<SplitLayoutState> = {}): SplitLayoutState => {
        const panes = [...previous.panes];
        panes[paneIndex] = { ...panes[paneIndex], session: selectedSession, project: primaryProject };
        return { ...previous, panes, ...extra };
      };

      const matchIndex = primaryId
        ? previous.panes.findIndex((pane) => pane.session?.id === primaryId)
        : -1;

      if (previous.pendingSessionId && primaryId !== previous.pendingSessionId && primaryId === previousPrimaryId) {
        // The router has not caught up with a pane click yet; only refresh the
        // copy of the still-selected session wherever it is shown.
        return matchIndex >= 0 ? updatePaneObjects(matchIndex) : previous;
      }

      if (matchIndex >= 0) {
        return updatePaneObjects(matchIndex, {
          focusedPaneId: previous.panes[matchIndex].paneId,
          pendingSessionId: null,
        });
      }

      const focusedIndex = Math.max(0, previous.panes.findIndex((pane) => pane.paneId === previous.focusedPaneId));
      return updatePaneObjects(focusedIndex, { pendingSessionId: null });
    });
  }, [selectedProject, selectedSession]);

  useEffect(() => {
    if (newSessionTrigger === previousNewSessionTriggerRef.current) return;
    previousNewSessionTriggerRef.current = newSessionTrigger;
    const focusedPaneId = stateRef.current.focusedPaneId;
    setPaneNewSessionTriggers((previous) => ({
      ...previous,
      [focusedPaneId]: (previous[focusedPaneId] ?? 0) + 1,
    }));
  }, [newSessionTrigger]);

  /** Makes a pane the focused one and points the router at its session. */
  const focusPane = useCallback((paneId: string) => {
    const current = stateRef.current;
    const pane = current.panes.find((candidate) => candidate.paneId === paneId);
    if (!pane?.session || current.focusedPaneId === paneId) return;
    setState((previous) => ({ ...previous, focusedPaneId: paneId, pendingSessionId: pane.session!.id }));
    onNavigateToSession(pane.session.id);
  }, [onNavigateToSession]);

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
  }, []);

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
  }, []);

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
  }, [onNavigateToSession]);

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
  }, [onNavigateToSession]);

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
      newSessionTrigger: paneNewSessionTriggers[pane.paneId] ?? 0,
    };
  });

  return {
    layout: isMobile ? ('single' as const) : describeLayout(state.panes),
    panes,
    focusPane,
    setPaneTab,
    setLayout,
    dropSession,
    closePane,
  };
}
