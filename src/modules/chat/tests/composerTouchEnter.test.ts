import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import type { KeyboardEvent } from 'react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';
import { useChatComposerState } from '@/modules/chat/hooks/useChatComposerState';
import type { PermissionMode, Project, ProjectSession } from '@/shared/types';

/**
 * Phone keyboards have no Shift+Enter: their return key (the line-break icon
 * on Android) must add a new line, with the send button sending. Desktops
 * keep Enter-to-send.
 */

const PROJECT: Project = { projectId: 'project-1', displayName: 'Project One', fullPath: '/tmp/project-one' };
const SESSION: ProjectSession = { id: 'session-1', __provider: 'claude', __projectId: 'project-1' };

const originalMatchMedia = window.matchMedia;
const stubPointer = (isTouchOnly: boolean) => {
  window.matchMedia = ((query: string) => ({
    matches: isTouchOnly ? query === '(pointer: coarse)' : query === '(pointer: fine)' || query === '(any-pointer: fine)',
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
};

const pressEnter = (modifiers: { ctrlKey?: boolean } = {}) => {
  const sent: Array<{ type: string }> = [];
  const { result } = renderHook(() => useChatComposerState({
    selectedProject: PROJECT,
    selectedSession: SESSION,
    currentSessionId: SESSION.id,
    provider: 'claude',
    permissionMode: 'default',
    cyclePermissionMode: () => undefined,
    resolvePermissionModeForProvider: () => 'default' as PermissionMode,
    currentProviderModel: 'test-model',
    currentProviderEffort: 'medium',
    isLoading: false,
    canAbortSession: false,
    tokenBudget: null,
    sendMessage: (message) => { sent.push(message as { type: string }); },
    scrollToBottom: () => undefined,
    addMessage: () => undefined,
    setIsUserScrolledUp: () => undefined,
    setPendingPermissionRequests: () => undefined,
  }));
  act(() => result.current.setInput('first line'));

  const preventDefault = vi.fn();
  const textarea = document.createElement('textarea');
  textarea.value = 'first line';
  act(() => {
    result.current.handleKeyDown({
      key: 'Enter',
      shiftKey: false,
      ctrlKey: Boolean(modifiers.ctrlKey),
      metaKey: false,
      altKey: false,
      preventDefault,
      stopPropagation: () => undefined,
      currentTarget: textarea,
      target: textarea,
      nativeEvent: { isComposing: false },
    } as unknown as KeyboardEvent<HTMLTextAreaElement>);
  });
  return { preventDefault, sends: sent.filter((message) => message.type === 'chat.send').length };
};

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('[]', { status: 200 }))));
  window.fetch = globalThis.fetch;
  localStorage.clear();
});

afterEach(() => {
  window.matchMedia = originalMatchMedia;
  vi.unstubAllGlobals();
  localStorage.clear();
});

test('on a touch-only phone, the keyboard return key inserts a line break instead of sending', () => {
  stubPointer(true);
  const { preventDefault, sends } = pressEnter();
  assert.equal(preventDefault.mock.calls.length, 0, 'the default action (a new line) is kept');
  assert.equal(sends, 0);
});

test('with a mouse or trackpad, Enter still sends', () => {
  stubPointer(false);
  const { preventDefault, sends } = pressEnter();
  assert.ok(preventDefault.mock.calls.length > 0, 'no line break is inserted');
  assert.equal(sends, 1);
});

test('Ctrl+Enter sends even on a touch device (attached keyboard)', () => {
  stubPointer(true);
  const { sends } = pressEnter({ ctrlKey: true });
  assert.equal(sends, 1);
});
