const os = require("node:os");
const path = require("node:path");

const { requestJson } = require("./http");
const { buildMeter, formatCaptureTime, readJsonFile, subscriptionResult } = require("./subscription");
const { readLatestSnapshot, sessionsDir } = require("./codex-local");
const { readLiveRateLimits } = require("./codex-appserver");

const CHATGPT_USAGE_URL = "https://chatgpt.com/backend-api/codex/usage";

// The ChatGPT subscription token is written by whichever OpenAI client is
// signed in, so probe the known stores in order rather than pinning one path.
function credentialSources(env) {
  const sources = [];

  if (env.GPT_AUTH_FILE) {
    sources.push({ label: env.GPT_AUTH_FILE, filePath: env.GPT_AUTH_FILE });
  }

  sources.push(
    { label: "~/.codex/auth.json", filePath: path.join(env.CODEX_HOME || path.join(os.homedir(), ".codex"), "auth.json") },
    { label: "~/.config/openai/auth.json", filePath: path.join(os.homedir(), ".config", "openai", "auth.json") },
    {
      label: "~/.local/share/opencode/auth.json",
      filePath: path.join(os.homedir(), ".local", "share", "opencode", "auth.json"),
    }
  );

  return sources;
}

function extractFromCodexShape(parsed) {
  const tokens = parsed?.tokens;
  const accessToken = tokens?.access_token || tokens?.accessToken;
  if (!accessToken) {
    return null;
  }
  return { accessToken, accountId: tokens.account_id || tokens.accountId || null };
}

function extractFromOpencodeShape(parsed) {
  if (!parsed || typeof parsed !== "object") {
    return null;
  }

  for (const [key, entry] of Object.entries(parsed)) {
    if (!/openai|chatgpt|codex/i.test(key) || !entry || typeof entry !== "object") {
      continue;
    }

    const accessToken = entry.access || entry.accessToken || entry.access_token || entry.key || entry.apiKey;
    if (accessToken) {
      return { accessToken, accountId: entry.account_id || entry.accountId || null };
    }
  }

  return null;
}

function resolveCredentials(env) {
  if (env.GPT_ACCESS_TOKEN) {
    return {
      accessToken: env.GPT_ACCESS_TOKEN,
      accountId: env.GPT_ACCOUNT_ID || null,
      origin: "GPT_ACCESS_TOKEN",
    };
  }

  const attempted = [];
  for (const source of credentialSources(env)) {
    const parsed = readJsonFile(source.filePath);
    if (!parsed) {
      attempted.push(`${source.label} (absent)`);
      continue;
    }

    const found = extractFromCodexShape(parsed) || extractFromOpencodeShape(parsed);
    if (found) {
      return {
        ...found,
        accountId: env.GPT_ACCOUNT_ID || found.accountId,
        origin: source.label,
      };
    }

    // Top-level keys are provider names, not secrets — surfacing them turns a
    // dead end into a usable hint about which account is actually signed in.
    const keys = Object.keys(parsed).slice(0, 12).join("/") || "empty";
    attempted.push(`${source.label} (no OpenAI entry; has ${keys})`);
  }

  throw new Error(
    `No ChatGPT credentials found. Looked in: ${attempted.join(", ")}. Sign in with the Codex CLI, or set GPT_ACCESS_TOKEN (and optionally GPT_ACCOUNT_ID) in .env.`
  );
}

function formatWindowLabel(windowMinutes, fallback) {
  const minutes = Number(windowMinutes);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    return fallback;
  }
  if (minutes % 10080 === 0) {
    const weeks = minutes / 10080;
    return weeks === 1 ? "Weekly" : `Every ${weeks} weeks`;
  }
  if (minutes % 1440 === 0) {
    const days = minutes / 1440;
    return days === 1 ? "Daily" : `Every ${days} days`;
  }
  if (minutes % 60 === 0) {
    return `Session (${minutes / 60}h)`;
  }
  return `${minutes}m window`;
}

function resetsAtFromSeconds(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value < 0) {
    return null;
  }
  return new Date(Date.now() + value * 1000).toISOString();
}

