import os from 'node:os';

import { query } from '@anthropic-ai/claude-agent-sdk';
import type { McpServerStatus, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

import { buildClaudeSdkEnv } from '@/modules/providers/list/claude/claude-runtime.provider.js';
import { resolveClaudeCodeExecutablePath } from '@/shared/claude-cli-path.js';

/**
 * Every MCP server a Claude session starts with — claude.ai connectors, the
 * servers plugins bring and the user's own — as the CLI itself reports them.
 *
 * The CLI is the only thing that knows the claude.ai connectors (it fetches
 * them with the login's token) and whether each one actually connects, so the
 * list comes from a Claude Code process that is started, asked, and closed
 * without ever being sent a prompt: nothing reaches the model and no session
 * is written.
 */

type ClaudeConnectorGroup = 'cloud' | 'plugin' | 'local';

type ClaudeConnector = {
  /** The name sessions know the server by, e.g. `claude.ai Slack`. */
  name: string;
  /** The name without its `claude.ai ` or `plugin:<plugin>:` prefix. */
  displayName: string;
  group: ClaudeConnectorGroup;
  /** The plugin that brings the server, for the `plugin` group. */
  plugin: string | null;
  /** Where the server's config lives: claudeai, user, project, local, dynamic… */
  scope: string | null;
  status: McpServerStatus['status'];
  error: string | null;
  transport: string | null;
  url: string | null;
  command: string | null;
  serverVersion: string | null;
  tools: Array<{
    name: string;
    description: string | null;
    readOnly: boolean;
    destructive: boolean;
  }>;
};

type ClaudeConnectorsSnapshot = {
  connectors: ClaudeConnector[];
  checkedAt: string | null;
  /** A check is running; the client asks again until it has finished. */
  refreshing: boolean;
  /** Why the last check failed, when it did. */
  error: string | null;
};

// Connecting is what takes the time (every remote connector is dialled), and
// a connector's state rarely changes on its own, so a check is reused for a
// while and the panel can always ask for a fresh one.
const SNAPSHOT_TTL_MS = 15 * 60_000;
// Below nginx's 60s proxy timeout: a first check is awaited by the request.
const CHECK_TIMEOUT_MS = 45_000;
const POLL_INTERVAL_MS = 1_000;

let snapshot: { connectors: ClaudeConnector[]; checkedAt: number } | null = null;
let lastError: string | null = null;
let inFlight: Promise<void> | null = null;

const readString = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value : null;

// `--figma-api-key=…`, `?token=…`, `PASSWORD: …`: anything named like a
// credential keeps its name and loses its value. A server's command and URL
// are shown in the browser, and some servers take their key on the command line.
const CREDENTIAL_VALUE = /((?:api[-_]?key|key|token|secret|password|passwd|auth)[\w-]*\s*[=:]\s*)([^\s&'"]+)/gi;

function maskCredentials(text: string | null): string | null {
  return text ? text.replace(CREDENTIAL_VALUE, '$1••••') : text;
}

function classify(status: McpServerStatus): Pick<ClaudeConnector, 'group' | 'plugin' | 'displayName'> {
  if (status.scope === 'claudeai' || status.name.startsWith('claude.ai ')) {
    return { group: 'cloud', plugin: null, displayName: status.name.replace(/^claude\.ai /, '') };
  }
  const plugin = /^plugin:([^:]+):(.+)$/.exec(status.name);
  if (plugin) {
    return { group: 'plugin', plugin: plugin[1], displayName: plugin[2] };
  }
  return { group: 'local', plugin: null, displayName: status.name };
}

/** Turns the CLI's status of one server into the row the settings panel shows; exported for its tests. */
export function toClaudeConnector(status: McpServerStatus): ClaudeConnector {
  const config = (status.config ?? {}) as Record<string, unknown>;
  const args = Array.isArray(config.args) ? config.args.filter((arg): arg is string => typeof arg === 'string') : [];
  const command = readString(config.command);
  return {
    name: status.name,
    ...classify(status),
    scope: status.scope ?? null,
    status: status.status,
    error: readString(status.error),
    // A claude.ai connector is reached through Anthropic's proxy, but what the
    // user recognises is the service's own address.
    transport: config.type === 'claudeai-proxy' ? 'http' : readString(config.type) ?? (command ? 'stdio' : null),
    url: maskCredentials(readString(config.url)),
    command: maskCredentials(command ? [command, ...args].join(' ') : null),
    serverVersion: readString(status.serverInfo?.version),
    tools: (status.tools ?? []).map((tool) => ({
      name: tool.name,
      description: readString(tool.description),
      readOnly: Boolean(tool.annotations?.readOnly),
      destructive: Boolean(tool.annotations?.destructive),
    })),
  };
}

async function checkConnectors(): Promise<ClaudeConnector[]> {
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  // Streaming input that ends without a message: until it does, the process
  // starts, connects its servers and answers control requests, but no turn runs.
  const noPrompt: AsyncIterable<SDKUserMessage> = {
    [Symbol.asyncIterator]: () => ({
      next: () => held.then((): IteratorResult<SDKUserMessage> => ({ done: true, value: undefined })),
    }),
  };

  const executable = resolveClaudeCodeExecutablePath(process.env.CLAUDE_CLI_PATH);
  const probe = query({
    prompt: noPrompt,
    options: {
      cwd: os.homedir(),
      env: buildClaudeSdkEnv(),
      settingSources: ['project', 'user', 'local'],
      ...(executable ? { pathToClaudeCodeExecutable: executable } : {}),
    },
  });

  try {
    const deadline = Date.now() + CHECK_TIMEOUT_MS;
    let statuses = await probe.mcpServerStatus();
    while (statuses.some((status) => status.status === 'pending') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      statuses = await probe.mcpServerStatus();
    }
    return statuses.map(toClaudeConnector);
  } finally {
    release();
    probe.close();
  }
}

function startCheck(): Promise<void> {
  if (!inFlight) {
    inFlight = checkConnectors()
      .then((connectors) => {
        snapshot = { connectors, checkedAt: Date.now() };
        lastError = null;
      })
      .catch((error: unknown) => {
        lastError = error instanceof Error ? error.message : String(error);
        console.error('[Connectors] Check failed:', lastError);
      })
      .finally(() => {
        inFlight = null;
      });
  }
  return inFlight;
}

function currentSnapshot(): ClaudeConnectorsSnapshot {
  return {
    connectors: snapshot?.connectors ?? [],
    checkedAt: snapshot ? new Date(snapshot.checkedAt).toISOString() : null,
    refreshing: inFlight !== null,
    error: lastError,
  };
}

/** Used by the providers routes for the Connectors panel in the agents settings. */
export const claudeConnectorsService = {
  /**
   * The last check, starting a new one when asked to or when it has gone
   * stale. Only the very first check is waited for; after that the stored
   * list comes back at once and `refreshing` says a newer one is on its way.
   */
  async getConnectors(options: { refresh?: boolean } = {}): Promise<ClaudeConnectorsSnapshot> {
    const stale = !snapshot || Date.now() - snapshot.checkedAt > SNAPSHOT_TTL_MS;
    if (options.refresh || stale) {
      const check = startCheck();
      if (!snapshot) {
        await check;
      }
    }
    return currentSnapshot();
  },
};
