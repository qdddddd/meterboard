const { getShanghaiDateString, mergeUsageTotals, parseShanghaiDateTime, toNumber } = require("./utils");
const { withEdgePage } = require("./edge-browser");

const PACKY_CONSOLE_URL = "https://www.packyapi.com/console";
const PACKY_QUOTA_TO_USD = 500000;

/**
 * Packy provider using Playwright browser automation to reuse the user's
 * Edge session. Today's usage is read directly from the console's summary
 * endpoints instead of paginating and aggregating the consumption log.
 */

function buildUnixTimestamp(dateStr, isEnd) {
  const value = parseShanghaiDateTime(dateStr, isEnd);
  if (!Number.isFinite(value)) {
    throw new Error(`Invalid Packy date: ${dateStr}`);
  }
  return Math.floor(value / 1000);
}

function isLoginScreen(text, url) {
  return text.includes("登录") || text.toLowerCase().includes("login") || url.includes("/login");
}

function resolveQuotaDivisor(quotaPerUnit, env) {
  const envDivisor = toNumber(env?.PACKY_QUOTA_TO_USD);
  if (envDivisor > 0) return envDivisor;
  if (Number.isFinite(quotaPerUnit) && quotaPerUnit > 0) return quotaPerUnit;
  return PACKY_QUOTA_TO_USD;
}

async function fetchPackyApi(page, buildUrl) {
  return page.evaluate(async (url) => {
    let currentUserId = -1;
    try {
      const rawUser = localStorage.getItem("user");
      const parsedUser = rawUser ? JSON.parse(rawUser) : null;
      const userId = parsedUser?.id ?? -1;
      currentUserId = Number.isFinite(Number(userId)) && Number(userId) > 0 ? Number(userId) : -1;
    } catch {
      currentUserId = -1;
    }

    const response = await fetch(url, {
      credentials: "include",
      headers: {
        accept: "application/json, text/plain, */*",
        ...(currentUserId > 0 ? { "New-Api-User": String(currentUserId) } : {}),
      },
    });

    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.success === false) {
      const message = payload?.message || `Packy API ${response.status}`;
      throw new Error(`${url} — ${message}`);
    }
    return payload?.data ?? payload ?? null;
  }, buildUrl);
}

async function scrapePackyData(start, end, env, runtime) {
  return withEdgePage(runtime, env, async (page) => {
    await page.goto(PACKY_CONSOLE_URL, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });

    const consoleState = await page.evaluate(() => ({
      text: document.body.innerText,
      url: document.URL,
      quotaPerUnit: Number.parseFloat(localStorage.getItem("quota_per_unit") || "0"),
    }));

    if (isLoginScreen(consoleState.text, consoleState.url)) {
      throw new Error(
        "Not logged in to Packy. Open Edge, sign in at https://www.packyapi.com, then refresh again."
      );
    }

    const startTs = buildUnixTimestamp(start, false);
    const endTs = buildUnixTimestamp(end, true);
    const divisor = resolveQuotaDivisor(consoleState.quotaPerUnit, env);

    const userData = await fetchPackyApi(page, "/api/user/self");
    const remainingQuota = toNumber(userData?.quota);
    const balanceRemainingUsd = remainingQuota > 0 ? remainingQuota / divisor : null;

    const statData = await fetchPackyApi(
      page,
      `/api/log/self/stat?start_timestamp=${startTs}&end_timestamp=${endTs}&type=0`
    );
    const spentQuota = toNumber(statData?.quota);
    const costUsd = spentQuota > 0 ? spentQuota / divisor : 0;

    const pageSize = 100;
    let inputTokens = 0;
    let outputTokens = 0;
    let queryCount = 0;
    let pageNumber = 1;
    while (true) {
      const logPage = await fetchPackyApi(
        page,
        `/api/log/self/?p=${pageNumber}&page_size=${pageSize}&type=0&token_name=&model_name=&start_timestamp=${startTs}&end_timestamp=${endTs}&group=`
      );
      if (pageNumber === 1) {
        queryCount = toNumber(logPage?.total);
      }
      const items = Array.isArray(logPage?.items) ? logPage.items : [];
      for (const item of items) {
        inputTokens += Math.round(toNumber(item?.prompt_tokens));
        outputTokens += Math.round(toNumber(item?.completion_tokens));
      }
      if (items.length < pageSize || pageNumber * pageSize >= queryCount) {
        break;
      }
      pageNumber += 1;
    }
    const totalTokens = inputTokens + outputTokens;

    const today = getShanghaiDateString();
    const daily = [{
      date: today,
      inputTokens,
      outputTokens,
      totalTokens,
      queryCount,
      costUsd,
    }];

    return {
      daily,
      todayDaily: daily[0],
      balanceRemainingUsd,
      balanceExpirationDate: null,
      balanceRemainingText: null,
      balanceExpirationText: "No expiry",
      scrapedAt: new Date().toISOString(),
    };
  });
}

/**
 * Generic factory for a Packy billing provider.
 * @param {string} envPrefix  - env var prefix, e.g. "PACKY"
 * @param {string} defaultId  - fallback providerId string
 */
function createPackyProvider(envPrefix, defaultId) {
  async function fetchUsage({ start, end, env, runtime }) {
    try {
      const data = await scrapePackyData(start, end, env, runtime);
      const todayDate = getShanghaiDateString();
      const todayDaily = data.todayDaily || (
        Array.isArray(data.daily)
          ? data.daily.find((item) => item.date === todayDate) || null
          : null
      );
      const daily = Array.isArray(data.daily) ? data.daily : [];

      const totals = mergeUsageTotals(daily);

      const providerId = env[`${envPrefix}_PROVIDER_ID`] || defaultId;

      return {
        provider: providerId,
        totals,
        daily,
        todayDaily,
        account: {
          balanceRemainingUsd: data.balanceRemainingUsd || null,
          balanceExpirationDate: data.balanceExpirationDate || null,
          balanceRemainingText: data.balanceRemainingText || null,
          balanceExpirationText: data.balanceExpirationText || null,
        },
        meta: {
          supportsTokenBreakdown: true,
          supportsQueryCount: true,
        },
      };
    } catch (error) {
      throw new Error(`${envPrefix} provider failed: ${error.message}`);
    }
  }

  return {
    providerId: defaultId,
    fetchUsage,
  };
}

module.exports = { createPackyProvider };
