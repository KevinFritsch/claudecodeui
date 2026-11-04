import { useMemo, useState } from 'react';
import { ChevronRight, Cloud, ExternalLink, Package, Plug, RefreshCw, Search, Server } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Badge, Button, buttonVariants, Input } from '@/shared/ui';
import { useClaudeConnectors } from '@/modules/mcp/hooks/useClaudeConnectors';
import type { ClaudeConnector } from '@/modules/mcp/hooks/useClaudeConnectors';

type Connector = ClaudeConnector;
type ConnectorStatus = Connector['status'];
type ConnectorGroup = Connector['group'];

// Where claude.ai connectors are added and signed in to; sessions here pick
// them up from the account on their next check.
const CLAUDE_CONNECTORS_URL = 'https://claude.ai/settings/connectors';

const STATUS_ORDER: Record<ConnectorStatus, number> = {
  connected: 0,
  pending: 1,
  'needs-auth': 2,
  failed: 3,
  disabled: 4,
};

const STATUS_DOT: Record<ConnectorStatus, string> = {
  connected: 'bg-emerald-500',
  pending: 'bg-muted-foreground/50 animate-pulse',
  'needs-auth': 'bg-amber-500',
  failed: 'bg-red-500',
  disabled: 'bg-muted-foreground/40',
};

const GROUP_ICON: Record<ConnectorGroup, typeof Cloud> = {
  cloud: Cloud,
  plugin: Package,
  local: Server,
};

