const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { URL } = require("node:url");

const { getShanghaiDateString, mergeUsageTotals, normalizeDailyRecords, toNumber } = require("./providers/utils");
const { closeSharedEdgeContext } = require("./providers/edge-browser");

const openaiProvider = require("./providers/openai");
const anthropicProvider = require("./providers/anthropic");
const customProvider = require("./providers/custom");
const rightCodeProvider = require("./providers/rightcode");
const micuProvider = require("./providers/micu");
const timiCcProvider = require("./providers/timicc");
const { createPackyProvider } = require("./providers/packy");

const PROVIDERS = {
  openai: {
    ...openaiProvider,
    dashboardUrl: "https://platform.openai.com/usage",
  },
  anthropic: {
    ...anthropicProvider,
    dashboardUrl: "https://console.anthropic.com/settings/usage",
  },
  custom: {
    ...customProvider,
    getDashboardUrl: (env) => env.CUSTOM_PROVIDER_DASHBOARD_URL || null,
  },
  "right-code": {
    ...rightCodeProvider,
    dashboardUrl: "https://www.right.codes/dashboard",
  },
  micu: {
    ...micuProvider,
    dashboardUrl: "https://www.openclaudecode.cn/console",
  },
  timicc: {
    ...timiCcProvider,
    dashboardUrl: "https://timicc.com/dashboard",
  },
  packy: {
    ...createPackyProvider("PACKY", "packy"),
    dashboardUrl: "https://www.packyapi.com/console",
  },
};

const PUBLIC_DIR = path.join(__dirname, "public");
const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

function parseDotEnv(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const source = fs.readFileSync(filePath, "utf8");
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const equalIndex = line.indexOf("=");
    if (equalIndex < 0) {
      continue;
    }

    const key = line.slice(0, equalIndex).trim();
    let value = line.slice(equalIndex + 1).trim();

    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    if (!Object.prototype.hasOwnProperty.call(process.env, key)) {
      process.env[key] = value;
    }
  }
}

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function parseRange(requestUrl) {
  const start = requestUrl.searchParams.get("start");
  const end = requestUrl.searchParams.get("end");

  if (!start && !end) {
    const today = getShanghaiDateString();
    return { start: today, end: today };
  }

  if (!start || !end) {
    throw new Error("Both start and end query params are required (YYYY-MM-DD)");
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
    throw new Error("Dates must use YYYY-MM-DD format");
  }

  if (start > end) {
    throw new Error("start date cannot be after end date");
  }

  return { start, end };
}

function getEnabledProviders() {
  const configured = (process.env.PROVIDERS || "openai,anthropic")
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);

  return configured
    .map((name) => PROVIDERS[name])
    .filter(Boolean);
}

function getEnabledProviderMap() {
  return new Map(getEnabledProviders().map((provider) => [provider.providerId, provider]));
}

function mergeProviderDaily(providerResults) {
  const allDaily = providerResults.flatMap((item) => item.daily);
  return normalizeDailyRecords(allDaily);
}

function safeProviderError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 300);
}

function toTodayMetric(todayRow) {
  if (!todayRow) {
    return null;
  }

  return {
    totalTokens: Math.round(toNumber(todayRow.totalTokens)),
    queryCount: Math.round(toNumber(todayRow.queryCount)),
    costUsd: Number(toNumber(todayRow.costUsd).toFixed(4)),
  };
}

function getProviderDashboardUrl(provider, env) {
  if (!provider) {
    return null;
  }

  if (typeof provider.getDashboardUrl === "function") {
    return provider.getDashboardUrl(env) || null;
  }

  return provider.dashboardUrl || null;
}

