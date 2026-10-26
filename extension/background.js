// Claude in Firefox — background script
// Talks to a native messaging host (spawned by Firefox) which relays commands
// from a local MCP server that Claude Code/Desktop connects to.

const NATIVE_HOST_ID = "com.anthropic.claude_in_firefox";
const NOT_FOUND = "__CLAUDE_NOT_FOUND__";

let port = null;
let blockPatterns = [];
let reconnectDelay = 3000;

async function loadBlocklist() {
  try {
    const res = await fetch(browser.runtime.getURL("blocklist.json"));
    const list = await res.json();
    blockPatterns = list.map((p) => new RegExp(p, "i"));
  } catch (e) {
    console.error("Failed to load blocklist.json, failing closed (blocking all navigation).", e);
    blockPatterns = [/.*/];
  }
}

function isBlockedUrl(urlStr) {
  try {
    return blockPatterns.some((re) => re.test(new URL(urlStr).hostname));
  } catch (e) {
    return false;
  }
}

function setBadge(text, color) {
  try {
    browser.browserAction.setBadgeText({ text });
    browser.browserAction.setBadgeBackgroundColor({ color });
  } catch (e) {
    /* badge API may vary; non-fatal */
  }
}

function connectNative() {
  try {
    port = browser.runtime.connectNative(NATIVE_HOST_ID);
  } catch (e) {
    // A malformed/missing host manifest throws here SYNCHRONOUSLY, which is not
    // covered by onDisconnect. Retrying matters: without it the extension parks
    // in a dead state until it is manually reloaded, giving no visible signal
    // beyond the badge. Back off so a permanent misconfiguration does not spin.
    console.error("connectNative threw; retrying in " + reconnectDelay + "ms", e);
    setBadge("ERR", "#cc0000");
    port = null;
    setTimeout(connectNative, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 60000);
    return;
  }
  setBadge("ON", "#2e7d32");
  reconnectDelay = 3000;
  port.onMessage.addListener(handleHostMessage);
  port.onDisconnect.addListener(() => {
    port = null;
    setBadge("OFF", "#888888");
    console.log("Native host disconnected", browser.runtime.lastError);
    setTimeout(connectNative, reconnectDelay);
  });
}

async function handleHostMessage(msg) {
  const { id, action, params } = msg || {};
  if (!id) return;
  try {
    const result = await dispatch(action, params || {});
    port.postMessage({ id, result });
  } catch (err) {
    let text = String((err && err.message) || err);
    if (text.includes(NOT_FOUND)) {
      text = "Element not found on the page (searched all frames). Call firefox_read_page to see what is actually there.";
    }
    port.postMessage({ id, error: text });
  }
}

async function getActiveTab() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error("No active tab found.");
  return tab;
}

function isNoReceiver(message) {
  return (
    message.includes("Could not establish connection") ||
    message.includes("Receiving end does not exist") ||
    message.includes("No matching message handler")
  );
}

async function listFrames(tabId) {
  try {
    const frames = await browser.webNavigation.getAllFrames({ tabId });
    // Top frame first — the element is usually there, and trying it first keeps
    // the common case to a single round trip.
    return frames.map((f) => f.frameId).sort((a, b) => a - b);
  } catch (e) {
    return [0];
  }
}

// Send to one specific frame.
function sendToFrame(tabId, frameId, message) {
  return browser.tabs.sendMessage(tabId, message, { frameId });
}

// Try each frame in turn, taking the first that can satisfy the action. A
// "not found" from one frame must not abort the call — the element may live in
// an iframe, which is the whole reason this fans out.
async function sendToAnyFrame(tabId, message) {
  const frameIds = await listFrames(tabId);
  let sawFrame = false;
  for (const frameId of frameIds) {
    try {
      const result = await sendToFrame(tabId, frameId, message);
      return { result, frameId };
    } catch (e) {
      const m = String((e && e.message) || e);
      if (m.includes(NOT_FOUND)) {
        sawFrame = true;
        continue;
      }
      if (isNoReceiver(m)) continue; // no content script in that frame
      throw e;
    }
  }
  if (sawFrame) throw new Error(NOT_FOUND);
  throw new Error(
    "No content script responded in this tab. Reload the page — content scripts are not injected into about:, view-source:, or addons.mozilla.org pages."
  );
}

// Refs are namespaced "<frameId>:<ref>" so identical per-frame counters cannot
// collide once results from several frames are merged.
function splitRef(ref) {
  const i = String(ref).indexOf(":");
  if (i === -1) return null;
  return { frameId: Number(ref.slice(0, i)), ref: ref.slice(i + 1) };
}

async function routeElementAction(tabId, action, params) {
  const parsed = params.ref ? splitRef(params.ref) : null;
  if (parsed && Number.isFinite(parsed.frameId)) {
    // A ref already identifies its frame, so go straight there.
    const result = await sendToFrame(tabId, parsed.frameId, {
      action,
      params: { ...params, ref: parsed.ref },
    });
    return result;
  }
  const { result } = await sendToAnyFrame(tabId, { action, params });
  return result;
}

