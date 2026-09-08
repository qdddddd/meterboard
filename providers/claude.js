const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { requestJson } = require("./http");
const { buildMeter, expandHome, readJsonFile, stampCapturedMeters, subscriptionResult } = require("./subscription");
const { readRecentCost } = require("./claude-cost");

const ANTHROPIC_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const OAUTH_BETA = "oauth-2025-04-20";

const LIMIT_LABELS = {
  session: "Session (5h)",
  weekly_all: "Weekly (all models)",
  weekly_opus: "Weekly (Opus)",
  weekly_sonnet: "Weekly (Sonnet)",
  weekly_scoped: "Weekly",
};

// Legacy top-level keys, kept as a fallback for accounts whose usage payload
// predates the `limits` array.
const LEGACY_WINDOWS = [
  ["five_hour", "session", "Session (5h)"],
  ["seven_day", "weekly_all", "Weekly (all models)"],
  ["seven_day_opus", "weekly_opus", "Weekly (Opus)"],
  ["seven_day_sonnet", "weekly_sonnet", "Weekly (Sonnet)"],
];

function usageCachePath(env) {
  if (env.CLAUDE_USAGE_CACHE_PATH) {
    return expandHome(env.CLAUDE_USAGE_CACHE_PATH);
  }
  const configDir = env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  return path.join(configDir, "cache", "usage-utilization.json");
}

function credentialsPath(env) {
  if (env.CLAUDE_CREDENTIALS_PATH) {
    return env.CLAUDE_CREDENTIALS_PATH;
  }
  const configDir = env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  return path.join(configDir, ".credentials.json");
}

function readOauthCredentials(env) {
  if (env.CLAUDE_OAUTH_TOKEN) {
    return { accessToken: env.CLAUDE_OAUTH_TOKEN, fromEnv: true };
  }

  const filePath = credentialsPath(env);
  const parsed = readJsonFile(filePath);
  if (!parsed) {
    throw new Error(
      `No Claude credentials at ${filePath}. Sign in with the Claude Code CLI, or set CLAUDE_CREDENTIALS_PATH / CLAUDE_OAUTH_TOKEN.`
    );
  }

  const oauth = parsed.claudeAiOauth || parsed.claude_ai_oauth || null;
  const accessToken = oauth?.accessToken || oauth?.access_token;
  if (!accessToken) {
    throw new Error(`No claudeAiOauth.accessToken in ${filePath}.`);
  }

  return {
    accessToken,
    expiresAt: Number(oauth.expiresAt || oauth.expires_at) || null,
    subscriptionType: oauth.subscriptionType || oauth.subscription_type || null,
    rateLimitTier: oauth.rateLimitTier || oauth.rate_limit_tier || null,
  };
}

// The credentials file's rateLimitTier is frozen at token-issue time and goes
// stale across plan changes (it read max_5x on a max_20x account). The account
// record in .claude.json tracks the current tier, so it wins.
function readPlanMetadata(env) {
  const meta = {};

  try {
    const configFile = env.CLAUDE_CONFIG_DIR
      ? path.join(expandHome(env.CLAUDE_CONFIG_DIR), ".claude.json")
      : path.join(os.homedir(), ".claude.json");
    const account = readJsonFile(configFile)?.oauthAccount;
    if (account) {
      meta.rateLimitTier = account.organizationRateLimitTier || null;
      meta.subscriptionType = account.organizationType || null;
    }
  } catch {
    // Fall through to the credentials file.
  }

  try {
    const oauth = readJsonFile(credentialsPath(env))?.claudeAiOauth || null;
    if (oauth) {
      meta.rateLimitTier = meta.rateLimitTier || oauth.rateLimitTier || oauth.rate_limit_tier || null;
      meta.subscriptionType = meta.subscriptionType || oauth.subscriptionType || oauth.subscription_type || null;
    }
  } catch {
    // Plan label is cosmetic; the meters render without it.
  }

  return meta;
}

