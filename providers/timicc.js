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

function readFreshTimiccToken(leveldbPath) {
  let entries;
  try {
    entries = fs.readdirSync(leveldbPath);
  } catch {
    return null;
  }
  const files = entries
    .filter((name) => /\.(ldb|log)$/.test(name))
    .map((name) => path.join(leveldbPath, name));

  const now = Math.floor(Date.now() / 1000);
  let best = null;
  for (const file of files) {
    let buf;
    try { buf = fs.readFileSync(file); } catch { continue; }
    for (const candidate of findTimiccTokensInBuffer(buf)) {
      if (candidate.exp <= now) continue;
      if (!best || candidate.exp > best.exp) best = candidate;
    }
  }
  return best?.token || null;
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
        `No TimiCC token available. Set TIMICC_AUTH_TOKEN in .env, or sign in at https://timicc.com so the token can be read from ${leveldbPath}.`
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
      throw new Error(`${error.message} (no fresher token in ${leveldbPath} — re-login at https://timicc.com)`);
    }
    cachedToken = fresh;
    return await fetchTimiCcApi(apiPath, fresh);
  }
}

async function fetchTimiCcData(env) {
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
