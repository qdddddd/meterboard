const refreshButton = document.getElementById("refresh");
const todayDateLabel = document.getElementById("today-date");


const providersContainer = document.getElementById("providers");
const providerStatus = document.getElementById("provider-status");
const subscriptionsPanel = document.getElementById("subscriptions-panel");
const subscriptionsContainer = document.getElementById("subscriptions");
const subscriptionStatus = document.getElementById("subscription-status");
const messages = document.getElementById("messages");

let activeUsageStream = null;
let activeUsageToken = 0;
let currentDashboardState = null;
const refreshingProviders = new Set();
const subscriptionProviderIds = new Set();

function formatInt(value) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value || 0);
}

function formatUsd(value) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  }).format(value || 0);
}

function toSafeNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function getTodayDate() {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

  const parts = formatter.formatToParts(new Date());
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  return `${year}-${month}-${day}`;
}

function updateTodayLabel(todayDate) {
  if (!todayDateLabel) {
    return;
  }

  todayDateLabel.textContent = todayDate || getTodayDate();
}

function setLoading(isLoading) {
  refreshButton.disabled = isLoading;
  refreshButton.textContent = isLoading ? "Loading..." : "Refresh usage";
}

function clearMessages() {
  messages.innerHTML = "";
}

function showMessage(type, text) {
  const element = document.createElement("p");
  element.className = `message ${type}`;
  element.textContent = text;
  messages.append(element);
}

function createProviderHeading(label, dashboardUrl) {
  const heading = document.createElement("h3");

  if (!dashboardUrl) {
    heading.textContent = label;
    return heading;
  }

  const link = document.createElement("a");
  link.className = "provider-link";
  link.href = dashboardUrl;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.title = `Open ${label} dashboard`;
  link.textContent = label;
  heading.append(link);
  return heading;
}

function closeUsageStream() {
  if (!activeUsageStream) {
    return;
  }

  activeUsageStream.close();
  activeUsageStream = null;
}

function resetDashboardForLoading() {
  currentDashboardState = null;
  refreshingProviders.clear();
  providersContainer.innerHTML = "";
  subscriptionsContainer.innerHTML = "";
  subscriptionStatus.textContent = "";
  subscriptionsPanel.hidden = true;
  providerStatus.textContent = "Preparing provider requests...";
}

function upsertProviderEntry(collection, entry) {
  const index = collection.findIndex((item) => item.provider === entry.provider);
  if (index >= 0) {
    collection[index] = entry;
    return;
  }

  collection.push(entry);
}

function removeProviderEntry(collection, providerName) {
  return (collection || []).filter((item) => item.provider !== providerName);
}

function recalculateDashboardState(state) {
  const nextState = state || {};
  nextState.providers = Array.isArray(nextState.providers) ? nextState.providers : [];
  nextState.providerErrors = Array.isArray(nextState.providerErrors) ? nextState.providerErrors : [];
  nextState.todayByProvider = nextState.todayByProvider && typeof nextState.todayByProvider === "object"
    ? nextState.todayByProvider
    : {};
  nextState.fetchedAt = new Date().toISOString();
  nextState.streamComplete = true;
  return nextState;
}

function renderDashboardState(state) {
  if (!state) {
    return;
  }

  updateTodayLabel(state.todayDate);
  renderProviders(state);
}

function getSpentTodayText(providerName, todayByProvider, isFinalState) {
  const today = (todayByProvider && todayByProvider[providerName]) || null;
  if (today && Number.isFinite(today.costUsd)) {
    return formatUsd(today.costUsd);
  }

  return isFinalState ? formatUsd(0) : "Loading...";
}

