const { getShanghaiDateString, mergeUsageTotals, normalizeDailyRecords, toNumber } = require("./utils");

const TIMICC_API_BASE = "https://timicc.com";

// timicc.com exposes balance + usage via the OpenAI-style /v1/usage endpoint,
// authenticated by a non-expiring API key (sk-...) from the console. This
// avoids the session token, which lives in an httpOnly cookie and expires
// every few days.
async function fetchTimiccUsage(apiKey) {
  const response = await fetch(`${TIMICC_API_BASE}/v1/usage`, {
    headers: { Authorization: `Bearer ${apiKey}`, accept: "application/json" },
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.isValid === false) {
    const message = payload?.message || payload?.error?.message || `TimiCC API ${response.status}`;
    throw new Error(`/v1/usage — ${message}`);
  }
  return payload;
}

function buildTodayRecord(today) {
  const inputTokens = Math.round(
    toNumber(today?.input_tokens) +
    toNumber(today?.cache_creation_tokens) +
    toNumber(today?.cache_read_tokens)
  );
  const outputTokens = Math.round(toNumber(today?.output_tokens));
  const totalTokens = Math.round(toNumber(today?.total_tokens)) || (inputTokens + outputTokens);
  return {
    date: getShanghaiDateString(),
    inputTokens,
    outputTokens,
    totalTokens,
    queryCount: Math.round(toNumber(today?.requests)),
    costUsd: toNumber(today?.cost),
  };
}

async function fetchUsage({ start, end, env }) {
  try {
    const apiKey = env.TIMICC_API_KEY || env.TIMICC_AUTH_TOKEN;
    if (!apiKey) {
      throw new Error(
        "TIMICC_API_KEY is not set. Generate an API key (sk-...) in the timicc.com console and set TIMICC_API_KEY in .env."
      );
    }

    const usage = await fetchTimiccUsage(apiKey);
    const todayDate = getShanghaiDateString();
    const todayRecord = buildTodayRecord(usage?.usage?.today);
    const daily = normalizeDailyRecords(
      [todayRecord].filter((item) => item.date >= start && item.date <= end)
    );
    const balance = toNumber(usage?.remaining ?? usage?.balance);

    return {
      provider: env.TIMICC_PROVIDER_ID || "timicc",
      totals: mergeUsageTotals(daily),
      daily,
      todayDaily: { ...todayRecord, date: todayDate },
      account: {
        balanceRemainingUsd: Number.isFinite(balance) ? balance : null,
        balanceExpirationDate: null,
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
