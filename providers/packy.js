const { getShanghaiDateString, mergeUsageTotals, normalizeDailyRecords, parseShanghaiDateTime, toNumber } = require("./utils");
const { withEdgePage } = require("./edge-browser");

const PACKY_CONSOLE_URL = "https://www.packyapi.com/console";
const PACKY_CONSUMPTION_LOG_URL = "https://www.packyapi.com/console/consumption-log";
const PACKY_QUOTA_TO_USD = 500000;

/**
 * Packy provider using Playwright browser automation.
 * 
 * This provider uses your existing Edge profile, so if you're already logged in
 * to packyapi.com in Edge, it will reuse that session automatically.
 * 
 * No credentials needed in .env - just log in manually in Edge once!
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

function parseBalanceByLabels(text, labels) {
  if (!text) {
    return null;
  }

  for (const label of labels) {
    const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(`${escapedLabel}[^0-9$]*\\$?\\s*([0-9][0-9,]*(?:\\.[0-9]+)?)`, "i");
    const match = text.match(regex);
    if (match) {
      return parseFloat(match[1].replace(/,/g, ""));
    }
  }

  return null;
}

function parseConsoleSummary(text) {
  const balanceRemainingUsd = parseBalanceByLabels(text, ["当前余额", "账户余额", "余额", "剩余余额", "可用余额"]);
  const costMatch = text.match(/统计额度[^$]*\$\s*([0-9.]+)/);
  const tokensMatch = text.match(/统计Tokens[^0-9]*([0-9,]+)/);

  return {
    balanceRemainingUsd,
    totalCost: costMatch ? parseFloat(costMatch[1]) : 0,
    totalTokens: tokensMatch ? parseInt(tokensMatch[1].replace(/,/g, ""), 10) : 0,
  };
}

function derivePackyBalanceRemainingUsd(consoleText, consoleState, env) {
  const parsedBalance = parseConsoleSummary(consoleText).balanceRemainingUsd;
  if (Number.isFinite(parsedBalance)) {
    return parsedBalance;
  }

  const rawQuota = toNumber(consoleState?.quota);
  if (rawQuota > 0) {
    const envDivisor = toNumber(env?.PACKY_QUOTA_TO_USD);
    const divisor = envDivisor > 0
      ? envDivisor
      : Number.isFinite(consoleState?.quotaPerUnit) && consoleState.quotaPerUnit > 0
        ? consoleState.quotaPerUnit
        : PACKY_QUOTA_TO_USD;
    return rawQuota / divisor;
  }

  return null;
}

function normalizePackyCostUsd(item, quotaPerUnit, env) {
  const quota = toNumber(item?.quota);
  if (quota > 0) {
    const envDivisor = toNumber(env?.PACKY_QUOTA_TO_USD);
    const divisor = envDivisor > 0
      ? envDivisor
      : Number.isFinite(quotaPerUnit) && quotaPerUnit > 0
        ? quotaPerUnit
        : PACKY_QUOTA_TO_USD;
    return quota / divisor;
  }

  const directCost = toNumber(item?.cost) || toNumber(item?.amount);
  return directCost > 0 ? directCost : 0;
}

function mapPackyLogItemToDailyRecord(item, quotaPerUnit, env) {
  const createdAt = toNumber(item?.created_at);
  if (!createdAt) {
    return null;
  }

  const promptTokens = Math.round(toNumber(item.prompt_tokens));
  const completionTokens = Math.round(toNumber(item.completion_tokens));
  const totalTokens = Math.round(
    toNumber(item.total_tokens) || promptTokens + completionTokens
  );

  const costUsd = normalizePackyCostUsd(item, quotaPerUnit, env);

  return {
    date: getShanghaiDateString(new Date(createdAt * 1000)),
    inputTokens: promptTokens,
    outputTokens: completionTokens,
    totalTokens,
    queryCount: 1,
    costUsd,
  };
}

async function fetchPackyLogItems(page, start, end) {
  const startTimestamp = buildUnixTimestamp(start, false);
  const endTimestamp = buildUnixTimestamp(end, true);

  return page.evaluate(async ({ endTimestamp: endTs, startTimestamp: startTs }) => {
    let currentUserId = -1;
    try {
      const rawUser = localStorage.getItem("user");
      const parsedUser = rawUser ? JSON.parse(rawUser) : null;
      const userId = parsedUser?.id ?? -1;
      currentUserId = Number.isFinite(Number(userId)) && Number(userId) > 0 ? Number(userId) : -1;
    } catch {
      currentUserId = -1;
    }

    if (currentUserId <= 0) {
      throw new Error("Unable to identify the Packy account from local storage");
    }

    const pageSize = 100;
    let pageNumber = 1;
    let totalPages = 1;
    const allItems = [];

    while (pageNumber <= totalPages) {
      const params = new URLSearchParams({
        p: String(pageNumber),
        page_size: String(pageSize),
        type: "0",
        token_name: "",
        model_name: "",
        start_timestamp: String(startTs),
        end_timestamp: String(endTs),
        group: "",
      });

      const response = await fetch(`/api/log/self/?${params.toString()}`, {
        credentials: "include",
        headers: {
          accept: "application/json, text/plain, */*",
          "New-Api-User": String(currentUserId),
        },
      });

      const payload = await response.json();
      if (!response.ok || payload?.success === false) {
        throw new Error(payload?.message || `Packy log request failed (${response.status})`);
      }

      const data = payload?.data || {};
      const items = Array.isArray(data.items) ? data.items : [];
      const total = Number(data.total) || items.length;
      totalPages = Math.max(1, Math.ceil(total / pageSize));
      allItems.push(...items);

      if (items.length === 0) {
        break;
      }

      pageNumber += 1;
    }

    return allItems;
  }, { startTimestamp, endTimestamp });
}

