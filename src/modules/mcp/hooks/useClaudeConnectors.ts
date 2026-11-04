import { useCallback, useEffect, useState } from 'react';

import { api, readApiJson } from '@/shared/api';

type ConnectorStatus = 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled';
type ConnectorGroup = 'cloud' | 'plugin' | 'local';

/** One MCP server a Claude session starts with, as the server's check reported it. */
export type ClaudeConnector = {
  name: string;
  displayName: string;
  group: ConnectorGroup;
  plugin: string | null;
  scope: string | null;
  status: ConnectorStatus;
  error: string | null;
  transport: string | null;
  url: string | null;
  command: string | null;
  serverVersion: string | null;
  tools: Array<{ name: string; description: string | null; readOnly: boolean; destructive: boolean }>;
};

type ConnectorsSnapshot = {
  connectors: ClaudeConnector[];
  checkedAt: string | null;
  refreshing: boolean;
  error: string | null;
};

// Once there is a list, a check runs in the background on the server; ask
// again until it has landed.
const REFRESH_POLL_MS = 4_000;

/**
 * Used by the Connectors panel: loads Claude's MCP servers with their status
 * and tools, and follows a background re-check until it finishes.
 */
export function useClaudeConnectors() {
  // The last check the server returned; null until the first one arrives.
  const [snapshot, setSnapshot] = useState<ConnectorsSnapshot | null>(null);
  // A request is in flight, which disables Refresh and spins its icon.
  const [isLoading, setIsLoading] = useState(false);
  // Why the request itself failed (the server reports a failed check in the snapshot).
  const [requestError, setRequestError] = useState<string | null>(null);

  const load = useCallback(async (refresh: boolean) => {
    setIsLoading(true);
    try {
      const payload = await readApiJson<{ data: ConnectorsSnapshot }>(
        await api.providers.claudeConnectors(refresh),
      );
      setSnapshot(payload.data);
      setRequestError(null);
    } catch (error) {
      // fetch() rejects with a TypeError when no answer came back at all.
      setRequestError(error instanceof TypeError
        ? 'Could not reach the server. Check the connection and try again.'
        : error instanceof Error ? error.message : String(error));
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(false);
  }, [load]);

  const isRefreshing = Boolean(snapshot?.refreshing);
  useEffect(() => {
    if (!isRefreshing) return;
    const timer = setTimeout(() => void load(false), REFRESH_POLL_MS);
    return () => clearTimeout(timer);
  }, [isRefreshing, load, snapshot]);

  return {
    connectors: snapshot?.connectors ?? null,
    checkedAt: snapshot?.checkedAt ?? null,
    isChecking: isLoading || isRefreshing,
    isFirstCheck: !snapshot && isLoading,
    error: requestError || snapshot?.error || null,
    refresh: useCallback(() => void load(true), [load]),
  };
}
