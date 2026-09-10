const refreshButton = document.getElementById("refresh");
const todayDateLabel = document.getElementById("today-date");


const providersContainer = document.getElementById("providers");
const providerStatus = document.getElementById("provider-status");
const subscriptionsPanel = document.getElementById("subscriptions-panel");
const subscriptionsContainer = document.getElementById("subscriptions");
const subscriptionStatus = document.getElementById("subscription-status");
const messages = document.getElementById("messages");

let activeUsageStream = null;
let abortActiveUsage = null;
let activeUsageToken = 0;
let currentDashboardState = null;
let streamActive = false;
const subscriptionProviderIds = new Set();

// A card is built once per provider and then updated in place. A refresh marks
// every card pending and rewrites only the values as each provider answers, so
// the frames never leave the page and nothing reflows underneath the pointer.
const providerCards = new Map();
let providerOrder = [];

const LOADING_TEXT = "Loading...";

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

// Writing only on change keeps unchanged numbers from blinking and preserves
// any text the user has selected inside a card across a refresh.
function setText(node, text) {
  const next = text == null ? "" : String(text);
  if (node.textContent !== next) {
    node.textContent = next;
  }
}

function setClassName(node, className) {
  if (node.className !== className) {
    node.className = className;
  }
}

function setAttribute(node, name, value) {
  if (node.getAttribute(name) !== value) {
    node.setAttribute(name, value);
  }
}

function setHidden(node, hidden) {
  if (node.hidden !== hidden) {
    node.hidden = hidden;
  }
}

// Moves nodes only when the desired order differs from the current one, so a
// re-render that changes nothing touches no DOM position.
function applyOrder(container, nodes) {
  let previous = null;

  for (const node of nodes) {
    const expected = previous ? previous.nextSibling : container.firstChild;
    if (expected !== node) {
      container.insertBefore(node, expected);
    }
    previous = node;
  }
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

  setText(todayDateLabel, todayDate || getTodayDate());
}

function setLoading(isLoading) {
  setDisabledKeepingFocus(refreshButton, isLoading);
  refreshButton.setAttribute("aria-busy", String(isLoading));
}

const messageElement = document.createElement("p");
messageElement.className = "message info";
messageElement.hidden = true;
messages.append(messageElement);

// One reusable line instead of append-and-clear: the message box keeps its size
// through a refresh rather than collapsing and pushing the page around.
function setMessage(type, text) {
  if (!text) {
    setHidden(messageElement, true);
    return;
  }

  setClassName(messageElement, `message ${type}`);
  setText(messageElement, text);
  setHidden(messageElement, false);
}

function updateProviderHeading(heading, label, dashboardUrl) {
  if (!dashboardUrl) {
    const staleLink = heading.querySelector("a.provider-link");
    if (staleLink) {
      staleLink.remove();
    }

    setText(heading, label);
    return;
  }

  let link = heading.querySelector("a.provider-link");
  if (!link) {
    setText(heading, "");
    link = document.createElement("a");
    link.className = "provider-link";
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    heading.append(link);
  }

  if (link.getAttribute("href") !== dashboardUrl) {
    link.href = dashboardUrl;
  }

  const title = `Open ${label} dashboard`;
  if (link.title !== title) {
    link.title = title;
  }

  setText(link, label);
}

// Superseding a refresh has to settle the promise wrapping it, not just close
// the socket: a closed EventSource emits nothing more, so an unsettled promise
// would retain its handlers and its async frame for the life of the page.
const SUPERSEDED = Symbol("superseded refresh");