function formatPlanLabel(credentials) {
  const tier = String(credentials.rateLimitTier || "");
  const subscription = String(credentials.subscriptionType || "");

  const maxMultiplier = /max[_-]?(\d+)x/i.exec(tier);
  if (maxMultiplier) {
    return `Max ${maxMultiplier[1]}x`;
  }
  if (/max/i.test(tier) || /max/i.test(subscription)) {
    return "Max";
  }
  if (/team/i.test(tier)) {
    return "Team";
  }
  if (/enterprise/i.test(tier)) {
    return "Enterprise";
  }
  if (/pro/i.test(tier) || /pro/i.test(subscription)) {
    return "Pro";
  }
  return subscription ? subscription.charAt(0).toUpperCase() + subscription.slice(1) : null;
}

function scopeSuffix(scope) {
  const displayName = scope?.model?.display_name || scope?.model?.id || scope?.surface;
  return displayName ? ` · ${displayName}` : "";
}

function metersFromLimits(limits) {
  const meters = [];

  for (const [index, limit] of limits.entries()) {
    if (!limit || limit.percent === null || limit.percent === undefined) {
      continue;
    }

    const kind = String(limit.kind || limit.group || `limit_${index}`);
    const baseLabel = LIMIT_LABELS[kind] || kind.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

    meters.push(
      buildMeter({
        id: `${kind}-${index}`,
        label: `${baseLabel}${scopeSuffix(limit.scope)}`,
        percent: limit.percent,
        resetsAt: limit.resets_at,
        severity: limit.severity,
        isActive: limit.is_active,
      })
    );
  }

  return meters;
}

function metersFromLegacyWindows(usage) {
  const meters = [];

  for (const [key, id, label] of LEGACY_WINDOWS) {
    const window = usage?.[key];
    if (!window || window.utilization === null || window.utilization === undefined) {
      continue;
    }

    meters.push(
      buildMeter({
        id,
        label,
        percent: window.utilization,
        resetsAt: window.resets_at,
        isActive: id === "session",
      })
    );
  }

  return meters;
}

function extraUsageMeter(usage) {
  const extra = usage?.extra_usage;
  if (!extra?.is_enabled || extra.utilization === null || extra.utilization === undefined) {
    return null;
  }

  const limit = Number(extra.monthly_limit);
  const used = Number(extra.used_credits);
  const detail =
    Number.isFinite(limit) && Number.isFinite(used) ? `${used} / ${limit} ${extra.currency || "credits"}` : null;

  return buildMeter({
    id: "extra_usage",
    label: "Extra usage (monthly)",
    percent: extra.utilization,
    detail,
    isActive: true,
  });
}

function spendMeter(usage) {
  const spend = usage?.spend;
  if (!spend?.enabled || spend.percent === null || spend.percent === undefined) {
    return null;
  }

  const exponent = Number(spend.used?.exponent);
  const amountMinor = Number(spend.used?.amount_minor);
  const detail =
    Number.isFinite(amountMinor) && Number.isFinite(exponent)
      ? `${(amountMinor / 10 ** exponent).toFixed(2)} ${spend.used?.currency || "USD"} used`
      : null;

  return buildMeter({
    id: "spend",
    label: "Spend cap",
    percent: spend.percent,
    severity: spend.severity,
    detail,
    isActive: true,
  });
}

function metersFromUsagePayload(payload) {
  const limits = Array.isArray(payload.limits) ? payload.limits : [];
  const meters = limits.length > 0 ? metersFromLimits(limits) : metersFromLegacyWindows(payload);

  for (const optional of [extraUsageMeter(payload), spendMeter(payload)]) {
    if (optional) {
      meters.push(optional);
    }
  }

  return meters;
}