function formatExpirationText(expirationDate, fallbackText, todayDate) {
  if (!expirationDate) {
    return fallbackText || "N/A";
  }

  const referenceDate = typeof todayDate === "string" ? todayDate : getTodayDate();
  const expirationValue = Date.parse(`${expirationDate}T00:00:00Z`);
  const referenceValue = Date.parse(`${referenceDate}T00:00:00Z`);

  if (!Number.isFinite(expirationValue) || !Number.isFinite(referenceValue)) {
    return expirationDate;
  }

  const dayMs = 24 * 60 * 60 * 1000;
  const daysLeft = Math.round((expirationValue - referenceValue) / dayMs);
  const label = Math.abs(daysLeft) === 1 ? "day" : "days";
  return `${expirationDate} (${daysLeft} ${label} left)`;
}

function parseStreamPayload(event) {
  return JSON.parse(event.data);
}

function createProviderRefreshButton(providerName, isFinalState) {
  const isRefreshing = refreshingProviders.has(providerName);
  const button = document.createElement("button");
  button.type = "button";
  button.className = "provider-refresh";
  button.disabled = !isFinalState || isRefreshing;
  button.setAttribute("aria-label", `Refresh ${providerName} only`);
  button.setAttribute("aria-busy", String(isRefreshing));
  button.title = isRefreshing
    ? `Refreshing ${providerName}...`
    : `Refresh ${providerName} only`;

  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("aria-hidden", "true");
  icon.setAttribute("class", "provider-refresh-icon");

  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute(
    "d",
    "M12 5a7 7 0 1 0 6.52 9.54h-2.13A5 5 0 1 1 12 7c1.3 0 2.48.5 3.37 1.32L13 10.7h6V5.2l-2.21 2.21A8.96 8.96 0 0 0 12 5Z"
  );
  path.setAttribute("fill", "currentColor");

  icon.append(path);
  button.append(icon);
  button.addEventListener("click", () => {
    refreshProvider(providerName);
  });
  return button;
}

// Subscription providers are metered by rate-limit windows instead of balance,
// so they render as meters in their own panel rather than as spend cards.
function isSubscriptionEntry(entry) {
  if (!entry) {
    return false;
  }

  if (entry.meta?.kind === "subscription" || entry.kind === "subscription") {
    return true;
  }

  return subscriptionProviderIds.has(entry.provider);
}

function formatPercent(value) {
  const percent = toSafeNumber(value);
  return Number.isInteger(percent) ? String(percent) : percent.toFixed(1);
}

function formatResetTime(resetsAt) {
  if (!resetsAt) {
    return null;
  }

  const resetValue = Date.parse(resetsAt);
  if (!Number.isFinite(resetValue)) {
    return null;
  }

  const remainingMs = resetValue - Date.now();
  if (remainingMs <= 0) {
    return "resetting now";
  }

  const resetDate = new Date(resetValue);
  const clock = resetDate.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  const remainingHours = remainingMs / 3600000;

  if (remainingHours < 24) {
    const countdown =
      remainingHours < 1 ? `${Math.max(1, Math.round(remainingMs / 60000))}m` : `${Math.round(remainingHours)}h`;
    return `resets ${clock} (${countdown})`;
  }

  const day = resetDate.toLocaleDateString([], { month: "short", day: "numeric" });
  return `resets ${day} ${clock} (${Math.round(remainingHours / 24)}d)`;
}