// Codex writes `resets_at` as absolute unix seconds; other clients have used ISO
// strings. The frontend parses with Date.parse, so normalise everything to ISO.
function resolveResetsAt(value) {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
  }

  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return null;
  }

  return new Date(seconds > 1e12 ? seconds : seconds * 1000).toISOString();
}

function readWindow(source, id, fallbackLabel) {
  if (!source || typeof source !== "object") {
    return null;
  }

  const percent = source.used_percent ?? source.usedPercent ?? source.utilization ?? source.percent;
  if (percent === null || percent === undefined) {
    return null;
  }

  const resetsAt =
    resolveResetsAt(source.resets_at ?? source.resetsAt) ||
    resetsAtFromSeconds(source.resets_in_seconds ?? source.resetsInSeconds);

  return buildMeter({
    id,
    label: formatWindowLabel(
      source.window_minutes ?? source.windowMinutes ?? source.windowDurationMins,
      fallbackLabel
    ),
    percent,
    resetsAt,
    isActive: id === "primary",
  });
}

const WINDOW_KEYS = [
  ["primary", "Session"],
  ["secondary", "Weekly"],
];

function metersFromPayload(payload) {
  const limits = payload?.rate_limits || payload?.rateLimits || payload;
  const meters = [];

  for (const [key, fallbackLabel] of WINDOW_KEYS) {
    const meter = readWindow(limits?.[key], key, fallbackLabel);
    if (meter) {
      meters.push(meter);
    }
  }

  if (meters.length === 0 && Array.isArray(limits)) {
    for (const [index, entry] of limits.entries()) {
      const meter = readWindow(entry, `limit-${index}`, entry?.name || `Window ${index + 1}`);
      if (meter) {
        meters.push(meter);
      }
    }
  }

  return meters;
}

// A snapshot is a point-in-time copy, so every meter is stamped with when it was
// taken. Once a window's reset time has passed the recorded percentage describes
// a window that no longer exists, so report it as reset rather than as current.
function metersFromSnapshot({ rateLimits, capturedAt }) {
  const capturedLabel = capturedAt ? formatCaptureTime(capturedAt) : null;
  const meters = [];

  for (const [key, fallbackLabel] of WINDOW_KEYS) {
    const window = rateLimits?.[key];
    if (!window || typeof window !== "object") {
      continue;
    }

    const percent = window.used_percent ?? window.usedPercent;
    if (percent === null || percent === undefined) {
      continue;
    }

    const resetsAt = resolveResetsAt(window.resets_at ?? window.resetsAt);
    const rolledOver = capturedLabel ? Boolean(resetsAt) && Date.parse(resetsAt) <= Date.now() : false;

    meters.push(
      buildMeter({
        id: key,
        label: formatWindowLabel(
          window.window_minutes ?? window.windowMinutes ?? window.windowDurationMins,
          fallbackLabel
        ),
        percent: rolledOver ? 0 : percent,
        resetsAt: rolledOver ? null : resetsAt,
        detail: capturedLabel ? (rolledOver ? `window reset since ${capturedLabel}` : `as of ${capturedLabel}`) : null,
        isActive: key === "primary",
      })
    );
  }

  return meters;
}

