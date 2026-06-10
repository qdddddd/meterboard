const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { getShanghaiDateString, mergeUsageTotals, normalizeDailyRecords, toNumber } = require("./utils");

const TIMICC_API_BASE = "https://timicc.com";
const DEFAULT_LEVELDB_PATH = path.join(os.homedir(), ".config", "microsoft-edge", "Default", "Local Storage", "leveldb");
const JWT_RE = /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;
const TIMICC_MARKER = "timicc.com";

let cachedToken = null;

function decodeJwtPayload(jwt) {
  const parts = jwt.split(".");
  if (parts.length !== 3) return null;
  try {
    const padded = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

function findTimiccTokensInBuffer(buf) {
  const text = buf.toString("latin1");
  const candidates = [];
  let match;
  while ((match = JWT_RE.exec(text)) !== null) {
    const window = text.slice(Math.max(0, match.index - 500), match.index);
    if (!window.includes(TIMICC_MARKER)) continue;
    const payload = decodeJwtPayload(match[0]);
    if (payload && typeof payload.exp === "number") {
      candidates.push({ token: match[0], exp: payload.exp });
    }
  }
  return candidates;
}

function expandHome(p) {
  if (!p) return p;
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

function resolveLeveldbPath(env) {
  return expandHome(env.TIMICC_LOCALSTORAGE_PATH) || DEFAULT_LEVELDB_PATH;
}

function listLeveldbFiles(leveldbPath, newestFirst = false) {
  let entries;
  try {
    entries = fs.readdirSync(leveldbPath);
  } catch {
    return [];
  }
  const files = entries
    .filter((name) => /\.(ldb|log)$/.test(name))
    .map((name) => {
      const full = path.join(leveldbPath, name);
      let mtime = 0;
      try { mtime = fs.statSync(full).mtimeMs; } catch {}
      return { full, mtime };
    });
  if (newestFirst) files.sort((a, b) => b.mtime - a.mtime);
  return files.map((f) => f.full);
}

function readFreshTimiccToken(leveldbPath) {
  const now = Math.floor(Date.now() / 1000);
  let best = null;
  for (const file of listLeveldbFiles(leveldbPath)) {
    let buf;
    try { buf = fs.readFileSync(file); } catch { continue; }
    for (const candidate of findTimiccTokensInBuffer(buf)) {
      if (candidate.exp <= now) continue;
      if (!best || candidate.exp > best.exp) best = candidate;
    }
  }
  return best?.token || null;
}

// timicc.com no longer keeps its bearer token in localStorage (it moved to an
// httpOnly cookie), but it still caches the account profile under `auth_user`.
// Pull the latest one so we can at least surface the balance when the API token
// is missing or expired. Anchored to the timicc.com origin, brace-matched JSON,
// newest leveldb file wins.
function extractTimiccJsonValue(text, keyName) {
  let i = -1;
  while ((i = text.indexOf(keyName, i + 1)) !== -1) {
    if (!text.slice(Math.max(0, i - 30), i).includes(TIMICC_MARKER)) continue;
    const start = text.indexOf("{", i);
    if (start === -1) continue;
    const limit = Math.min(text.length, start + 50000);
    let depth = 0, inStr = false, esc = false;
    for (let j = start; j < limit; j++) {
      const c = text[j];
      if (esc) { esc = false; continue; }
      if (c === "\\") { esc = true; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (c === "{") depth++;
      else if (c === "}" && --depth === 0) {
        try { return JSON.parse(text.slice(start, j + 1)); } catch { break; }
      }
    }
  }
  return null;
}

function readTimiccAuthUser(leveldbPath) {
  for (const file of listLeveldbFiles(leveldbPath, true)) {
    let text;
    try { text = fs.readFileSync(file).toString("latin1"); } catch { continue; }
    const obj = extractTimiccJsonValue(text, "auth_user");
    if (obj && obj.balance !== undefined) return obj;
  }
  return null;
}

async function fetchTimiCcApi(apiPath, token) {
  const response = await fetch(`${TIMICC_API_BASE}${apiPath}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      accept: "application/json",
    },
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || (payload && payload.code !== undefined && payload.code !== 0)) {
    const message = payload?.message || `TimiCC API ${response.status}`;
    const err = new Error(`${apiPath} — ${message}`);
    err.status = response.status;
    err.serverMessage = payload?.message || "";
    throw err;
  }
  return payload?.data ?? payload ?? null;
}

function isAuthExpired(error) {
  if (!error) return false;
  if (error.status === 401) return true;
  return /token has expired|unauthorized|invalid token/i.test(error.serverMessage || error.message || "");
}

async function callWithRetry(env, apiPath) {
  const leveldbPath = resolveLeveldbPath(env);
  let token = cachedToken || env.TIMICC_AUTH_TOKEN;

  if (!token) {
    token = readFreshTimiccToken(leveldbPath);
    if (!token) {
      throw new Error(
        "No TimiCC token available. timicc.com no longer keeps its bearer token in localStorage — capture it from DevTools > Network (the \"Authorization: Bearer\" header on an /api/v1 request) and set TIMICC_AUTH_TOKEN in .env."
      );
    }
    cachedToken = token;
  }

  try {
    return await fetchTimiCcApi(apiPath, token);
  } catch (error) {
    if (!isAuthExpired(error)) throw error;
    const fresh = readFreshTimiccToken(leveldbPath);
    if (!fresh || fresh === token) {
      throw new Error(`${error.message} (TIMICC_AUTH_TOKEN expired — capture a fresh one from DevTools > Network and update .env)`);
    }
    cachedToken = fresh;
    return await fetchTimiCcApi(apiPath, fresh);
  }
}

async function fetchTimiCcData(env) {
  try {
    const profile = await callWithRetry(env, "/api/v1/user/profile");
    const stats = await callWithRetry(env, "/api/v1/usage/dashboard/stats");

    const todayInputTokens = Math.round(
      toNumber(stats?.today_input_tokens) +
      toNumber(stats?.today_cache_creation_tokens) +
      toNumber(stats?.today_cache_read_tokens)
    );
    const todayOutputTokens = Math.round(toNumber(stats?.today_output_tokens));
    const todayTotalTokens = Math.round(toNumber(stats?.today_tokens)) || (todayInputTokens + todayOutputTokens);
    const today = getShanghaiDateString();

    return {
      daily: [{
        date: today,
        inputTokens: todayInputTokens,
        outputTokens: todayOutputTokens,
        totalTokens: todayTotalTokens,
        queryCount: Math.round(toNumber(stats?.today_requests)),
        costUsd: toNumber(stats?.today_cost),
      }],
      balanceRemainingUsd: toNumber(profile?.balance),
      balanceExpirationDate: null,
      scrapedAt: new Date().toISOString(),
    };
  } catch (error) {
    // No usable API token (missing/expired). The bearer token is no longer in
    // localStorage, but the cached profile is — surface the balance from there
    // so the dashboard stays useful, with usage left blank.
    const cached = readTimiccAuthUser(resolveLeveldbPath(env));
    const cachedBalance = toNumber(cached?.balance);
    if (cached && Number.isFinite(cachedBalance)) {
      return {
        daily: [],
        balanceRemainingUsd: cachedBalance,
        balanceExpirationDate: null,
        scrapedAt: new Date().toISOString(),
        balanceOnly: true,
        balanceOnlyReason: error.message,
      };
    }
    throw error;
  }
}

async function fetchUsage({ start, end, env }) {
  try {
    const data = await fetchTimiCcData(env);
    const todayDate = getShanghaiDateString();
    const todayDaily = Array.isArray(data.daily) && data.daily[0] ? { ...data.daily[0], date: todayDate } : null;
    const daily = normalizeDailyRecords(
      (data.daily || []).map((item) => ({ ...item, date: todayDate })).filter((item) => item.date >= start && item.date <= end)
    );

    return {
      provider: env.TIMICC_PROVIDER_ID || "timicc",
      totals: mergeUsageTotals(daily),
      daily,
      todayDaily,
      account: {
        balanceRemainingUsd: Number.isFinite(data.balanceRemainingUsd) ? data.balanceRemainingUsd : null,
        balanceExpirationDate: data.balanceExpirationDate || null,
      },
      meta: {
        supportsTokenBreakdown: true,
        supportsQueryCount: true,
        ...(data.balanceOnly
          ? { balanceOnly: true, note: "Balance read from browser localStorage; usage needs a valid TIMICC_AUTH_TOKEN." }
          : {}),
      },
    };
  } catch (error) {
    throw new Error(`TimiCC provider failed: ${error.message}`);
  }
}

module.exports = {
  providerId: "timicc",
  fetchUsage,
};
