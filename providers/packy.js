const { getShanghaiDateString, mergeUsageTotals, parseShanghaiDateTime, toNumber } = require("./utils");
const { requestJson } = require("./http");

const PACKY_API_BASE = "https://www.packyapi.com";
const PACKY_QUOTA_TO_USD = 500000;

function buildUnixTimestamp(dateStr, isEnd) {
  const value = parseShanghaiDateTime(dateStr, isEnd);
  if (!Number.isFinite(value)) {
    throw new Error(`Invalid Packy date: ${dateStr}`);
  }
  return Math.floor(value / 1000);
}

function resolveQuotaDivisor(env) {
  const envDivisor = toNumber(env?.PACKY_QUOTA_TO_USD);
  if (envDivisor > 0) return envDivisor;
  return PACKY_QUOTA_TO_USD;
}

// Local DNS poisons www.packyapi.com, so requests must tunnel through the
// proxy (requestJson) and let it resolve the hostname — bare fetch ignores
// proxy env vars and dies on the poisoned route.
async function fetchPackyApi(path, token, userId, env) {
  const { status, payload } = await requestJson(`${PACKY_API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "New-Api-User": String(userId),
      accept: "application/json, text/plain, */*",
    },
    env,
  });
  if (status < 200 || status >= 300 || payload?.success === false) {
    const message = payload?.message || `Packy API ${status}`;
    throw new Error(`${path} — ${message}`);
  }
  return payload?.data ?? payload ?? null;
}

async function fetchPackyData(start, end, env) {
  const token = env.PACKY_AUTH_TOKEN;
  const userId = Number(env.PACKY_USER_ID);
  if (!token || !Number.isFinite(userId) || userId <= 0) {
    throw new Error(
      "PACKY_AUTH_TOKEN and PACKY_USER_ID must both be set. Generate an access token at https://www.packyapi.com/console; find your user id with `JSON.parse(localStorage.user).id` in the console."
    );
  }

  const startTs = buildUnixTimestamp(start, false);
  const endTs = buildUnixTimestamp(end, true);
  const divisor = resolveQuotaDivisor(env);

  const userData = await fetchPackyApi("/api/user/self", token, userId, env);
  const remainingQuota = toNumber(userData?.quota);
  const balanceRemainingUsd = remainingQuota > 0 ? remainingQuota / divisor : null;

  const statData = await fetchPackyApi(
    `/api/log/self/stat?start_timestamp=${startTs}&end_timestamp=${endTs}&type=0`,
    token,
    userId,
    env
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
      `/api/log/self?p=${pageNumber}&page_size=${pageSize}&type=0&token_name=&model_name=&start_timestamp=${startTs}&end_timestamp=${endTs}&group=`,
      token,
      userId,
      env
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
}

function createPackyProvider(envPrefix, defaultId) {
  async function fetchUsage({ start, end, env }) {
    try {
      const data = await fetchPackyData(start, end, env);
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
