const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { getShanghaiDateString, mergeUsageTotals, normalizeDailyRecords, toNumber } = require("./utils");

const TIMICC_API_BASE = "https://timicc.com";
const DEFAULT_LEVELDB_PATH = path.join(os.homedir(), ".config", "microsoft-edge", "Default", "Local Storage", "leveldb");
const TIMICC_MARKER = "timicc.com";

function expandHome(p) {
  if (!p) return p;
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

function resolveLeveldbPath(env) {
  return expandHome(env.TIMICC_LOCALSTORAGE_PATH) || DEFAULT_LEVELDB_PATH;
}

// Leveldb files, newest first, so the most recently written value wins.
function listLeveldbFiles(leveldbPath) {
  let entries;
  try {
    entries = fs.readdirSync(leveldbPath);
  } catch {
    return [];
  }
  return entries
    .filter((name) => /\.(ldb|log)$/.test(name))
    .map((name) => {
      const full = path.join(leveldbPath, name);
      let mtime = 0;
      try { mtime = fs.statSync(full).mtimeMs; } catch {}
      return { full, mtime };
    })
    .sort((a, b) => b.mtime - a.mtime)
    .map((f) => f.full);
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
  for (const file of listLeveldbFiles(leveldbPath)) {
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

async function callTimiCcApi(env, apiPath) {
  const token = env.TIMICC_AUTH_TOKEN;
  if (!token) {
    throw new Error(
      "No TimiCC token available. timicc.com no longer keeps its bearer token in localStorage — capture it from DevTools > Network (the \"Authorization: Bearer\" header on an /api/v1 request) and set TIMICC_AUTH_TOKEN in .env."
    );
  }
  return fetchTimiCcApi(apiPath, token);
}

async function fetchTimiCcData(env) {
  try {
    const profile = await callTimiCcApi(env, "/api/v1/user/profile");
    const stats = await callTimiCcApi(env, "/api/v1/usage/dashboard/stats");

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