function writeSseEvent(response, eventName, payload) {
  response.write(`event: ${eventName}\n`);
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

async function fetchProviderResult(provider, range, runtime) {
  const result = await provider.fetchUsage({ ...range, env: process.env, runtime });
  return {
    ...result,
    meta: {
      ...(result.meta || {}),
      sourceProviderId: provider.providerId,
      dashboardUrl: result.meta?.dashboardUrl || getProviderDashboardUrl(provider, process.env),
    },
  };
}

function pickTodayUsageFromResult(providerResult, todayDate) {
  if (providerResult?.todayDaily?.date === todayDate) {
    return providerResult.todayDaily;
  }

  if (!providerResult || !Array.isArray(providerResult.daily)) {
    return null;
  }

  return providerResult.daily.find((entry) => entry.date === todayDate) || null;
}

function aggregateAccountSummary(providerResults, todayUsageRows) {
  const summary = {
    balanceRemainingUsd: null,
    balanceSpentTodayUsd: 0,
    balanceExpirationDate: null,
    tokensUsedToday: 0,
    totalQueriesToday: 0,
  };

  let hasBalance = false;
  const expirationCandidates = [];

  for (const result of providerResults) {
    const account = result.account || {};
    const remaining = account.balanceRemainingUsd;
    if (Number.isFinite(remaining)) {
      hasBalance = true;
      summary.balanceRemainingUsd = toNumber(summary.balanceRemainingUsd) + toNumber(remaining);
    }

    if (typeof account.balanceExpirationDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(account.balanceExpirationDate)) {
      expirationCandidates.push(account.balanceExpirationDate);
    }
  }

  if (!hasBalance) {
    summary.balanceRemainingUsd = null;
  }

  if (expirationCandidates.length > 0) {
    summary.balanceExpirationDate = expirationCandidates.sort()[0];
  }

  for (const row of todayUsageRows) {
    summary.balanceSpentTodayUsd += toNumber(row.costUsd);
    summary.tokensUsedToday += toNumber(row.totalTokens);
    summary.totalQueriesToday += toNumber(row.queryCount);
  }

  summary.balanceSpentTodayUsd = Number(summary.balanceSpentTodayUsd.toFixed(4));
  summary.tokensUsedToday = Math.round(summary.tokensUsedToday);
  summary.totalQueriesToday = Math.round(summary.totalQueriesToday);

  return summary;
}

async function fetchSingleProvider(range, providerId) {
  const providerMap = getEnabledProviderMap();
  const provider = providerMap.get(providerId);
  if (!provider) {
    throw new Error(`Provider '${providerId}' is not enabled`);
  }

  const runtime = {};
  const todayDate = getShanghaiDateString();
  const rangeContainsToday = range.start <= todayDate && todayDate <= range.end;

  try {
    const providerResult = await fetchProviderResult(provider, range, runtime);
    let todayMetric = toTodayMetric(pickTodayUsageFromResult(providerResult, todayDate));
    let todayMetricError = null;

    if (!todayMetric && !rangeContainsToday) {
      try {
        const todayResult = await fetchProviderResult(provider, { start: todayDate, end: todayDate }, runtime);
        todayMetric = toTodayMetric(pickTodayUsageFromResult(todayResult, todayDate));
      } catch (error) {
        todayMetricError = safeProviderError(error);
      }
    }

    return {
      range,
      provider: providerResult,
      todayDate,
      todayMetric,
      todayMetricError,
      fetchedAt: new Date().toISOString(),
    };
  } finally {
    await closeSharedEdgeContext(runtime);
  }
}

async function fetchUsageAcrossProviders(range, handlers = {}) {
  const providers = getEnabledProviders();
  if (providers.length === 0) {
    throw new Error("No providers enabled. Set PROVIDERS in .env");
  }

  const runtime = {};

  const todayDate = getShanghaiDateString();
  const rangeContainsToday = range.start <= todayDate && todayDate <= range.end;

  if (typeof handlers.onStart === "function") {
    handlers.onStart({
      providers: providers.map((provider) => provider.providerId),
      todayDate,
      rangeContainsToday,
    });
  }

  try {
    const providerRuns = await Promise.all(
      providers.map(async (provider, index) => {
        try {
          const providerResult = await fetchProviderResult(provider, range, runtime);

          if (typeof handlers.onProvider === "function") {
            handlers.onProvider({
              provider: providerResult,
              todayMetric: rangeContainsToday ? toTodayMetric(pickTodayUsageFromResult(providerResult, todayDate)) : null,
            });
          }

          return {
            index,
            ok: true,
            provider,
            providerResult,
          };
        } catch (error) {
          const providerError = {
            provider: provider.providerId,
            message: safeProviderError(error),
            dashboardUrl: getProviderDashboardUrl(provider, process.env),
          };

          if (typeof handlers.onProviderError === "function") {
            handlers.onProviderError({ error: providerError });
          }

          return {
            index,
            ok: false,
            provider,
            providerError,
          };
        }
      })
    );

    providerRuns.sort((a, b) => a.index - b.index);

    const successful = providerRuns.filter((item) => item.ok).map((item) => item.providerResult);
    const errors = providerRuns.filter((item) => !item.ok).map((item) => item.providerError);

    if (successful.length === 0) {
      const details = errors.map((item) => `${item.provider}: ${item.message}`).join(" | ");
      throw new Error(`No provider succeeded. ${details}`);
    }

    const daily = mergeProviderDaily(successful);
    const totals = mergeUsageTotals(successful.map((item) => item.totals));
    const todayUsageRows = [];
    const todayByProvider = {};
    const todayMetricErrors = [];

    if (rangeContainsToday) {
      for (const providerResult of successful) {
        const todayRow = pickTodayUsageFromResult(providerResult, todayDate);
        const metric = toTodayMetric(todayRow);

        if (todayRow && metric) {
          todayUsageRows.push(todayRow);
          todayByProvider[providerResult.provider] = metric;
        }
      }
    } else {
      const providerById = new Map(providers.map((provider) => [provider.providerId, provider]));
      const missingTodayProviders = successful.filter((providerResult) => !pickTodayUsageFromResult(providerResult, todayDate));

      const todaySettled = await Promise.all(
        missingTodayProviders.map(async (providerResult) => {
          const provider = providerById.get(providerResult.meta?.sourceProviderId || providerResult.provider);

          if (!provider) {
            return {
              ok: false,
              provider: { providerId: providerResult.provider },
              error: new Error("Provider definition not found for today fetch"),
            };
          }

          try {
            const result = await fetchProviderResult(provider, { start: todayDate, end: todayDate }, runtime);
            return {
              ok: true,
              provider,
              result,
            };
          } catch (error) {
            return {
              ok: false,
              provider,
              error,
            };
          }
        })
      );

      for (const providerResult of successful) {
        const todayRow = pickTodayUsageFromResult(providerResult, todayDate);
        const metric = toTodayMetric(todayRow);

        if (todayRow && metric) {
          todayUsageRows.push(todayRow);
          todayByProvider[providerResult.provider] = metric;
        }
      }

      for (const todayResult of todaySettled) {
        if (todayResult.ok) {
          const todayRow = pickTodayUsageFromResult(todayResult.result, todayDate);
          const metric = toTodayMetric(todayRow);

          if (todayRow && metric) {
            todayUsageRows.push(todayRow);
            todayByProvider[todayResult.result.provider] = metric;
          }
        } else {
          todayMetricErrors.push({
            provider: todayResult.provider.providerId,
            message: safeProviderError(todayResult.error),
          });
        }
      }
    }

    const accountSummary = aggregateAccountSummary(successful, todayUsageRows);

    const payload = {
      range,
      totals: {
        inputTokens: Math.round(toNumber(totals.inputTokens)),
        outputTokens: Math.round(toNumber(totals.outputTokens)),
        totalTokens: Math.round(toNumber(totals.totalTokens)),
        queryCount: Math.round(toNumber(totals.queryCount)),
        costUsd: Number(toNumber(totals.costUsd).toFixed(4)),
      },
      accountSummary,
      todayDate,
      todayByProvider,
      providers: successful,
      providerErrors: errors,
      todayMetricErrors,
      daily,
      fetchedAt: new Date().toISOString(),
    };

    if (typeof handlers.onComplete === "function") {
      handlers.onComplete(payload);
    }

    return payload;
  } finally {
    await closeSharedEdgeContext(runtime);
  }
}

function serveStaticFile(urlPath, response) {
  const normalizedPath = urlPath === "/" ? "/index.html" : urlPath;
  const resolvedPath = path.join(PUBLIC_DIR, normalizedPath);

  if (!resolvedPath.startsWith(PUBLIC_DIR)) {
    sendJson(response, 403, { error: "Forbidden" });
    return;
  }

  fs.stat(resolvedPath, (statError, stat) => {
    if (statError || !stat.isFile()) {
      sendJson(response, 404, { error: "Not found" });
      return;
    }

    const extension = path.extname(resolvedPath).toLowerCase();
    const contentType = MIME_TYPES[extension] || "application/octet-stream";

    response.writeHead(200, { "Content-Type": contentType });
    fs.createReadStream(resolvedPath).pipe(response);
  });
}

parseDotEnv(path.join(__dirname, ".env"));

const server = http.createServer(async (request, response) => {
  if (!request.url) {
    sendJson(response, 400, { error: "Invalid request URL" });
    return;
  }

  const requestUrl = new URL(request.url, `http://${request.headers.host || "localhost"}`);

  if (request.method === "GET" && requestUrl.pathname === "/api/health") {
    sendJson(response, 200, {
      ok: true,
      providers: getEnabledProviders().map((provider) => provider.providerId),
      serverTime: new Date().toISOString(),
    });
    return;
  }

  if (request.method === "GET" && requestUrl.pathname === "/api/usage/stream") {
    try {
      const range = parseRange(requestUrl);
      response.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      });

      response.flushHeaders?.();

      let clientClosed = false;
      request.on("close", () => {
        clientClosed = true;
      });

      const writeIfOpen = (eventName, payload) => {
        if (!clientClosed) {
          writeSseEvent(response, eventName, payload);
        }
      };

      await fetchUsageAcrossProviders(range, {
        onStart(payload) {
          writeIfOpen("start", payload);
        },
        onProvider(payload) {
          writeIfOpen("provider", payload);
        },
        onProviderError(payload) {
          writeIfOpen("provider-error", payload);
        },
        onComplete(payload) {
          writeIfOpen("done", payload);
        },
      });

      if (!clientClosed) {
        response.end();
      }
    } catch (error) {
      if (!response.headersSent) {
        sendJson(response, 400, {
          error: safeProviderError(error),
        });
        return;
      }

      writeSseEvent(response, "fatal", {
        error: safeProviderError(error),
      });
      response.end();
    }
    return;
  }

  if (request.method === "GET" && requestUrl.pathname === "/api/usage") {
    try {
      const range = parseRange(requestUrl);
      const payload = await fetchUsageAcrossProviders(range);
      sendJson(response, 200, payload);
    } catch (error) {
      sendJson(response, 400, {
        error: safeProviderError(error),
      });
    }
    return;
  }

  if (request.method === "GET" && requestUrl.pathname === "/api/provider") {
    try {
      const range = parseRange(requestUrl);
      const providerId = requestUrl.searchParams.get("provider");

      if (!providerId) {
        throw new Error("provider query param is required");
      }

      const payload = await fetchSingleProvider(range, providerId.trim().toLowerCase());
      sendJson(response, 200, payload);
    } catch (error) {
      sendJson(response, 400, {
        error: safeProviderError(error),
      });
    }
    return;
  }

  if (request.method === "GET") {
    serveStaticFile(requestUrl.pathname, response);
    return;
  }

  sendJson(response, 405, { error: "Method not allowed" });
});

const port = Number(process.env.PORT) || 8080;
server.listen(port, () => {
  const enabled = getEnabledProviders().map((provider) => provider.providerId);
  console.log(`Token usage dashboard running on http://localhost:${port}`);
  console.log(`Enabled providers: ${enabled.join(", ") || "none"}`);
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}, shutting down`);

  const serverClosed = new Promise((resolve) => server.close(() => resolve()));
  server.closeIdleConnections?.();
  server.closeAllConnections?.();

  try {
    await Promise.race([
      Promise.all([serverClosed, closeSharedEdgeContext()]),
      new Promise((resolve) => setTimeout(resolve, 8000)),
    ]);
  } catch (error) {
    console.error("Shutdown error:", error);
  }
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
