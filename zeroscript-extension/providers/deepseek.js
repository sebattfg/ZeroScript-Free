// SPDX-License-Identifier: GPL-3.0-or-later
//
const ZSProvider = (() => {
  "use strict";
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let diag = () => {};

  const S = {
    chatItem: ".ds-message",
    userMod: "d29f3d7d",
    userBubble: ".fbb737a4",
    box: ".ds-markdown",
    editor: "textarea",
    msgEditBox: ".ds-textarea",
    thinking: ".ds-think-content",
    markdown: ".ds-markdown",
    generating: ".ds-loading",
    sendBtn: ".ds-button--primary",
    stopBtn: ".ds-button--primary",
    errorSurfaces:
      '[class*="ds-toast"],[class*="toast"],[class*="error"],[class*="alert"],' +
      '[class*="warning"],[class*="modal"],[role="alert"]',
    attachArea: ".ds-file-list, [class*='file-preview'], [class*='upload']",
    imageThumb: "[class*='thumbnail'], [class*='file-item']",
    modeRadioGroup: '[role="radiogroup"]',
    modeRadio: '[role="radio"]',
    deepThinkToggle: ".ds-toggle-button",
  };

  const RE = {
    contextLimit: new RegExp(
      [
        "conversation.{0,20}(too long|trop long)",
        "context.{0,20}(limit|exceeded|d\\u00e9pass\\u00e9)",
        "session.{0,20}(expired|expir\\u00e9e)",
        "please.{0,30}(start|cr\\u00e9er).{0,20}(new|nouveau).{0,20}(chat|conversation)",
        "(token|context).{0,10}limit",
        "message.{0,20}too.{0,10}long",
        "maximum.{0,20}context",
        "this conversation has reached",
        "cette conversation a atteint",
      ].join("|"),
      "i"
    ),
    tooLong: /conversation .{0,20}(too long|getting too long|trop longue)/i,
    busy: /server is busy|serveur est occup|please try again|réessayer plus tard|system is currently busy/i,
    continueBtn: /^(continue|continuer|继续(生成)?|fortfahren|continuar|seguir|続行)$/i,
    stopped: /(arrêté|arrété|stopped|已停止|停止生成|已暂停)/i,
    expertMode: /expert|专家|专业/i,
    instantMode: /instant|rapide|快速/i,
    visionMode: /vision|视觉|图像|多模态/i,
    deepThink: /pensée profonde|pensee profonde|profonde|réflexion|reflexion|deep ?think|深度思考|r1/i,
    searchMode: /recherche intelligente|smart search|search|web|搜索/i,
  };

  const timings = {
    GEN_IDLE_MS: 800,
    REASON_IDLE_MS: 12000,
    WARMUP_MS: 45000,
    REASON_NOREPLY_MS: 90000,
    STABLE_MS: 9000,
    RESPONSE_TIMEOUT_MS: 300000,
  };

  function isUserItem(item) {
    if (!item) return false;
    if (S.userMod && item.classList.contains(S.userMod)) return true;
    if (S.userBubble && item.querySelector(S.userBubble)) return true;
    return false;
  }
  const isAssistantItem = (item) => !!item && !isUserItem(item);

  function itemText(item) {
    if (isAssistantItem(item)) {
      const mds = [...item.querySelectorAll(S.markdown)].filter((m) => !m.closest(S.thinking));
      return mds.map((m) => m.textContent).join("\n");
    }
    return item.textContent || "";
  }

  function classifyText(item, excludeSel) {
    if (isAssistantItem(item)) {
      return [...item.querySelectorAll(S.markdown)]
        .filter((m) => !m.closest(S.thinking) && !(excludeSel && m.closest(excludeSel)))
        .map((m) => m.textContent).join("\n");
    }
    let t = "";
    for (const n of item.childNodes) {
      if (excludeSel && n.nodeType === 1 && n.matches && n.matches(excludeSel)) continue;
      t += n.textContent || "";
    }
    return t;
  }

  const allItems = () => [...document.querySelectorAll(S.chatItem)];
  const assistantItems = () => allItems().filter(isAssistantItem);
  const assistantCount = () => assistantItems().length;
  const userCount = () => allItems().filter(isUserItem).length;

  const getEditor = () => {
    const site = [...document.querySelectorAll(S.editor)].filter((e) => !e.closest("#zs-root"));
    return site.find((e) => !e.closest(S.msgEditBox)) || site[0] || null;
  };
  const editorText = () => {
    const e = getEditor();
    if (!e) return "";
    return (e.value != null ? e.value : e.textContent || "");
  };

  function setInputLock(on) {
    const ed = getEditor();
    if (!ed) return;
    if (on) {
      if (!ed.dataset.zsPlaceholder) ed.dataset.zsPlaceholder = ed.getAttribute("placeholder") || "";
      ed.setAttribute("readonly", "");
      ed.setAttribute("placeholder", "⏳ Agent working… please wait");
    } else {
      ed.removeAttribute("readonly");
      if (ed.dataset.zsPlaceholder != null) ed.setAttribute("placeholder", ed.dataset.zsPlaceholder);
    }
  }

  const lastAssistant = () => {
    const it = assistantItems();
    return it.length ? it[it.length - 1] : null;
  };

  function lastAssistantId() {
    const last = lastAssistant();
    return itemKey(last);
  }

  function itemKey(item) {
    if (!item) return null;
    const p = item.parentElement;
    const key = p && p.getAttribute("data-virtual-list-item-key");
    return key != null ? key : null;
  }

  const chatIsEmpty = () => allItems().length === 0;
  const isFreshChat = () => chatIsEmpty() && !!getEditor() && !/\/s\/[^/]+/.test(location.pathname);

  function composerFrame() {
    const ta = getEditor();
    if (!ta) return null;
    const sb = document.querySelector(S.sendBtn);
    const group = document.querySelector(S.modeRadioGroup);
    const targets = [sb, group].filter(Boolean);
    let n = ta;
    for (let i = 0; i < 14 && n && n.parentElement; i++) {
      if (targets.every((t) => n.contains(t))) return n;
      n = n.parentElement;
    }
    let f = ta;
    for (let i = 0; i < 6 && f.parentElement; i++) f = f.parentElement;
    return f;
  }

  function barMount() {
    const ta = getEditor();
    if (!ta) return null;
    const send = document.querySelector(S.sendBtn);
    const group = document.querySelector(S.modeRadioGroup);
    let box = ta.parentElement;
    while (box && box !== document.body) {
      const holdsSend = !send || box.contains(send);
      const holdsTabs = group && box.contains(group);
      if (holdsSend && !holdsTabs) break;
      box = box.parentElement;
    }
    if (!box || box === document.body) box = ta.parentElement;
    if (!box) return null;
    let before = box.firstElementChild;
    if (before && before.id === "zs-bar") before = before.nextElementSibling;
    return { parent: box, before, inside: true };
  }

  const nodeText = (n) => (n && (n.innerText || n.textContent || "").trim()) || "";
  const isPressedOn = (n) =>
    n && (n.getAttribute("aria-pressed") === "true" ||
          n.getAttribute("aria-checked") === "true" ||
          n.classList.contains("ds-toggle-button--selected"));
  const isPressedOff = (n) =>
    n && (n.getAttribute("aria-pressed") === "false" ||
          n.getAttribute("aria-checked") === "false");

  function findModeRadio(type, re) {
    const group = document.querySelector(S.modeRadioGroup);
    const radios = group ? [...group.querySelectorAll(S.modeRadio)] : [...document.querySelectorAll(S.modeRadio)];
    return radios.find((r) => r.getAttribute("data-model-type") === type) ||
           (re && radios.find((r) => re.test(nodeText(r)))) ||
           null;
  }
  const findExpertRadio = () => findModeRadio("expert", RE.expertMode);
  const findVisionRadio = () => findModeRadio("vision", RE.visionMode);
  const findInstantRadio = () => findModeRadio("default", RE.instantMode);
  const radioOn = (r) => !!r && r.getAttribute("aria-checked") === "true";

  let _visLatch = false, _visLatchSet = false, _visAt = 0, _visCache = false;
  function badgeVision() {
    const els = [...document.querySelectorAll("div,span")].filter(
      (e) => e.childElementCount === 0 &&
             /^(instant|expert|vision)$/i.test((e.textContent || "").trim()) &&
             e.getBoundingClientRect().width > 0);
    if (!els.length) return null;
    els.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
    return /vision/i.test(els[0].textContent || "");
  }
  function detectVision() {
    const now = Date.now();
    if (now - _visAt < 400) return _visCache;
    _visAt = now;
    const group = document.querySelector(S.modeRadioGroup);
    if (group) {
      const v = findVisionRadio();
      if (v) { _visLatch = radioOn(v); _visLatchSet = true; return (_visCache = _visLatch); }
    }
    const b = badgeVision();
    if (b != null) { _visLatch = b; _visLatchSet = true; return (_visCache = b); }
    if (_visLatchSet) return (_visCache = _visLatch);
    return (_visCache = true);
  }
  const isVisionSelected = () => detectVision();

  function findToggleBy(re) {
    return [...document.querySelectorAll(S.deepThinkToggle)].find((t) => re.test(nodeText(t))) || null;
  }

  function composerModeState() {
    const expert = findExpertRadio();
    const deepThink = findToggleBy(RE.deepThink);
    const search = findToggleBy(RE.searchMode);
    const vision = findVisionRadio();
    const instant = findInstantRadio();
    const unified = !expert && !vision && !instant && !document.querySelector(S.modeRadioGroup);
    return {
      expertFound: !!expert,
      expertOn: radioOn(expert),
      visionFound: !!vision,
      visionOn: radioOn(vision),
      instantFound: !!instant,
      instantOn: radioOn(instant),
      deepThinkFound: !!deepThink,
      deepThinkOn: !!deepThink && isPressedOn(deepThink),
      searchFound: !!search,
      searchOff: !search || !isPressedOn(search),
      searchHiddenInExpert: !search && !!expert && expert.getAttribute("aria-checked") === "true",
      unified,
      modeLabel: unified ? "unified" : vision && radioOn(vision) ? "vision" : expert && radioOn(expert) ? "expert" : instant && radioOn(instant) ? "instant" : "unknown",
    };
  }

  function enforceComposer(reason) {
    if (!reason) return composerModeState();
    try {
      const state = composerModeState();
      if (state.unified) {
        const search = findToggleBy(RE.searchMode);
        if (search && isPressedOn(search)) {
          try { search.click(); } catch (e) { diag("mode_fallback", { reason, target: "search-unified", error: String(e && e.message || e) }); }
        }
        const after = composerModeState();
        diag("mode_enforce_auto", { reason, ...after });
        return after;
      }
      const search = findToggleBy(RE.searchMode);
      if (search && isPressedOn(search)) {
        try { search.click(); } catch (e) { diag("mode_fallback", { reason, target: "search", error: String(e && e.message || e) }); }
      }
      const after = composerModeState();
      diag("mode_enforce_auto", { reason, before: state.modeLabel, after: after.modeLabel, ...after });
      return after;
    } catch (e) {
      diag("mode_fallback", { reason, target: "composer", error: String(e && e.message || e) });
      return composerModeState();
    }
  }

  async function ensureComposerReady(reason) {
    let state = composerModeState();
    for (let i = 0; i < 10; i++) {
      state = enforceComposer(reason);
      const anyModel = state.expertOn || state.visionOn || state.instantOn || state.unified;
      const modelReady = anyModel || (!state.expertFound && !state.visionFound && !state.instantFound);
      if (modelReady && state.searchOff) break;
      await sleep(120);
    }
    state = composerModeState();
    const ready = state.unified ? state.searchOff : (state.expertOn || state.visionOn || state.instantOn || (!state.expertFound && !state.visionFound && !state.instantFound)) && state.searchOff;
    diag("mode_ready_auto", { reason, ...state, ready });
    return { ...state, ready };
  }

  function isStopBtn(btn) {
    if (!btn) return false;
    if (btn.querySelector("rect")) return true;
    const p = btn.querySelector("path");
    if (!p) return false;
    return /^\s*M\s*[0-3][\s.]/.test(p.getAttribute("d") || "");
  }

  function streamText(item) {
    if (!item) return "";
    const think = item.querySelector(S.thinking);
    const thinkTxt = think ? think.textContent || "" : "";
    const replyTxt = [...item.querySelectorAll(S.markdown)]
      .filter((m) => !m.closest(S.thinking) && !m.closest(".zs-chip"))
      .map((m) => m.textContent)
      .join("");
    return thinkTxt + "\n" + replyTxt;
  }
  const streamLen = (item) => streamText(item === undefined ? lastAssistant() : item).length;

  let _streamMax = -1, _streamAt = 0, _streamItem = null;
  function sampleStream() {
    const item = lastAssistant();
    const len = streamText(item).length;
    const now = Date.now();
    if (item !== _streamItem || len < _streamMax - 400) {
      _streamItem = item; _streamMax = len; _streamAt = now; return;
    }
    if (len > _streamMax) { _streamMax = len; _streamAt = now; }
  }
  const grewWithin = (ms) => _streamMax > 1 && Date.now() - _streamAt < ms;

  function reasoningInProgress(item) {
    if (!item) return false;
    const think = item.querySelector(S.thinking);
    const thinkTxt = think ? (think.textContent || "") : "";
    if (!thinkTxt.trim().length) return false;
    const replyLen = [...item.querySelectorAll(S.markdown)]
      .filter((m) => !m.closest(S.thinking) && !m.closest(".zs-chip"))
      .reduce((n, m) => n + (m.textContent || "").length, 0);
    if (replyLen !== 0) return false;
    if (turnHalted(item)) return false;
    return true;
  }

  function turnHalted(item) {
    if (!item) return false;
    const think = item.querySelector(S.thinking);
    const thinkTxt = think ? (think.textContent || "") : "";
    return RE.stopped.test(item.textContent || "") && !RE.stopped.test(thinkTxt);
  }

  function isGenerating() {
    if (document.querySelector(S.generating)) return true;
    const btn = document.querySelector(S.sendBtn);
    if (isStopBtn(btn)) return true;
    sampleStream();
    if (reasoningInProgress(lastAssistant())) return grewWithin(timings.REASON_IDLE_MS);
    return grewWithin(timings.GEN_IDLE_MS);
  }

  function isBusyNow() {
    if (document.querySelector(S.generating)) return true;
    const btn = document.querySelector(S.sendBtn);
    if (isStopBtn(btn)) return true;
    sampleStream();
    if (!reasoningInProgress(lastAssistant())) return false;
    return grewWithin(timings.REASON_IDLE_MS);
  }

  function isHardGenerating() {
    return isStopBtn(document.querySelector(S.sendBtn));
  }

  function genDebug() {
    try {
      sampleStream();
      const btn = document.querySelector(S.sendBtn);
      const path = btn && btn.querySelector("path");
      const rp = btn && btn.querySelector("rect");
      return {
        spinner: !!document.querySelector(S.generating),
        stopBtn: isStopBtn(btn),
        btnGlyph: rp ? "rect" : (path ? (path.getAttribute("d") || "").slice(0, 6) : "none"),
        reasoning: reasoningInProgress(lastAssistant()),
        streamMax: _streamMax,
        streamAgeMs: _streamAt ? Date.now() - _streamAt : -1,
        grewGen: grewWithin(timings.GEN_IDLE_MS),
        grewReason: grewWithin(timings.REASON_IDLE_MS),
        gen: isGenerating(),
        mode: composerModeState().modeLabel,
      };
    } catch (e) { return { err: String(e && e.message || e) }; }
  }

  function snapshot() {
    try {
      const it = lastAssistant();
      if (!it) return { th: 0, rp: 0 };
      const th = it.querySelector(S.thinking);
      const rp = [...it.querySelectorAll(S.markdown)]
        .filter((m) => !m.closest(S.thinking) && !m.closest(".zs-chip"))
        .reduce((n, m) => n + (m.textContent || "").length, 0);
      return { th: th ? (th.textContent || "").trim().length : 0, rp, mode: composerModeState().modeLabel };
    } catch { return {}; }
  }

  function findContinueBtn() {
    for (const b of document.querySelectorAll(".ds-button")) {
      if (b.offsetParent === null) continue;
      if (RE.continueBtn.test((b.innerText || "").trim())) return b;
    }
    return null;
  }

  function clickContinueBtn() {
    const b = findContinueBtn();
    if (!b) return false;
    try { b.click(); return true; } catch { return false; }
  }

  function readAssistant() {
    const item = lastAssistant();
    if (!item) return { present: false, reply: "", thinking: "", item: null };
    const th = item.querySelector(`${S.thinking} ${S.markdown}`);
    const mds = [...item.querySelectorAll(S.markdown)].filter((m) => !m.closest(S.thinking));
    return {
      present: true,
      reply: mds.map((m) => m.textContent).join("\n").trim(),
      thinking: th ? th.textContent.trim() : "",
      item,
    };
  }

  async function waitFor(pred, timeout) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (pred()) return true;
      await sleep(120);
    }
    return false;
  }

  function setTextareaValue(el, v) {
    const proto = window.HTMLTextAreaElement && window.HTMLTextAreaElement.prototype;
    const setter = proto && Object.getOwnPropertyDescriptor(proto, "value");
    if (setter && setter.set) setter.set.call(el, v);
    else el.value = v;
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function pressEnter(editor) {
    const o = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true };
    editor.dispatchEvent(new KeyboardEvent("keydown", o));
    editor.dispatchEvent(new KeyboardEvent("keyup", o));
  }

  function clickSendButton() {
    if (isBusyNow()) return false;
    const btn = document.querySelector(S.sendBtn);
    if (btn && !isStopBtn(btn) && btn.getAttribute("aria-disabled") !== "true") {
      btn.click();
      return true;
    }
    return false;
  }

  const SEND_CAP = 163840;
  const SEND_MAX = 160000;
  function truncateForSend(text) {
    if (!text || text.length <= SEND_MAX) return text;
    const omitted = text.length - SEND_MAX;
    const marker =
      `\n\n[…ZeroScript: result truncated to fit DeepSeek's ${SEND_CAP}-character ` +
      `input limit - ${omitted} of ${text.length} characters omitted. Do NOT re-run ` +
      `the command; work with the head and tail shown here…]\n\n`;
    const budget = SEND_MAX - marker.length;
    const headLen = Math.floor(budget * 0.85);
    const tailLen = budget - headLen;
    return text.slice(0, headLen) + marker + text.slice(text.length - tailLen);
  }

  async function typeAndSend(text, images) {
    const editor = getEditor();
    if (!editor) throw new Error("DeepSeek input box not found");
    editor.focus();
    text = truncateForSend(text);
    setTextareaValue(editor, text);
    const hasImages = !!(images && images.length);
    if (hasImages) {
      try { await attachImages(images); } catch {}
      const t0 = Date.now();
      while (Date.now() - t0 < 25000) {
        const btn = document.querySelector(S.sendBtn);
        if (btn && !isStopBtn(btn) && btn.getAttribute("aria-disabled") !== "true") {
          try { btn.click(); } catch {}
        }
        if (await waitFor(() => editorText().trim() === "" || isHardGenerating(), 1200)) return;
      }
      return;
    }
    await waitFor(() => {
      const btn = document.querySelector(S.sendBtn);
      return btn && btn.getAttribute("aria-disabled") !== "true" && !isStopBtn(btn);
    }, 800);
    if (!clickSendButton() && !isBusyNow()) {
      pressEnter(editor);
    }
  }

  function stopGeneration() {
    const b = document.querySelector(S.stopBtn);
    if (isStopBtn(b)) try { b.click(); } catch {}
  }

  function scanError() {
    try {
      for (const el of document.querySelectorAll(S.errorSurfaces)) {
        if (el.offsetParent === null) continue;
        if (el.closest(S.chatItem)) continue;
        const t = (el.innerText || "").trim();
        if (t.length > 8 && t.length < 600 && RE.contextLimit.test(t)) return t.slice(0, 240);
      }
    } catch {}
    if (!getEditor()) return "The input box disappeared (session ended?).";
    return null;
  }

  const isTooLongMsg = (text) => RE.tooLong.test(text);
  const isBusyMsg = (text) => RE.busy.test(text);

  function fileFromImage(img, i) {
    const mime = img.mimeType || "image/jpeg";
    const bin = atob(img.data);
    const arr = new Uint8Array(bin.length);
    for (let j = 0; j < bin.length; j++) arr[j] = bin.charCodeAt(j);
    const ext = mime.includes("png") ? "png" : "jpg";
    return new File([arr], `zeroscript_${Date.now()}_${i}.${ext}`, { type: mime });
  }

  const attachThumbs = () => {
    try {
      return [...document.querySelectorAll("img")].filter(
        (im) => !im.closest(S.chatItem) &&
          (/^blob:/.test(im.getAttribute("src") || "") || /^zeroscript_/.test(im.getAttribute("alt") || "")));
    } catch { return []; }
  };

  function clearAttachments() {
    try {
      document.querySelectorAll(`${S.attachArea} [class*='delete'], ${S.attachArea} [class*='close'], ${S.attachArea} [class*='remove']`)
        .forEach((d) => ["mouseover", "mousedown", "mouseup", "click"]
          .forEach((t) => { try { d.dispatchEvent(new MouseEvent(t, { bubbles: true })); } catch {} }));
    } catch {}
  }

  async function attachImages(images) {
    const editor = getEditor();
    if (!editor || !images || !images.length) return false;
    if (attachThumbs().length > 0) return true;
    const want = images.length;
    const dt = new DataTransfer();
    images.forEach((img, i) => { try { dt.items.add(fileFromImage(img, i)); } catch {} });
    if (!dt.items.length) return false;
    editor.focus();
    const fileInput = document.querySelector('input[type="file"]');
    if (fileInput) {
      try {
        fileInput.files = dt.files;
        fileInput.dispatchEvent(new Event("change", { bubbles: true }));
      } catch {}
    } else {
      editor.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    }
    return await waitFor(() => attachThumbs().length >= want, 15000);
  }

  const conversationKey = () => (location.pathname === "/" ? "" : location.pathname);

  function installSendHooks(handlers) {
    document.addEventListener(
      "keydown",
      (e) => {
        if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
        const editor = getEditor();
        if (!editor || !editor.contains(e.target)) return;
        const text = editorText().trim();
        if (text === "") return;
        if (handlers.isBlocked()) return;
        if (!handlers.isStarted()) {
          if (!chatIsEmpty()) return;
          handlers.onBlockedAttempt();
          return;
        }
        handlers.onUserMessage(assistantCount());
      },
      true
    );

    document.addEventListener(
      "click",
      (e) => {
        if (!getEditor()) return;
        const t = e.target;
        const cont = t && t.closest && t.closest(".ds-button");
        if (cont && RE.continueBtn.test((cont.innerText || "").trim())) {
          handlers.onNativeContinue();
          return;
        }
        const btn = t && t.closest && t.closest(S.sendBtn);
        if (!btn) return;
        if (isStopBtn(btn)) {
          handlers.onNativeStop();
          return;
        }
        if (btn.getAttribute("aria-disabled") === "true") return;
        if (handlers.isBlocked()) return;
        if (!handlers.isStarted()) {
          if (!chatIsEmpty()) return;
          handlers.onBlockedAttempt();
          return;
        }
        handlers.onUserMessage(assistantCount());
      },
      true
    );
  }

  function findToolBlockSpot(item, chip) {
    const P = ZSParse;
    const hasStart = (t) => P.LUA_START_RE.test(t) || t.includes("###mcp_tool###");
    const hasEnd = (t) => P.LUA_END_RE.test(t) || t.includes("###end_mcp_tool###") || t.includes("###end-mcp_tool###");
    const isJson = (t) => /\{\s*"(?:command|tool)"\s*:/.test(t);
    const isDsml = (t) => P.DSML_RE.test(t);
    const containers = [...item.querySelectorAll(S.markdown)].filter((m) => !m.closest(S.thinking));
    if (!containers.length) return null;
    let parent = null, ref = null;
    for (const container of containers) {
      const kids = [...container.children].filter((k) => k !== chip && !(chip && k.contains(chip)));
      let i = 0;
      while (i < kids.length) {
        const txt = (kids[i].textContent || "");
        const tLow = txt.toLowerCase();
        const startsBlock = hasStart(tLow);
        const startsDsml = isDsml(txt);
        if (!startsBlock && !isJson(txt) && !startsDsml) { i++; continue; }
        const runStart = i;
        let runEnd = i;
        if (startsDsml) {
          let j = i + 1;
          while (j < kids.length && isDsml(kids[j].textContent || "")) { runEnd = j; j++; }
        } else if (startsBlock && !hasEnd(tLow)) {
          let j = i + 1;
          runEnd = kids.length - 1;
          for (; j < kids.length; j++) {
            if (hasEnd((kids[j].textContent || "").toLowerCase())) { runEnd = j; break; }
          }
        }
        for (let k = runStart; k <= runEnd; k++) {
          let hide = kids[k];
          const wrap = hide.closest("[class*='code'], .md-code-block");
          if (wrap && container.contains(wrap) && wrap !== container) hide = wrap;
          hide.classList.add("zs-tool-hide");
          if (!ref && hide.parentElement) { parent = hide.parentElement; ref = hide; }
        }
        i = runEnd + 1;
      }
    }
    return ref ? { parent, ref } : null;
  }

  const promptExtra = "DeepSeek auto-adapt: the user chose their model (Instant/Expert/Vision/Unified) and DeepThink setting themselves - do not ask them to switch; just use the available tools. Search is disabled automatically.";

  return {
    id: "deepseek",
    displayName: "DeepSeek",
    get supportsVision() { return isVisionSelected(); },
    timings,
    thinkingSel: S.thinking,
    promptExtra,
    init({ diag: d } = {}) {
      if (d) diag = d;
      
      diag("ds.init", { ver: "auto-adapt", unified: composerModeState().unified });
    },
    allItems, isUserItem, isAssistantItem, itemText, classifyText,
    assistantCount, userCount, lastAssistant, lastAssistantId, itemKey, readAssistant,
    streamLen, snapshot,
    getEditor, editorText, chatIsEmpty, isFreshChat, composerFrame, barMount,
    setInputLock, typeAndSend, stopGeneration,
    isGenerating, isBusyNow, isHardGenerating, genDebug,
    enforceComposer, ensureComposerReady,
    turnHalted, findContinueBtn, clickContinueBtn,
    scanError, isTooLongMsg, isBusyMsg,
    attachImages, clearAttachments, conversationKey,
    installSendHooks, findToolBlockSpot,
  };
})();