function createMeter(meter) {
  const row = document.createElement("div");
  row.className = meter.isActive ? "meter meter-active" : "meter";

  const head = document.createElement("div");
  head.className = "meter-head";

  const label = document.createElement("span");
  label.className = "meter-label";
  label.textContent = meter.label;

  const value = document.createElement("span");
  value.className = `meter-value severity-${meter.severity || "normal"}`;
  value.textContent = `${formatPercent(meter.usedPercent)}%`;

  head.append(label, value);

  const track = document.createElement("div");
  track.className = "meter-track";
  track.setAttribute("role", "progressbar");
  track.setAttribute("aria-valuemin", "0");
  track.setAttribute("aria-valuemax", "100");
  track.setAttribute("aria-valuenow", formatPercent(meter.usedPercent));
  track.setAttribute("aria-label", `${meter.label} used`);

  const fill = document.createElement("div");
  fill.className = `meter-fill severity-${meter.severity || "normal"}`;
  fill.style.width = `${Math.min(100, Math.max(0, toSafeNumber(meter.usedPercent)))}%`;
  track.append(fill);

  row.append(head, track);

  const footParts = [];
  if (meter.detail) {
    footParts.push(meter.detail);
  }

  const resetText = formatResetTime(meter.resetsAt);
  if (resetText) {
    footParts.push(resetText);
  }

  if (footParts.length > 0) {
    const foot = document.createElement("p");
    foot.className = "meter-foot";
    foot.textContent = footParts.join(" · ");
    row.append(foot);
  }

  return row;
}

function createSubscriptionHeader(displayName, providerName, dashboardUrl, planLabel, isFinalState) {
  const header = document.createElement("div");
  header.className = "subscription-header";

  const trailing = document.createElement("div");
  trailing.className = "subscription-header-trailing";

  if (planLabel) {
    const plan = document.createElement("span");
    plan.className = "plan-pill";
    plan.textContent = planLabel;
    trailing.append(plan);
  }

  trailing.append(createProviderRefreshButton(providerName, isFinalState));
  header.append(createProviderHeading(displayName, dashboardUrl), trailing);
  return header;
}

function renderSubscriptions(providers, errors, isFinalState, expectedCount) {
  subscriptionsContainer.innerHTML = "";

  const finishedCount = providers.length + errors.length;
  if (expectedCount === 0 && finishedCount === 0) {
    subscriptionsPanel.hidden = true;
    subscriptionStatus.textContent = "";
    return;
  }

  subscriptionsPanel.hidden = false;

  // Wide cards (meta.layout === "wide") span the grid and sit on top, so their
  // position is stable no matter which provider answers first on the stream.
  const ordered = [...providers].sort(
    (a, b) => (a.meta?.layout === "wide" ? 0 : 1) - (b.meta?.layout === "wide" ? 0 : 1)
  );

  for (const provider of ordered) {
    const item = document.createElement("article");
    item.className = provider.meta?.layout === "wide" ? "subscription-item subscription-item-wide" : "subscription-item";

    const meta = provider.meta || {};
    const account = provider.account || {};

    item.append(
      createSubscriptionHeader(
        meta.displayName || provider.provider,
        provider.provider,
        meta.dashboardUrl,
        account.planLabel,
        isFinalState
      )
    );

    const meters = document.createElement("div");
    meters.className = "meters";

    for (const meter of provider.meters || []) {
      meters.append(createMeter(meter));
    }

    // Informational only: a flat-rate plan bills nothing per token, so this is
    // what the same work would have cost at API prices.
    if (Number.isFinite(meta.costUsd)) {
      const cost = document.createElement("p");
      cost.className = "subscription-cost";

      const value = document.createElement("span");
      value.className = "subscription-cost-value";
      value.textContent = formatUsd(meta.costUsd);

      const note = document.createElement("span");
      const sessions = meta.costSessionCount;
      const days = meta.costWindowDays;
      note.textContent =
        " at API rates" +
        (Number.isFinite(sessions) ? ` · ${sessions} session${sessions === 1 ? "" : "s"}` : "") +
        (Number.isFinite(days) ? ` active in ${days}d` : "");

      cost.append(value, note);
      cost.title = "What this usage would have cost at API prices. A subscription bills a flat rate, so it is not money spent.";
      meters.append(cost);
    }

    if ((provider.meters || []).length === 0) {
      const empty = document.createElement("p");
      empty.className = "provider-meta";
      empty.textContent = "No rate-limit windows reported.";
      meters.append(empty);
    }

    item.append(meters);
    subscriptionsContainer.append(item);
  }

  for (const error of errors) {
    const item = document.createElement("article");
    item.className = "subscription-item";

    item.append(createSubscriptionHeader(error.provider, error.provider, error.dashboardUrl, null, isFinalState));

    const details = document.createElement("p");
    details.className = "provider-meta status-error";
    details.textContent = error.message;
    item.append(details);

    subscriptionsContainer.append(item);
  }

  if (!isFinalState && expectedCount > finishedCount) {
    subscriptionStatus.textContent = `${finishedCount} of ${expectedCount} loaded`;
  } else {
    subscriptionStatus.textContent = `${providers.length} ok, ${errors.length} failed`;
  }

  if (finishedCount === 0 && !isFinalState) {
    const waiting = document.createElement("p");
    waiting.className = "hint";
    waiting.textContent = "Reading subscription limits...";
    subscriptionsContainer.append(waiting);
  }
}

