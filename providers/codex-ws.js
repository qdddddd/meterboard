const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { expandHome } = require("./subscription");

// Preferred live source. The user runs a long-lived
// `codex app-server --listen ws://...` that already holds an authenticated
// upstream connection, so asking it costs no process spawn and no re-auth.
// It speaks exactly the same JSON-RPC the stdio transport does, which is why
// this module hands back the raw result and lets the caller shape it.
//
// Auth is enforced: the server rejects a connection with no header, an empty
// header, a wrong token, or the bare token without the `Bearer ` prefix.
const DEFAULT_WS_URL = "ws://127.0.0.1:8965";
const CONNECT_TIMEOUT_MS = 3000;
const RPC_TIMEOUT_MS = 25000;
// Once the meters are in hand, the supplementary usage read is the only thing
// left to wait for. Holding the whole refresh at the full RPC timeout for it
// would be paying an essential deadline for optional data.
const USAGE_GRACE_MS = 5000;

// The token path has moved between releases, so probe the known locations
// rather than pinning one. CODEX_WS_TOKEN_FILE wins when set.
function tokenCandidates(env) {
  const candidates = [];

  if (env.CODEX_WS_TOKEN_FILE) {
    candidates.push(expandHome(env.CODEX_WS_TOKEN_FILE));
  }

  const configDir = env.XDG_CONFIG_HOME ? expandHome(env.XDG_CONFIG_HOME) : path.join(os.homedir(), ".config");
  candidates.push(path.join(configDir, "agents", "codex-serve.token"));
  candidates.push(path.join(configDir, "codex-serve", "token"));

  return candidates;
}

function resolveToken(env) {
  if (env.CODEX_WS_TOKEN) {
    return { token: env.CODEX_WS_TOKEN.trim(), origin: "CODEX_WS_TOKEN" };
  }

  const attempted = [];
  for (const candidate of tokenCandidates(env)) {
    if (!candidate) {
      continue;
    }
    try {
      const token = fs.readFileSync(candidate, "utf8").trim();
      if (token) {
        return { token, origin: candidate };
      }
      attempted.push(`${candidate} (empty)`);
    } catch {
      attempted.push(`${candidate} (unreadable)`);
    }
  }

  throw new Error(`no capability token found (looked in: ${attempted.join(", ") || "nowhere"})`);
}

function requestOverWebSocket(url, token) {
  return new Promise((resolve, reject) => {
    if (typeof WebSocket !== "function") {
      reject(new Error("this Node build has no global WebSocket"));
      return;
    }

    let socket;
    try {
      socket = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
    } catch (error) {
      reject(new Error(`could not open ${url}: ${error.message}`));
      return;
    }

    let settled = false;
    let rateLimits = null;
    let rateLimitsDone = false;
    let usage = null;
    let usageDone = false;

    const finish = (error, value) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(connectTimer);
      clearTimeout(rpcTimer);
      clearTimeout(graceTimer);
      try {
        socket.close();
      } catch {
        // Already closing; nothing to do.
      }
      error ? reject(error) : resolve(value);
    };

    // As on the stdio transport, the usage read is supplementary: once the rate
    // limits are in hand a later stall must not discard them.
    const finishOrSalvage = (error) => {
      if (rateLimits) {
        finish(null, { rateLimits, usage: null });
        return;
      }
      finish(error);
    };

    // A dead server refuses the TCP connect almost immediately, so this timer is
    // only a backstop for a host that accepts and then goes quiet. Keeping it
    // short is what makes falling back to a spawned binary cheap.
    let connectTimer = setTimeout(
      () => finish(new Error(`no response from ${url} within ${CONNECT_TIMEOUT_MS}ms`)),
      CONNECT_TIMEOUT_MS
    );
    let rpcTimer = null;
    let graceTimer = null;

    const settleIfReady = () => {
      if (rateLimitsDone && usageDone) {
        finish(null, { rateLimits, usage });
      }
    };

    const send = (message) => {
      try {
        socket.send(JSON.stringify(message));
      } catch (error) {
        finishOrSalvage(new Error(`could not write to ${url}: ${error.message}`));
      }
    };

    socket.addEventListener("open", () => {
      clearTimeout(connectTimer);
      rpcTimer = setTimeout(
        () => finishOrSalvage(new Error(`codex app-server did not answer within ${RPC_TIMEOUT_MS}ms`)),
        RPC_TIMEOUT_MS
      );
      send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { clientInfo: { name: "meterboard", version: "1.0.0" } },
      });
    });

    socket.addEventListener("message", (event) => {
      let message;
      try {
        message = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
      } catch {
        return;
      }

      if (message.id === 1) {
        if (message.error) {
          finish(new Error(`initialize failed: ${JSON.stringify(message.error).slice(0, 200)}`));
          return;
        }
        // The two reads are independent and each costs an upstream round trip,
        // so issue them together rather than chaining. Replies may come back in
        // either order, which is why they are matched by id, not by arrival.
        send({ jsonrpc: "2.0", id: 2, method: "account/rateLimits/read", params: null });
        send({ jsonrpc: "2.0", id: 3, method: "account/usage/read", params: null });
      } else if (message.id === 2) {
        if (message.error) {
          finish(new Error(`account/rateLimits/read failed: ${JSON.stringify(message.error).slice(0, 200)}`));
          return;
        }
        rateLimits = message.result;
        rateLimitsDone = true;
        if (!usageDone) {
          graceTimer = setTimeout(() => finishOrSalvage(new Error("usage read timed out")), USAGE_GRACE_MS);
        }
        settleIfReady();
      } else if (message.id === 3) {
        usage = message.error ? null : message.result;
        usageDone = true;
        settleIfReady();
      }
    });

    // The server closes the socket outright on a bad or missing token, so a
    // close before any answer is the signal that auth was rejected. `close`
    // always follows `error` and is the only one of the two carrying a code, so
    // the error handler defers to it rather than settling with a vaguer message.
    socket.addEventListener("close", (event) =>
      finishOrSalvage(
        new Error(
          `${url} closed the connection${event.code ? ` (code ${event.code})` : ""}` +
            `${event.reason ? `: ${event.reason}` : "; the capability token may be wrong or the server may be gone"}`
        )
      )
    );

    socket.addEventListener("error", () => {
      // Give `close` a moment to supply the real reason; fall back if it never
      // arrives so a half-open socket cannot stall past the timeouts above.
      // A rejected upgrade and a dead host are indistinguishable here -- the
      // WebSocket API exposes no status code -- so the message names both
      // rather than asserting the wrong one.
      setTimeout(
        () =>
          finishOrSalvage(
            new Error(`could not open a session with ${url} (server not listening, or the token was rejected)`)
          ),
        250
      );
    });
  });
}

async function readViaWebSocket(env) {
  const url = env.CODEX_WS_URL || DEFAULT_WS_URL;
  const { token, origin } = resolveToken(env);
  const { rateLimits, usage } = await requestOverWebSocket(url, token);
  return { rateLimits, usage, url, tokenOrigin: origin };
}

module.exports = { readViaWebSocket, DEFAULT_WS_URL };
