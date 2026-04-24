const { getShanghaiDateString, mergeUsageTotals, normalizeDailyRecords, toNumber } = require("./utils");

const TIMICC_API_BASE = "https://timicc.com";

async function fetchTimiCcApi(path, token) {
  const response = await fetch(`${TIMICC_API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      accept: "application/json",
    },
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || (payload && payload.code !== undefined && payload.code !== 0)) {
    const message = payload?.message || `TimiCC API ${response.status}`;
    throw new Error(`${path} — ${message}`);
  }
  return payload?.data ?? payload ?? null;
}

async function fetchTimiCcData(env) {
  const token = env.TIMICC_AUTH_TOKEN;
  if (!token) {
    throw new Error(
      "TIMICC_AUTH_TOKEN is not set. Sign in at https://timicc.com, open DevTools → Application → Local Storage, copy the `auth_token` value into .env, and restart the service."
    );
  }

  const profile = await fetchTimiCcApi("/api/v1/user/profile", token);
  const stats = await fetchTimiCcApi("/api/v1/usage/dashboard/stats", token);

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