async function scrapePackyData(start, end, env, runtime) {
  return withEdgePage(runtime, env, async (page) => {
    await page.goto(PACKY_CONSOLE_URL, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    await page.waitForTimeout(3000);

    const consoleState = await page.evaluate(() => {
      let quota = 0;
      try {
        const rawUser = localStorage.getItem("user");
        const parsedUser = rawUser ? JSON.parse(rawUser) : null;
        quota = Number(parsedUser?.quota || parsedUser?.user?.quota || 0);
      } catch {
        quota = 0;
      }

      return {
        text: document.body.innerText,
        url: document.URL,
        quotaPerUnit: Number.parseFloat(localStorage.getItem("quota_per_unit") || "0"),
        quota,
      };
    });

    if (isLoginScreen(consoleState.text, consoleState.url)) {
      throw new Error(
        "Not logged in to Packy. Open Edge, sign in at https://www.packyapi.com, then refresh again."
      );
    }

    const consoleSummary = parseConsoleSummary(consoleState.text);
    const balanceRemainingUsd = derivePackyBalanceRemainingUsd(consoleState.text, consoleState, env);

    await page.goto(PACKY_CONSUMPTION_LOG_URL, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    await page.waitForTimeout(2500);

    const logState = await page.evaluate(() => ({
      text: document.body.innerText,
      url: document.URL,
    }));

    if (isLoginScreen(logState.text, logState.url)) {
      throw new Error(
        "Not logged in to Packy. Open Edge, sign in at https://www.packyapi.com, then refresh again."
      );
    }

    const rawItems = await fetchPackyLogItems(page, start, end);
    const daily = normalizeDailyRecords(
      rawItems.map((item) => mapPackyLogItemToDailyRecord(item, consoleState.quotaPerUnit, env)).filter(Boolean)
    );
    const today = getShanghaiDateString();
    const todayDaily = daily.find((item) => item.date === today) || null;

    return {
      daily,
      balanceRemainingUsd,
      balanceExpirationDate: null,
      balanceRemainingText: null,
      balanceExpirationText: "No expiry",
      scrapedAt: new Date().toISOString(),
      consoleSummary,
      todayDaily,
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
          supportsTokenBreakdown: false,
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
