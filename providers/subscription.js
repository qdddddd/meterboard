const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { toNumber } = require("./utils");

// Subscription providers are metered by rate-limit windows, not by balance, so
// they contribute nothing to the token/cost/balance aggregates. The dashboard
// keys off meta.kind to render them as meters instead of spend cards.
const EMPTY_TOTALS = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  queryCount: 0,
  costUsd: 0,
});

function expandHome(filePath) {
  if (!filePath) {
    return null;
  }
  if (filePath === "~") {
    return os.homedir();
  }
  if (filePath.startsWith("~/")) {
    return path.join(os.homedir(), filePath.slice(2));
  }
  return path.resolve(filePath);
}

function readJsonFile(filePath) {
  const resolved = expandHome(filePath);
  if (!resolved || !fs.existsSync(resolved)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(resolved, "utf8"));
  } catch (error) {
    throw new Error(`Could not parse ${resolved}: ${error.message}`);
  }
}

// Snapshot-backed meters stamp when their numbers were captured. Shanghai time
// matches the rest of the dashboard, which reports days in that zone.
function formatCaptureTime(isoTimestamp) {
  const captured = Date.parse(isoTimestamp);
  if (!Number.isFinite(captured)) {
    return "unknown time";
  }

  return new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })
    .format(new Date(captured))
    .replace(",", "");
}

// A cached percentage describes the window that was open when it was captured.
// Once that window's reset has passed the number is about a window that no
// longer exists, so report it as reset instead of as current usage.
function stampCapturedMeters(meters, capturedAt) {
  const capturedLabel = formatCaptureTime(capturedAt);

  return meters.map((meter) => {
    const rolledOver = Boolean(meter.resetsAt) && Date.parse(meter.resetsAt) <= Date.now();
    if (rolledOver) {
      return {
        ...meter,
        usedPercent: 0,
        severity: "normal",
        resetsAt: null,
        detail: `window reset since ${capturedLabel}`,
      };
    }

    return {
      ...meter,
      detail: meter.detail ? `${meter.detail} · as of ${capturedLabel}` : `as of ${capturedLabel}`,
    };
  });
}

function severityFromPercent(percent, reported) {
  if (typeof reported === "string" && reported && reported !== "normal") {
    return reported;
  }
  if (percent >= 90) {
    return "critical";
  }
  if (percent >= 75) {
    return "warning";
  }
  return "normal";
}

function clampPercent(value) {
  const percent = toNumber(value);
  if (!Number.isFinite(percent) || percent < 0) {
    return 0;
  }
  return Math.min(100, Math.round(percent * 10) / 10);
}

function buildMeter({ id, label, percent, resetsAt, severity, detail, isActive }) {
  const usedPercent = clampPercent(percent);
  return {
    id,
    label,
    usedPercent,
    resetsAt: resetsAt || null,
    severity: severityFromPercent(usedPercent, severity),
    detail: detail || null,
    isActive: Boolean(isActive),
  };
}

function subscriptionResult({ providerId, planLabel, meters, extra = {} }) {
  return {
    provider: providerId,
    totals: { ...EMPTY_TOTALS },
    daily: [],
    todayDaily: null,
    account: {
      balanceRemainingUsd: null,
      balanceExpirationDate: null,
      balanceRemainingText: planLabel || "Subscription",
      balanceExpirationText: "Subscription",
      planLabel: planLabel || null,
    },
    meters,
    meta: {
      kind: "subscription",
      supportsTokenBreakdown: false,
      supportsQueryCount: false,
      ...extra,
    },
  };
}

module.exports = {
  EMPTY_TOTALS,
  buildMeter,
  clampPercent,
  expandHome,
  formatCaptureTime,
  readJsonFile,
  stampCapturedMeters,
  subscriptionResult,
};
