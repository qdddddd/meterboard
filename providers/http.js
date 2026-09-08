const http = require("node:http");
const https = require("node:https");
const tls = require("node:tls");
const { URL } = require("node:url");

// Node's global fetch ignores https_proxy, and undici is not a dependency here,
// so outbound calls to api.anthropic.com / chatgpt.com tunnel through the proxy
// with a hand-rolled CONNECT agent.
function resolveProxyUrl(targetUrl, env = process.env) {
  const explicit = env.SUBSCRIPTION_PROXY_URL;
  const proxy = explicit || env.HTTPS_PROXY || env.https_proxy || env.ALL_PROXY || env.all_proxy;
  if (!proxy) {
    return null;
  }

  const noProxy = env.NO_PROXY || env.no_proxy || "";
  const host = targetUrl.hostname.toLowerCase();
  for (const rawRule of noProxy.split(",")) {
    const rule = rawRule.trim().toLowerCase();
    if (!rule || rule.includes("/")) {
      continue;
    }
    if (rule === "*" || host === rule || host.endsWith(rule.startsWith(".") ? rule : `.${rule}`)) {
      return null;
    }
  }

  try {
    return new URL(proxy);
  } catch {
    return null;
  }
}

function openTunnel(proxyUrl, host, port) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: proxyUrl.hostname,
      port: Number(proxyUrl.port) || 80,
      method: "CONNECT",
      path: `${host}:${port}`,
      headers: {
        Host: `${host}:${port}`,
        ...(proxyUrl.username
          ? {
              "Proxy-Authorization": `Basic ${Buffer.from(
                `${decodeURIComponent(proxyUrl.username)}:${decodeURIComponent(proxyUrl.password || "")}`
              ).toString("base64")}`,
            }
          : {}),
      },
    });

    request.once("connect", (response, socket) => {
      if (response.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`Proxy CONNECT to ${host}:${port} failed with ${response.statusCode}`));
        return;
      }
      resolve(socket);
    });

    request.once("error", reject);
    request.end();
  });
}

function readResponse(response) {
  return new Promise((resolve, reject) => {
    let body = "";
    response.setEncoding("utf8");
    response.on("data", (chunk) => {
      body += chunk;
    });
    response.on("end", () => resolve(body));
    response.on("error", reject);
  });
}

async function requestText(url, options = {}) {
  const { method = "GET", headers = {}, body = null, env = process.env, timeoutMs = 20000 } = options;
  const target = new URL(url);
  const proxyUrl = resolveProxyUrl(target, env);

  if (!proxyUrl) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { method, headers, body, signal: controller.signal });
      return { status: response.status, body: await response.text() };
    } finally {
      clearTimeout(timer);
    }
  }

  const port = Number(target.port) || 443;
  const socket = await openTunnel(proxyUrl, target.hostname, port);

  return new Promise((resolve, reject) => {
    const request = https.request(
      {
        method,
        host: target.hostname,
        path: `${target.pathname}${target.search}`,
        headers: { Host: target.hostname, ...headers },
        createConnection: () => tls.connect({ socket, servername: target.hostname }),
      },
      (response) => {
        readResponse(response)
          .then((text) => resolve({ status: response.statusCode, body: text }))
          .catch(reject);
      }
    );

    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error(`Request to ${target.hostname} timed out after ${timeoutMs}ms`));
    });
    request.on("error", reject);
    if (body) {
      request.write(body);
    }
    request.end();
  });
}

async function requestJson(url, options = {}) {
  const { status, body } = await requestText(url, options);
  let payload = null;
  try {
    payload = JSON.parse(body);
  } catch {
    payload = null;
  }
  return { status, payload, rawBody: body };
}

module.exports = { requestJson, requestText, resolveProxyUrl };