function formatPlanLabel(payload) {
  const plan = payload?.plan_type || payload?.planType || payload?.account?.plan_type;
  if (!plan) {
    return null;
  }
  const text = String(plan).replace(/_/g, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// Default source. Asks the local `codex` binary for the current account rate
// limits -- the same live number the Codex UI shows.
async function fetchFromAppServer(env) {
  const { rateLimits, binary } = await readLiveRateLimits(env);

  const meters = metersFromSnapshot({ rateLimits, capturedAt: null });
  if (meters.length === 0) {
    throw new Error(
      `codex app-server returned no usable rate-limit windows (keys: ${Object.keys(rateLimits || {}).join(", ") || "none"}).`
    );
  }

  return subscriptionResult({
    providerId: env.GPT_PROVIDER_ID || "gpt",
    planLabel: formatPlanLabel(rateLimits),
    meters,
    extra: { displayName: "Codex", source: "app-server", codexBinary: binary },
  });
}

// Offline fallback. Reads the rate-limit snapshot Codex already stored locally,
// which only advances when a Codex turn actually runs on this machine.
function fetchFromLocalSessions(env) {
  const { snapshot, dir, totalRollouts } = readLatestSnapshot(env);

  if (!snapshot) {
    const detail = totalRollouts
      ? `${totalRollouts} session file(s) in ${dir} carried no rate-limit events`
      : `no Codex session files under ${dir}`;
    throw new Error(
      `No local Codex rate-limit snapshot: ${detail}. Run Codex once so it records one, or point GPT_SESSIONS_DIR at the right directory.`
    );
  }

  const meters = metersFromSnapshot(snapshot);
  if (meters.length === 0) {
    throw new Error(
      `Codex snapshot from ${snapshot.sourceFile} had no usable rate-limit windows (keys: ${
        Object.keys(snapshot.rateLimits || {}).join(", ") || "none"
      }).`
    );
  }

  return subscriptionResult({
    providerId: env.GPT_PROVIDER_ID || "gpt",
    planLabel: formatPlanLabel(snapshot.rateLimits),
    meters,
    extra: {
      displayName: "Codex",
      source: "local-session",
      snapshotAt: snapshot.capturedAt,
      snapshotFile: snapshot.sourceFile,
    },
  });
}

// Opt-in only (GPT_USAGE_SOURCE=network). chatgpt.com/backend-api is a
// non-public consumer endpoint behind a Cloudflare challenge; there is
// deliberately no automatic fallback onto it when the local read comes up empty.
async function fetchFromNetwork(env) {
  const credentials = resolveCredentials(env);

  const { status, payload, rawBody } = await requestJson(env.GPT_USAGE_URL || CHATGPT_USAGE_URL, {
    env,
    headers: {
      Authorization: `Bearer ${credentials.accessToken}`,
      accept: "application/json",
      "User-Agent": "token-usage-dashboard",
      ...(credentials.accountId ? { "chatgpt-account-id": credentials.accountId } : {}),
    },
  });

  if ((status === 403 || status === 503) && /^\s*</.test(rawBody || "")) {
    throw new Error(
      `ChatGPT returned ${status} with a Cloudflare challenge page, not an API response. The endpoint is unreachable from this network regardless of credentials; leave GPT_USAGE_SOURCE unset to read local Codex snapshots instead.`
    );
  }

  if (status === 401 || status === 403) {
    throw new Error(
      `ChatGPT returned ${status} using credentials from ${credentials.origin}. The token is expired or lacks subscription scope; sign in again with the Codex CLI.`
    );
  }

  if (status !== 200 || !payload) {
    const detail = payload?.detail || payload?.error?.message || rawBody?.slice(0, 160) || "no response body";
    throw new Error(`ChatGPT usage endpoint returned ${status}: ${detail}`);
  }

  const meters = metersFromPayload(payload);
  if (meters.length === 0) {
    throw new Error(
      `ChatGPT usage response had no recognisable rate-limit windows (keys: ${Object.keys(payload).join(", ") || "none"}). Set GPT_USAGE_URL if your client uses a different endpoint.`
    );
  }

  return subscriptionResult({
    providerId: env.GPT_PROVIDER_ID || "gpt",
    planLabel: formatPlanLabel(payload),
    meters,
    extra: { displayName: "Codex", source: "network", credentialOrigin: credentials.origin },
  });
}

async function fetchUsage({ env }) {
  const source = String(env.GPT_USAGE_SOURCE || "app-server").trim().toLowerCase();

  try {
    if (source === "network") {
      return await fetchFromNetwork(env);
    }
    if (source === "local") {
      return fetchFromLocalSessions(env);
    }

    // Falling back to the stored snapshot keeps the card alive when the codex
    // binary is missing or busy. It stays on-disk only -- never onto the network.
    try {
      return await fetchFromAppServer(env);
    } catch (liveError) {
      const stale = fetchFromLocalSessions(env);
      stale.meta.degradedFrom = liveError.message;
      return stale;
    }
  } catch (error) {
    throw new Error(`GPT subscription provider failed: ${error.message}`);
  }
}

module.exports = {
  providerId: "gpt",
  fetchUsage,
  sessionsDir,
};
