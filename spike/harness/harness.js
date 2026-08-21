/* dsh-point MEU-0 spike harness.
 * Validates three technical premises from DECISIONS D6/D9:
 *   1. A sandboxed (allow-same-origin) srcdoc iframe exposes its DOM to the parent.
 *   2. html2canvas (and a foreignObject SVG fallback) can screenshot an element inside it.
 *   3. window.getSelection captures text in a docx-like container, which can also be screenshotted.
 * All user-visible strings are Chinese; code comments stay English (project convention).
 */
(() => {
  'use strict';

  const iframe = document.getElementById('sandbox-frame');
  const officeContainer = document.getElementById('office-container');
  const resultsList = document.getElementById('results-list');
  const toggle = document.getElementById('mark-mode-toggle');
  const modeHint = document.getElementById('mode-hint');
  const runAllBtn = document.getElementById('run-all');
  const captureSelectionBtn = document.getElementById('capture-selection');
  const selectDemoBtn = document.getElementById('select-demo');

  // Assign the inline srcdoc HTML (mirrors dsh's programmatic srcdoc assignment).
  const srcdocTemplate = document.getElementById('srcdoc-template');
  iframe.srcdoc = srcdocTemplate.textContent.trim();

  let markMode = false;
  let hoveredEl = null;

  /* ---------- small helpers ---------- */

  function log(...args) {
    console.log('[dsh-spike]', ...args);
  }

  // Never swallow exceptions: record context + full stack, then return a readable string.
  function error(ctx, e) {
    const msg = (e && e.stack) ? e.stack : String(e);
    console.error(`[dsh-spike] ${ctx}:`, e);
    return msg;
  }

  function cssPath(el) {
    if (!el || el.nodeType !== 1) return '';
    if (el.id) return '#' + CSS.escape(el.id);
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && cur.tagName !== 'BODY' && cur.tagName !== 'HTML') {
      if (cur.id) { parts.unshift('#' + CSS.escape(cur.id)); break; }
      let sel = cur.tagName.toLowerCase();
      const parent = cur.parentElement;
      if (parent) {
        const sameTag = Array.from(parent.children).filter(c => c.tagName === cur.tagName);
        if (sameTag.length > 1) sel += `:nth-of-type(${sameTag.indexOf(cur) + 1})`;
      }
      parts.unshift(sel);
      cur = cur.parentElement;
    }
    return parts.join(' > ');
  }

  function visibleText(el) {
    if (!el) return '';
    let t = '';
    if (typeof el.innerText === 'string') t = el.innerText;
    if (!t && typeof el.textContent === 'string') t = el.textContent;
    if (!t && el.getAttribute) {
      t = el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('alt') || el.getAttribute('src') || '';
    }
    return (t || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  }

  function snippet(html, n = 300) {
    const s = (html || '').replace(/\s+/g, ' ').trim();
    return s.length > n ? s.slice(0, n) + ' …' : s;
  }

  function iframeDoc() {
    try {
      return iframe.contentDocument || null;
    } catch (e) {
      error('iframe.contentDocument access', e);
      return null;
    }
  }

  /* ---------- highlight ---------- */

  function highlight(el) {
    if (!el || el.nodeType !== 1) return;
    if (el.__origOutline === undefined) el.__origOutline = el.style.outline;
    el.style.outline = '2px solid #ff2d55';
    el.style.outlineOffset = '1px';
  }

  function unhighlight(el) {
    if (!el || el.nodeType !== 1) return;
    if (el.__origOutline !== undefined) { el.style.outline = el.__origOutline; delete el.__origOutline; }
    else { el.style.outline = ''; }
  }

  function clearHover() {
    if (hoveredEl) { unhighlight(hoveredEl); hoveredEl = null; }
  }

  /* ---------- screenshots ---------- */

  // Try html2canvas first; on failure fall back to foreignObject SVG serialization.
  // Returns an array of attempts so the report can see exactly what failed and why.
  async function screenshotElement(el, opts = {}) {
    const attempts = [];
    const h2cOptions = Object.assign({
      backgroundColor: '#ffffff',
      scale: 1,
      logging: false,
      useCORS: true,
      allowTaint: false,
    }, opts.html2canvas || {});

    try {
      if (typeof html2canvas !== 'function') throw new Error('html2canvas global not found');
      const canvas = await html2canvas(el, h2cOptions);
      const dataUrl = canvas.toDataURL('image/png');
      attempts.push({ method: 'html2canvas', ok: true, dataUrl });
      return attempts; // primary path succeeded, no fallback needed
    } catch (e) {
      attempts.push({ method: 'html2canvas', ok: false, error: error('html2canvas', e) });
    }

    try {
      const dataUrl = await foreignObjectScreenshot(el);
      attempts.push({ method: 'foreignObject', ok: true, dataUrl });
    } catch (e) {
      attempts.push({ method: 'foreignObject', ok: false, error: error('foreignObject', e) });
    }
    return attempts;
  }

  // foreignObject SVG serialization: clone subtree, inline computed styles, wrap in SVG.
  // External (non-CORS) images will taint the canvas and make toDataURL throw a SecurityError.
  function foreignObjectScreenshot(el) {
    const win = (el.ownerDocument && el.ownerDocument.defaultView) || window;
    const clone = el.cloneNode(true);
    inlineComputedStyles(clone, win);
    const w = Math.max(1, Math.ceil(el.getBoundingClientRect().width));
    const h = Math.max(1, Math.ceil(el.getBoundingClientRect().height));
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h + '">' +
      '<foreignObject width="100%" height="100%">' +
      '<div xmlns="http://www.w3.org/1999/xhtml">' + clone.outerHTML + '</div>' +
      '</foreignObject></svg>';
    const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.decoding = 'sync';
      img.onload = () => {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = w; canvas.height = h;
          const ctx = canvas.getContext('2d');
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, w, h);
          ctx.drawImage(img, 0, 0, w, h);
          resolve(canvas.toDataURL('image/png'));
        } catch (e) {
          reject(e);
        }
      };
      img.onerror = () => reject(new Error('foreignObject SVG image failed to load'));
      img.src = url;
    });
  }

  // Curated set of properties that matter for a faithful visual clone.
  const CLONE_PROPS = [
    'display', 'position', 'top', 'left', 'right', 'bottom', 'width', 'height',
    'margin', 'padding', 'border', 'background', 'background-color', 'color',
    'font-family', 'font-size', 'font-weight', 'font-style', 'line-height',
    'text-align', 'text-decoration', 'white-space', 'overflow', 'border-radius',
    'box-sizing', 'vertical-align', 'list-style', 'visibility', 'opacity',
    'flex-direction', 'align-items', 'justify-content', 'gap', 'grid-template-columns',
  ];

  function inlineComputedStyles(root, win) {
    const stack = [root];
    while (stack.length) {
      const node = stack.pop();
      if (node.nodeType !== 1) continue;
      let cs;
      try { cs = win.getComputedStyle(node); } catch (e) { /* skip */ }
      if (cs) {
        let out = '';
        for (const p of CLONE_PROPS) {
          let v;
          try { v = cs.getPropertyValue(p); } catch (e) { continue; }
          if (v) out += p + ':' + v + ';';
        }
        if (out) node.setAttribute('style', out);
      }
      for (const child of node.children) stack.push(child);
    }
  }

  /* ---------- capture element (iframe or office) ---------- */

  async function captureElement(el, source) {
    if (!el || el.nodeType !== 1) return;
    const info = {
      source,
      tag: el.tagName.toLowerCase(),
      selector: cssPath(el),
      text: visibleText(el),
      html: snippet(el.outerHTML),
      time: new Date().toISOString(),
    };
    const attempts = await screenshotElement(el);
    info.attempts = attempts;
    renderResultCard(info);
    log('captured', source, info.selector, attempts.map(a => a.method + ':' + (a.ok ? 'ok' : 'fail')).join(','));
    return info;
  }

  /* ---------- results rendering ---------- */

  function ensureListClear() {
    const placeholder = resultsList.querySelector('.empty');
    if (placeholder) placeholder.remove();
  }

  function renderResultCard(info) {
    ensureListClear();
    const card = document.createElement('div');
    card.className = 'result-card';
    const h3 = document.createElement('h3');
    h3.textContent = (info.source === 'iframe' ? '[iframe] ' : '[office] ') + info.tag + ' @ ' + info.selector;
    card.appendChild(h3);

    const kv = document.createElement('div');
    kv.className = 'kv';
    kv.appendChild(kvRow('可见文本', info.text || '(空)'));
    kv.appendChild(kvRow('CSS 选择器', info.selector));
    card.appendChild(kv);

    const htmlPre = document.createElement('pre');
    htmlPre.textContent = info.html || '(无 outerHTML)';
    card.appendChild(htmlPre);

    const success = info.attempts.find(a => a.ok);
    const failed = info.attempts.filter(a => !a.ok);
    if (success) {
      const img = document.createElement('img');
      img.className = 'shot';
      img.alt = '截图（' + success.method + '）';
      img.src = success.dataUrl;
      card.appendChild(img);
      const meta = document.createElement('div');
      meta.className = 'shot-meta';
      meta.textContent = '截图成功（方法：' + success.method + '）';
      card.appendChild(meta);
    }
    for (const f of failed) {
      const failEl = document.createElement('div');
      failEl.className = 'shot-meta fail';
      failEl.textContent = '截图失败（方法：' + f.method + '）：' + f.error;
      card.appendChild(failEl);
    }
    if (!success) {
      const failEl = document.createElement('div');
      failEl.className = 'shot-meta fail';
      failEl.textContent = '该元素区域截图全部失败（见上方失败明细）。';
      card.appendChild(failEl);
    }
    resultsList.appendChild(card);
  }

  function kvRow(label, value) {
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = value;
    const frag = document.createDocumentFragment();
    frag.appendChild(dt);
    frag.appendChild(dd);
    return frag;
  }

  /* ---------- mark mode ---------- */

  function setMarkMode(on) {
    markMode = on;
    toggle.checked = on;
    document.body.classList.toggle('mark-mode', on);
    modeHint.textContent = '标记模式：' + (on ? '开' : '关');
    if (!on) clearHover();
  }

  function attachOfficeListeners() {
    officeContainer.addEventListener('mouseover', (e) => {
      if (!markMode) return;
      const t = e.target;
      if (hoveredEl && hoveredEl !== t) unhighlight(hoveredEl);
      hoveredEl = t;
      highlight(t);
    });
    officeContainer.addEventListener('mouseout', (e) => {
      if (!markMode) return;
      if (e.target === hoveredEl) { unhighlight(hoveredEl); hoveredEl = null; }
    });
    officeContainer.addEventListener('click', (e) => {
      if (!markMode) return;
      captureElement(e.target, 'office');
    });
  }

  function attachIframeListeners() {
    const doc = iframeDoc();
    if (!doc) {
      console.error('[dsh-spike] iframe.contentDocument is null — sandbox/srcdoc DOM not reachable');
      return;
    }
    // Capture phase so we catch events on any element inside the frame.
    doc.addEventListener('mouseover', (e) => {
      if (!markMode) return;
      const t = e.target;
      if (hoveredEl && hoveredEl !== t) unhighlight(hoveredEl);
      hoveredEl = t;
      highlight(t);
    }, true);
    doc.addEventListener('mouseout', (e) => {
      if (!markMode) return;
      if (e.target === hoveredEl) { unhighlight(hoveredEl); hoveredEl = null; }
    }, true);
    doc.addEventListener('click', (e) => {
      if (!markMode) return;
      // MouseEvent.clientX/Y inside a same-origin iframe are already relative to
      // the iframe's own viewport, so feed them straight into elementFromPoint
      // (no offset against the parent frame's rect — that would double-subtract).
      const el = doc.elementFromPoint(e.clientX, e.clientY) || e.target;
      captureElement(el, 'iframe');
    }, true);
  }

  iframe.addEventListener('load', () => {
    attachIframeListeners();
    log('iframe loaded, contentDocument reachable =', !!iframeDoc());
  });

  /* ---------- office text selection ---------- */

  function makeSelection(paragraph, startOffset, endOffset) {
    const sel = window.getSelection();
    const range = document.createRange();
    const textNode = paragraph.firstChild;
    if (!textNode || textNode.nodeType !== 3) return false;
    range.setStart(textNode, startOffset);
    range.setEnd(textNode, endOffset);
    sel.removeAllRanges();
    sel.addRange(range);
    return true;
  }

  async function captureSelection() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
      console.error('[dsh-spike] captureSelection: no non-collapsed selection');
      return null;
    }
    const text = sel.toString();
    const range = sel.getRangeAt(0);
    let common = range.commonAncestorContainer;
    let el = (common.nodeType === 1) ? common : common.parentElement;
    // If the selection's common ancestor is a bare text node's parent, use the closest block.
    if (el && el.nodeType === 1 && el.textContent === text && el.children.length === 0) {
      el = el.parentElement;
    }
    const info = {
      source: 'office-selection',
      tag: el ? el.tagName.toLowerCase() : '',
      selector: cssPath(el),
      text: text.slice(0, 200),
      html: el ? snippet(el.outerHTML) : '',
      time: new Date().toISOString(),
    };
    if (el && el.nodeType === 1) {
      // Also screenshot the selected block's region (satisfies "选区捕获 + 区域截图").
      info.attempts = await screenshotElement(el);
    }
    log('selection', JSON.stringify({ text, selector: info.selector }));
    renderResultCard(info);
    return info;
  }

  /* ---------- run-all deterministic checks ---------- */

  async function runAllChecks() {
    ensureListClear();
    const summary = { check1: null, check2: null, check3: null };

    // Check 1: iframe DOM reachable.
    try {
      const doc = iframeDoc();
      if (!doc) throw new Error('contentDocument is null');
      const card = doc.getElementById('card-1');
      if (!card) throw new Error('#card-1 not found');
      const r = card.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const hit = doc.elementFromPoint(cx, cy);
      summary.check1 = {
        ok: true,
        contentDocument: !!doc,
        elementFromPointHit: hit ? hit.tagName + '/' + (hit.id || hit.className || '') : null,
        selector: cssPath(card),
        text: visibleText(card).slice(0, 80),
      };
      log('check1 ok', JSON.stringify(summary.check1));
    } catch (e) {
      summary.check1 = { ok: false, error: error('check1', e) };
      log('check1 fail', summary.check1.error);
    }

    // Check 2: iframe element screenshot (primary html2canvas, fallback foreignObject).
    try {
      const doc = iframeDoc();
      const card = doc.getElementById('card-1');
      if (!card) throw new Error('#card-1 not found for screenshot');
      const attempts = await screenshotElement(card);
      summary.check2 = { ok: attempts.some(a => a.ok), attempts };
      log('check2', JSON.stringify(attempts.map(a => ({ method: a.method, ok: a.ok, error: a.error ? a.error.slice(0, 120) : undefined }))));
    } catch (e) {
      summary.check2 = { ok: false, error: error('check2', e) };
      log('check2 fail', summary.check2.error);
    }

    // Check 2b: external image canvas pollution (useCORS=false, allowTaint=false).
    try {
      const doc = iframeDoc();
      const extImg = doc.getElementById('ext-img');
      if (!extImg) throw new Error('#ext-img not found');
      let polluted = false;
      let polluteError = null;
      try {
        const canvas = await html2canvas(extImg, { backgroundColor: '#ffffff', scale: 1, useCORS: false, allowTaint: false, logging: false });
        canvas.toDataURL('image/png'); // tainted canvas throws here
      } catch (e) {
        polluted = true;
        polluteError = error('external-image toDataURL', e);
      }
      summary.check2b = { polluted, error: polluteError };
      log('check2b', JSON.stringify({ polluted, error: polluteError ? polluteError.slice(0, 200) : null }));
    } catch (e) {
      summary.check2b = { polluted: false, error: error('check2b', e) };
    }

    // Check 3: office selection capture.
    try {
      const para = document.getElementById('para-1');
      if (!para) throw new Error('#para-1 not found');
      makeSelection(para, 4, 14);
      const selInfo = await captureSelection();
      summary.check3 = { ok: !!selInfo && !!selInfo.text, text: selInfo ? selInfo.text : null };
      log('check3', JSON.stringify(summary.check3));
    } catch (e) {
      summary.check3 = { ok: false, error: error('check3', e) };
    }

    // Render a summary card with raw results (in addition to whatever cards were created).
    renderSummaryCard(summary);
    window.__spikeSummary = summary;
    return summary;
  }

  function renderSummaryCard(summary) {
    const card = document.createElement('div');
    card.className = 'result-card';
    card.id = 'summary-card';
    const h3 = document.createElement('h3');
    h3.textContent = '一键验证结果';
    card.appendChild(h3);
    const pre = document.createElement('pre');
    pre.textContent = JSON.stringify(summary, (k, v) => {
      if (k === 'dataUrl') return '[dataUrl len=' + (v ? v.length : 0) + ']';
      return v;
    }, 2);
    card.appendChild(pre);
    resultsList.prepend(card);
  }

  /* ---------- wiring ---------- */

  toggle.addEventListener('change', () => setMarkMode(toggle.checked));
  runAllBtn.addEventListener('click', () => { runAllChecks(); });
  captureSelectionBtn.addEventListener('click', () => { captureSelection(); });
  selectDemoBtn.addEventListener('click', () => {
    const para = document.getElementById('para-1');
    if (para) makeSelection(para, 4, 14);
  });

  attachOfficeListeners();

  // Expose a tiny debug surface for deterministic verification via ego-browser.
  window.__dshSpike = {
    setMarkMode,
    makeSelection,
    captureSelection,
    captureElement,
    runAllChecks,
    screenshotElement,
    cssPath,
    visibleText,
    iframeDoc,
  };

  log('harness ready');
})();