function renderProviders(data) {
  providersContainer.innerHTML = "";

  const isFinalState = data.streamComplete !== false;
  const allProviders = data.providers || [];
  const allErrors = data.providerErrors || [];

  const subscriptionProviders = allProviders.filter(isSubscriptionEntry);
  const subscriptionErrors = allErrors.filter(isSubscriptionEntry);
  const apiProviders = allProviders.filter((entry) => !isSubscriptionEntry(entry));
  const apiErrors = allErrors.filter((entry) => !isSubscriptionEntry(entry));

  const expectedSubscriptionCount = Number.isFinite(data.expectedSubscriptionCount)
    ? data.expectedSubscriptionCount
    : subscriptionProviders.length + subscriptionErrors.length;

  renderSubscriptions(subscriptionProviders, subscriptionErrors, isFinalState, expectedSubscriptionCount);

  const totalExpected = Number.isFinite(data.expectedProviderCount)
    ? data.expectedProviderCount
    : allProviders.length + allErrors.length;
  const expectedProviderCount = Math.max(0, totalExpected - expectedSubscriptionCount);

  for (const provider of apiProviders) {
    const item = document.createElement("article");
    item.className = "provider-item";

    const account = provider.account || {};
    const meta = provider.meta || {};
    const name = createProviderHeading(provider.provider, meta.dashboardUrl);
    const refreshControl = createProviderRefreshButton(provider.provider, isFinalState);
    const header = document.createElement("div");
    header.className = "provider-header";
    header.append(name, refreshControl);
    const balance = Number.isFinite(account.balanceRemainingUsd)
      ? formatUsd(account.balanceRemainingUsd)
      : account.balanceRemainingText || "N/A";
    const spentToday = getSpentTodayText(provider.provider, data.todayByProvider, isFinalState);
    const expires = formatExpirationText(account.balanceExpirationDate, account.balanceExpirationText, data.todayDate);

    const ok = document.createElement("p");
    ok.className = "provider-meta status-ok";
    ok.textContent = `OK  ${balance}`;

    const totalTokens = formatInt(provider.totals.totalTokens);
    const totalQueries = meta.supportsQueryCount === false ? "Not exposed" : formatInt(provider.totals.queryCount);

    const usageEntries = [
      `Total tokens: ${totalTokens}`,
      `Total queries: ${totalQueries}`,
    ];

    const balanceEntries = [
      `Balance spent today: ${spentToday}`,
      `Balance expiration day: ${expires}`,
    ];

    const subcards = document.createElement("div");
    subcards.className = "provider-subcards";

    const usageCard = document.createElement("section");
    usageCard.className = "provider-subcard";

    const usageTitle = document.createElement("p");
    usageTitle.className = "provider-meta provider-subcard-title";
    usageTitle.textContent = "Usage";

    const usageList = document.createElement("ul");
    usageList.className = "provider-facts";

    for (const text of usageEntries) {
      const entry = document.createElement("li");
      entry.textContent = text;
      usageList.append(entry);
    }

    usageCard.append(usageTitle, usageList);

    const balanceCard = document.createElement("section");
    balanceCard.className = "provider-subcard";

    const balanceTitle = document.createElement("p");
    balanceTitle.className = "provider-meta provider-subcard-title";
    balanceTitle.textContent = "Balance";

    const balanceList = document.createElement("ul");
    balanceList.className = "provider-facts";

    for (const text of balanceEntries) {
      const entry = document.createElement("li");
      entry.textContent = text;
      balanceList.append(entry);
    }

    balanceCard.append(balanceTitle, balanceList);

    subcards.append(usageCard, balanceCard);

    item.append(header, ok, subcards);
    providersContainer.append(item);
  }

  for (const error of apiErrors) {
    const item = document.createElement("article");
    item.className = "provider-item";

    const name = createProviderHeading(error.provider, error.dashboardUrl);
    const refreshControl = createProviderRefreshButton(error.provider, isFinalState);
    const header = document.createElement("div");
    header.className = "provider-header";
    header.append(name, refreshControl);

    const failed = document.createElement("p");
    failed.className = "provider-meta status-error";
    failed.textContent = "Error";

    const details = document.createElement("p");
    details.className = "provider-meta status-error";
    details.textContent = error.message;

    item.append(header, failed, details);
    providersContainer.append(item);
  }

  const successCount = apiProviders.length;
  const errorCount = apiErrors.length;
  const finishedCount = successCount + errorCount;

  if (!isFinalState && expectedProviderCount > 0) {
    providerStatus.textContent = `${finishedCount} of ${expectedProviderCount} provider(s) finished: ${successCount} ok, ${errorCount} failed`;
  } else {
    providerStatus.textContent = `${successCount} provider(s) ok, ${errorCount} provider(s) failed`;
  }

  if (finishedCount === 0 && expectedProviderCount > 0 && !isFinalState) {
    const waiting = document.createElement("p");
    waiting.className = "hint";
    waiting.textContent = "Waiting for the first provider result...";
    providersContainer.append(waiting);
  }
}