// Default source. Claude Code caches the usage payload to disk as it runs, so
// the dashboard reads that file and never calls api.anthropic.com. This is the
// whole point: polling that endpoint from a dashboard got the account banned.
function fetchFromCache(env) {
  const filePath = usageCachePath(env);

  let capturedAt;
  try {
    capturedAt = new Date(fs.statSync(filePath).mtimeMs).toISOString();
  } catch {
    throw new Error(
      `No usage cache at ${filePath}. Run any Claude Code command so it writes one, or set CLAUDE_USAGE_CACHE_PATH.`
    );
  }

  const payload = readJsonFile(filePath);
  if (!payload) {
    throw new Error(`Usage cache at ${filePath} is empty or unreadable.`);
  }

  const meters = stampCapturedMeters(metersFromUsagePayload(payload), capturedAt);
  if (meters.length === 0) {
    throw new Error(`Usage cache at ${filePath} held no rate-limit windows (keys: ${Object.keys(payload).join(", ") || "none"}).`);
  }

  const plan = readPlanMetadata(env);

  // Cost is informational: a subscription bills a flat rate, so this is what the
  // same work would have cost at API prices, as Claude Code itself computed it.
  let cost = null;
  if (String(env.CLAUDE_SHOW_COST || "true").toLowerCase() !== "false") {
    try {
      cost = readRecentCost(env);
    } catch {
      // Never let the cost scan take the meters down with it.
      cost = null;
    }
  }

  return subscriptionResult({
    providerId: env.CLAUDE_PROVIDER_ID || "claude",
    planLabel: formatPlanLabel(plan),
    meters,
    extra: {
      displayName: "Claude",
      source: "local-cache",
      snapshotAt: capturedAt,
      snapshotFile: filePath,
      ...(cost
        ? {
            costUsd: Number(cost.costUsd.toFixed(2)),
            costSessionCount: cost.sessionCount,
            costWindowDays: cost.windowDays,
          }
        : {}),
    },
  });
}

// Opt-in only (CLAUDE_USAGE_SOURCE=network), and it is opt-in for a reason:
// api.anthropic.com/api/oauth/usage is not a public API, and polling it from
// this dashboard previously got the account banned. Nothing falls back to it.
async function fetchFromNetwork(env) {
  {
    const credentials = readOauthCredentials(env);

    const { status, payload, rawBody } = await requestJson(env.CLAUDE_USAGE_URL || ANTHROPIC_USAGE_URL, {
      env,
      headers: {
        Authorization: `Bearer ${credentials.accessToken}`,
        "anthropic-beta": env.CLAUDE_OAUTH_BETA || OAUTH_BETA,
        accept: "application/json",
        "User-Agent": "token-usage-dashboard",
      },
    });

    if (status === 401 || status === 403) {
      const hint = credentials.fromEnv
        ? "CLAUDE_OAUTH_TOKEN is expired or invalid."
        : "The stored OAuth token is expired. Run any Claude Code command to refresh it, then retry.";
      throw new Error(`Anthropic returned ${status}. ${hint}`);
    }

    if (status !== 200 || !payload) {
      const detail = payload?.error?.message || rawBody?.slice(0, 160) || "no response body";
      throw new Error(`Anthropic usage endpoint returned ${status}: ${detail}`);
    }

    const meters = metersFromUsagePayload(payload);

    if (meters.length === 0) {
      throw new Error("Anthropic returned no rate-limit windows for this account.");
    }

    return subscriptionResult({
      providerId: env.CLAUDE_PROVIDER_ID || "claude",
      planLabel: formatPlanLabel(credentials),
      meters,
      extra: {
        displayName: "Claude",
        source: "network",
        tokenExpiresAt: credentials.expiresAt ? new Date(credentials.expiresAt).toISOString() : null,
      },
    });
  }
}

async function fetchUsage({ env }) {
  const source = String(env.CLAUDE_USAGE_SOURCE || "cache").trim().toLowerCase();

  try {
    return source === "network" ? await fetchFromNetwork(env) : fetchFromCache(env);
  } catch (error) {
    throw new Error(`Claude subscription provider failed: ${error.message}`);
  }
}

module.exports = {
  providerId: "claude",
  fetchUsage,
};
