#!/usr/bin/env node
// MCP server — this is what you register with `claude mcp add`. It exposes
// browser-automation tools over MCP (stdio) and relays each call over HTTP
// to native-host.js, which Firefox has already launched and connected to
// the extension. Firefox must be open with the connector loaded for any
// of these tools to work.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const BRIDGE_URL = `http://127.0.0.1:${process.env.CLAUDE_FIREFOX_BRIDGE_PORT || 8765}/call`;

async function callBridge(action, params = {}) {
  let res;
  try {
    res = await fetch(BRIDGE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, params }),
    });
  } catch (e) {
    throw new Error(
      "Could not reach the Firefox native host bridge on " +
        BRIDGE_URL +
        ". Make sure Firefox is running with the Claude in Firefox connector loaded. (" +
        e.message +
        ")"
    );
  }
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || "Unknown bridge error");
  return data.result;
}

function textResult(obj) {
  return {
    content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }],
  };
}

const server = new McpServer({ name: "claude-in-firefox", version: "0.1.0" });

server.tool(
  "firefox_navigate",
  "Navigate the active Firefox tab to a URL. Blocked for URLs on the local safety list (see extension/blocklist.json).",
  { url: z.string().describe("The URL to navigate to") },
  async ({ url }) => textResult(await callBridge("navigate", { url }))
);

server.tool("firefox_go_back", "Go back in the active tab's history.", {}, async () =>
  textResult(await callBridge("go_back"))
);

server.tool("firefox_go_forward", "Go forward in the active tab's history.", {}, async () =>
  textResult(await callBridge("go_forward"))
);

server.tool("firefox_tab_info", "Get the active tab's id, URL, and title.", {}, async () =>
  textResult(await callBridge("get_tab_info"))
);

server.tool("firefox_list_tabs", "List all open tabs across all windows.", {}, async () =>
  textResult(await callBridge("list_tabs"))
);

server.tool(
  "firefox_create_tab",
  "Open a new tab at a URL. Blocked for URLs on the local safety list.",
  { url: z.string() },
  async ({ url }) => textResult(await callBridge("create_tab", { url }))
);

server.tool(
  "firefox_switch_tab",
  "Switch focus to a tab by its id.",
  { tabId: z.number() },
  async ({ tabId }) => textResult(await callBridge("switch_tab", { tabId }))
);

server.tool(
  "firefox_close_tab",
  "Close a tab by its id.",
  { tabId: z.number() },
  async ({ tabId }) => textResult(await callBridge("close_tab", { tabId }))
);

server.tool(
  "firefox_get_page_text",
  "Get the visible text content of the active page (truncated to 20k chars).",
  {},
  async () => textResult(await callBridge("get_page_text"))
);

server.tool(
  "firefox_read_page",
  "List the visible interactive elements (links, buttons, inputs, selects, ARIA widgets) on the active page, including inside iframes. Each element comes back with a 'ref' handle, a CSS selector, its text, and its on-screen box. PREFER the ref for follow-up actions: refs point at the exact element and keep working when the page shifts, whereas CSS selectors can silently start matching a different node.",
  {},
  async () => textResult(await callBridge("read_page"))
);

const target = {
  ref: z.string().optional().describe("Element handle from firefox_read_page (preferred)"),
  selector: z.string().optional().describe("CSS selector, used when no ref is given"),
};

server.tool(
  "firefox_click",
  "Click an element on the active page, by ref (preferred) or CSS selector. Searches every frame, scrolls the element into view, and dispatches a full pointer/mouse sequence. Reports 'obscuredBy' if another element (cookie banner, modal) was covering it.",
  target,
  async ({ ref, selector }) => textResult(await callBridge("click", { ref, selector }))
);

server.tool(
  "firefox_click_text",
  "Click the first visible element whose text matches (exact match preferred, then the smallest containing match). Searches every frame.",
  { text: z.string() },
  async ({ text }) => textResult(await callBridge("click_text", { text }))
);

server.tool(
  "firefox_hover",
  "Hover the pointer over an element, by ref or CSS selector. Use this to open hover menus and reveal tooltips before reading the page again.",
  target,
  async ({ ref, selector }) => textResult(await callBridge("hover", { ref, selector }))
);

server.tool(
  "firefox_type_text",
  "Type into an input, textarea, or contenteditable, by ref (preferred) or CSS selector. Sends a real keydown/keypress/input/keyup sequence per character, so autocomplete, search-as-you-type and framework-controlled fields react as they would to a human. Clears the field first unless clear=false.",
  {
    ...target,
    text: z.string(),
    clear: z.boolean().optional().describe("Clear the field before typing (default true)"),
    submit: z.boolean().optional().describe("Press Enter afterwards, falling back to submitting the form"),
  },
  async ({ ref, selector, text, clear, submit }) =>
    textResult(await callBridge("type_text", { ref, selector, text, clear, submit }))
);

server.tool(
  "firefox_press_key",
  "Press a single key, optionally with modifiers, on a specific element or on whatever currently has focus. Use for Enter, Tab, Escape, ArrowUp/ArrowDown (dropdown navigation), Backspace, and shortcuts like ctrl+a.",
  {
    ...target,
    key: z.string().describe('Key name, e.g. "Enter", "Tab", "Escape", "ArrowDown", "a"'),
    ctrl: z.boolean().optional(),
    shift: z.boolean().optional(),
    alt: z.boolean().optional(),
    meta: z.boolean().optional(),
  },
  async (a) => textResult(await callBridge("press_key", a))
);

server.tool(
  "firefox_select_option",
  "Choose an option in a <select> dropdown, by option value or visible label. Fires input/change so the page reacts. If nothing matches, the error lists the available options.",
  {
    ...target,
    value: z.string().optional().describe("Option value attribute"),
    label: z.string().optional().describe("Visible option text (exact, then substring)"),
  },
  async ({ ref, selector, value, label }) =>
    textResult(await callBridge("select_option", { ref, selector, value, label }))
);

server.tool(
  "firefox_wait_for",
  "Wait until a CSS selector matches a visible element, polling until it appears. Use after an action that triggers async loading, instead of reading the page and hoping the content arrived. Returns a ref for the element.",
  {
    selector: z.string(),
    timeoutMs: z.number().optional().describe("How long to wait, default 10000"),
  },
  async ({ selector, timeoutMs }) => textResult(await callBridge("wait_for", { selector, timeoutMs }))
);

server.tool(
  "firefox_scroll",
  "Scroll the active page up or down.",
  {
    direction: z.enum(["up", "down"]).default("down"),
    amount: z.number().optional().describe("Pixels to scroll, default 600"),
  },
  async ({ direction, amount }) => textResult(await callBridge("scroll", { direction, amount }))
);

server.tool(
  "firefox_screenshot",
  "Take a PNG screenshot of the visible area of the active tab.",
  {},
  async () => {
    const result = await callBridge("screenshot");
    const base64 = result.dataUrl.split(",")[1];
    return { content: [{ type: "image", data: base64, mimeType: "image/png" }] };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
