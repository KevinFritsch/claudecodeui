import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { beforeEach, test } from 'vitest';

import { useSplitLayout } from '@/modules/project-workspace/hooks/useSplitLayout';
import type { Project, ProjectSession } from '@/shared/types';

/**
 * The split view's focused pane mirrors the router's session; the other panes
 * hold their own. These cover the transitions where the two could drift:
 * dropping a session, clicking a pane, sidebar navigation and New Session.
 */

const project: Project = { projectId: 'p1', displayName: 'kvn', fullPath: '/home/kvn', path: '/home/kvn' };
const sessionA: ProjectSession = { id: 'a', summary: 'A', __provider: 'claude', __projectId: 'p1' };
const sessionB: ProjectSession = { id: 'b', summary: 'B', __provider: 'claude', __projectId: 'p1' };
const sessionC: ProjectSession = { id: 'c', summary: 'C', __provider: 'claude', __projectId: 'p1' };

type HookProps = { selectedSession: ProjectSession | null; newSessionTrigger: number };

const renderSplitLayout = (initial: HookProps) => {
  const navigations: string[] = [];
  const hook = renderHook((props: HookProps) => useSplitLayout({
    selectedProject: project,
    selectedSession: props.selectedSession,
    newSessionTrigger: props.newSessionTrigger,
    onNavigateToSession: (sessionId) => navigations.push(sessionId),
    isMobile: false,
  }), { initialProps: initial });
  return { ...hook, navigations };
};

const paneSessionIds = (panes: Array<{ session: ProjectSession | null }>) =>
  panes.map((pane) => pane.session?.id ?? null);

beforeEach(() => {
  window.localStorage.clear();
});

test('dropping on the right of a single chat opens it beside the current one and focuses it', async () => {
  const { result, rerender, navigations } = renderSplitLayout({ selectedSession: sessionA, newSessionTrigger: 0 });

  await act(async () => {
    await result.current.dropSession({ sessionId: 'b', session: sessionB, project }, { kind: 'cells', cells: [1, 3] });
  });

  assert.equal(result.current.layout, 'columns');
  assert.deepEqual(navigations, ['b']);
  // Until the router switches, the dropped pane shows its own copy, not A.
  assert.deepEqual(paneSessionIds(result.current.panes), ['a', 'b']);
  assert.equal(result.current.panes[1].isFocused, true);

  rerender({ selectedSession: sessionB, newSessionTrigger: 0 });
  assert.deepEqual(paneSessionIds(result.current.panes), ['a', 'b']);
  assert.equal(result.current.panes[1].isFocused, true);
});

test('a sidebar click replaces only the focused pane, and an already open session moves focus', async () => {
  const { result, rerender } = renderSplitLayout({ selectedSession: sessionA, newSessionTrigger: 0 });
  await act(async () => {
    await result.current.dropSession({ sessionId: 'b', session: sessionB, project }, { kind: 'cells', cells: [1, 3] });
  });
  rerender({ selectedSession: sessionB, newSessionTrigger: 0 });

  rerender({ selectedSession: sessionC, newSessionTrigger: 0 });
  assert.deepEqual(paneSessionIds(result.current.panes), ['a', 'c']);

  rerender({ selectedSession: sessionA, newSessionTrigger: 0 });
  assert.deepEqual(paneSessionIds(result.current.panes), ['a', 'c']);
  assert.equal(result.current.panes[0].isFocused, true);
});

test('New Session only resets the focused pane', async () => {
  const { result, rerender } = renderSplitLayout({ selectedSession: sessionA, newSessionTrigger: 0 });
  await act(async () => {
    await result.current.dropSession({ sessionId: 'b', session: sessionB, project }, { kind: 'cells', cells: [1, 3] });
  });
  rerender({ selectedSession: sessionB, newSessionTrigger: 0 });

  rerender({ selectedSession: null, newSessionTrigger: 1 });
  assert.deepEqual(result.current.panes.map((pane) => pane.newSessionTrigger), [0, 1]);
  assert.deepEqual(paneSessionIds(result.current.panes), ['a', null]);
});

test('closing a pane in the two-column layout returns to a single chat', async () => {
  const { result, rerender, navigations } = renderSplitLayout({ selectedSession: sessionA, newSessionTrigger: 0 });
  await act(async () => {
    await result.current.dropSession({ sessionId: 'b', session: sessionB, project }, { kind: 'cells', cells: [1, 3] });
  });
  rerender({ selectedSession: sessionB, newSessionTrigger: 0 });

  act(() => {
    result.current.closePane(result.current.panes[1].paneId);
  });
  assert.equal(result.current.layout, 'single');
  assert.deepEqual(paneSessionIds(result.current.panes), ['a']);
  assert.equal(navigations.at(-1), 'a');
});

