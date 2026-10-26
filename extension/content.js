// Claude in Firefox — content script
// Executes DOM-level actions on behalf of the background script. This runs in
// EVERY frame (all_frames: true); the background script fans an action out to
// each frame and takes the first one that can satisfy it.

// Sentinel the background script looks for when deciding whether to try the
// next frame. A thrown "not found" from frame A must not abort the whole call
// when the element actually lives in frame B.
const NOT_FOUND = "__CLAUDE_NOT_FOUND__";

// Stable handles handed out by read_page. CSS paths built from :nth-of-type
// are brittle on dynamic pages — one inserted node and every later selector
// silently points at the wrong element. A ref points at the exact node we saw.
const refs = new Map();
let refCounter = 0;

function newRef(el) {
  const id = "e" + ++refCounter;
  refs.set(id, el);
  return id;
}

function cssPath(el) {
  if (!(el instanceof Element)) return "";
  const path = [];
  while (el && el.nodeType === Node.ELEMENT_NODE) {
    let selector = el.nodeName.toLowerCase();
    if (el.id) {
      path.unshift(selector + "#" + CSS.escape(el.id));
      break;
    }
    let sib = el;
    let nth = 1;
    while ((sib = sib.previousElementSibling)) {
      if (sib.nodeName.toLowerCase() === el.nodeName.toLowerCase()) nth++;
    }
    path.unshift(selector + ":nth-of-type(" + nth + ")");
    el = el.parentElement;
  }
  return path.join(" > ");
}

function isVisible(el) {
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return false;
  const style = window.getComputedStyle(el);
  if (style.visibility === "hidden" || style.display === "none") return false;
  if (style.opacity === "0") return false;
  return true;
}

// Resolve whichever addressing mode the caller used. Refs win when present
// because they survive DOM churn that would invalidate a selector.
function resolveTarget(params) {
  if (params.ref) {
    const el = refs.get(params.ref);
    if (!el) throw new Error(NOT_FOUND);
    if (!el.isConnected) throw new Error("Element " + params.ref + " is no longer in the document (page changed since read_page).");
    return el;
  }
  if (params.selector) {
    let el;
    try {
      el = document.querySelector(params.selector);
    } catch (e) {
      throw new Error("Invalid CSS selector: " + params.selector);
    }
    if (!el) throw new Error(NOT_FOUND);
    return el;
  }
  throw new Error("Provide either 'ref' or 'selector'.");
}

function labelFor(el) {
  const raw =
    el.getAttribute("aria-label") ||
    el.innerText ||
    el.value ||
    el.placeholder ||
    el.getAttribute("title") ||
    el.getAttribute("alt") ||
    "";
  return raw.trim().replace(/\s+/g, " ").slice(0, 120);
}

function getInteractiveElements() {
  const els = document.querySelectorAll(
    'a, button, input, textarea, select, summary, [role="button"], [role="link"], [role="checkbox"], [role="tab"], [role="menuitem"], [contenteditable="true"], [onclick], [tabindex]:not([tabindex="-1"])'
  );
  const out = [];
  els.forEach((el) => {
    if (out.length >= 200) return;
    if (!isVisible(el)) return;
    if (el.disabled) return;
    const r = el.getBoundingClientRect();
    out.push({
      ref: newRef(el),
      selector: cssPath(el),
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute("type") || undefined,
      role: el.getAttribute("role") || undefined,
      name: el.getAttribute("name") || undefined,
      checked: el.type === "checkbox" || el.type === "radio" ? !!el.checked : undefined,
      text: labelFor(el),
      // Viewport coordinates help an agent reason about layout and ordering.
      box: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    });
  });
  return out;
}

function findByText(text) {
  const lower = text.trim().toLowerCase();
  const candidates = document.querySelectorAll(
    'a, button, [role="button"], [role="link"], [role="tab"], [role="menuitem"], input[type="submit"], input[type="button"], summary, label, span, div, li, td'
  );
  let partial = null;
  for (const el of candidates) {
    if (!isVisible(el)) continue;
    const t = (el.innerText || el.value || el.getAttribute("aria-label") || "").trim().toLowerCase();
    if (!t) continue;
    if (t === lower) return el;
    // Prefer the smallest partial match — on nested markup an ancestor <div>
    // often contains the text too, and clicking it usually misses the control.
    if (t.includes(lower)) {
      if (!partial || el.innerText.length < partial.innerText.length) partial = el;
    }
  }
  return partial;
}

// --- keyboard simulation -------------------------------------------------
// Setting .value fires no key events, so anything listening for keydown (type
// -ahead, search suggestions, framework-controlled inputs, key handlers that
// call preventDefault) never sees the input. Emit the real sequence instead.

