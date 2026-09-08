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
const MAX_FILES = 400;

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

function readRecentCost(env) {
  const dir = projectsDir(env);
  if (!dir || !fs.existsSync(dir)) {
    return null;
  }

  const windowDays = Number(env.CLAUDE_COST_WINDOW_DAYS) || DEFAULT_WINDOW_DAYS;
  const cutoff = Date.now() - windowDays * 24 * 60 * 60 * 1000;

  const recent = collectTranscripts(dir)
    .filter((entry) => entry.mtimeMs >= cutoff)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, MAX_FILES);

  // A resumed session can appear in more than one transcript; its cost is
  // cumulative, so the largest value for a session id is the current total.
  const bySession = new Map();
  for (const entry of recent) {
    const found = lastCostState(entry.filePath, entry.size);
    if (found) {
      bySession.set(found.sessionId, Math.max(bySession.get(found.sessionId) || 0, found.costUsd));
    }
  }

  if (bySession.size === 0) {
    return null;
  }

  let costUsd = 0;
  for (const value of bySession.values()) {
    costUsd += value;
  }

  return { costUsd, sessionCount: bySession.size, windowDays };
}

module.exports = { readRecentCost, projectsDir };
