import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { beforeEach, test } from 'vitest';

import { useSplitLayout } from '@/modules/project-workspace/hooks/useSplitLayout';
import { requestSessionPlacement } from '@/shared/sessionPlacement';
import type { Project, ProjectSession } from '@/shared/types';

/**
 * Project tabs: each project keeps its own split, so opening a session of
 * another project no longer replaces a pane in the current one; "beside"
 * opens a session (or a new chat) next to the focused pane.
 */

const GOLFN: Project = { projectId: 'golfn', displayName: 'GolfN', fullPath: '/golfn', path: '/golfn' };
const KVN: Project = { projectId: 'kvn', displayName: 'Kvn', fullPath: '/kvn', path: '/kvn' };
const session = (id: string, project: Project): ProjectSession => ({ id, summary: id, __provider: 'claude', __projectId: project.projectId });
const G1 = session('g1', GOLFN);
const G2 = session('g2', GOLFN);
const K1 = session('k1', KVN);
const K2 = session('k2', KVN);

type Props = { project: Project | null; session: ProjectSession | null; trigger: number };

const renderWorkspace = (initial: Props) => {
  const navigations: string[] = [];
  const hook = renderHook((props: Props) => useSplitLayout({
    selectedProject: props.project,
    selectedSession: props.session,
    newSessionTrigger: props.trigger,
    onNavigateToSession: (id) => navigations.push(id),
    isMobile: false,
  }), { initialProps: initial });
  return { ...hook, navigations };
};

const ids = (panes: Array<{ session: ProjectSession | null }>) => panes.map((pane) => pane.session?.id ?? null);

// Opens g1 and g2 side by side in the GolfN tab.
const openGolfnSplit = (rerender: (props: Props) => void) => {
  requestSessionPlacement('beside');
  rerender({ project: GOLFN, session: G2, trigger: 0 });
};

beforeEach(() => {
  window.localStorage.clear();
});

test('a session of another project opens in its own tab and leaves the split alone', () => {
  const { result, rerender } = renderWorkspace({ project: GOLFN, session: G1, trigger: 0 });
  openGolfnSplit(rerender);
  assert.deepEqual(ids(result.current.panes), ['g1', 'g2']);

  rerender({ project: KVN, session: K1, trigger: 0 });
  assert.deepEqual(result.current.tabs.map((tab) => [tab.label, tab.isActive]), [['GolfN', false], ['Kvn', true]]);
  assert.deepEqual(ids(result.current.panes), ['k1']);

  // Another Kvn session replaces the Kvn tab's pane, not a GolfN one.
  rerender({ project: KVN, session: K2, trigger: 0 });
  assert.deepEqual(ids(result.current.panes), ['k2']);

  // Back to a GolfN session: its tab, with both chats still side by side.
  rerender({ project: GOLFN, session: G1, trigger: 0 });
  assert.equal(result.current.tabs.find((tab) => tab.isActive)?.label, 'GolfN');
  assert.deepEqual(ids(result.current.panes), ['g1', 'g2']);
});

test('clicking a tab shows its split and points the router at its focused session', () => {
  const { result, rerender, navigations } = renderWorkspace({ project: GOLFN, session: G1, trigger: 0 });
  openGolfnSplit(rerender);
  rerender({ project: KVN, session: K1, trigger: 0 });

  act(() => result.current.selectTab('golfn'));
  assert.equal(navigations.at(-1), 'g2', 'g2 was the focused GolfN pane');
  assert.deepEqual(ids(result.current.panes), ['g1', 'g2']);

  // A stale router update for the old session must not flip the tab back.
  rerender({ project: KVN, session: { ...K1 }, trigger: 0 });
  assert.equal(result.current.tabs.find((tab) => tab.isActive)?.label, 'GolfN');

  rerender({ project: GOLFN, session: G2, trigger: 0 });
  assert.equal(result.current.tabs.find((tab) => tab.isActive)?.label, 'GolfN');
});

