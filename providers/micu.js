const { getShanghaiDateString, mergeUsageTotals, parseShanghaiDateTime, toNumber } = require("./utils");
const { withEdgePage } = require("./edge-browser");

const MICU_CONSOLE_URL = "https://www.openclaudecode.cn/console";
const MICU_QUOTA_TO_USD = 500000;

function buildUnixTimestamp(dateStr, isEnd) {
  const value = parseShanghaiDateTime(dateStr, isEnd);
  if (!Number.isFinite(value)) {
    throw new Error(`Invalid Micu date: ${dateStr}`);
  }
  return Math.floor(value / 1000);
}

function isLoginScreen(text, url) {
  return text.includes("登录") || text.toLowerCase().includes("login") || url.includes("/login");
}

function resolveQuotaDivisor(quotaPerUnit) {
  if (Number.isFinite(quotaPerUnit) && quotaPerUnit > 0) return quotaPerUnit;
  return MICU_QUOTA_TO_USD;
}

async function fetchMicuApi(page, url) {
  return page.evaluate(async (requestUrl) => {
    let currentUserId = -1;
    try {
      const rawUser = localStorage.getItem("user");
      const parsedUser = rawUser ? JSON.parse(rawUser) : null;
      const userId = parsedUser?.id ?? parsedUser?.user?.id ?? -1;
      currentUserId = Number.isFinite(Number(userId)) && Number(userId) > 0 ? Number(userId) : -1;
    } catch {
      currentUserId = -1;
    }

    const response = await fetch(requestUrl, {
      credentials: "include",
      headers: {
        accept: "application/json, text/plain, */*",
        ...(currentUserId > 0 ? { "new-api-user": String(currentUserId) } : {}),
      },
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.success === false) {
      const message = payload?.message || `Micu API ${response.status}`;
      throw new Error(`${requestUrl} — ${message}`);
    }
    return payload?.data ?? payload ?? null;
  }, url);
}

function parseOtherPayload(other) {
  if (!other || typeof other !== "string") return {};
  try {
    const parsed = JSON.parse(other);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function pickCacheMetric(payload, primaryKey, fallbackKey) {
  if (Object.prototype.hasOwnProperty.call(payload, primaryKey)) {
    return Math.round(toNumber(payload[primaryKey]));
  }
  if (Object.prototype.hasOwnProperty.call(payload, fallbackKey)) {
    return Math.round(toNumber(payload[fallbackKey]));
  }
  return 0;
}

function tokensFromLogItem(item) {
  const other = parseOtherPayload(item?.other);
  const cacheRead = pickCacheMetric(other, "cache_tokens", "cache_tokens_5m");
  const cacheCreation = pickCacheMetric(other, "cache_creation_tokens", "cache_creation_tokens_5m");
  const inputTokens = Math.round(toNumber(item?.prompt_tokens)) + cacheRead + cacheCreation;
  const outputTokens = Math.round(toNumber(item?.completion_tokens));
  return { inputTokens, outputTokens };
}

async function scrapeMicuData(start, end, env, runtime) {
  return withEdgePage(runtime, env, async (page) => {
    await page.goto(MICU_CONSOLE_URL, {
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
        "Not logged in to Micu. Open Edge, sign in at https://www.openclaudecode.cn, then refresh again."
      );
    }

    const startTs = buildUnixTimestamp(start, false);
    const endTs = buildUnixTimestamp(end, true);
    const divisor = resolveQuotaDivisor(consoleState.quotaPerUnit);

    const userData = await fetchMicuApi(page, "/api/user/self");
    const remainingQuota = toNumber(userData?.quota ?? userData?.user?.quota);
    const balanceRemainingUsd = remainingQuota > 0 ? remainingQuota / divisor : null;

    const statData = await fetchMicuApi(
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
      const logPage = await fetchMicuApi(
        page,
        `/api/log/self?p=${pageNumber}&page_size=${pageSize}&type=0&token_name=&model_name=&start_timestamp=${startTs}&end_timestamp=${endTs}&group=&request_id=`
      );
      if (pageNumber === 1) {
        queryCount = toNumber(logPage?.total);
      }
      const items = Array.isArray(logPage?.items) ? logPage.items : [];
      for (const item of items) {
        const tokens = tokensFromLogItem(item);
        inputTokens += tokens.inputTokens;
        outputTokens += tokens.outputTokens;
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
      scrapedAt: new Date().toISOString(),
    };
  });
}

async function fetchUsage({ start, end, env, runtime }) {
  try {
    const data = await scrapeMicuData(start, end, env, runtime);
    const today = getShanghaiDateString();
    const todayDaily = data.todayDaily || (
      Array.isArray(data.daily) ? data.daily.find((item) => item.date === today) || null : null
    );
    const daily = Array.isArray(data.daily) ? data.daily : [];

    return {
      provider: env.MICU_PROVIDER_ID || "micu",
      totals: mergeUsageTotals(daily),
      daily,
      todayDaily,
      account: {
        balanceRemainingUsd: Number.isFinite(data.balanceRemainingUsd) ? data.balanceRemainingUsd : null,
        balanceExpirationDate: data.balanceExpirationDate || null,
      },
    };
  } catch (error) {
    throw new Error(`Micu provider failed: ${error.message}`);
  }
}

module.exports = {
  providerId: "micu",
  fetchUsage,
};