const NAMED_KEYS = {
  Enter: { code: "Enter", keyCode: 13 },
  Tab: { code: "Tab", keyCode: 9 },
  Escape: { code: "Escape", keyCode: 27 },
  Backspace: { code: "Backspace", keyCode: 8 },
  Delete: { code: "Delete", keyCode: 46 },
  ArrowUp: { code: "ArrowUp", keyCode: 38 },
  ArrowDown: { code: "ArrowDown", keyCode: 40 },
  ArrowLeft: { code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { code: "ArrowRight", keyCode: 39 },
  Home: { code: "Home", keyCode: 36 },
  End: { code: "End", keyCode: 35 },
  PageUp: { code: "PageUp", keyCode: 33 },
  PageDown: { code: "PageDown", keyCode: 34 },
  " ": { code: "Space", keyCode: 32 },
};

function keyInfo(key) {
  if (NAMED_KEYS[key]) return NAMED_KEYS[key];
  if (key.length === 1) {
    const cc = key.charCodeAt(0);
    if (/[a-zA-Z]/.test(key)) return { code: "Key" + key.toUpperCase(), keyCode: key.toUpperCase().charCodeAt(0) };
    if (/[0-9]/.test(key)) return { code: "Digit" + key, keyCode: cc };
    return { code: "", keyCode: cc };
  }
  return { code: key, keyCode: 0 };
}

function dispatchKey(el, type, key, mods = {}) {
  const info = keyInfo(key);
  const ev = new KeyboardEvent(type, {
    key,
    code: info.code,
    keyCode: info.keyCode,
    which: info.keyCode,
    bubbles: true,
    cancelable: true,
    composed: true,
    ctrlKey: !!mods.ctrl,
    shiftKey: !!mods.shift,
    altKey: !!mods.alt,
    metaKey: !!mods.meta,
  });
  return el.dispatchEvent(ev); // false => a handler called preventDefault()
}

// React/Vue track the value via a property setter on the prototype; assigning
// el.value directly bypasses it and the framework reverts the field on the next
// render. Go through the native setter so the framework observes the change.
function setNativeValue(el, value) {
  const proto = Object.getPrototypeOf(el);
  const desc = Object.getOwnPropertyDescriptor(proto, "value");
  if (desc && desc.set) desc.set.call(el, value);
  else el.value = value;
}

function isEditable(el) {
  return el.isContentEditable;
}

function insertChar(el, ch) {
  if (isEditable(el)) {
    document.execCommand("insertText", false, ch);
  } else {
    setNativeValue(el, (el.value ?? "") + ch);
  }
}

function clearField(el) {
  if (isEditable(el)) {
    el.textContent = "";
  } else {
    setNativeValue(el, "");
  }
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

function typeInto(el, text, opts = {}) {
  el.focus();
  if (el !== document.activeElement && el.click) el.click();
  if (opts.clear !== false) clearField(el);

  for (const ch of Array.from(text)) {
    const notPrevented = dispatchKey(el, "keydown", ch);
    if (notPrevented) {
      dispatchKey(el, "keypress", ch);
      insertChar(el, ch);
      el.dispatchEvent(
        new InputEvent("input", { bubbles: true, cancelable: false, data: ch, inputType: "insertText" })
      );
    }
    dispatchKey(el, "keyup", ch);
  }
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

function pressKey(el, key, mods) {
  const target = el || document.activeElement || document.body;
  const notPrevented = dispatchKey(target, "keydown", key, mods);
  if (notPrevented && key.length === 1) {
    dispatchKey(target, "keypress", key, mods);
    if (target.value !== undefined || isEditable(target)) {
      insertChar(target, key);
      target.dispatchEvent(new InputEvent("input", { bubbles: true, data: key, inputType: "insertText" }));
    }
  }
  dispatchKey(target, "keyup", key, mods);
  return { ok: true, key, defaultPrevented: !notPrevented };
}

function clickElement(el) {
  el.scrollIntoView({ block: "center", inline: "center" });
  const r = el.getBoundingClientRect();
  const cx = r.x + r.width / 2;
  const cy = r.y + r.height / 2;

  // Report when something else sits on top (cookie banner, modal overlay) —
  // the click still goes through via .click(), but silently hitting an
  // invisible overlay is a confusing failure to debug from the agent side.
  let obscuredBy = null;
  const top = document.elementFromPoint(cx, cy);
  if (top && top !== el && !el.contains(top) && !top.contains(el)) {
    obscuredBy = top.tagName.toLowerCase() + (top.className ? "." + String(top.className).split(/\s+/)[0] : "");
  }

  const opts = { bubbles: true, cancelable: true, composed: true, clientX: cx, clientY: cy };
  el.dispatchEvent(new PointerEvent("pointerdown", opts));
  el.dispatchEvent(new MouseEvent("mousedown", opts));
  el.dispatchEvent(new PointerEvent("pointerup", opts));
  el.dispatchEvent(new MouseEvent("mouseup", opts));
  el.click();
  return { ok: true, obscuredBy, text: labelFor(el) };
}

function hoverElement(el) {
  el.scrollIntoView({ block: "center" });
  const r = el.getBoundingClientRect();
  const opts = { bubbles: true, cancelable: true, composed: true, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 };
  el.dispatchEvent(new PointerEvent("pointerover", opts));
  el.dispatchEvent(new MouseEvent("mouseover", opts));
  el.dispatchEvent(new MouseEvent("mousemove", opts));
  return { ok: true, text: labelFor(el) };
}

function selectOption(el, params) {
  if (el.tagName.toLowerCase() !== "select") {
    throw new Error("select_option expects a <select>, got <" + el.tagName.toLowerCase() + ">");
  }
  const opts = Array.from(el.options);
  let match = null;
  if (params.value !== undefined) match = opts.find((o) => o.value === params.value);
  if (!match && params.label !== undefined) {
    const want = String(params.label).trim().toLowerCase();
    match = opts.find((o) => o.text.trim().toLowerCase() === want) || opts.find((o) => o.text.trim().toLowerCase().includes(want));
  }
  if (!match) {
    throw new Error(
      "No matching option. Available: " + opts.map((o) => `${JSON.stringify(o.text.trim())}=${JSON.stringify(o.value)}`).slice(0, 25).join(", ")
    );
  }
  el.focus();
  el.value = match.value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return { ok: true, selected: { value: match.value, label: match.text.trim() } };
}

function waitFor(selector, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 10000);
  return new Promise((resolve, reject) => {
    const tick = () => {
      let el = null;
      try {
        el = document.querySelector(selector);
      } catch (e) {
        return reject(new Error("Invalid CSS selector: " + selector));
      }
      if (el && isVisible(el)) {
        return resolve({ ok: true, ref: newRef(el), text: labelFor(el) });
      }
      if (Date.now() > deadline) return reject(new Error(NOT_FOUND));
      setTimeout(tick, 150);
    };
    tick();
  });
}

browser.runtime.onMessage.addListener((msg) => {
  const { action, params = {} } = msg || {};
  try {
    switch (action) {
      case "ping":
        return Promise.resolve({ ok: true, url: location.href, frame: window === window.top ? "top" : "sub" });

      case "get_page_text":
        return Promise.resolve({
          url: location.href,
          title: document.title,
          text: document.body ? document.body.innerText.slice(0, 20000) : "",
        });

      case "read_page":
        return Promise.resolve({
          url: location.href,
          title: document.title,
          elements: getInteractiveElements(),
        });

      case "click":
        return Promise.resolve(clickElement(resolveTarget(params)));

      case "click_text": {
        const el = findByText(params.text);
        if (!el) return Promise.reject(new Error(NOT_FOUND));
        return Promise.resolve(clickElement(el));
      }

      case "hover":
        return Promise.resolve(hoverElement(resolveTarget(params)));

      case "type_text": {
        const el = resolveTarget(params);
        typeInto(el, params.text, { clear: params.clear });
        if (params.submit) {
          const notPrevented = dispatchKey(el, "keydown", "Enter");
          dispatchKey(el, "keyup", "Enter");
          // Only fall back to a raw form submit if nothing handled Enter.
          if (notPrevented) {
            const form = el.closest("form");
            if (form) {
              if (form.requestSubmit) form.requestSubmit();
              else form.submit();
            }
          }
        }
        return Promise.resolve({ ok: true, value: el.value ?? el.textContent });
      }

      case "press_key":
        return Promise.resolve(
          pressKey(params.ref || params.selector ? resolveTarget(params) : null, params.key, {
            ctrl: params.ctrl,
            shift: params.shift,
            alt: params.alt,
            meta: params.meta,
          })
        );

      case "select_option":
        return Promise.resolve(selectOption(resolveTarget(params), params));

      case "wait_for":
        return waitFor(params.selector, params.timeoutMs);

      case "scroll": {
        const amount = params.amount || 600;
        window.scrollBy(0, params.direction === "up" ? -amount : amount);
        return Promise.resolve({ ok: true, scrollY: Math.round(window.scrollY) });
      }

      default:
        return Promise.reject(new Error("Unknown content action: " + action));
    }
  } catch (err) {
    return Promise.reject(err);
  }
});
