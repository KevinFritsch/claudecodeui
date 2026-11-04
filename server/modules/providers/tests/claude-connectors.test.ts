import assert from 'node:assert/strict';
import test from 'node:test';

import { toClaudeConnector } from '@/modules/providers/services/claude-connectors.service.js';

test('a claude.ai connector is grouped as cloud and shows the service address', () => {
  const connector = toClaudeConnector({
    name: 'claude.ai Slack',
    status: 'connected',
    scope: 'claudeai',
    serverInfo: { name: 'Slack', version: '1.2.0' },
    config: { type: 'claudeai-proxy', url: 'https://mcp.slack.com/mcp', id: 'mcpsrv_1' },
    tools: [{ name: 'search', annotations: { readOnly: true } }, { name: 'send', annotations: {} }],
  });

  assert.equal(connector.group, 'cloud');
  assert.equal(connector.displayName, 'Slack');
  assert.equal(connector.transport, 'http');
  assert.equal(connector.url, 'https://mcp.slack.com/mcp');
  assert.equal(connector.serverVersion, '1.2.0');
  assert.deepEqual(connector.tools.map((tool) => [tool.name, tool.readOnly]), [['search', true], ['send', false]]);
});

test('a plugin server keeps its plugin name and full command line', () => {
  const connector = toClaudeConnector({
    name: 'plugin:golfn:golfn-grafana',
    status: 'needs-auth',
    scope: 'dynamic',
    config: { type: 'stdio', command: 'uvx', args: ['mcp-grafana'] },
  });

  assert.equal(connector.group, 'plugin');
  assert.equal(connector.plugin, 'golfn');
  assert.equal(connector.displayName, 'golfn-grafana');
  assert.equal(connector.command, 'uvx mcp-grafana');
  assert.deepEqual(connector.tools, []);
});

test('anything else is one of the user\'s own servers', () => {
  const connector = toClaudeConnector({ name: 'figma-local', status: 'failed', scope: 'user', error: 'spawn ENOENT' });

  assert.equal(connector.group, 'local');
  assert.equal(connector.error, 'spawn ENOENT');
  assert.equal(connector.transport, null);
});

test('credentials in a command line or URL are masked', () => {
  const local = toClaudeConnector({
    name: 'figma-local',
    status: 'connected',
    scope: 'user',
    config: { type: 'stdio', command: 'npx', args: ['-y', 'figma-developer-mcp', '--figma-api-key=figd_SECRET123', '--stdio'] },
  });
  const remote = toClaudeConnector({
    name: 'remote',
    status: 'connected',
    scope: 'user',
    config: { type: 'http', url: 'https://example.com/mcp?token=abc123&region=eu' },
  });

  assert.equal(local.command, 'npx -y figma-developer-mcp --figma-api-key=•••• --stdio');
  assert.equal(remote.url, 'https://example.com/mcp?token=••••&region=eu');
});
