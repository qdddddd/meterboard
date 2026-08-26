const { getShanghaiDateString, mergeUsageTotals, parseShanghaiDateTime, toNumber } = require("./utils");
const { requestJson } = require("./http");

const MICU_API_BASE = "https://www.micuapi.ai";
const MICU_QUOTA_TO_USD = 500000;

function buildUnixTimestamp(dateStr, isEnd) {
  const value = parseShanghaiDateTime(dateStr, isEnd);
  if (!Number.isFinite(value)) {
    throw new Error(`Invalid Micu date: ${dateStr}`);
  }
  return Math.floor(value / 1000);
}

function resolveQuotaDivisor(env) {
  const envDivisor = toNumber(env?.MICU_QUOTA_TO_USD);
  if (envDivisor > 0) return envDivisor;
  return MICU_QUOTA_TO_USD;
}

// Local DNS poisons www.micuapi.ai, so requests must tunnel through the
// proxy (requestJson) and let it resolve the hostname — bare fetch ignores
// proxy env vars and dies on the poisoned route.
async function fetchMicuApi(path, token, userId, env) {
  const { status, payload } = await requestJson(`${MICU_API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "new-api-user": String(userId),
      accept: "application/json, text/plain, */*",
    },
    env,
  });
  if (status < 200 || status >= 300 || payload?.success === false) {
    const message = payload?.message || `Micu API ${status}`;
    throw new Error(`${path} — ${message}`);
  }
  return payload?.data ?? payload ?? null;
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

async function fetchMicuData(start, end, env) {
  const token = env.MICU_AUTH_TOKEN;
  const userId = Number(env.MICU_USER_ID);
  if (!token || !Number.isFinite(userId) || userId <= 0) {
    throw new Error(
      "MICU_AUTH_TOKEN and MICU_USER_ID must both be set. Generate an access token at https://www.micuapi.ai/console; find your user id with `JSON.parse(localStorage.user).id` in the console."
    );
  }

  const startTs = buildUnixTimestamp(start, false);
  const endTs = buildUnixTimestamp(end, true);
  const divisor = resolveQuotaDivisor(env);

  const userData = await fetchMicuApi("/api/user/self", token, userId, env);
  const remainingQuota = toNumber(userData?.quota ?? userData?.user?.quota);
  const balanceRemainingUsd = remainingQuota > 0 ? remainingQuota / divisor : null;

  const statData = await fetchMicuApi(
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
    const logPage = await fetchMicuApi(
      `/api/log/self?p=${pageNumber}&page_size=${pageSize}&type=0&token_name=&model_name=&start_timestamp=${startTs}&end_timestamp=${endTs}&group=&request_id=`,
      token,
      userId,
      env
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
}

async function fetchUsage({ start, end, env }) {
  try {
    const data = await fetchMicuData(start, end, env);
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