function formatCheckedAt(checkedAt: string | null): string | null {
  if (!checkedAt) return null;
  const minutes = Math.round((Date.now() - Date.parse(checkedAt)) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  return new Date(checkedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function ConnectorRow({ connector }: { connector: Connector }) {
  const { t } = useTranslation('settings');
  // Details and tools stay folded so a long list can be scanned by name.
  const [isOpen, setIsOpen] = useState(false);
  const statusLabel = t(`connectors.status.${connector.status}`, {
    defaultValue: {
      connected: 'Connected',
      pending: 'Connecting…',
      'needs-auth': 'Needs sign-in',
      failed: 'Failed',
      disabled: 'Disabled',
    }[connector.status],
  });

  return (
    <div className="rounded-lg border border-border bg-card/50">
      <button
        type="button"
        onClick={() => setIsOpen((open) => !open)}
        aria-expanded={isOpen}
        className="flex w-full items-center gap-3 px-3 py-2.5 text-left"
      >
        <span className={`h-2 w-2 flex-shrink-0 rounded-full ${STATUS_DOT[connector.status]}`} aria-hidden />
        <span className="min-w-0 flex-1 truncate font-medium text-foreground">{connector.displayName}</span>
        {connector.plugin && (
          <Badge variant="outline" className="hidden max-w-40 truncate text-xs sm:inline-flex">
            {connector.plugin}
          </Badge>
        )}
        <span className="flex-shrink-0 text-xs text-muted-foreground">
          {connector.status === 'connected'
            ? t('connectors.toolCount', { count: connector.tools.length, defaultValue: '{{count}} tools' })
            : statusLabel}
        </span>
        <ChevronRight
          className={`h-4 w-4 flex-shrink-0 text-muted-foreground transition-transform ${isOpen ? 'rotate-90' : ''}`}
        />
      </button>

      {isOpen && (
        <div className="space-y-2 border-t border-border px-3 py-3 text-sm text-muted-foreground">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline" className="text-xs">{statusLabel}</Badge>
            {connector.transport && <Badge variant="outline" className="text-xs">{connector.transport}</Badge>}
            {connector.scope && <Badge variant="outline" className="text-xs">{connector.scope}</Badge>}
            {connector.serverVersion && <span className="text-xs">v{connector.serverVersion}</span>}
          </div>

          {(connector.url || connector.command) && (
            <code className="block break-all rounded bg-muted px-2 py-1 text-xs">
              {connector.url || connector.command}
            </code>
          )}

          {connector.error && (
            <p className="break-words text-xs text-red-600 dark:text-red-400">{connector.error}</p>
          )}

          {connector.status === 'needs-auth' && connector.group === 'cloud' && (
            <a
              href={CLAUDE_CONNECTORS_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
            >
              {t('connectors.signInCloud', { defaultValue: 'Connect on claude.ai' })}
              <ExternalLink className="h-3 w-3" />
            </a>
          )}
          {connector.status === 'needs-auth' && connector.group !== 'cloud' && (
            <p className="text-xs">
              {t('connectors.signInLocal', {
                defaultValue: 'Sign in by running /mcp in a Claude session in the Shell tab.',
              })}
            </p>
          )}

          {connector.tools.length > 0 && (
            <div className="flex flex-wrap gap-1.5 pt-1">
              {connector.tools.map((tool) => (
                <span
                  key={tool.name}
                  title={tool.description ?? undefined}
                  className={`rounded-md border px-1.5 py-0.5 font-mono text-[11px] ${
                    tool.destructive
                      ? 'border-red-500/30 text-red-600 dark:text-red-400'
                      : tool.readOnly
                        ? 'border-border text-muted-foreground'
                        : 'border-border text-foreground/80'
                  }`}
                >
                  {tool.name}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ConnectorGroupSection({
  group,
  title,
  connectors,
  expandAll,
}: {
  group: ConnectorGroup;
  title: string;
  connectors: Connector[];
  /** Shows the folded rows too, while a filter is narrowing the list. */
  expandAll: boolean;
}) {
  const { t } = useTranslation('settings');
  // Connectors that are not connected are folded away: there are usually
  // many, and they would push the other groups out of sight.
  const [showInactive, setShowInactive] = useState(false);
  if (connectors.length === 0) return null;

  const Icon = GROUP_ICON[group];
  const connected = connectors.filter((connector) => connector.status === 'connected').length;
  const needsAuth = connectors.filter((connector) => connector.status === 'needs-auth').length;
  const sorted = [...connectors].sort(
    (a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.displayName.localeCompare(b.displayName),
  );
  // A filter already narrows the list, and a failure is worth seeing at once.
  const isFoldable = (connector: Connector) => (
    !expandAll && (connector.status === 'needs-auth' || connector.status === 'disabled')
  );
  const folded = sorted.filter(isFoldable).length;
  const shown = showInactive ? sorted : sorted.filter((connector) => !isFoldable(connector));

  return (
    <section className="space-y-2">
      <div className="flex items-baseline gap-2">
        <Icon className="h-4 w-4 self-center text-muted-foreground" />
        <h4 className="text-sm font-medium text-foreground">{title}</h4>
        <span className="text-xs text-muted-foreground">
          {t('connectors.groupSummary', { connected, defaultValue: '{{connected}} connected' })}
          {needsAuth > 0 && ` · ${t('connectors.groupNeedsAuth', { count: needsAuth, defaultValue: '{{count}} need sign-in' })}`}
        </span>
      </div>
      <div className="space-y-1.5">
        {shown.map((connector) => <ConnectorRow key={connector.name} connector={connector} />)}
      </div>
      {folded > 0 && (
        <button
          type="button"
          onClick={() => setShowInactive((show) => !show)}
          className="text-xs font-medium text-primary hover:underline"
        >
          {showInactive
            ? t('connectors.hideInactive', { defaultValue: 'Show fewer' })
            : t('connectors.showInactive', { count: folded, defaultValue: 'Show {{count}} more not connected' })}
        </button>
      )}
    </section>
  );
}

/**
 * Used by the settings module's agents tab, above Claude's MCP server list: every
 * server a Claude session starts with — claude.ai connectors, plugin servers
 * and the user's own — with whether it connects and the tools it offers.
 */
export default function ClaudeConnectors() {
  const { t } = useTranslation('settings');
  const { connectors, checkedAt: lastCheckedAt, isChecking, isFirstCheck, error, refresh } = useClaudeConnectors();
  // Narrows every group to servers whose name or tools match.
  const [filter, setFilter] = useState('');

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const all = connectors ?? [];
    if (!needle) return all;
    return all.filter((connector) => (
      connector.name.toLowerCase().includes(needle)
      || connector.tools.some((tool) => tool.name.toLowerCase().includes(needle))
    ));
  }, [connectors, filter]);

  const checkedAt = formatCheckedAt(lastCheckedAt);
  const isFiltering = filter.trim().length > 0;

  return (
    // Set apart from the MCP Servers editor that follows it in the same tab.
    <div className="mb-8 space-y-4 border-b border-border pb-8">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <Plug className="mt-0.5 h-5 w-5 flex-shrink-0 text-purple-500" />
          <div className="min-w-0 space-y-1">
            <h3 className="text-lg font-medium text-foreground">
              {t('connectors.title', { defaultValue: 'Connectors' })}
            </h3>
            <p className="text-sm text-muted-foreground">
              {t('connectors.description', {
                defaultValue: 'Everything a Claude session can reach: your claude.ai connectors, servers from plugins and your own.',
              })}
              {checkedAt && ` ${t('connectors.checkedAt', { when: checkedAt, defaultValue: 'Checked {{when}}.' })}`}
            </p>
          </div>
        </div>
        <div className="flex flex-shrink-0 gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={refresh}
            disabled={isChecking}
            className="flex-1 sm:flex-none"
          >
            <RefreshCw className={`mr-1.5 h-4 w-4 ${isChecking ? 'animate-spin' : ''}`} />
            {isChecking
              ? t('connectors.checking', { defaultValue: 'Checking…' })
              : t('connectors.refresh', { defaultValue: 'Refresh' })}
          </Button>
          <a
            href={CLAUDE_CONNECTORS_URL}
            target="_blank"
            rel="noopener noreferrer"
            className={buttonVariants({ size: 'sm', className: 'flex-1 sm:flex-none' })}
          >
            {t('connectors.add', { defaultValue: 'Add connector' })}
            <ExternalLink className="ml-1.5 h-3.5 w-3.5" />
          </a>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-800/60 dark:bg-red-900/20 dark:text-red-200">
          {error}
        </div>
      )}

      {isFirstCheck && (
        <div className="py-8 text-center text-sm text-muted-foreground">
          {t('connectors.firstCheck', {
            defaultValue: 'Connecting to every server to check it. This takes about half a minute…',
          })}
        </div>
      )}

      {connectors && connectors.length > 0 && (
        <>
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder={t('connectors.filter', { defaultValue: 'Filter by name or tool' })}
              className="pl-8"
            />
          </div>
          <ConnectorGroupSection
            group="cloud"
            title={t('connectors.groups.cloud', { defaultValue: 'claude.ai' })}
            connectors={visible.filter((connector) => connector.group === 'cloud')}
            expandAll={isFiltering}
          />
          <ConnectorGroupSection
            group="plugin"
            title={t('connectors.groups.plugin', { defaultValue: 'Plugins' })}
            connectors={visible.filter((connector) => connector.group === 'plugin')}
            expandAll={isFiltering}
          />
          <ConnectorGroupSection
            group="local"
            title={t('connectors.groups.local', { defaultValue: 'Your servers' })}
            connectors={visible.filter((connector) => connector.group === 'local')}
            expandAll={isFiltering}
          />
          {visible.length === 0 && (
            <div className="py-4 text-center text-sm text-muted-foreground">
              {t('connectors.noMatch', { defaultValue: 'Nothing matches that filter.' })}
            </div>
          )}
        </>
      )}
    </div>
  );
}
