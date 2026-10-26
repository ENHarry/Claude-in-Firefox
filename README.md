# Claude in Firefox (community connector)

This is a small, from-scratch connector that lets Claude Code (or Claude
Desktop) drive your Firefox browser: navigate, read pages, click, type,
scroll, and screenshot. It's not an official Anthropic product — Claude in
Chrome only ships for Chromium browsers today — but it's built by me for
you, not downloaded from a third-party repo, so there's no hidden token
harvesting and the safety blocklist is on by default instead of stripped
out.

## How it fits together

```
Claude Code / Claude Desktop
        |  (MCP, stdio)
        v
   host/mcp-server.js            <-- you register this with `claude mcp add`
        |  (HTTP, localhost only)
        v
   host/native-host.js           <-- Firefox launches this automatically
        |  (native messaging, stdio)
        v
   extension/background.js  -->  extension/content.js
        (runs inside Firefox, does the actual clicking/typing/reading)
```

Firefox must be open with the extension loaded for any of this to work —
`native-host.js` only exists as a running process while the extension is
connected.

## Safety notes (please read)

- This grants an AI agent live control of whatever Firefox profile you
  load the extension into, including any sites you're logged into. I'd
  recommend using a separate Firefox profile without your banking, email,
  or other sensitive accounts logged in, especially while you're getting
  a feel for how it behaves.
- `extension/blocklist.json` blocks navigation, clicking, typing, and
  screenshots on any tab whose hostname matches a pattern in that file. I
  seeded it with a handful of major banks/brokerages and a couple of
  government sites, but it is **not comprehensive** — add your own bank,
  and anything else you don't want an agent touching (gambling sites,
  your school's SIS/gradebook, etc.), as a regex on one line each.
- The local HTTP bridge in `native-host.js` binds to `127.0.0.1` only —
  it's not reachable from your network.
- Nothing in this project reads or transmits your Claude account
  credentials. `claude mcp add` just tells your existing Claude Code
  installation to launch `mcp-server.js` as a subprocess; there's no
  token bootstrapping.
- Treat this the way you'd treat any local dev tool you wrote yourself:
  it hasn't been security-reviewed by anyone but you (and me).

## Setup

**Prerequisites:** Node.js 18+, Firefox 109+, Claude Code CLI (or Claude
Desktop).

1. Install host dependencies:
   ```
   cd host
   npm install
   cd ..
   ```

2. Register the native messaging host:
   - macOS/Linux: `./install.sh`
   - Windows (PowerShell): `.\install.ps1`

3. Load the extension in Firefox:
   - Go to `about:debugging#/runtime/this-firefox`
   - Click **Load Temporary Add-on...**
   - Select `extension/manifest.json`
   - You should see a browser toolbar icon; it'll show an "ON" badge once
     it connects to the native host.

   **Limitation:** temporary add-ons are removed when Firefox restarts, so
   you'd need to reload it each time. See "Persistent install" below to
   make it survive restarts.

### Persistent install (self-signing via AMO)

On release-channel Firefox, `xpinstall.signatures.required=false` is
**ignored** — that pref only works on Developer Edition and Nightly. The
supported route on release Firefox is to self-sign through Mozilla's
unlisted-add-on flow. The add-on stays private to you; unlisted add-ons
are signed automatically and are never published in the AMO directory.

1. Get a free AMO API credential at
   https://addons.mozilla.org/developers/addon/api/key/ (sign in with a
   Mozilla account, then "Generate new credentials"). You get a **JWT
   issuer** (`user:12345:67`) and a **JWT secret**. The secret is shown
   **once** — copy it immediately.

2. From this directory:
   ```
   npm install
   copy amo-credentials.example.json amo-credentials.json
   ```
   Paste your issuer into `apiKey` and your secret into `apiSecret`.
   `amo-credentials.json` is gitignored — don't commit it.

3. Sign:
   ```
   npm run sign
   ```
   This uploads to Mozilla for automated validation (a few minutes) and
   writes a signed `.xpi` to `dist/`.

4. Install it: Firefox → `about:addons` → gear icon → **Install Add-on
   From File...** → pick the `.xpi` from `dist/`. It now survives
   restarts.

**If `npm run sign` times out:** it often does. `web-ext sign` uploads and
then polls for the signed file, but gives up after a few minutes, while
Mozilla's signing queue can take longer. **The upload still succeeded** —
the version now exists on AMO, so re-running `npm run sign` fails as a
duplicate version. Don't re-sign. Instead:

```
npm run check-signing      # check once, download if ready
npm run wait-for-signing   # poll every 60s until signed, then download
```

Either one downloads the signed `.xpi` into `dist/` as soon as AMO
finishes, and verifies the signature is really present before telling you
it worked.

**Naming constraint:** AMO rejects add-on *names* containing "Firefox" or
"Mozilla" (trademarks). That's why the extension is named "Claude Browser
Connector" rather than "Claude in Firefox". The gecko **id** may still
contain "firefox" — only the display name is checked. `sign.ps1` checks
for this before uploading.

**Re-signing after code changes:** AMO will not issue two signatures for
the same version number. Bump `version` in `extension/manifest.json`
before each re-sign, then `npm run sign` again and reinstall the new
`.xpi`.

4. Register the MCP server with Claude Code:
   ```
   claude mcp add claude-in-firefox -- node "$(pwd)/host/mcp-server.js"
   ```
   (On Windows, use the full path from the install.ps1 output instead of
   `$(pwd)`.) For Claude Desktop, add an equivalent entry to its MCP
   config file pointing at the same `mcp-server.js` path.

5. Restart Claude Code / Desktop so it picks up the new MCP server, then
   ask it to do something in the browser — it now has tools like
   `firefox_navigate`, `firefox_read_page`, `firefox_click`,
   `firefox_type_text`, and `firefox_screenshot`.

## Tools exposed

| Tool | What it does |
|---|---|
| `firefox_navigate` | Go to a URL in the active tab, **waiting for the load to finish** |
| `firefox_go_back` / `firefox_go_forward` | History navigation (also waits for load) |
| `firefox_tab_info` | Active tab id/url/title |
| `firefox_list_tabs` | List all open tabs |
| `firefox_create_tab` / `firefox_switch_tab` / `firefox_close_tab` | Tab management |
| `firefox_get_page_text` | Visible text of the page, including iframe content |
| `firefox_read_page` | Interactive elements across all frames, each with a stable `ref`, selector, text, and box |
| `firefox_click` / `firefox_click_text` | Click by ref, selector, or visible text |
| `firefox_hover` | Hover to open menus / reveal tooltips |
| `firefox_type_text` | Type with real per-character key events; optional clear and submit |
| `firefox_press_key` | Enter, Tab, Escape, arrows, and modifier combos |
| `firefox_select_option` | Choose a `<select>` option by value or label |
| `firefox_wait_for` | Poll until a selector appears, for async content |
| `firefox_scroll` | Scroll up/down |
| `firefox_screenshot` | PNG of the visible viewport |

### Notes on reliable automation

- **Prefer `ref` over `selector`.** `firefox_read_page` hands back a `ref` for
  each element. Refs point at the exact node that was seen; CSS paths built
  from `:nth-of-type` can silently start matching a *different* element after
  the DOM shifts, which fails in the worst possible way — quietly and wrongly.
- **Typing sends real key events.** Each character dispatches
  `keydown`/`keypress`/`input`/`keyup`, and values are written through the
  native property setter. Setting `.value` alone is invisible to
  search-as-you-type, autocomplete, and React/Vue controlled inputs.
- **Iframes are covered.** Content scripts run in every frame and the
  background script fans each action out until a frame satisfies it. Refs are
  namespaced `<frameId>:<ref>` so they route straight back to the right frame.
- **Navigation waits.** `tabs.update` resolves when navigation is *queued*, not
  when the page is ready, so `firefox_navigate` waits for `webNavigation`
  completion before returning. Use `firefox_wait_for` for content that arrives
  after load via XHR.
- **Content scripts cannot run everywhere.** `about:`, `view-source:`, and
  `addons.mozilla.org` are off-limits to extensions; page-level tools return an
  explicit error there rather than appearing to silently do nothing.

## Troubleshooting

- **"Could not reach the Firefox native host bridge"** — Firefox isn't
  open, the extension isn't loaded, or it hasn't connected yet. Check the
  toolbar badge.
- **"Timed out waiting for the Firefox extension"** — the native host
  process is running but the extension's background script isn't
  responding; try reloading the extension via `about:debugging`.
- **"Blocked by local safety list"** — working as intended; edit
  `extension/blocklist.json` and reload the extension if you want to
  change what's blocked.
