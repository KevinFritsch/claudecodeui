import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, test, vi } from 'vitest';

const claudeConnectors = vi.fn();

vi.mock('@/shared/api', () => ({
  api: { providers: { claudeConnectors } },
  readApiJson: async (response: { json: () => Promise<unknown> }) => response.json(),
}));

const { useClaudeConnectors } = await import('@/modules/mcp/hooks/useClaudeConnectors');

const respond = (data: unknown) => ({ ok: true, json: async () => ({ success: true, data }) });
const slack = { name: 'claude.ai Slack', displayName: 'Slack', group: 'cloud', status: 'connected', tools: [] };

afterEach(() => {
  claudeConnectors.mockReset();
  vi.useRealTimers();
});

test('loads the connectors once on mount', async () => {
  claudeConnectors.mockResolvedValue(respond({ connectors: [slack], checkedAt: '2026-11-04T10:00:00Z', refreshing: false, error: null }));

  const { result } = renderHook(() => useClaudeConnectors());

  await waitFor(() => assert.equal(result.current.connectors?.length, 1));
  assert.equal(result.current.isChecking, false);
  assert.deepEqual(claudeConnectors.mock.calls, [[false]]);
});

test('follows a background re-check until it lands', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  claudeConnectors
    .mockResolvedValueOnce(respond({ connectors: [], checkedAt: '2026-11-04T10:00:00Z', refreshing: false, error: null }))
    .mockResolvedValueOnce(respond({ connectors: [], checkedAt: '2026-11-04T10:00:00Z', refreshing: true, error: null }))
    .mockResolvedValueOnce(respond({ connectors: [slack], checkedAt: '2026-11-04T10:01:00Z', refreshing: false, error: null }));

  const { result } = renderHook(() => useClaudeConnectors());
  await waitFor(() => assert.equal(claudeConnectors.mock.calls.length, 1));

  act(() => result.current.refresh());
  await waitFor(() => assert.equal(result.current.isChecking, true));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(4_000);
  });

  await waitFor(() => assert.equal(result.current.connectors?.length, 1));
  assert.equal(result.current.isChecking, false);
  assert.deepEqual(claudeConnectors.mock.calls, [[false], [true], [false]]);
});

test('reports an unreachable server in plain words', async () => {
  claudeConnectors.mockRejectedValue(new TypeError('Failed to fetch'));

  const { result } = renderHook(() => useClaudeConnectors());

  await waitFor(() => assert.match(result.current.error ?? '', /Could not reach the server/));
  assert.equal(result.current.connectors, null);
});