test('the grid keeps existing panes and pads the remaining corners', async () => {
  const { result, rerender } = renderSplitLayout({ selectedSession: sessionA, newSessionTrigger: 0 });
  await act(async () => {
    await result.current.dropSession({ sessionId: 'b', session: sessionB, project }, { kind: 'cells', cells: [1, 3] });
  });
  rerender({ selectedSession: sessionB, newSessionTrigger: 0 });

  act(() => result.current.setLayout('grid'));
  assert.equal(result.current.layout, 'grid');
  assert.deepEqual(paneSessionIds(result.current.panes), ['a', 'b', null, null]);

  await act(async () => {
    await result.current.dropSession({ sessionId: 'c', session: sessionC, project }, { kind: 'cells', cells: [3] });
  });
  const bottomRight = result.current.panes.find((pane) => pane.cells.join() === '3');
  assert.equal(bottomRight?.session?.id, 'c');
  assert.equal(bottomRight?.isFocused, true);
  assert.equal(result.current.panes.length, 4);
});

const cellsBySession = (panes: Array<{ session: ProjectSession | null; cells: number[] }>) =>
  Object.fromEntries(panes.map((pane) => [pane.session?.id ?? 'empty', [...pane.cells].sort().join(',')]));

test('dropping on the top edge stacks the chats', async () => {
  const { result } = renderSplitLayout({ selectedSession: sessionA, newSessionTrigger: 0 });
  await act(async () => {
    await result.current.dropSession({ sessionId: 'b', session: sessionB, project }, { kind: 'cells', cells: [0, 1] });
  });
  assert.equal(result.current.layout, 'rows');
  assert.deepEqual(cellsBySession(result.current.panes), { b: '0,1', a: '2,3' });
});

test('a corner drop on a single chat keeps it in the far column and frees the cell below the corner', async () => {
  const { result } = renderSplitLayout({ selectedSession: sessionA, newSessionTrigger: 0 });
  await act(async () => {
    await result.current.dropSession({ sessionId: 'b', session: sessionB, project }, { kind: 'cells', cells: [1] });
  });
  assert.equal(result.current.layout, null);
  assert.deepEqual(cellsBySession(result.current.panes), { a: '0,2', b: '1', empty: '3' });
});

test('dropping on the bottom of a side-by-side pair splits both columns', async () => {
  const { result, rerender } = renderSplitLayout({ selectedSession: sessionA, newSessionTrigger: 0 });
  await act(async () => {
    await result.current.dropSession({ sessionId: 'b', session: sessionB, project }, { kind: 'cells', cells: [1, 3] });
  });
  rerender({ selectedSession: sessionB, newSessionTrigger: 0 });
  await act(async () => {
    await result.current.dropSession({ sessionId: 'c', session: sessionC, project }, { kind: 'cells', cells: [2, 3] });
  });
  assert.deepEqual(cellsBySession(result.current.panes), { a: '0', b: '1', c: '2,3' });

  // Closing the bottom chat lets the neighbour grow back to fill the space.
  act(() => {
    result.current.closePane(result.current.panes.find((pane) => pane.session?.id === 'c')!.paneId);
  });
  assert.equal(result.current.panes.length, 2);
  assert.equal(result.current.panes.flatMap((pane) => pane.cells).length, 4);
});

test('each pane keeps its own tab, and a dropped session opens on its chat', async () => {
  const { result, rerender } = renderSplitLayout({ selectedSession: sessionA, newSessionTrigger: 0 });
  await act(async () => {
    await result.current.dropSession({ sessionId: 'b', session: sessionB, project }, { kind: 'cells', cells: [1, 3] });
  });
  rerender({ selectedSession: sessionB, newSessionTrigger: 0 });

  const paneA = result.current.panes.find((pane) => pane.session?.id === 'a')!;
  const paneB = result.current.panes.find((pane) => pane.session?.id === 'b')!;
  act(() => result.current.setPaneTab(paneA.paneId, 'shell'));
  act(() => result.current.setPaneTab(paneB.paneId, 'git'));
  assert.deepEqual(
    Object.fromEntries(result.current.panes.map((pane) => [pane.session?.id, pane.tab])),
    { a: 'shell', b: 'git' },
  );

  await act(async () => {
    await result.current.dropSession({ sessionId: 'c', session: sessionC, project }, { kind: 'pane', paneId: paneA.paneId });
  });
  const replaced = result.current.panes.find((pane) => pane.paneId === paneA.paneId)!;
  assert.equal(replaced.session?.id, 'c');
  assert.equal(replaced.tab, 'chat');
});