function waitForLoad(tabId, timeoutMs = 20000) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (how) => {
      if (settled) return;
      settled = true;
      try {
        browser.webNavigation.onCompleted.removeListener(onCompleted);
      } catch (e) {
        /* ignore */
      }
      clearTimeout(timer);
      resolve(how);
    };
    const onCompleted = (details) => {
      if (details.tabId === tabId && details.frameId === 0) {
        // Content scripts run at document_idle, marginally after onCompleted.
        setTimeout(() => finish("load"), 250);
      }
    };
    browser.webNavigation.onCompleted.addListener(onCompleted);
    const timer = setTimeout(() => finish("timeout"), timeoutMs);
  });
}

async function dispatch(action, params) {
  switch (action) {
    case "navigate": {
      if (isBlockedUrl(params.url)) throw new Error("Blocked by local safety list: " + params.url);
      const tab = params.tabId ? { id: params.tabId } : await getActiveTab();
      await browser.tabs.update(tab.id, { url: params.url });
      // Without this the agent reads the PREVIOUS page: tabs.update resolves as
      // soon as navigation is queued, not when the new document is ready.
      const how = await waitForLoad(tab.id);
      const after = await browser.tabs.get(tab.id);
      return { tabId: tab.id, url: after.url, title: after.title, waited: how };
    }
    case "go_back":
    case "go_forward": {
      const tab = await getActiveTab();
      await (action === "go_back" ? browser.tabs.goBack(tab.id) : browser.tabs.goForward(tab.id));
      const how = await waitForLoad(tab.id, 10000);
      const after = await browser.tabs.get(tab.id);
      return { ok: true, url: after.url, title: after.title, waited: how };
    }
    case "get_tab_info": {
      const tab = await getActiveTab();
      return { id: tab.id, url: tab.url, title: tab.title };
    }
    case "list_tabs": {
      const tabs = await browser.tabs.query({});
      return tabs.map((t) => ({ id: t.id, url: t.url, title: t.title, active: t.active }));
    }
    case "create_tab": {
      if (isBlockedUrl(params.url)) throw new Error("Blocked by local safety list: " + params.url);
      const tab = await browser.tabs.create({ url: params.url });
      await waitForLoad(tab.id);
      const after = await browser.tabs.get(tab.id);
      return { id: tab.id, url: after.url, title: after.title };
    }
    case "switch_tab": {
      await browser.tabs.update(params.tabId, { active: true });
      return { ok: true };
    }
    case "close_tab": {
      await browser.tabs.remove(params.tabId);
      return { ok: true };
    }
    case "screenshot": {
      const tab = await getActiveTab();
      if (isBlockedUrl(tab.url)) throw new Error("Blocked by local safety list: " + tab.url);
      const dataUrl = await browser.tabs.captureVisibleTab(undefined, { format: "png" });
      return { dataUrl };
    }

    // Aggregate across every frame so iframe content is visible at all.
    case "read_page": {
      const tab = await getActiveTab();
      if (isBlockedUrl(tab.url)) throw new Error("Blocked by local safety list: " + tab.url);
      const frameIds = await listFrames(tab.id);
      const elements = [];
      let title = "";
      for (const frameId of frameIds) {
        try {
          const r = await sendToFrame(tab.id, frameId, { action: "read_page", params: {} });
          if (frameId === 0) title = r.title;
          for (const el of r.elements) {
            elements.push({ ...el, ref: `${frameId}:${el.ref}`, frameId, frameUrl: frameId === 0 ? undefined : r.url });
            if (elements.length >= 300) break;
          }
        } catch (e) {
          if (!isNoReceiver(String((e && e.message) || e))) throw e;
        }
        if (elements.length >= 300) break;
      }
      return { url: tab.url, title, frames: frameIds.length, elements };
    }

    case "get_page_text": {
      const tab = await getActiveTab();
      if (isBlockedUrl(tab.url)) throw new Error("Blocked by local safety list: " + tab.url);
      const frameIds = await listFrames(tab.id);
      let text = "";
      let title = "";
      for (const frameId of frameIds) {
        try {
          const r = await sendToFrame(tab.id, frameId, { action: "get_page_text", params: {} });
          if (frameId === 0) title = r.title;
          if (r.text && r.text.trim()) {
            text += (frameId === 0 ? "" : `\n\n--- iframe ${frameId} (${r.url}) ---\n`) + r.text;
          }
        } catch (e) {
          if (!isNoReceiver(String((e && e.message) || e))) throw e;
        }
      }
      return { url: tab.url, title, text: text.slice(0, 20000) };
    }

    case "click":
    case "click_text":
    case "hover":
    case "type_text":
    case "press_key":
    case "select_option":
    case "wait_for":
    case "scroll":
    case "ping": {
      const tab = await getActiveTab();
      if (isBlockedUrl(tab.url)) throw new Error("Blocked by local safety list: " + tab.url);
      return await routeElementAction(tab.id, action, params);
    }

    default:
      throw new Error("Unknown action: " + action);
  }
}

loadBlocklist().then(connectNative);