function getProviderDashboardUrl(providerName) {
  const providerEntry = currentDashboardState?.providers?.find((item) => item.provider === providerName);
  if (providerEntry?.meta?.dashboardUrl) {
    return providerEntry.meta.dashboardUrl;
  }

  const errorEntry = currentDashboardState?.providerErrors?.find((item) => item.provider === providerName);
  return errorEntry?.dashboardUrl || null;
}

async function refreshProvider(providerName) {
  if (!currentDashboardState) {
    return;
  }

  if (activeUsageStream) {
    showMessage("info", "Wait for the full dashboard refresh to finish before refreshing one provider.");
    return;
  }

  if (refreshingProviders.has(providerName)) {
    return;
  }

  refreshingProviders.add(providerName);
  renderProviders(currentDashboardState);

  try {
    const params = new URLSearchParams({ provider: providerName });

    const response = await fetch(`/api/provider?${params.toString()}`);
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error || `Unable to refresh ${providerName}`);
    }

    currentDashboardState.range = payload.range || currentDashboardState.range;
    currentDashboardState.todayDate = payload.todayDate || currentDashboardState.todayDate;
    currentDashboardState.providers = Array.isArray(currentDashboardState.providers) ? currentDashboardState.providers : [];
    currentDashboardState.providerErrors = removeProviderEntry(currentDashboardState.providerErrors, providerName);
    upsertProviderEntry(currentDashboardState.providers, payload.provider);

    if (!currentDashboardState.todayByProvider || typeof currentDashboardState.todayByProvider !== "object") {
      currentDashboardState.todayByProvider = {};
    }

    if (payload.todayMetric) {
      currentDashboardState.todayByProvider[providerName] = payload.todayMetric;
    } else if (!payload.todayMetricError) {
      delete currentDashboardState.todayByProvider[providerName];
    }

    recalculateDashboardState(currentDashboardState);
    renderDashboardState(currentDashboardState);
  } catch (error) {
    const hasLiveProvider = currentDashboardState.providers?.some((item) => item.provider === providerName);
    if (!hasLiveProvider) {
      upsertProviderEntry(currentDashboardState.providerErrors, {
        provider: providerName,
        message: error.message || String(error),
        dashboardUrl: getProviderDashboardUrl(providerName),
      });
      renderProviders(currentDashboardState);
    }

    showMessage("error", error.message || String(error));
  } finally {
    refreshingProviders.delete(providerName);
    renderProviders(currentDashboardState);
  }
}

