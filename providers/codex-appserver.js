const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const { expandHome } = require("./subscription");

// Live source. `codex app-server` speaks JSON-RPC over stdio and answers
// `account/rateLimits/read` with the same snapshot the Codex UI renders. Asking
// the vendor's own binary — which authenticates with its own stored credentials
// and refreshes them the normal way — is what makes this safe: the dashboard
// never touches chatgpt.com itself, so it never looks like a scraper.
const RPC_TIMEOUT_MS = 25000;

function candidateBinaries(env) {
  const candidates = [];

  if (env.CODEX_BIN) {
    candidates.push(expandHome(env.CODEX_BIN));
  }

  for (const dir of String(env.PATH || "").split(path.delimiter)) {
    if (dir) {
      candidates.push(path.join(dir, "codex"));
    }
  }

  // The VS Code / desktop install ships the binary under a versioned extension
  // directory, so resolve the newest rather than pinning a version.
  const extensionsDir = path.join(os.homedir(), ".vscode", "extensions");
  let entries = [];
  try {
    entries = fs
      .readdirSync(extensionsDir)
      .filter((name) => /^openai\.chatgpt-/.test(name))
      .sort()
      .reverse();
  } catch {
    entries = [];
  }

  for (const entry of entries) {
    candidates.push(path.join(extensionsDir, entry, "bin", "linux-x86_64", "codex"));
    candidates.push(path.join(extensionsDir, entry, "bin", "codex"));
  }

  candidates.push(path.join(os.homedir(), ".local", "bin", "codex"));

  return candidates;
}

function resolveBinary(env) {
  for (const candidate of candidateBinaries(env)) {
    if (!candidate) {
      continue;
    }
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Not installed at this path; keep looking.
    }
  }
  return null;
}

// The binary reaches chatgpt.com itself, so it needs the proxy this host uses.
// A systemd unit inherits none of the shell's proxy variables, which is why the
// dashboard hands them down explicitly instead of relying on the ambient env.
function childEnv(env) {
  const proxy = env.SUBSCRIPTION_PROXY_URL || env.HTTPS_PROXY || env.https_proxy || env.ALL_PROXY || env.all_proxy;
  if (!proxy) {
    return env;
  }

  return {
    ...env,
    HTTPS_PROXY: proxy,
    https_proxy: proxy,
    HTTP_PROXY: env.HTTP_PROXY || env.http_proxy || proxy,
    http_proxy: env.http_proxy || env.HTTP_PROXY || proxy,
    ...(env.NO_PROXY || env.no_proxy
      ? { NO_PROXY: env.NO_PROXY || env.no_proxy, no_proxy: env.no_proxy || env.NO_PROXY }
      : {}),
  };
}

function requestRateLimits(binary, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ["app-server"], { stdio: ["pipe", "pipe", "pipe"], env: childEnv(env) });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let rateLimits = null;

    const finish = (error, value) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      child.kill();
      error ? reject(error) : resolve(value);
    };

    const timer = setTimeout(
      () => finish(new Error(`codex app-server did not answer within ${RPC_TIMEOUT_MS}ms`)),
      RPC_TIMEOUT_MS
    );

    const send = (message) => {
      try {
        child.stdin.write(`${JSON.stringify(message)}\n`);
      } catch (error) {
        finish(new Error(`could not write to codex app-server: ${error.message}`));
      }
    };

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();

      let newline;
      while ((newline = stdout.indexOf("\n")) >= 0) {
        const line = stdout.slice(0, newline).trim();
        stdout = stdout.slice(newline + 1);
        if (!line) {
          continue;
        }

        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }

        if (message.id === 1) {
          if (message.error) {
            finish(new Error(`initialize failed: ${JSON.stringify(message.error).slice(0, 200)}`));
            return;
          }
          send({ jsonrpc: "2.0", id: 2, method: "account/rateLimits/read", params: null });
        } else if (message.id === 2) {
          if (message.error) {
            finish(new Error(`account/rateLimits/read failed: ${JSON.stringify(message.error).slice(0, 200)}`));
            return;
          }
          rateLimits = message.result;
          send({ jsonrpc: "2.0", id: 3, method: "account/usage/read", params: null });
        } else if (message.id === 3) {
          // Usage is supplementary; a failure here must not lose the meters.
          finish(null, { rateLimits, usage: message.error ? null : message.result });
          return;
        }
      }
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => finish(new Error(`could not run ${binary}: ${error.message}`)));
    child.on("exit", (code) =>
      finish(new Error(`codex app-server exited with ${code}${stderr ? `: ${stderr.trim().slice(0, 200)}` : ""}`))
    );

    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { clientInfo: { name: "token-usage-dashboard", version: "1.0.0" } },
    });
  });
}

async function readLiveRateLimits(env) {
  const binary = resolveBinary(env);
  if (!binary) {
    throw new Error(
      "no `codex` binary found (looked on PATH, in ~/.vscode/extensions/openai.chatgpt-*, and ~/.local/bin). Set CODEX_BIN to its full path."
    );
  }

  const { rateLimits: result, usage } = await requestRateLimits(binary, env);
  const byLimitId = result?.rateLimitsByLimitId;
  const snapshot = byLimitId?.codex || result?.rateLimits || (byLimitId && Object.values(byLimitId)[0]);

  if (!snapshot) {
    throw new Error("codex app-server returned no rate-limit snapshot");
  }

  return { rateLimits: snapshot, resetCredits: result?.rateLimitResetCredits || null, usage, binary };
}

module.exports = { readLiveRateLimits, resolveBinary };
