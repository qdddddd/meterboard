const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { expandHome } = require("./subscription");

// Codex appends a `token_count` event after every model response, and that event
// carries the rate-limit snapshot the server just returned. Reading the newest
// one gives the same numbers the usage endpoint would, with no request to
// chatgpt.com — which is the point: that endpoint is a non-public consumer API
// sitting behind a Cloudflare challenge, and polling it from a dashboard is the
// pattern that got the Anthropic account banned.
//
// Only `timestamp` and `payload.rate_limits` are ever read out of these files.
// They also contain conversation transcripts; nothing here touches them.
const DEFAULT_SCAN_LIMIT = 10;
const MAX_FILE_BYTES = 64 * 1024 * 1024;

function sessionsDir(env) {
  if (env.GPT_SESSIONS_DIR) {
    return expandHome(env.GPT_SESSIONS_DIR);
  }
  const home = env.CODEX_HOME ? expandHome(env.CODEX_HOME) : path.join(os.homedir(), ".codex");
  return path.join(home, "sessions");
}

function collectRollouts(dir, found = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }

  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectRollouts(full, found);
    } else if (entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name)) {
      try {
        found.push({ filePath: full, mtimeMs: fs.statSync(full).mtimeMs });
      } catch {
        // A session file can vanish mid-scan; skip it rather than fail the meter.
      }
    }
  }

  return found;
}

// Rate-limit events are appended, so the last match in a file is its newest.
function newestSnapshotInFile(filePath) {
  let contents;
  try {
    if (fs.statSync(filePath).size > MAX_FILE_BYTES) {
      return null;
    }
    contents = fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }

  const lines = contents.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line || !line.includes("rate_limits")) {
      continue;
    }

    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }

    const rateLimits = record?.payload?.rate_limits;
    const capturedMs = Date.parse(record?.timestamp);
    if (rateLimits && Number.isFinite(capturedMs)) {
      return { rateLimits, capturedAt: new Date(capturedMs).toISOString(), capturedMs };
    }
  }

  return null;
}

function readLatestSnapshot(env) {
  const dir = sessionsDir(env);
  if (!dir || !fs.existsSync(dir)) {
    return { snapshot: null, dir, scanned: 0 };
  }

  const scanLimit = Number(env.GPT_SESSION_SCAN_LIMIT) || DEFAULT_SCAN_LIMIT;
  const rollouts = collectRollouts(dir).sort((a, b) => b.mtimeMs - a.mtimeMs);
  const candidates = rollouts.slice(0, Math.max(1, scanLimit));

  for (const [index, candidate] of candidates.entries()) {
    const snapshot = newestSnapshotInFile(candidate.filePath);
    if (snapshot) {
      return {
        snapshot: { ...snapshot, sourceFile: path.basename(candidate.filePath) },
        dir,
        scanned: index + 1,
        totalRollouts: rollouts.length,
      };
    }
  }

  return { snapshot: null, dir, scanned: candidates.length, totalRollouts: rollouts.length };
}

module.exports = { readLatestSnapshot, sessionsDir };
