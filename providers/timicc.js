const { getShanghaiDateString, mergeUsageTotals, normalizeDailyRecords, toNumber } = require("./utils");
const { withEdgePage } = require("./edge-browser");

const TIMICC_DASHBOARD_URL = "https://timicc.com/dashboard";

function isLoginScreen(url) {
  const lowerUrl = url.toLowerCase();
  return lowerUrl.includes("/login") || lowerUrl.includes("/auth");
}

async function fetchTimiCcApi(page, path) {
  return page.evaluate(async (requestPath) => {
    const token = localStorage.getItem("auth_token") || "";
    if (!token) {
      throw new Error("Missing TimiCC auth_token — sign in at https://timicc.com and refresh");
    }
    const response = await fetch(requestPath, {
      headers: {
        Authorization: `Bearer ${token}`,
        accept: "application/json",
      },
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || (payload && payload.code !== undefined && payload.code !== 0)) {
      const message = payload?.message || `TimiCC API ${response.status}`;
      throw new Error(`${requestPath} — ${message}`);
    }
    return payload?.data ?? payload ?? null;
  }, path);
}

async function scrapeTimiCcData(env, runtime) {
  return withEdgePage(runtime, env, async (page) => {
    await page.goto(TIMICC_DASHBOARD_URL, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });

    const url = await page.evaluate(() => document.URL);
    if (isLoginScreen(url)) {
      throw new Error("Not logged in to TimiCC. Open Edge, sign in at https://timicc.com, then refresh again.");
    }

    const profile = await fetchTimiCcApi(page, "/api/v1/user/profile");
    const stats = await fetchTimiCcApi(page, "/api/v1/usage/dashboard/stats");

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
  });
}

async function fetchUsage({ start, end, env, runtime }) {
  try {
    const data = await scrapeTimiCcData(env, runtime);
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
