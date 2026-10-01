import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { AppError } from '@/shared/utils.js';

/** One rate-limit window as the usage endpoint reports it (session, weekly, per-model weekly). */
type ClaudePlanUsageLimit = {
  kind: string;
  group: string | null;
  label: string;
  percent: number;
  resetsAt: string | null;
  severity: string | null;
  isActive: boolean;
};

type ClaudePlanUsage = {
  limits: ClaudePlanUsageLimit[];
  /** Pay-as-you-go credits used once plan limits run out; null when the account has none. */
  extraUsage: {
    enabled: boolean;
    usedMinor: number;
    limitMinor: number | null;
    currency: string;
    exponent: number;
  } | null;
  subscriptionType: string | null;
  rateLimitTier: string | null;
  fetchedAt: string;
};

type AnyRecord = Record<string, unknown>;

const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
// The endpoint is rate limited and the numbers move slowly, so a short cache
// keeps a usage panel left open (or several tabs) from hammering it.
const USAGE_CACHE_TTL_MS = 60_000;
const USAGE_REQUEST_TIMEOUT_MS = 10_000;

let cachedUsage: { value: ClaudePlanUsage; expiresAt: number } | null = null;

const readRecord = (value: unknown): AnyRecord | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as AnyRecord) : null;

const readString = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value : null;

const readNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

/**
 * Reads the `claude /login` token. The token is never refreshed here: a
 * refresh rotates the refresh token, which would silently log the CLI out.
 * Claude Code renews it itself on its next run.
 */
async function readClaudeOauthCredentials(): Promise<{
  accessToken: string;
  subscriptionType: string | null;
  rateLimitTier: string | null;
}> {
  const envToken = process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
  let oauth: AnyRecord | null = null;
  try {
    const content = await readFile(path.join(os.homedir(), '.claude', '.credentials.json'), 'utf8');
    oauth = readRecord(readRecord(JSON.parse(content))?.claudeAiOauth);
  } catch {
    // Missing or unreadable file: fall through to the env token.
  }

  const fileToken = readString(oauth?.accessToken);
  const expiresAt = readNumber(oauth?.expiresAt);
  const fileTokenUsable = fileToken && (!expiresAt || Date.now() < expiresAt);
  const accessToken = fileTokenUsable ? fileToken : envToken;

  if (!accessToken) {
    throw new AppError(
      fileToken
        ? 'The Claude login token has expired. Run any Claude command to renew it, then retry.'
        : 'Claude is not logged in with a subscription. Run claude /login.',
      { code: 'CLAUDE_USAGE_UNAVAILABLE', statusCode: 409 },
    );
  }

  return {
    accessToken,
    subscriptionType: readString(oauth?.subscriptionType),
    rateLimitTier: readString(oauth?.rateLimitTier),
  };
}

function labelForLimit(kind: string, scope: AnyRecord | null): string {
  const modelName = readString(readRecord(scope?.model)?.display_name);
  if (kind === 'session') return 'Current session';
  if (kind === 'weekly_all') return 'Weekly · all models';
  if (kind === 'weekly_scoped' && modelName) return `Weekly · ${modelName}`;
  return modelName ? `${kind} · ${modelName}` : kind.replace(/_/g, ' ');
}

/** Older responses lack `limits`; rebuild the two core windows from the legacy fields. */
function readLegacyLimits(payload: AnyRecord): ClaudePlanUsageLimit[] {
  const legacy: Array<[string, string, string]> = [
    ['five_hour', 'session', 'Current session'],
    ['seven_day', 'weekly_all', 'Weekly · all models'],
    ['seven_day_opus', 'weekly_scoped', 'Weekly · Opus'],
    ['seven_day_sonnet', 'weekly_scoped', 'Weekly · Sonnet'],
  ];
  return legacy.flatMap(([field, kind, label]) => {
    const window = readRecord(payload[field]);
    const percent = readNumber(window?.utilization);
    if (percent === null) return [];
    return [{
      kind,
      group: kind === 'session' ? 'session' : 'weekly',
      label,
      percent,
      resetsAt: readString(window?.resets_at),
      severity: null,
      isActive: false,
    }];
  });
}

function normalizeUsagePayload(
  payload: AnyRecord,
  credentials: { subscriptionType: string | null; rateLimitTier: string | null },
): ClaudePlanUsage {
  const rawLimits = Array.isArray(payload.limits) ? payload.limits : null;
  const limits = rawLimits
    ? rawLimits.flatMap((entry): ClaudePlanUsageLimit[] => {
      const limit = readRecord(entry);
      const kind = readString(limit?.kind);
      const percent = readNumber(limit?.percent);
      if (!limit || !kind || percent === null) return [];
      return [{
        kind,
        group: readString(limit.group),
        label: labelForLimit(kind, readRecord(limit.scope)),
        percent,
        resetsAt: readString(limit.resets_at),
        severity: readString(limit.severity),
        isActive: limit.is_active === true,
      }];
    })
    : readLegacyLimits(payload);

  const spend = readRecord(payload.spend);
  const extra = readRecord(payload.extra_usage);
  const used = readRecord(spend?.used);
  const limit = readRecord(spend?.limit);
  const extraUsage = spend || extra
    ? {
      enabled: spend?.enabled === true || extra?.is_enabled === true,
      usedMinor: readNumber(used?.amount_minor) ?? 0,
      limitMinor: readNumber(limit?.amount_minor),
      currency: readString(used?.currency) ?? readString(extra?.currency) ?? 'USD',
      exponent: readNumber(used?.exponent) ?? readNumber(extra?.decimal_places) ?? 2,
    }
    : null;

  return {
    limits,
    extraUsage,
    subscriptionType: credentials.subscriptionType,
    rateLimitTier: credentials.rateLimitTier,
    fetchedAt: new Date().toISOString(),
  };
}

export const claudePlanUsageService = {
  /**
   * Returns the logged-in Claude subscription's session, weekly and per-model
   * limits, the same numbers Claude Code's `/usage` shows. Cached for a minute
   * unless `forceRefresh` is set.
   */
  async getPlanUsage(options: { forceRefresh?: boolean } = {}): Promise<ClaudePlanUsage> {
    if (!options.forceRefresh && cachedUsage && Date.now() < cachedUsage.expiresAt) {
      return cachedUsage.value;
    }

    const credentials = await readClaudeOauthCredentials();
    let response: Response;
    try {
      response = await fetch(CLAUDE_USAGE_URL, {
        headers: {
          Authorization: `Bearer ${credentials.accessToken}`,
          'anthropic-beta': 'oauth-2025-04-20',
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(USAGE_REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new AppError('Could not reach the Claude usage service.', {
        code: 'CLAUDE_USAGE_UNREACHABLE',
        statusCode: 502,
        details: error instanceof Error ? error.message : String(error),
      });
    }

    if (!response.ok) {
      throw new AppError(`The Claude usage service answered ${response.status}.`, {
        code: 'CLAUDE_USAGE_FAILED',
        statusCode: response.status === 429 ? 429 : 502,
      });
    }

    const payload = readRecord(await response.json()) ?? {};
    const value = normalizeUsagePayload(payload, credentials);
    cachedUsage = { value, expiresAt: Date.now() + USAGE_CACHE_TTL_MS };
    return value;
  },
};
