const { getShanghaiDateString, mergeUsageTotals, normalizeDailyRecords, toNumber } = require("./utils");
const { requestJson } = require("./http");

const RIGHT_CODE_API_BASE = "https://www.right.codes";

// Local DNS poisons www.right.codes, so requests must tunnel through the
// proxy (requestJson) and let it resolve the hostname — bare fetch ignores
// proxy env vars and dies on the poisoned route.
async function fetchRightCodeApi(path, token, env) {
  const { status, payload } = await requestJson(`${RIGHT_CODE_API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      accept: "application/json",
    },
    env,
  });
  if (status < 200 || status >= 300) {
    const message = payload?.message || payload?.error || `Right Code API ${status}`;
    throw new Error(`${path} — ${message}`);
  }
  return payload;
}

function formatRangeTimestamp(dateStr, isEnd) {
  return `${dateStr}T${isEnd ? "23:59:00" : "00:00:00"}`;
}

function pickEarliestFutureExpiration(subscriptions) {
  if (!Array.isArray(subscriptions) || subscriptions.length === 0) return null;
  const nowIso = new Date().toISOString();
  const future = subscriptions
    .map((item) => item?.expired_at)
    .filter((value) => typeof value === "string" && value > nowIso)
    .sort();
  const chosen = future[0] || subscriptions[0]?.expired_at;
  if (typeof chosen !== "string") return null;
  const match = chosen.match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : null;
}

async function fetchRightCodeData(start, end, env) {
  const token = env.RIGHT_CODE_AUTH_TOKEN;
  if (!token) {
    throw new Error(
      "RIGHT_CODE_AUTH_TOKEN is not set. Sign in at https://www.right.codes, then copy `userToken` from localStorage into .env."
    );
  }

  const startParam = encodeURIComponent(formatRangeTimestamp(start, false));
  const endParam = encodeURIComponent(formatRangeTimestamp(end, true));

  const [me, stats, subscriptions] = await Promise.all([
    fetchRightCodeApi("/auth/me", token, env),
    fetchRightCodeApi(
      `/use-log/stats/advanced?start_date=${startParam}&end_date=${endParam}&granularity=day`,
      token,
      env
    ),
    fetchRightCodeApi("/subscriptions/list", token, env).catch(() => null),
  ]);

  const today = getShanghaiDateString();
  const totalTokens = Math.round(toNumber(stats?.total_tokens));
  const queryCount = Math.round(toNumber(stats?.total_requests));
  const costUsd = toNumber(stats?.total_cost);

  return {
    daily: [{
      date: today,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens,
      queryCount,
      costUsd,
    }],
    balanceRemainingUsd: toNumber(me?.balance),
    balanceExpirationDate: pickEarliestFutureExpiration(subscriptions?.subscriptions),
  };
}

async function fetchUsage({ start, end, env }) {
  try {
    const data = await fetchRightCodeData(start, end, env);
    const todayDate = getShanghaiDateString();
    const todayDaily = Array.isArray(data.daily) && data.daily[0]
      ? { ...data.daily[0], date: todayDate }
      : null;

    const daily = normalizeDailyRecords(
      (data.daily || [])
        .map((item) => ({ ...item, date: todayDate }))
        .filter((item) => item.date >= start && item.date <= end)
    );

    const costMultiplier = toNumber(env.RIGHT_CODE_COST_MULTIPLIER) || 1;
    const adjustedDaily = daily.map((item) => ({
      ...item,
      costUsd: item.costUsd * costMultiplier,
    }));

    return {
      provider: env.RIGHT_CODE_PROVIDER_ID || "right-code",
      totals: mergeUsageTotals(adjustedDaily),
      daily: adjustedDaily,
      todayDaily,
      account: {
        balanceRemainingUsd: Number.isFinite(data.balanceRemainingUsd) ? data.balanceRemainingUsd : null,
        balanceExpirationDate: data.balanceExpirationDate || null,
      },
    };
  } catch (error) {
    throw new Error(`Right Code provider failed: ${error.message}`);
  }
}

module.exports = {
  providerId: "right-code",
  fetchUsage,
};