function closeUsageStream() {
  const abort = abortActiveUsage;
  abortActiveUsage = null;

  if (abort) {
    abort();
  }

  if (!activeUsageStream) {
    return;
  }

  activeUsageStream.close();
  activeUsageStream = null;
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

function createProviderRefreshButton(providerName) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "provider-refresh";
  button.setAttribute("aria-label", `Refresh ${providerName} only`);

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

// A disabled control cannot hold focus, so re-enabling one the user was on has
// to hand focus back or a keyboard user is dropped to the top of the document.
function setDisabledKeepingFocus(element, disabled) {
  if (element.disabled === disabled) {
    return;
  }

  const hadFocus = document.activeElement === element;
  element.disabled = disabled;

  if (!disabled && element.dataset.refocus === "true") {
    delete element.dataset.refocus;
    element.focus();
    return;
  }

  if (disabled && hadFocus) {
    element.dataset.refocus = "true";
  }
}

function updateCardControls(card) {
  const button = card.refreshControl;
  const isBusy = card.pending || card.refreshing;
  const name = card.displayName || card.provider;

  setDisabledKeepingFocus(button, streamActive || isBusy);
  setAttribute(button, "aria-busy", String(isBusy));
  setAttribute(button, "aria-label", isBusy ? `Refreshing ${name}` : `Refresh ${name} only`);

  const title = isBusy ? `Refreshing ${name}...` : `Refresh ${name} only`;
  if (button.title !== title) {
    button.title = title;
  }

  setAttribute(card.root, "aria-busy", String(isBusy));
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

function createMeterRow() {
  const row = document.createElement("div");
  row.className = "meter";

  const head = document.createElement("div");
  head.className = "meter-head";

  const label = document.createElement("span");
  label.className = "meter-label";

  const value = document.createElement("span");
  value.className = "meter-value severity-normal";

  head.append(label, value);

  const track = document.createElement("div");
  track.className = "meter-track";
  track.setAttribute("role", "progressbar");
  track.setAttribute("aria-valuemin", "0");
  track.setAttribute("aria-valuemax", "100");

  const fill = document.createElement("div");
  fill.className = "meter-fill severity-normal";
  fill.style.width = "0%";
  track.append(fill);

  const foot = document.createElement("p");
  foot.className = "meter-foot";
  foot.hidden = true;

  row.append(head, track, foot);
  return { row, label, value, track, fill, foot };
}

// The fill node survives the update, so the CSS width transition animates from
// the previous reading to the new one instead of snapping in as a fresh node.
function updateMeterRow(refs, meter) {
  const severity = meter.severity || "normal";
  const percentText = formatPercent(meter.usedPercent);
  const width = `${Math.min(100, Math.max(0, toSafeNumber(meter.usedPercent)))}%`;

  setClassName(refs.row, meter.isActive ? "meter meter-active" : "meter");
  setText(refs.label, meter.label);
  setText(refs.value, `${percentText}%`);
  setClassName(refs.value, `meter-value severity-${severity}`);
  setClassName(refs.fill, `meter-fill severity-${severity}`);

  if (refs.fill.style.width !== width) {
    refs.fill.style.width = width;
  }

  setAttribute(refs.track, "aria-valuenow", percentText);
  setAttribute(refs.track, "aria-label", `${meter.label} used`);

  const footParts = [];
  if (meter.detail) {
    footParts.push(meter.detail);
  }

  const resetText = formatResetTime(meter.resetsAt);
  if (resetText) {
    footParts.push(resetText);
  }

  setText(refs.foot, footParts.join(" · "));
  setHidden(refs.foot, footParts.length === 0);
}

// Rows are matched by position, not by label. A window's label moves with the
// data it reports ("Sep 9 (latest)" becomes "Sep 10 (latest)"), so keying on the
// label would retire the row and build a new one for what is the same slot.
function syncMeters(card, meters) {
  const rows = Array.isArray(meters) ? meters : [];

  while (card.meterRows.length > rows.length) {
    card.meterRows.pop().row.remove();
  }

  while (card.meterRows.length < rows.length) {
    card.meterRows.push(createMeterRow());
  }

  rows.forEach((meter, index) => {
    updateMeterRow(card.meterRows[index], meter);
  });

  applyOrder(card.meters, [...card.meterRows.map((refs) => refs.row), card.note, card.stats, card.cost]);
}

function createStatRow() {
  return {
    term: document.createElement("dt"),
    value: document.createElement("dd"),
  };
}

function syncStats(card, stats) {
  const entries = (Array.isArray(stats) ? stats : []).filter((stat) => stat && stat.label);

  while (card.statRows.length > entries.length) {
    const refs = card.statRows.pop();
    refs.term.remove();
    refs.value.remove();
  }

  while (card.statRows.length < entries.length) {
    card.statRows.push(createStatRow());
  }

  const orderedNodes = [];
  entries.forEach((stat, index) => {
    const refs = card.statRows[index];
    setText(refs.term, stat.label);
    setText(refs.value, stat.value ?? "-");
    orderedNodes.push(refs.term, refs.value);
  });

  applyOrder(card.stats, orderedNodes);
  setHidden(card.stats, orderedNodes.length === 0);
}

function createFactList(title, labels) {
  const card = document.createElement("section");
  card.className = "provider-subcard";

  const heading = document.createElement("p");
  heading.className = "provider-meta provider-subcard-title";
  heading.textContent = title;

  const list = document.createElement("ul");
  list.className = "provider-facts";

  const items = labels.map((label) => {
    const item = document.createElement("li");
    item.textContent = `${label}: ${LOADING_TEXT}`;
    list.append(item);
    return item;
  });

  card.append(heading, list);
  return { card, items };
}

function createApiCard(providerName) {
  const root = document.createElement("article");
  root.className = "provider-item";
  root.dataset.provider = providerName;

  const heading = document.createElement("h3");
  heading.textContent = providerName;

  const refreshControl = createProviderRefreshButton(providerName);

  const header = document.createElement("div");
  header.className = "provider-header";
  header.append(heading, refreshControl);

  const status = document.createElement("p");
  status.className = "provider-meta";
  status.textContent = LOADING_TEXT;

  const errorDetails = document.createElement("p");
  errorDetails.className = "provider-meta status-error";
  errorDetails.hidden = true;

  const usage = createFactList("Usage", ["Total tokens", "Total queries"]);
  const balance = createFactList("Balance", ["Balance spent today", "Balance expiration day"]);

  const subcards = document.createElement("div");
  subcards.className = "provider-subcards";
  subcards.append(usage.card, balance.card);

  root.append(header, status, errorDetails, subcards);

  return {
    provider: providerName,
    kind: "api",
    root,
    heading,
    refreshControl,
    status,
    errorDetails,
    subcards,
    usageFacts: usage.items,
    balanceFacts: balance.items,
    dashboardUrl: null,
    displayName: null,
    state: "pending",
    pending: true,
    refreshing: false,
    todayResolved: false,
  };
}

function createSubscriptionCard(providerName) {
  const root = document.createElement("article");
  root.className = "subscription-item";
  root.dataset.provider = providerName;

  const heading = document.createElement("h3");
  heading.textContent = providerName;

  const plan = document.createElement("span");
  plan.className = "plan-pill";
  plan.hidden = true;

  const refreshControl = createProviderRefreshButton(providerName);

  const trailing = document.createElement("div");
  trailing.className = "subscription-header-trailing";
  trailing.append(plan, refreshControl);

  const header = document.createElement("div");
  header.className = "subscription-header";
  header.append(heading, trailing);

  const meters = document.createElement("div");
  meters.className = "meters";

  const note = document.createElement("p");
  note.className = "provider-meta";
  note.textContent = "Reading subscription limits...";

  const stats = document.createElement("dl");
  stats.className = "provider-stats";
  stats.hidden = true;

  // Informational only: a flat-rate plan bills nothing per token, so this is
  // what the same work would have cost at API prices.
  const cost = document.createElement("p");
  cost.className = "subscription-cost";
  cost.hidden = true;
  cost.title =
    "What this usage would have cost at API prices. A subscription bills a flat rate, so it is not money spent.";

  const costValue = document.createElement("span");
  costValue.className = "subscription-cost-value";

  const costNote = document.createElement("span");
  cost.append(costValue, costNote);

  meters.append(note, stats, cost);

  const errorDetails = document.createElement("p");
  errorDetails.className = "provider-meta status-error";
  errorDetails.hidden = true;

  root.append(header, meters, errorDetails);

  return {
    provider: providerName,
    kind: "subscription",
    root,
    heading,
    plan,
    refreshControl,
    meters,
    note,
    stats,
    cost,
    costValue,
    costNote,
    errorDetails,
    meterRows: [],
    statRows: [],
    layout: null,
    dashboardUrl: null,
    displayName: null,
    state: "pending",
    pending: true,
    refreshing: false,
  };
}

function ensureCard(providerName, kind) {
  const existing = providerCards.get(providerName);
  if (existing && existing.kind === kind) {
    return existing;
  }

  if (existing) {
    existing.root.remove();
  }

  const card = kind === "subscription" ? createSubscriptionCard(providerName) : createApiCard(providerName);
  providerCards.set(providerName, card);
  updateCardControls(card);
  return card;
}

// The roster from the `start` event is keyed by the server's providerId, which
// a result echoes back as meta.sourceProviderId. A provider whose own id is
// overridden (X_PROVIDER_ID) reports a different `provider`, so keying off that
// would open a second card and orphan the one the roster placed.
function providerKey(entry) {
  return entry?.meta?.sourceProviderId || entry?.provider;
}

function isSubscriptionProvider(providerName, entry) {
  if (entry && (entry.meta?.kind === "subscription" || entry.kind === "subscription")) {
    return true;
  }

  return subscriptionProviderIds.has(providerName);
}

// Wide cards (meta.layout === "wide") span the grid and sit on top, so their
// position is stable no matter which provider answers first on the stream. The
// remembered layout means a refresh never re-sorts an already placed card.
function placeCards() {
  const apiNodes = [];
  const subscriptionCards = [];

  for (const providerName of providerOrder) {
    const card = providerCards.get(providerName);
    if (!card) {
      continue;
    }

    if (card.kind === "subscription") {
      subscriptionCards.push(card);
    } else {
      apiNodes.push(card.root);
    }
  }

  subscriptionCards.sort((a, b) => (a.layout === "wide" ? 0 : 1) - (b.layout === "wide" ? 0 : 1));

  applyOrder(providersContainer, apiNodes);
  applyOrder(subscriptionsContainer, subscriptionCards.map((card) => card.root));
  setHidden(subscriptionsPanel, subscriptionCards.length === 0);
}

function syncProviderRoster(orderedIds) {
  providerOrder = orderedIds.slice();

  const known = new Set(providerOrder);
  for (const [providerName, card] of providerCards) {
    if (!known.has(providerName)) {
      card.root.remove();
      providerCards.delete(providerName);
    }
  }

  for (const providerName of providerOrder) {
    ensureCard(providerName, subscriptionProviderIds.has(providerName) ? "subscription" : "api");
  }

  placeCards();
}

function markAllPending() {
  for (const card of providerCards.values()) {
    card.pending = true;
    card.todayResolved = false;
    updateCardControls(card);
  }
}

// A stream that dies before `done` never runs the final pass, so a card that
// answered would sit with this refresh's balance beside the previous refresh's
// spend. Settling it the way `done` would keeps one card on one reading. Cards
// that never answered are left whole, still showing the reading they had.
function settleTodayMetrics() {
  for (const card of providerCards.values()) {
    if (card.kind === "api" && !card.pending && card.state === "ok" && !card.todayResolved) {
      setText(card.balanceFacts[0], `Balance spent today: ${formatUsd(0)}`);
      card.todayResolved = true;
    }
  }
}

function resolveSpentTodayText(providerName, todayByProvider, isFinalState) {
  const today = (todayByProvider && todayByProvider[providerName]) || null;
  if (today && Number.isFinite(today.costUsd)) {
    return formatUsd(today.costUsd);
  }

  // Mid-stream the metric may simply not have arrived, so the card keeps the
  // reading it already shows instead of flashing a placeholder zero.
  return isFinalState ? formatUsd(0) : null;
}

function applyApiResult(card, providerResult, todayByProvider, todayDate, isFinalState) {
  const account = providerResult.account || {};
  const meta = providerResult.meta || {};
  const totals = providerResult.totals || {};

  card.dashboardUrl = meta.dashboardUrl || card.dashboardUrl;
  updateProviderHeading(card.heading, providerResult.provider, card.dashboardUrl);

  const balance = Number.isFinite(account.balanceRemainingUsd)
    ? formatUsd(account.balanceRemainingUsd)
    : account.balanceRemainingText || "N/A";

  setClassName(card.status, "provider-meta status-ok");
  setText(card.status, `OK  ${balance}`);
  setHidden(card.errorDetails, true);
  setHidden(card.subcards, false);

  const totalQueries = meta.supportsQueryCount === false ? "Not exposed" : formatInt(totals.queryCount);
  setText(card.usageFacts[0], `Total tokens: ${formatInt(totals.totalTokens)}`);
  setText(card.usageFacts[1], `Total queries: ${totalQueries}`);

  const spentToday = resolveSpentTodayText(providerResult.provider, todayByProvider, isFinalState);
  if (spentToday !== null) {
    setText(card.balanceFacts[0], `Balance spent today: ${spentToday}`);
    card.todayResolved = true;
  }

  const expires = formatExpirationText(account.balanceExpirationDate, account.balanceExpirationText, todayDate);
  setText(card.balanceFacts[1], `Balance expiration day: ${expires}`);

  card.state = "ok";
}

function applyApiError(card, error) {
  card.dashboardUrl = error.dashboardUrl || card.dashboardUrl;
  updateProviderHeading(card.heading, error.provider, card.dashboardUrl);

  setClassName(card.status, "provider-meta status-error");
  setText(card.status, "Error");
  setText(card.errorDetails, error.message);
  setHidden(card.errorDetails, false);
  setHidden(card.subcards, true);

  card.state = "error";
}

function applySubscriptionResult(card, providerResult) {
  const meta = providerResult.meta || {};
  const account = providerResult.account || {};

  card.dashboardUrl = meta.dashboardUrl || card.dashboardUrl;
  card.displayName = meta.displayName || providerResult.provider;
  updateProviderHeading(card.heading, card.displayName, card.dashboardUrl);

  if (account.planLabel) {
    setText(card.plan, account.planLabel);
    setHidden(card.plan, false);
  } else {
    setHidden(card.plan, true);
  }

  setHidden(card.meters, false);
  setHidden(card.errorDetails, true);

  syncMeters(card, providerResult.meters);
  syncStats(card, meta.stats);

  const hasMeters = (providerResult.meters || []).length > 0;
  setText(card.note, "No rate-limit windows reported.");
  setHidden(card.note, hasMeters);

  if (Number.isFinite(meta.costUsd)) {
    const sessions = meta.costSessionCount;
    const days = meta.costWindowDays;

    setText(card.costValue, formatUsd(meta.costUsd));
    setText(
      card.costNote,
      " at API rates" +
        (Number.isFinite(sessions) ? ` · ${sessions} session${sessions === 1 ? "" : "s"}` : "") +
        (Number.isFinite(days) ? ` active in ${days}d` : "")
    );
    setHidden(card.cost, false);
  } else {
    setHidden(card.cost, true);
  }

  const nextLayout = meta.layout === "wide" ? "wide" : null;
  if (card.layout !== nextLayout) {
    card.layout = nextLayout;
    setClassName(card.root, nextLayout === "wide" ? "subscription-item subscription-item-wide" : "subscription-item");
    placeCards();
  }

  card.state = "ok";
}

function applySubscriptionError(card, error) {
  card.dashboardUrl = error.dashboardUrl || card.dashboardUrl;
  updateProviderHeading(card.heading, card.displayName || error.provider, card.dashboardUrl);

  setHidden(card.plan, true);
  setHidden(card.meters, true);
  setText(card.errorDetails, error.message);
  setHidden(card.errorDetails, false);

  card.state = "error";
}

function applyProviderResult(providerResult, todayByProvider, todayDate, isFinalState) {
  const key = providerKey(providerResult);
  const card = registerProvider(key, isSubscriptionProvider(key, providerResult) ? "subscription" : "api");

  if (card.kind === "subscription") {
    applySubscriptionResult(card, providerResult);
  } else {
    applyApiResult(card, providerResult, todayByProvider, todayDate, isFinalState);
  }

  card.pending = false;
  updateCardControls(card);
  return card;
}

function applyProviderError(error, isSubscription) {
  const card = registerProvider(providerKey(error), isSubscription ? "subscription" : "api");

  if (card.kind === "subscription") {
    applySubscriptionError(card, error);
  } else {
    applyApiError(card, error);
  }

  card.pending = false;
  updateCardControls(card);
  return card;
}

// The single way a card is obtained. It also covers the case where a provider
// arrives with a kind the roster did not announce, which replaces the card and
// so has to put the new one back into its container.
function registerProvider(providerName, kind) {
  const existing = providerCards.get(providerName);
  const placed = existing && existing.kind === kind && providerOrder.includes(providerName);

  if (!providerOrder.includes(providerName)) {
    providerOrder.push(providerName);
  }

  const card = ensureCard(providerName, kind);
  if (!placed) {
    placeCards();
  }

  return card;
}

function updateStatusText(isFinalState) {
  const counts = {
    api: { total: 0, finished: 0, ok: 0, failed: 0 },
    subscription: { total: 0, finished: 0, ok: 0, failed: 0 },
  };

  for (const card of providerCards.values()) {
    const bucket = counts[card.kind];
    bucket.total += 1;

    if (card.pending) {
      continue;
    }

    bucket.finished += 1;
    if (card.state === "error") {
      bucket.failed += 1;
    } else if (card.state === "ok") {
      bucket.ok += 1;
    }
  }

  const api = counts.api;
  if (!isFinalState && api.total > 0 && api.finished < api.total) {
    setText(
      providerStatus,
      `${api.finished} of ${api.total} provider(s) finished: ${api.ok} ok, ${api.failed} failed`
    );
  } else {
    setText(providerStatus, `${api.ok} provider(s) ok, ${api.failed} provider(s) failed`);
  }

  const subscription = counts.subscription;
  if (subscription.total === 0) {
    setText(subscriptionStatus, "");
  } else if (!isFinalState && subscription.finished < subscription.total) {
    setText(subscriptionStatus, `${subscription.finished} of ${subscription.total} loaded`);
  } else {
    setText(subscriptionStatus, `${subscription.ok} ok, ${subscription.failed} failed`);
  }
}

function renderDashboardState(state) {
  if (!state) {
    return;
  }

  updateTodayLabel(state.todayDate);

  const providers = Array.isArray(state.providers) ? state.providers : [];
  const errors = Array.isArray(state.providerErrors) ? state.providerErrors : [];

  for (const providerResult of providers) {
    applyProviderResult(providerResult, state.todayByProvider, state.todayDate, true);
  }

  for (const error of errors) {
    applyProviderError(error, isSubscriptionProvider(providerKey(error), error));
  }

  updateStatusText(true);
}

function getProviderDashboardUrl(providerName) {
  const card = providerCards.get(providerName);
  return card?.dashboardUrl || null;
}

async function refreshProvider(providerName) {
  if (streamActive) {
    setMessage("info", "Wait for the full dashboard refresh to finish before refreshing one provider.");
    return;
  }

  const card = providerCards.get(providerName);
  if (!card || card.refreshing) {
    return;
  }

  const requestToken = activeUsageToken;
  card.refreshing = true;
  updateCardControls(card);

  try {
    const params = new URLSearchParams({ provider: providerName });

    const response = await fetch(`/api/provider?${params.toString()}`);
    const payload = await response.json();

    // A full refresh started while this was in flight, so its data is newer.
    // Painting this older snapshot over it would leave the card silently stale.
    if (requestToken !== activeUsageToken) {
      return;
    }

    if (!response.ok) {
      throw new Error(payload.error || `Unable to refresh ${providerName}`);
    }

    if (currentDashboardState) {
      currentDashboardState.range = payload.range || currentDashboardState.range;
      currentDashboardState.todayDate = payload.todayDate || currentDashboardState.todayDate;
      currentDashboardState.providers = Array.isArray(currentDashboardState.providers)
        ? currentDashboardState.providers.filter((item) => item.provider !== providerName)
        : [];
      currentDashboardState.providers.push(payload.provider);
      currentDashboardState.providerErrors = (currentDashboardState.providerErrors || []).filter(
        (item) => item.provider !== providerName
      );

      if (!currentDashboardState.todayByProvider || typeof currentDashboardState.todayByProvider !== "object") {
        currentDashboardState.todayByProvider = {};
      }

      // The server keys this map by the provider's own reported name, which is
      // not the registry id the card is keyed by when *_PROVIDER_ID overrides it.
      const metricKey = payload.provider?.provider || providerName;
      if (payload.todayMetric) {
        currentDashboardState.todayByProvider[metricKey] = payload.todayMetric;
      } else if (!payload.todayMetricError) {
        delete currentDashboardState.todayByProvider[metricKey];
      }

      currentDashboardState.fetchedAt = payload.fetchedAt || currentDashboardState.fetchedAt;
    }

    // Read back from the merged map, which keeps the previous reading when the
    // today fetch itself failed, rather than reporting a zero that never was.
    const todayByProvider =
      currentDashboardState?.todayByProvider ||
      (payload.todayMetric ? { [payload.provider?.provider || providerName]: payload.todayMetric } : {});
    updateTodayLabel(payload.todayDate);
    applyProviderResult(payload.provider, todayByProvider, payload.todayDate, true);
  } catch (error) {
    const message = error.message || String(error);
    if (card.state !== "ok") {
      applyProviderError(
        { provider: providerName, message, dashboardUrl: getProviderDashboardUrl(providerName) },
        card.kind === "subscription"
      );
    }

    setMessage("error", message);
  } finally {
    card.refreshing = false;
    updateCardControls(card);
    if (!streamActive) {
      updateStatusText(true);
    }
  }
}

// The server emits one event per announced provider, but a dropped connection
// can end a stream with cards that were never answered. Leaving those on
// "Loading..." reads as still-working and makes the counts fail to add up.
function settleSilentCards(message) {
  for (const card of [...providerCards.values()]) {
    if (card.state === "pending") {
      applyProviderError(
        { provider: card.provider, message, dashboardUrl: card.dashboardUrl },
        card.kind === "subscription"
      );
    }
  }
}

async function fetchUsage(options = {}) {
  const { refreshLabel = "Updated" } = options;
  setLoading(true);
  activeUsageToken += 1;
  const requestToken = activeUsageToken;
  closeUsageStream();

  streamActive = true;
  markAllPending();
  updateStatusText(false);
  setMessage("info", "Refreshing usage...");

  if (providerCards.size === 0) {
    setText(providerStatus, "Preparing provider requests...");
  }

  try {
    const payload = await new Promise((resolve, reject) => {
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

      abortActiveUsage = () => {
        cleanup();
        reject(SUPERSEDED);
      };

      // A throw inside a listener escapes into EventSource dispatch, where it
      // would leave the promise unsettled and the whole dashboard wedged with a
      // dead Refresh button. Rejecting instead surfaces it and unwinds cleanly.
      function onEvent(name, handle) {
        stream.addEventListener(name, (event) => {
          if (settled || isStale()) {
            return;
          }

          try {
            handle(event);
          } catch (error) {
            cleanup();
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        });
      }

      onEvent("start", (event) => {
        const startPayload = parseStreamPayload(event);

        subscriptionProviderIds.clear();
        for (const providerId of startPayload.subscriptionProviders || []) {
          subscriptionProviderIds.add(providerId);
        }

        updateTodayLabel(startPayload.todayDate);
        syncProviderRoster(Array.isArray(startPayload.providers) ? startPayload.providers : []);
        markAllPending();
        updateStatusText(false);
      });

      onEvent("provider", (event) => {
        const providerPayload = parseStreamPayload(event);
        const todayByProvider = providerPayload.todayMetric
          ? { [providerPayload.provider.provider]: providerPayload.todayMetric }
          : {};

        applyProviderResult(providerPayload.provider, todayByProvider, undefined, false);
        updateStatusText(false);
      });

      onEvent("provider-error", (event) => {
        const errorPayload = parseStreamPayload(event);
        applyProviderError(errorPayload.error, isSubscriptionProvider(providerKey(errorPayload.error), errorPayload.error));
        updateStatusText(false);
      });

      onEvent("done", (event) => {
        const donePayload = parseStreamPayload(event);
        cleanup();
        streamActive = false;
        currentDashboardState = { ...donePayload, streamComplete: true };
        renderDashboardState(currentDashboardState);
        resolve(currentDashboardState);
      });

      onEvent("fatal", (event) => {
        const fatalPayload = parseStreamPayload(event);
        cleanup();
        reject(new Error(fatalPayload.error || "Unable to load usage"));
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

    setMessage("info", `${refreshLabel} ${new Date(payload.fetchedAt).toLocaleString()}`);
  } catch (error) {
    if (error !== SUPERSEDED) {
      setMessage("error", error.message || String(error));
    }
  } finally {
    if (requestToken === activeUsageToken) {
      streamActive = false;
      abortActiveUsage = null;
      settleSilentCards("No result reported before the refresh ended.");
      settleTodayMetrics();
      for (const card of providerCards.values()) {
        card.pending = false;
        updateCardControls(card);
      }

      updateStatusText(true);
      setLoading(false);
    }
  }
}

refreshButton.addEventListener("click", () => {
  fetchUsage();
});

updateTodayLabel();
fetchUsage();
