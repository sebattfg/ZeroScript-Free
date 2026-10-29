// SPDX-License-Identifier: GPL-3.0-or-later
// providers/ds-safety.js - DeepSeek only. Renders <ds_safety>…</ds_safety> blocks
// in assistant replies as a framed warning box instead of raw tag text.
//
// Self-contained: no dependency on core/main.js or the provider interface, so it
// can never interfere with the agent loop. Two shapes are handled:
//   A) a real <ds_safety> element in the DOM  -> styled purely by CSS (overlay.css)
//      plus a one-off header label (no re-parenting, React-safe);
//   B) literal text "<ds_safety> … </ds_safety>" inside the markdown (the usual
//      case: the site escapes unknown tags) -> the affected blocks are hidden
//      (class zs-safety-src, never removed) and a rendered box is inserted in
//      front of them. An unclosed tag (still streaming) renders as it grows.
(() => {
  "use strict";
  if (window.__zsDsSafety) return;
  window.__zsDsSafety = true;

  const OPEN = /<ds_safety\s*>/i;
  const CLOSE = /<\/ds_safety\s*>/i;
  const TITLE = "⚠ Komunikat bezpieczeństwa";
  const THINK = ".ds-think-content";
  const MD = ".ds-markdown";

  const blocksOf = (md) => [...md.children].filter(
    (el) => !el.classList.contains("zs-safety-wrap") && !el.closest(THINK)
  );
  const textOf = (el) => (el.textContent || "").replace(/ /g, " ");

  function buildBox(text, open) {
    const box = document.createElement("div");
    box.className = "zs-safety" + (open ? " zs-safety-open" : "");
    box.setAttribute("role", "note");
    const head = document.createElement("div");
    head.className = "zs-safety-head";
    head.textContent = TITLE;
    const body = document.createElement("div");
    body.className = "zs-safety-body";
    body.textContent = text.trim();
    box.append(head, body);
    return box;
  }

  function buildPlain(text) {
    const p = document.createElement("p");
    p.className = "zs-safety-plain";
    p.textContent = text.trim();
    return p;
  }

  // Walk the blocks of one markdown container and return runs: each run covers
  // the blocks from the one holding "<ds_safety>" through the one holding the
  // closing tag (or the end of the container while still streaming).
  function planRuns(md) {
    const blocks = blocksOf(md);
    const runs = [];
    let i = 0;
    while (i < blocks.length) {
      if (!OPEN.test(textOf(blocks[i]))) { i++; continue; }
      let j = i, joined = textOf(blocks[i]), closed = false;
      while (true) {
        const afterOpen = joined.slice(joined.search(OPEN));
        if (CLOSE.test(afterOpen)) { closed = true; break; }
        if (++j >= blocks.length) { j = blocks.length - 1; break; }
        joined += "\n" + textOf(blocks[j]);
      }
      // Split the joined text into [before][safety]...[after].
      const segs = [];
      let rest = joined;
      while (true) {
        const o = rest.search(OPEN);
        if (o < 0) { if (rest.trim()) segs.push({ t: "text", s: rest }); break; }
        if (o > 0 && rest.slice(0, o).trim()) segs.push({ t: "text", s: rest.slice(0, o) });
        const afterTag = rest.slice(o).replace(OPEN, "");
        const c = afterTag.search(CLOSE);
        if (c < 0) { segs.push({ t: "safety", s: afterTag, open: true }); break; }
        segs.push({ t: "safety", s: afterTag.slice(0, c), open: false });
        rest = afterTag.slice(c).replace(CLOSE, "");
      }
      runs.push({ from: i, to: j, segs, closed });
      i = j + 1;
    }
    return { blocks, runs };
  }

  function teardown(md) {
    md.querySelectorAll(":scope > .zs-safety-wrap").forEach((n) => n.remove());
    md.querySelectorAll(":scope > .zs-safety-src").forEach((n) => n.classList.remove("zs-safety-src"));
    delete md.dataset.zsSafetySig;
  }

  function processMarkdown(md) {
    if (md.closest(THINK)) return;
    const { blocks, runs } = planRuns(md);
    const sig = JSON.stringify(runs.map((r) => [r.from, r.to, r.segs]));
    if (!runs.length) {
      if (md.dataset.zsSafetySig) teardown(md);
      return;
    }
    if (md.dataset.zsSafetySig === sig && md.querySelector(":scope > .zs-safety-wrap")) return;
    teardown(md);
    for (const run of runs) {
      const wrap = document.createElement("div");
      wrap.className = "zs-safety-wrap";
      for (const seg of run.segs) {
        wrap.appendChild(seg.t === "safety" ? buildBox(seg.s, seg.open) : buildPlain(seg.s));
      }
      blocks[run.from].before(wrap);
      for (let k = run.from; k <= run.to; k++) blocks[k].classList.add("zs-safety-src");
    }
    md.dataset.zsSafetySig = sig;
  }

  // Shape A: a genuine <ds_safety> element. CSS draws the frame; we only add a
  // header label once (as a CSS-hidden attribute the ::before reads).
  function processElements() {
    for (const el of document.querySelectorAll("ds_safety")) {
      if (el.dataset.zsSafety) continue;
      el.dataset.zsSafety = "1";
      el.setAttribute("data-zs-title", TITLE);
    }
  }

  let queued = false;
  function sweep() {
    queued = false;
    try {
      processElements();
      for (const md of document.querySelectorAll(MD)) processMarkdown(md);
    } catch (e) { /* never let a render hiccup touch the page */ }
  }
  function schedule() {
    if (queued) return;
    queued = true;
    setTimeout(sweep, 150);
  }

  new MutationObserver(schedule).observe(document.documentElement, {
    childList: true, subtree: true, characterData: true,
  });
  setInterval(sweep, 2000);
  sweep();
})();