test('New session beside opens an empty chat next to the current one and only it resets', () => {
  const { result, rerender } = renderWorkspace({ project: GOLFN, session: G1, trigger: 0 });
  requestSessionPlacement('beside');
  rerender({ project: GOLFN, session: null, trigger: 1 });

  assert.deepEqual(ids(result.current.panes), ['g1', null]);
  assert.equal(result.current.panes[1].isFocused, true);
  assert.deepEqual(result.current.panes.map((pane) => pane.newSessionTrigger), [0, 1]);
});

test('a plain session click still replaces the focused pane', () => {
  const { result, rerender } = renderWorkspace({ project: GOLFN, session: G1, trigger: 0 });
  rerender({ project: GOLFN, session: G2, trigger: 0 });
  assert.deepEqual(ids(result.current.panes), ['g2']);
  assert.equal(result.current.tabs.length, 1);
});

test('closing the active tab moves to the other one', () => {
  const { result, rerender, navigations } = renderWorkspace({ project: GOLFN, session: G1, trigger: 0 });
  rerender({ project: KVN, session: K1, trigger: 0 });
  act(() => result.current.closeTab('kvn'));
  assert.deepEqual(result.current.tabs.map((tab) => tab.label), ['GolfN']);
  assert.equal(navigations.at(-1), 'g1');
});

const tabOf = (result: { current: ReturnType<typeof useSplitLayout> }) => result.current.tabs.find((tab) => tab.isActive)?.label;

test('a layout saved with two projects side by side is split into one tab per project', () => {
  window.localStorage.setItem('cloudcli:split-layout', JSON.stringify({
    panes: [
      { paneId: 'a', session: G1, project: GOLFN, cells: [0, 2], tab: 'chat' },
      { paneId: 'b', session: K1, project: KVN, cells: [1, 3], tab: 'chat' },
    ],
    focusedPaneId: 'a',
  }));
  const { result } = renderWorkspace({ project: GOLFN, session: G1, trigger: 0 });
  assert.deepEqual(result.current.tabs.map((tab) => tab.label).sort(), ['GolfN', 'Kvn']);
  assert.deepEqual(ids(result.current.panes), ['g1']);
});

test('a dropped session of another project goes to that project tab', async () => {
  const { result, rerender } = renderWorkspace({ project: GOLFN, session: G1, trigger: 0 });
  await act(async () => {
    await result.current.dropSession({ sessionId: 'k1', session: K1, project: KVN }, { kind: 'cells', cells: [1, 3] });
  });
  rerender({ project: KVN, session: K1, trigger: 0 });
  assert.equal(tabOf(result), 'Kvn');
  assert.deepEqual(ids(result.current.panes), ['k1']);

  act(() => result.current.selectTab('golfn'));
  assert.deepEqual(ids(result.current.panes), ['g1'], 'the GolfN tab holds GolfN only');
});

test('open beside with a session of another project opens it in that project tab', () => {
  const { result, rerender } = renderWorkspace({ project: GOLFN, session: G1, trigger: 0 });
  requestSessionPlacement('beside');
  rerender({ project: KVN, session: K1, trigger: 0 });
  assert.equal(tabOf(result), 'Kvn');
  assert.deepEqual(ids(result.current.panes), ['k1']);
});

test('a sidebar click that updates the session before the project keeps both tabs', () => {
  const { result, rerender } = renderWorkspace({ project: KVN, session: K1, trigger: 0 });
  rerender({ project: GOLFN, session: G1, trigger: 0 });
  act(() => result.current.selectTab('kvn'));
  rerender({ project: KVN, session: K1, trigger: 0 });
  assert.equal(tabOf(result), 'Kvn');

  // The router switches the session first, the project a render later.
  rerender({ project: KVN, session: G2, trigger: 0 });
  rerender({ project: GOLFN, session: G2, trigger: 0 });

  assert.deepEqual(result.current.tabs.map((tab) => tab.label).sort(), ['GolfN', 'Kvn'], 'the Kvn tab survives');
  assert.equal(tabOf(result), 'GolfN');
  assert.deepEqual(ids(result.current.panes), ['g2']);
  act(() => result.current.selectTab('kvn'));
  assert.deepEqual(ids(result.current.panes), ['k1'], 'and still holds its session');
});