async function fetchUsage(options = {}) {
  const { refreshLabel = "Updated" } = options;
  clearMessages();
  setLoading(true);
  activeUsageToken += 1;
  const requestToken = activeUsageToken;
  closeUsageStream();
  resetDashboardForLoading();

  try {
    const payload = await new Promise((resolve, reject) => {
      const state = {
        providers: [],
        providerErrors: [],
        todayByProvider: {},
        expectedProviderCount: 0,
        expectedSubscriptionCount: subscriptionProviderIds.size,
        streamComplete: false,
      };
      const stream = new EventSource("/api/usage/stream");
      let settled = false;

      activeUsageStream = stream;

      function isStale() {
        return requestToken !== activeUsageToken;
      }

      function cleanup() {
        if (settled) {
          return;
        }

        settled = true;
        stream.close();
        if (activeUsageStream === stream) {
          activeUsageStream = null;
        }
      }

      stream.addEventListener("start", (event) => {
        if (settled || isStale()) {
          return;
        }

        const payload = parseStreamPayload(event);
        state.expectedProviderCount = Array.isArray(payload.providers) ? payload.providers.length : 0;

        subscriptionProviderIds.clear();
        for (const providerId of payload.subscriptionProviders || []) {
          subscriptionProviderIds.add(providerId);
        }
        state.expectedSubscriptionCount = subscriptionProviderIds.size;

        renderProviders(state);
      });

      stream.addEventListener("provider", (event) => {
        if (settled || isStale()) {
          return;
        }

        const payload = parseStreamPayload(event);
        upsertProviderEntry(state.providers, payload.provider);
        if (payload.todayMetric) {
          state.todayByProvider[payload.provider.provider] = payload.todayMetric;
        }
        renderProviders(state);
      });

      stream.addEventListener("provider-error", (event) => {
        if (settled || isStale()) {
          return;
        }

        const payload = parseStreamPayload(event);
        upsertProviderEntry(state.providerErrors, payload.error);
        renderProviders(state);
      });

      stream.addEventListener("done", (event) => {
        if (settled || isStale()) {
          cleanup();
          return;
        }

        const payload = parseStreamPayload(event);
        cleanup();
        currentDashboardState = {
          ...payload,
          streamComplete: true,
          expectedProviderCount: state.expectedProviderCount,
          expectedSubscriptionCount: state.expectedSubscriptionCount,
        };
        renderDashboardState(currentDashboardState);
        resolve(currentDashboardState);
      });

      stream.addEventListener("fatal", (event) => {
        if (settled || isStale()) {
          cleanup();
          return;
        }

        const payload = parseStreamPayload(event);
        cleanup();
        reject(new Error(payload.error || "Unable to load usage"));
      });

      stream.onerror = () => {
        if (settled || isStale()) {
          cleanup();
          return;
        }

        cleanup();
        reject(new Error("Lost connection while loading usage"));
      };
    });

    showMessage("info", `${refreshLabel} ${new Date(payload.fetchedAt).toLocaleString()}`);
  } catch (error) {
    showMessage("error", error.message || String(error));
  } finally {
    if (requestToken === activeUsageToken) {
      setLoading(false);
    }
  }
}

refreshButton.addEventListener("click", () => {
  fetchUsage();
});

updateTodayLabel();
fetchUsage();
