const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const { requestText } = require("./http");
const { buildMeter, expandHome, formatCaptureTime, subscriptionResult } = require("./subscription");

// v2free is an SSPanel instance: /user serves usage HTML to a logged-in session
// and bounces everyone else to /auth/login. The session cookie is owned by the
// user's v2free_fetch.py script (its Chrome-impersonated login clears the
// site's bot gate, which plain Node cannot), so this provider only ever reads
// the cookie file and shells out to that script when the session has expired.
const USER_URL = "https://v2free.org/user";
const REFRESH_TIMEOUT_MS = 100000;

function cookiePath(env) {
  return expandHome(env.V2FREE_COOKIE_FILE || "~/.config/clash/v2free.cookie");
}

function refreshCommand(env) {
  if (env.V2FREE_REFRESH_CMD) {
    return env.V2FREE_REFRESH_CMD;
  }
  const python = path.join(os.homedir(), ".venv", "bin", "python");
  const script = path.join(os.homedir(), "Documents", "scripts", "v2free_fetch.py");
  return `${python} ${script} /dev/null`;
}

function readCookie(env) {
  try {
    return fs.readFileSync(cookiePath(env), "utf8").trim();
  } catch {
    return "";
  }
}

// The refresh script needs the same proxy the dashboard uses; under systemd
// nothing is inherited from the shell, so hand it down explicitly.
function refreshEnv(env) {
  const proxy = env.SUBSCRIPTION_PROXY_URL || env.HTTPS_PROXY || env.https_proxy;
  if (!proxy) {
    return env;
  }
  return { ...env, HTTPS_PROXY: proxy, https_proxy: proxy, HTTP_PROXY: proxy, http_proxy: proxy };
}

function refreshCookie(env) {
  const command = refreshCommand(env);

  return new Promise((resolve, reject) => {
    const child = spawn(command, { shell: true, stdio: ["ignore", "ignore", "pipe"], env: refreshEnv(env) });

    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`cookie refresh timed out after ${REFRESH_TIMEOUT_MS}ms (${command})`));
    }, REFRESH_TIMEOUT_MS);

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`could not run cookie refresh (${command}): ${error.message}`));
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`cookie refresh exited ${code}: ${stderr.trim().slice(-200) || "no output"}`));
      }
    });
  });
}

async function fetchUserPage(env) {
  const cookie = readCookie(env);
  if (!cookie) {
    return { status: 0, body: "" };
  }

  return requestText(USER_URL, {
    env,
    headers: {
      Cookie: cookie,
      "User-Agent":
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml",
    },
  });
}

function isLoggedInPage(status, body) {
  return status === 200 && typeof body === "string" && body.includes("剩余流量");
}

const UNIT_TO_GB = { KB: 1 / 1024 ** 2, MB: 1 / 1024, GB: 1, TB: 1024 };

function parseTrafficGb(text) {
  const match = /([\d.]+)\s*(KB|MB|GB|TB)/i.exec(text || "");
  if (!match) {
    return null;
  }
  const value = Number(match[1]) * UNIT_TO_GB[match[2].toUpperCase()];
  return Number.isFinite(value) ? value : null;
}

function parsePage(body) {
    const anchor = "[^>]*>\\s*([\\d.]+\\s*[KMGT]B)\\s*<";
  // Keep the page's own strings: the meter should quote the numbers the console
  // shows (过去已用 excludes today; 今日已用 still counts against the quota).
  const remainingText = new RegExp(`剩余流量:[^<]*<a[^>]*id="remain"${anchor}`).exec(body)?.[1] || null;
  const usedTodayText = new RegExp(`今日已用:\\s*<a${anchor}`).exec(body)?.[1] || null;
  const usedPastText = new RegExp(`过去已用:\\s*<a${anchor}`).exec(body)?.[1] || null;
  const remaining = parseTrafficGb(remainingText);
  const usedToday = parseTrafficGb(usedTodayText);
  const usedPast = parseTrafficGb(usedPastText);

  const pairs = {};
  for (const match of body.matchAll(/\["([a-z_]+)", "([^"]*)"\]/g)) {
    pairs[match[1]] = match[2];
  }

  return { remaining, usedToday, usedPast, remainingText, usedTodayText, usedPastText, pairs };
}

function formatGb(value) {
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)}GB`;
}

function buildResult(env, body) {
  const { remaining, usedToday, usedPast, remainingText, usedTodayText, usedPastText, pairs } = parsePage(body);

  if (remaining === null) {
    throw new Error("could not find 剩余流量 on /user; the page layout may have changed.");
  }

  const used = (usedToday || 0) + (usedPast || 0);
  const total = used + remaining;

  const resetsAt = /^\d{4}-\d{2}-\d{2}$/.test(pairs.next_reset || "")
    ? new Date(`${pairs.next_reset}T00:00:00+08:00`).toISOString()
    : null;

  const detailParts = [];
  if (usedPastText) {
    detailParts.push(`past ${usedPastText}`);
  }
  if (usedTodayText) {
    detailParts.push(`today ${usedTodayText}`);
  }
  detailParts.push(`left ${remainingText} of ${formatGb(total)}`);

  const meters = [
    buildMeter({
      id: "traffic",
      label: "Traffic (cycle)",
      percent: total > 0 ? (used / total) * 100 : 0,
      resetsAt,
      detail: detailParts.join(" · "),
      isActive: true,
    }),
  ];

  const planLabel = [pairs.plan, pairs.vip_class ? `VIP${pairs.vip_class}` : null].filter(Boolean).join(" · ") || null;

  return subscriptionResult({
    providerId: env.V2FREE_PROVIDER_ID || "v2free",
    planLabel,
    meters,
    extra: {
      displayName: "V2Free",
      layout: "wide",
      planExpiresAt: pairs.expire || null,
    },
  });
}

async function fetchUsage({ env }) {
  try {
    let { status, body } = await fetchUserPage(env);

    if (!isLoggedInPage(status, body)) {
      await refreshCookie(env);
      ({ status, body } = await fetchUserPage(env));
      if (!isLoggedInPage(status, body)) {
        throw new Error(`still not logged in after cookie refresh (HTTP ${status}).`);
      }
    }

    return buildResult(env, body);
  } catch (error) {
    throw new Error(`V2Free provider failed: ${error.message}`);
  }
}

module.exports = {
  providerId: "v2free",
  fetchUsage,
};
