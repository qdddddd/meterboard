const os = require("os");
const path = require("path");
const { chromium } = require("playwright");

let sharedEdgeContextPromise = null;
let sharedEdgeProfilePath = null;

function getEdgeUserDataDir(env) {
  if (env.EDGE_PROFILE_PATH) {
    return env.EDGE_PROFILE_PATH;
  }

  const platform = os.platform();
  const homeDir = os.homedir();

  if (platform === "win32") {
    return path.join(homeDir, "AppData", "Local", "Microsoft", "Edge", "User Data");
  }

  if (platform === "darwin") {
    return path.join(homeDir, "Library", "Application Support", "Microsoft Edge");
  }

  return path.join(homeDir, ".config", "microsoft-edge");
}

function getLaunchOptions() {
  return {
    headless: true,
    viewport: { width: 1280, height: 720 },
    channel: "msedge",
  };
}

async function getSharedEdgeContext(runtime, env) {
  if (!runtime) {
    return chromium.launchPersistentContext(getEdgeUserDataDir(env), getLaunchOptions());
  }

  const profilePath = getEdgeUserDataDir(env);

  if (!sharedEdgeContextPromise || sharedEdgeProfilePath !== profilePath) {
    sharedEdgeProfilePath = profilePath;
    const launchPromise = chromium.launchPersistentContext(profilePath, getLaunchOptions());
    sharedEdgeContextPromise = launchPromise;
    launchPromise.catch(() => {
      if (sharedEdgeContextPromise === launchPromise) {
        sharedEdgeContextPromise = null;
        sharedEdgeProfilePath = null;
      }
    });
  }

  runtime.edgeContextPromise = sharedEdgeContextPromise;
  return runtime.edgeContextPromise;
}

async function withEdgePage(runtime, env, work) {
  const standalone = !runtime;
  const context = await getSharedEdgeContext(runtime, env);
  const page = await context.newPage();

  try {
    return await work(page, context);
  } finally {
    await page.close().catch(() => {});

    if (standalone) {
      await context.close().catch(() => {});
    }
  }
}

async function closeSharedEdgeContext(runtime) {
  const pending = runtime?.edgeContextPromise || sharedEdgeContextPromise;
  if (runtime) {
    runtime.edgeContextPromise = null;
  }
  sharedEdgeContextPromise = null;
  sharedEdgeProfilePath = null;

  if (!pending) {
    return;
  }

  try {
    const context = await pending;
    await context.close();
  } catch {
    // ignore — context may have failed to launch or already be closed
  }
}

module.exports = {
  closeSharedEdgeContext,
  getEdgeUserDataDir,
  withEdgePage,
};
