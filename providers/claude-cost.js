const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { expandHome } = require("./subscription");

// Claude Code appends `cost-state` records to each session transcript, carrying
// the running totalCostUSD it computes itself — the same figure `/cost` reports.
// We read that number rather than recomputing one: the per-message usage cannot
// be reconciled with it (cost-state labels models its own way, e.g.
// `claude-opus-5[1m]`, and streaming leaves duplicate message ids), so any
// recomputation would be a guess at internal behaviour that shifts per release.
//
// The number is exact per session but cumulative over that session's whole life,
// and cost-state records are written infrequently — often only once, days after
// the session began. That rules out per-day attribution, so the window here is
// "sessions active in the last N days" and the total is their full cost.
const DEFAULT_WINDOW_DAYS = 7;
const TAIL_BYTES = 512 * 1024;

// Transcripts are append-only, so a file whose size and mtime are unchanged
// still holds the same last cost-state. Remembering the result per file turns a
// refresh from "read every transcript in the window" into "stat them, and read
// only the few that moved" -- on a real tree, hundreds of megabytes down to a
// handful of stats. The cache is a pure accelerator: delete it and the next
// refresh rebuilds it with the same numbers.
const CACHE_VERSION = 1;
const DEFAULT_CACHE_PATH = path.join(os.homedir(), ".cache", "meterboard", "claude-cost.json");

function projectsDir(env) {
  if (env.CLAUDE_PROJECTS_DIR) {
    return expandHome(env.CLAUDE_PROJECTS_DIR);
  }
  const configDir = env.CLAUDE_CONFIG_DIR ? expandHome(env.CLAUDE_CONFIG_DIR) : path.join(os.homedir(), ".claude");
  return path.join(configDir, "projects");
}

function collectTranscripts(dir, found = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }

  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectTranscripts(full, found);
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      try {
        const stat = fs.statSync(full);
        found.push({ filePath: full, mtimeMs: stat.mtimeMs, size: stat.size });
      } catch {
        // Transcript rotated away mid-scan; skip it.
      }
    }
  }

  return found;
}

// cost-state records sit near the end of a transcript, so read the tail rather
// than pulling megabytes of conversation into memory for every refresh.
function readTail(filePath, size) {
  if (size <= TAIL_BYTES) {
    return fs.readFileSync(filePath, "utf8");
  }

  const handle = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(TAIL_BYTES);
    fs.readSync(handle, buffer, 0, TAIL_BYTES, size - TAIL_BYTES);
    return buffer.toString("utf8");
  } finally {
    fs.closeSync(handle);
  }
}

function scanForCostState(contents, filePath) {
  const lines = contents.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line || !line.includes('"cost-state"')) {
      continue;
    }

    let record;
    try {
      record = JSON.parse(line);
    } catch {
      // A tail read can clip the first line mid-object; ignore it.
      continue;
    }

    if (record?.type === "cost-state" && typeof record.totalCostUSD === "number") {
      return { sessionId: record.sessionId || filePath, costUsd: record.totalCostUSD };
    }
  }

  return null;
}

// The tail holds the newest records, so a cost-state found there is the latest
// one. Only when the tail has none is a full read needed — some transcripts
// keep writing long after their last cost-state, pushing it out of the window.
function lastCostState(filePath, size) {
  try {
    const tail = readTail(filePath, size);
    if (tail.includes('"cost-state"')) {
      const found = scanForCostState(tail, filePath);
      if (found) {
        return found;
      }
    }

    if (size <= TAIL_BYTES) {
      return null;
    }

    const whole = fs.readFileSync(filePath, "utf8");
    return whole.includes('"cost-state"') ? scanForCostState(whole, filePath) : null;
  } catch {
    return null;
  }
}

function cachePath(env) {
  return env.CLAUDE_COST_CACHE_PATH ? expandHome(env.CLAUDE_COST_CACHE_PATH) : DEFAULT_CACHE_PATH;
}

function loadCache(env) {
  if (String(env.CLAUDE_COST_CACHE || "").trim().toLowerCase() === "false") {
    return null;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath(env), "utf8"));
    // A stale layout is not worth migrating; rebuilding costs one slow refresh.
    return parsed?.version === CACHE_VERSION && parsed.entries && typeof parsed.entries === "object"
      ? parsed.entries
      : null;
  } catch {
    return null;
  }
}

// Written via a temp file and renamed so a refresh interrupted mid-write cannot
// leave a half-parsed cache behind. A failure here is silent by design: the
// numbers are already computed, and losing the accelerator must not lose them.
function saveCache(env, entries) {
  if (String(env.CLAUDE_COST_CACHE || "").trim().toLowerCase() === "false") {
    return;
  }
  const target = cachePath(env);
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const temporary = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ version: CACHE_VERSION, entries }));
    fs.renameSync(temporary, target);
  } catch {
    // Unwritable cache directory; the scan still returned the right answer.
  }
}

function readRecentCost(env) {
  const dir = projectsDir(env);
  if (!dir || !fs.existsSync(dir)) {
    return null;
  }

  const windowDays = Number(env.CLAUDE_COST_WINDOW_DAYS) || DEFAULT_WINDOW_DAYS;
  const cutoff = Date.now() - windowDays * 24 * 60 * 60 * 1000;

  const recent = collectTranscripts(dir)
    .filter((entry) => entry.mtimeMs >= cutoff)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  const cached = loadCache(env) || {};
  const fresh = {};
  let reused = 0;
  let scanned = 0;

  // A resumed session can appear in more than one transcript; its cost is
  // cumulative, so the largest value for a session id is the current total.
  const bySession = new Map();
  for (const entry of recent) {
    const hit = cached[entry.filePath];
    let found;

    if (hit && hit.mtimeMs === entry.mtimeMs && hit.size === entry.size) {
      found = hit.sessionId === null ? null : { sessionId: hit.sessionId, costUsd: hit.costUsd };
      reused += 1;
    } else {
      found = lastCostState(entry.filePath, entry.size);
      scanned += 1;
    }

    // Remember misses too, so a transcript that never carries a cost-state is
    // not re-read in full on every single refresh.
    fresh[entry.filePath] = found
      ? { mtimeMs: entry.mtimeMs, size: entry.size, sessionId: found.sessionId, costUsd: found.costUsd }
      : { mtimeMs: entry.mtimeMs, size: entry.size, sessionId: null, costUsd: 0 };

    if (found) {
      bySession.set(found.sessionId, Math.max(bySession.get(found.sessionId) || 0, found.costUsd));
    }
  }

  // Only entries still inside the window are carried over, so the file cannot
  // grow without bound as old transcripts age out.
  saveCache(env, fresh);

  if (bySession.size === 0) {
    return null;
  }

  let costUsd = 0;
  for (const value of bySession.values()) {
    costUsd += value;
  }

  return { costUsd, sessionCount: bySession.size, windowDays, filesScanned: scanned, filesReused: reused };
}

module.exports = { readRecentCost, projectsDir, cachePath };
