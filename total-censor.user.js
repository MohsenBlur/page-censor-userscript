// ==UserScript==
// @name         Total Censor - jumble all text, blank out all images
// @namespace    total-censor
// @version      1.2.0
// @description  Off until you switch it on for a site from the userscript manager's menu. Then it replaces every visible letter/digit with a random one and swaps every image, video, canvas, SVG and CSS background for a blank placeholder, on that domain, for as long as you leave it on.
// @author       you
// @match        *://*/*
// @match        file:///*
// @run-at       document-start
// @all-frames   true
// @grant        GM_registerMenuCommand
// @grant        GM_unregisterMenuCommand
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addValueChangeListener
// @grant        unsafeWindow
// ==/UserScript==

(function () {
  'use strict';

  /* =============================== config =============================== */

  const CONFIG = {
    // Off everywhere until you switch a site on from the userscript manager's menu.
    // That choice is remembered per domain, so the site comes up censored next time.
    defaultOn: false,           // true = censor every site unless switched off
    rememberPerSite: true,      // false = the menu toggle lasts only for this page load
    skipHosts: [],              // hostnames to leave alone, e.g. ['mail.google.com']

    text: {
      enabled: true,
      punctuation: false,       // true = shuffle punctuation too (destroys word shapes)
      title: true,              // the browser tab title
      attributes: true,         // alt / title / placeholder / aria-label
      inputValues: true,        // values sitting in <input> / <textarea>
      blankPseudoText: false,   // ::before/::after text can only be erased, not jumbled
    },

    media: {
      images: true,
      backgrounds: true,        // CSS background-image
      pseudoImages: 'hide',     // ::before/::after imagery: 'hide' or 'checker'
                                // ('checker' paints one behind every pseudo-element,
                                //  including the ones that never had an image)
      inlineSvg: true,
      video: true,
      canvas: true,
      canvasRepaintMs: 800,     // keep re-painting canvases the page redraws (0 = paint once)
      iframes: false,           // off: the script already runs inside frames and censors them
      favicon: true,
    },

    // What stands in for an image: a flat panel with its own hairline outline, so two
    // images side by side still read as two images, plus a small photo mark on anything
    // big enough to carry one.
    placeholder: {
      fill: '#edeff1',
      edge: 'rgba(0, 0, 0, 0.26)',
      glyph: '#98a0a8',
      showGlyph: true,                  // skipped automatically on small images
      pattern: 'none',                  // 'none', or 'checker' for the louder look
      checker: { size: 14, light: '#d8d8d8', dark: '#8a8a8a' },
    },

    hideUntilCensored: true,    // blank the page until the first pass finishes (no flash)
    revealFailsafeMs: 3000,
    allowRestore: true,         // keep originals in memory so the toggle can put them back

    keys: {
      toggle:     { key: 'c', ctrl: true, alt: true, shift: false },
      rescramble: { key: 'r', ctrl: true, alt: true, shift: false },
    },
  };

  /* ========================= which site are we on ========================= */

  // Frames are keyed by the hostname of the top-level page, not their own, so that
  // switching a site on also covers the ad/embed/widget frames inside it.
  function siteHost() {
    if (window.top === window.self) return location.hostname || location.protocol;
    try {
      const chain = location.ancestorOrigins;
      if (chain && chain.length) {
        const host = new URL(chain[chain.length - 1]).hostname;   // outermost = top
        if (host) return host;
      }
    } catch (e) {}
    try {
      if (window.top.location.hostname) return window.top.location.hostname;
    } catch (e) {}   // cross-origin and no ancestorOrigins (Firefox): fall back to our own
    return location.hostname || location.protocol;
  }

  const SITE = siteHost();
  const SITE_KEY = 'censor-site:' + SITE;

  if (CONFIG.skipHosts.indexOf(SITE) !== -1) return;

  // Tampermonkey and Violentmonkey give us synchronous storage; Greasemonkey 4 only
  // has the async GM.* API; a plain console paste has neither.
  const gmSync = (typeof GM_getValue === 'function' && typeof GM_setValue === 'function');
  const gmAsync = (typeof GM !== 'undefined' && GM && typeof GM.getValue === 'function') ? GM : null;

  function storeGet(key) {     // a value, a promise, or undefined when never set
    try {
      if (gmSync) return GM_getValue(key, undefined);
      if (gmAsync) return gmAsync.getValue(key, undefined);
      const raw = localStorage.getItem(key);
      return raw === null ? undefined : raw === 'true';
    } catch (e) { return undefined; }
  }

  function storeSet(key, val) {
    try {
      if (gmSync) { GM_setValue(key, val); return; }
      if (gmAsync) { gmAsync.setValue(key, val); return; }
      localStorage.setItem(key, String(val));
    } catch (e) {}
  }

  /* =============================== state =============================== */

  let enabled = false;
  let observer = null;
  let globalStyle = null;
  let hideStyle = null;
  let canvasTimer = null;
  let uiHost = null;

  // These are rebuilt from scratch on every enable(); disable() throws them away so
  // a second run re-registers everything instead of thinking it is already done.
  let textRec = new WeakMap();     // text node -> { orig, out }
  let elRec = new WeakMap();       // element -> record of what we changed
  let observedRoots = new WeakSet();
  const textLog = [];              // the same text records, iterable, for restore
  const elLog = [];                // [element, record] pairs, for restore
  const canvasLog = [];            // canvases to keep repainting

  /* ============================== scrambling ============================== */

  const LOWER = 'abcdefghijklmnopqrstuvwxyz';
  const UPPER = LOWER.toUpperCase();
  const DIGITS = '0123456789';
  const PUNCT = '!?#$%&*+-=@~^';

  // Non-Latin scripts: map each character to a random one from the same script, so
  // the page keeps its typographic colour instead of turning into rows of tofu.
  const SCRIPTS = [
    { from: [0x0370, 0x03ff], lower: [0x03b1, 0x03c9], upper: [0x0391, 0x03a9] }, // Greek
    { from: [0x0400, 0x04ff], lower: [0x0430, 0x044f], upper: [0x0410, 0x042f] }, // Cyrillic
    { from: [0x0590, 0x05ff], lower: [0x05d0, 0x05ea] },                          // Hebrew
    { from: [0x0600, 0x06ff], lower: [0x0627, 0x064a] },                          // Arabic
    { from: [0x0900, 0x097f], lower: [0x0915, 0x0939] },                          // Devanagari
    { from: [0x0e00, 0x0e7f], lower: [0x0e01, 0x0e2e] },                          // Thai
    { from: [0x3040, 0x309f], lower: [0x3042, 0x3093] },                          // Hiragana
    { from: [0x30a0, 0x30ff], lower: [0x30a2, 0x30f3] },                          // Katakana
    { from: [0x3400, 0x9fff], lower: [0x4e00, 0x9fa5] },                          // CJK
    { from: [0xac00, 0xd7a3], lower: [0xac00, 0xd7a3] },                          // Hangul
  ];

  const pick = (s) => s.charAt((Math.random() * s.length) | 0);
  const pickCode = (r) => String.fromCharCode(r[0] + ((Math.random() * (r[1] - r[0] + 1)) | 0));

  let isLetter;
  try {
    const letterRe = new RegExp('\\p{L}', 'u');
    isLetter = (ch) => letterRe.test(ch);
  } catch (e) {
    isLetter = () => false;
  }
  const asciiPunctRe = /[^A-Za-z0-9\s]/;

  function scramble(str) {
    let out = '';
    for (const ch of str) {
      if (ch >= 'a' && ch <= 'z') { out += pick(LOWER); continue; }
      if (ch >= 'A' && ch <= 'Z') { out += pick(UPPER); continue; }
      if (ch >= '0' && ch <= '9') { out += pick(DIGITS); continue; }

      const code = ch.codePointAt(0);
      if (code < 0x80) {
        // ascii punctuation and whitespace: kept by default so layout survives
        out += (CONFIG.text.punctuation && asciiPunctRe.test(ch)) ? pick(PUNCT) : ch;
        continue;
      }

      let done = false;
      for (const s of SCRIPTS) {
        if (code >= s.from[0] && code <= s.from[1]) {
          const upper = s.upper && ch === ch.toUpperCase() && ch !== ch.toLowerCase();
          out += pickCode(upper ? s.upper : s.lower);
          done = true;
          break;
        }
      }
      if (done) continue;

      out += isLetter(ch) ? pick(LOWER) : ch;
    }
    return out;
  }

  /* ============================== placeholders ============================== */

  const uriCache = new Map();

  // A photo mark on a 24x24 grid: frame, sun, horizon.
  const GLYPH_PATHS =
    '<rect x="2.5" y="4.5" width="19" height="15" rx="2"/>' +
    '<circle cx="8.5" cy="10" r="1.8"/>' +
    '<path d="M3 17.5l5.5-5 3.5 3.5 3.5-3.5 5.5 5"/>';

  // The mark on its own, for elements we style instead of handing an <img> src.
  // background-size caps it, and the viewBox keeps it square inside a non-square box.
  function glyphURI() {
    let uri = uriCache.get('glyph');
    if (uri) return uri;
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 24 24" ' +
      'fill="none" stroke="' + CONFIG.placeholder.glyph + '" stroke-width="0.9" ' +
      'stroke-linejoin="round" stroke-linecap="round">' + GLYPH_PATHS + '</svg>';
    uri = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    uriCache.set('glyph', uri);
    return uri;
  }

  // Never wider than 40px, never more than 45% of the box, so it fits a hero banner
  // and a 20px icon alike.
  const GLYPH_SIZE = 'min(40px, 45%) min(40px, 45%)';

  function checkerGradient() {
    const d = CONFIG.placeholder.checker.dark;
    return 'linear-gradient(45deg, ' + d + ' 25%, transparent 25%, transparent 75%, ' + d + ' 75%, ' + d + ')';
  }

  // The stand-in image, drawn at the exact pixel size of what it replaces: panel,
  // optional photo mark, and a hairline outline last so it sits on top of everything.
  function placeholderURI(w, h) {
    w = Math.max(1, Math.min(4000, Math.round(w)));
    h = Math.max(1, Math.min(4000, Math.round(h)));
    const key = w + 'x' + h;
    const cached = uriCache.get(key);
    if (cached) return cached;

    const p = CONFIG.placeholder;
    let defs = '';
    let body;

    if (p.pattern === 'checker') {
      const s = p.checker.size;
      defs = '<defs><pattern id="c" width="' + (s * 2) + '" height="' + (s * 2) + '" patternUnits="userSpaceOnUse">' +
        '<rect width="' + (s * 2) + '" height="' + (s * 2) + '" fill="' + p.checker.light + '"/>' +
        '<rect width="' + s + '" height="' + s + '" fill="' + p.checker.dark + '"/>' +
        '<rect x="' + s + '" y="' + s + '" width="' + s + '" height="' + s + '" fill="' + p.checker.dark + '"/>' +
        '</pattern></defs>';
      body = '<rect width="100%" height="100%" fill="url(#c)"/>';
    } else {
      body = '<rect width="100%" height="100%" fill="' + p.fill + '"/>';
    }

    const min = Math.min(w, h);
    if (p.showGlyph && min >= 44) {
      const g = Math.max(20, Math.min(56, min * 0.3));
      const k = g / 24;                        // the mark is drawn on a 24x24 grid
      const sw = (1.5 / k).toFixed(2);         // keeps the stroke ~1.5px at any size
      body +=
        '<g transform="translate(' + ((w - g) / 2).toFixed(1) + ' ' + ((h - g) / 2).toFixed(1) +
        ') scale(' + k.toFixed(4) + ')" fill="none" stroke="' + p.glyph + '" stroke-width="' + sw +
        '" stroke-linejoin="round" stroke-linecap="round">' + GLYPH_PATHS + '</g>';
    }

    body += '<rect x="0.5" y="0.5" width="' + (w - 1) + '" height="' + (h - 1) +
            '" fill="none" stroke="' + p.edge + '" stroke-width="1"/>';

    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h +
                '" viewBox="0 0 ' + w + ' ' + h + '">' + defs + body + '</svg>';
    const uri = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    if (uriCache.size < 400) uriCache.set(key, uri);
    return uri;
  }

  // For everything we cannot hand an <img> src to: CSS backgrounds, masked icons,
  // inline SVG, video, canvas. The inset shadow draws the same hairline edge at
  // whatever size the element turns out to be.
  // `withGlyph` is for elements that stood in for a picture — inline SVG, canvas.
  // Plain CSS backgrounds skip it: most of them are texture and sprite icons, and a
  // mark on every one of those is noise.
  function panelCSS(withGlyph) {
    const p = CONFIG.placeholder;
    const glyph = (withGlyph && p.showGlyph) ? 'url("' + glyphURI() + '")' : null;
    const css = {
      'background-color': p.fill,
      'box-shadow': 'inset 0 0 0 1px ' + p.edge,
      'background-attachment': 'scroll',
      'background-origin': 'padding-box',
      'background-clip': 'border-box',
    };

    if (p.pattern === 'checker') {
      const s = p.checker.size;
      const g = checkerGradient();
      const tile = (s * 2) + 'px ' + (s * 2) + 'px';
      css['background-color'] = p.checker.light;
      css['background-image'] = (glyph ? glyph + ', ' : '') + g + ', ' + g;
      css['background-size'] = (glyph ? GLYPH_SIZE + ', ' : '') + tile + ', ' + tile;
      css['background-position'] = (glyph ? 'center center, ' : '') + '0 0, ' + s + 'px ' + s + 'px';
      css['background-repeat'] = (glyph ? 'no-repeat, ' : '') + 'repeat, repeat';
    } else if (glyph) {
      css['background-image'] = glyph;    // replacing background-image is what hides the original
      css['background-size'] = GLYPH_SIZE;
      css['background-position'] = 'center center';
      css['background-repeat'] = 'no-repeat';
    } else {
      css['background-image'] = 'none';
      css['background-repeat'] = 'repeat';
    }
    return css;
  }

  // A canvas is wiped rather than painted on, so the panel behind it shows through and
  // the page is free to keep drawing into a surface that stays blank.
  function blankCanvas(cv) {
    let ctx;
    try { ctx = cv.getContext('2d'); } catch (e) { ctx = null; }
    if (!ctx) return false;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.restore();
    return true;
  }

  /* ============================== bookkeeping ============================== */

  function rec(el) {
    let r = elRec.get(el);
    if (!r) {
      r = {};
      elRec.set(el, r);
      if (CONFIG.allowRestore) elLog.push([el, r]);
    }
    return r;
  }

  // Every style write goes through here so we can (a) restore it later and
  // (b) recognise our own mutations instead of looping on them.
  function setStyles(el, props) {
    const r = rec(el);
    if (r.style === undefined) r.style = el.getAttribute('style');
    for (const k in props) el.style.setProperty(k, props[k], 'important');
    r.applied = el.getAttribute('style');
  }

  function ourStyle(el) {
    const r = elRec.get(el);
    return !!r && r.applied !== undefined && el.getAttribute('style') === r.applied;
  }

  /* ============================== skip rules ============================== */

  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'TEXTAREA',
    'CANVAS', 'IFRAME', 'OBJECT', 'EMBED', 'VIDEO', 'AUDIO', 'MAP', 'AREA',
  ]);

  function skipText(node) {
    let el = node.parentNode;
    while (el) {
      if (el.nodeType === 11) { el = el.host; continue; }   // cross a shadow boundary
      if (el.nodeType !== 1) return false;
      const tag = el.tagName;
      if (SKIP_TAGS.has(tag)) return true;
      if (tag === 'TITLE' && !CONFIG.text.title) return true;
      if (el === uiHost) return true;
      if (el.hasAttribute && el.hasAttribute('data-censor-skip')) return true;
      // don't fight the user while they are typing in a rich text editor
      if (el.isContentEditable && el.contains(document.activeElement)) return true;
      el = el.parentNode;
    }
    return false;
  }

  function skipElement(el) {
    if (uiHost && (el === uiHost || (uiHost.contains && uiHost.contains(el)))) return true;
    if (el.closest && el.closest('[data-censor-skip]')) return true;
    return false;
  }

  /* ============================== text ============================== */

  function censorText(node) {
    if (!CONFIG.text.enabled) return;
    const cur = node.data;
    if (!cur || !/\S/.test(cur)) return;

    const r = textRec.get(node);
    if (r && r.out === cur) return;          // this is our own output, leave it alone
    if (skipText(node)) return;

    const out = scramble(cur);
    if (r) {
      r.orig = cur;
      r.out = out;
    } else {
      const nr = { node: node, orig: cur, out: out };
      textRec.set(node, nr);
      if (CONFIG.allowRestore) textLog.push(nr);
    }
    node.data = out;
  }

  const TEXT_ATTRS = ['alt', 'title', 'placeholder', 'aria-label', 'aria-placeholder', 'aria-description'];
  const VALUE_TYPES = new Set(['text', 'search', 'email', 'url', 'tel', 'number', 'submit', 'button', 'reset', '']);

  function censorAttrs(el) {
    if (!CONFIG.text.enabled) return;

    if (CONFIG.text.attributes) {
      for (const name of TEXT_ATTRS) {
        if (!el.hasAttribute(name)) continue;
        const cur = el.getAttribute(name);
        if (!cur || !/\S/.test(cur)) continue;
        const r = rec(el);
        if (!r.attrs) r.attrs = {};
        if (r.attrs[name] && r.attrs[name].out === cur) continue;
        const out = scramble(cur);
        r.attrs[name] = { orig: cur, out: out };
        el.setAttribute(name, out);
      }
    }

    if (CONFIG.text.inputValues) {
      const tag = el.tagName;
      if (tag !== 'INPUT' && tag !== 'TEXTAREA') return;
      if (el === document.activeElement) return;
      if (tag === 'INPUT' && !VALUE_TYPES.has((el.type || '').toLowerCase())) return;
      const cur = el.value;
      if (!cur || !/\S/.test(cur)) return;
      const r = rec(el);
      if (r.value && r.value.out === cur) return;
      const out = scramble(cur);
      r.value = { orig: cur, out: out };
      el.value = out;
    }
  }

  /* ============================== media ============================== */

  function censorImage(el) {
    const prev = elRec.get(el);
    if (prev && prev.appliedSrc && el.getAttribute('src') === prev.appliedSrc) return;

    // A lazy-loading placeholder has nothing on screen yet. Leave it alone and let
    // the observer call us back when the real src lands.
    if (!el.getAttribute('src') && !el.getAttribute('srcset') && !el.currentSrc) return;

    const r = rec(el);
    if (!r.img) {
      r.img = {
        src: el.getAttribute('src'),
        srcset: el.getAttribute('srcset'),
        sizes: el.getAttribute('sizes'),
      };
    }
    r.imgPending = true;

    const finish = () => {
      if (!enabled || !r.imgPending) return;
      r.imgPending = false;
      // Draw at the size the image is actually displayed at, so the outline stays a
      // crisp 1px and the mark keeps its proportions. A thumbnail shrunk from a large
      // original would otherwise get a hairline scaled down to nothing, which is exactly
      // when neighbouring images start to look like one image. Falling back to the
      // intrinsic size keeps the aspect ratio right when there is no layout yet.
      const box = el.getBoundingClientRect();
      const w = Math.round(box.width) || el.naturalWidth || el.width || 320;
      const h = Math.round(box.height) || el.naturalHeight || el.height || 200;
      r.appliedSrc = placeholderURI(w, h);
      el.removeAttribute('srcset');
      el.removeAttribute('sizes');
      el.setAttribute('src', r.appliedSrc);
      if (r.hidden) { setStyles(el, { visibility: 'visible' }); r.hidden = false; }
    };

    // Not loaded yet: hide it, wait for its real size, then swap. No flash of the
    // original, and the checkerboard inherits the intrinsic size so nothing reflows.
    // Already complete (decoded, or broken and never coming) means no event is left
    // to wait for, so go straight to the swap.
    if (el.complete) {
      finish();
    } else {
      setStyles(el, { visibility: 'hidden' });
      r.hidden = true;
      el.addEventListener('load', finish, { once: true });
      el.addEventListener('error', finish, { once: true });
      setTimeout(finish, 4000);
    }
  }

  function censorSource(el) {
    const r = rec(el);
    if (r.source) return;
    r.source = { srcset: el.getAttribute('srcset'), src: el.getAttribute('src') };
    el.removeAttribute('srcset');
    el.removeAttribute('src');
  }

  function censorSvg(el) {
    const r = rec(el);
    if (r.svg) return;
    r.svg = true;
    el.setAttribute('data-censored-svg', '');   // the stylesheet hides its children
    setStyles(el, panelCSS(true));
  }

  function censorVideo(el) {
    const r = rec(el);
    if (r.video) return;
    const box = el.getBoundingClientRect();
    const w = el.videoWidth || el.width || box.width || 480;
    const h = el.videoHeight || el.height || box.height || 270;

    r.video = {
      src: el.getAttribute('src'),
      poster: el.getAttribute('poster'),
      autoplay: el.autoplay,
      sources: [],
    };
    for (const s of Array.from(el.querySelectorAll('source'))) {
      r.video.sources.push([s, s.parentNode]);
      s.remove();
    }
    try { el.pause(); } catch (e) {}
    el.autoplay = false;
    el.removeAttribute('src');
    try { el.load(); } catch (e) {}
    el.setAttribute('poster', placeholderURI(w, h));   // a source-less video renders its poster
    setStyles(el, panelCSS());
  }

  function censorCanvas(el) {
    const r = rec(el);
    if (r.canvas) return;
    r.canvas = true;
    if (blankCanvas(el)) {
      setStyles(el, panelCSS(true));
      if (CONFIG.media.canvasRepaintMs > 0) canvasLog.push(el);
    } else {
      // WebGL or a context we cannot grab: hiding it is the only reliable cover
      setStyles(el, { visibility: 'hidden' });
      r.canvasHidden = true;
    }
  }

  function iframeDoc() {
    const p = CONFIG.placeholder;
    let bg = 'background-color:' + p.fill;
    if (p.pattern === 'checker') {
      const s = p.checker.size;
      const g = checkerGradient();
      bg = 'background-color:' + p.checker.light + ';background-image:' + g + ',' + g +
           ';background-size:' + (s * 2) + 'px ' + (s * 2) + 'px' +
           ';background-position:0 0,' + s + 'px ' + s + 'px';
    }
    return '<!doctype html><meta charset="utf-8"><style>html,body{margin:0;height:100%}' +
           'body{' + bg + ';box-sizing:border-box;border:1px solid ' + p.edge + '}</style>';
  }

  function censorIframe(el) {
    const r = rec(el);
    if (r.iframe) return;
    r.iframe = { src: el.getAttribute('src'), srcdoc: el.getAttribute('srcdoc') };
    el.setAttribute('srcdoc', iframeDoc());
    el.removeAttribute('src');
  }

  function hasImageURL(v) {
    return !!v && v !== 'none' && v.indexOf('url(') !== -1;
  }

  // CSS imagery: background-image, and mask-image, which is how most modern UIs
  // (Wikipedia, GitHub, anything on a design system) draw their icons.
  function censorBackground(el) {
    const r = elRec.get(el);
    if (r && r.bg) return;
    let cs;
    try { cs = getComputedStyle(el); } catch (e) { return; }

    const bg = hasImageURL(cs.backgroundImage);   // plain gradients are left alone
    const mask = hasImageURL(cs.getPropertyValue('mask-image')) ||
                 hasImageURL(cs.getPropertyValue('-webkit-mask-image'));
    if (!bg && !mask) return;

    rec(el).bg = true;
    const props = panelCSS();
    if (mask) {
      props['mask-image'] = 'none';
      props['-webkit-mask-image'] = 'none';
    }
    setStyles(el, props);
  }

  function censorFavicon() {
    if (!CONFIG.media.favicon || !document.head) return;
    const uri = placeholderURI(64, 64);
    let found = false;
    for (const link of Array.from(document.querySelectorAll('link[rel]'))) {
      if (!/\bicon\b/i.test(link.getAttribute('rel') || '')) continue;
      found = true;
      if (link.getAttribute('href') === uri) continue;
      const r = rec(link);
      if (!r.icon) r.icon = { href: link.getAttribute('href') };
      link.setAttribute('href', uri);
    }
    if (!found) {
      const link = document.createElement('link');
      link.rel = 'icon';
      link.href = uri;
      link.setAttribute('data-censor-added', '');
      document.head.appendChild(link);
    }
  }

  /* ============================== element dispatch ============================== */

  function visitElement(el) {
    if (skipElement(el)) return;
    const tag = el.localName;

    censorAttrs(el);

    if (CONFIG.media.images) {
      if (tag === 'img') { censorImage(el); return; }
      if (tag === 'source') { censorSource(el); return; }
      if (tag === 'input' && (el.type || '').toLowerCase() === 'image') { censorImage(el); return; }
    }
    if (CONFIG.media.inlineSvg && tag === 'svg') { censorSvg(el); return; }
    if (CONFIG.media.video && (tag === 'video' || tag === 'audio')) { censorVideo(el); return; }
    if (CONFIG.media.canvas && tag === 'canvas') { censorCanvas(el); return; }
    if (CONFIG.media.iframes && (tag === 'iframe' || tag === 'frame')) { censorIframe(el); return; }
    if (CONFIG.media.backgrounds) censorBackground(el);
  }

  /* ============================== traversal ============================== */

  function walk(root) {
    if (!root) return;
    if (root.nodeType === 1) {
      visitElement(root);
      if (root.shadowRoot) { observeRoot(root.shadowRoot); walk(root.shadowRoot); }
    }
    let walker;
    try {
      walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, null);
    } catch (e) { return; }
    let n;
    while ((n = walker.nextNode())) {
      if (n.nodeType === 3) {
        censorText(n);
      } else {
        visitElement(n);
        if (n.shadowRoot) { observeRoot(n.shadowRoot); walk(n.shadowRoot); }
      }
    }
  }

  /* ============================== mutations ============================== */

  const WATCHED_ATTRS = ['src', 'srcset', 'sizes', 'poster', 'style', 'class', 'href',
    'alt', 'title', 'placeholder', 'aria-label', 'value'];

  function onMutations(records) {
    if (!enabled) return;
    for (const m of records) {
      if (m.type === 'characterData') {
        censorText(m.target);
      } else if (m.type === 'childList') {
        for (const n of m.addedNodes) {
          if (n.nodeType === 3) censorText(n);
          else if (n.nodeType === 1) walk(n);
        }
      } else if (m.type === 'attributes') {
        const el = m.target;
        if (el.nodeType !== 1) continue;
        const name = m.attributeName;
        const r = elRec.get(el);
        if (name === 'style' && ourStyle(el)) continue;
        if (name === 'src' && r && r.appliedSrc && el.getAttribute('src') === r.appliedSrc) continue;
        if ((name === 'srcset' || name === 'sizes') && r && r.appliedSrc) continue;
        if (name === 'href') { if (el.localName === 'link') censorFavicon(); continue; }
        // the site overwrote something we had censored, so censor it again
        if (r) { r.bg = false; r.svg = false; r.canvas = false; }
        visitElement(el);
      }
    }
  }

  function observeRoot(root) {
    if (!observer || observedRoots.has(root)) return;
    observedRoots.add(root);
    observer.observe(root, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: WATCHED_ATTRS,
    });
  }

  /* ============================== global css ============================== */

  function injectGlobalCSS() {
    if (globalStyle) return;
    const s = CONFIG.placeholder.checker.size;
    const g = checkerGradient();
    let css =
      '[data-censored-svg] > * { visibility: hidden !important; }\n';
    if (CONFIG.media.backgrounds) {
      // Pseudo-elements cannot take inline styles, and CSS has no way to ask
      // "only if you already have an image", so it is all of them or none.
      css += (CONFIG.media.pseudoImages === 'checker')
        ? '*::before, *::after { background-image: ' + g + ', ' + g + ' !important;' +
          ' background-size: ' + (s * 2) + 'px ' + (s * 2) + 'px !important;' +
          ' background-position: 0 0, ' + s + 'px ' + s + 'px !important; }\n'
        : '*::before, *::after { background-image: none !important; }\n';
      // a masked pseudo-element would otherwise keep showing its icon silhouette
      css += '*::before, *::after { mask-image: none !important; -webkit-mask-image: none !important; }\n';
      css += '* { list-style-image: none !important; border-image-source: none !important; }\n';
    }
    if (CONFIG.text.blankPseudoText) {
      css += '*::before, *::after { content: "" !important; }\n';
    }
    globalStyle = document.createElement('style');
    globalStyle.setAttribute('data-censor-skip', '');
    globalStyle.textContent = css;
    (document.head || document.documentElement).appendChild(globalStyle);
  }

  function setHidden(on) {
    if (!CONFIG.hideUntilCensored) return;
    if (on) {
      if (hideStyle) return;
      hideStyle = document.createElement('style');
      hideStyle.setAttribute('data-censor-skip', '');
      hideStyle.textContent = 'html { visibility: hidden !important; }';
      (document.head || document.documentElement).appendChild(hideStyle);
      setTimeout(() => setHidden(false), CONFIG.revealFailsafeMs);   // never leave a blank page
    } else if (hideStyle) {
      hideStyle.remove();
      hideStyle = null;
    }
  }

  /* ============================== enable / disable ============================== */

  // `initial` = we are censoring from page load, so blank the page until the first
  // pass lands. Switching it on by hand later has nothing to hide from.
  function enable(initial) {
    if (enabled) return;
    enabled = true;
    if (initial) setHidden(true);
    injectGlobalCSS();

    observer = new MutationObserver(onMutations);
    observeRoot(document);

    try {
      walk(document.documentElement);
      censorFavicon();
    } catch (e) {
      console.error('[total-censor]', e);
    }
    setHidden(false);

    if (CONFIG.media.canvas && CONFIG.media.canvasRepaintMs > 0 && !canvasTimer) {
      canvasTimer = setInterval(() => {
        for (let i = canvasLog.length - 1; i >= 0; i--) {
          const cv = canvasLog[i];
          if (!cv.isConnected) { canvasLog.splice(i, 1); continue; }
          blankCanvas(cv);
        }
      }, CONFIG.media.canvasRepaintMs);
    }
  }

  function disable() {
    if (!enabled) return;
    enabled = false;

    if (observer) { observer.disconnect(); observer = null; }
    if (canvasTimer) { clearInterval(canvasTimer); canvasTimer = null; }
    if (globalStyle) { globalStyle.remove(); globalStyle = null; }

    for (const r of textLog) {
      if (r.node.data === r.out) r.node.data = r.orig;
    }

    for (let i = elLog.length - 1; i >= 0; i--) {
      const el = elLog[i][0];
      const r = elLog[i][1];
      try {
        if (r.img) {
          el.removeAttribute('src');
          if (r.img.src != null) el.setAttribute('src', r.img.src);
          if (r.img.srcset != null) el.setAttribute('srcset', r.img.srcset);
          if (r.img.sizes != null) el.setAttribute('sizes', r.img.sizes);
        }
        if (r.source) {
          if (r.source.srcset != null) el.setAttribute('srcset', r.source.srcset);
          if (r.source.src != null) el.setAttribute('src', r.source.src);
        }
        if (r.svg) el.removeAttribute('data-censored-svg');
        if (r.video) {
          for (const pair of r.video.sources) pair[1].appendChild(pair[0]);
          el.removeAttribute('poster');
          if (r.video.poster != null) el.setAttribute('poster', r.video.poster);
          if (r.video.src != null) el.setAttribute('src', r.video.src);
          el.autoplay = r.video.autoplay;
          try { el.load(); } catch (e) {}
        }
        if (r.iframe) {
          el.removeAttribute('srcdoc');
          if (r.iframe.srcdoc != null) el.setAttribute('srcdoc', r.iframe.srcdoc);
          if (r.iframe.src != null) el.setAttribute('src', r.iframe.src);
        }
        if (r.icon && r.icon.href != null) el.setAttribute('href', r.icon.href);
        if (r.attrs) {
          for (const name in r.attrs) {
            if (el.getAttribute(name) === r.attrs[name].out) el.setAttribute(name, r.attrs[name].orig);
          }
        }
        if (r.value && el.value === r.value.out) el.value = r.value.orig;
        if (r.style !== undefined) {
          if (r.style === null) el.removeAttribute('style');
          else el.setAttribute('style', r.style);
        }
      } catch (e) { /* element is gone; nothing to restore */ }
    }

    for (const link of Array.from(document.querySelectorAll('link[data-censor-added]'))) link.remove();

    textLog.length = 0;
    elLog.length = 0;
    canvasLog.length = 0;
    textRec = new WeakMap();
    elRec = new WeakMap();
    observedRoots = new WeakSet();
    // canvases cannot be un-painted: only a reload brings their pixels back
  }

  function rescramble() {
    if (!enabled) return;
    for (const r of textLog) {
      if (r.node.data !== r.out) continue;
      r.out = scramble(r.orig);
      r.node.data = r.out;
    }
    for (const pair of elLog) {
      const el = pair[0];
      const r = pair[1];
      if (r.attrs) {
        for (const name in r.attrs) {
          const a = r.attrs[name];
          if (el.getAttribute(name) !== a.out) continue;
          a.out = scramble(a.orig);
          el.setAttribute(name, a.out);
        }
      }
      if (r.value && el.value === r.value.out) {
        r.value.out = scramble(r.value.orig);
        el.value = r.value.out;
      }
    }
  }

  /* ========================= the per-site switch ========================= */

  // Applies a state without touching storage. Used by the storage listener so other
  // tabs and frames on the same site follow along.
  function applyState(on, initial) {
    if (on === enabled) return;
    if (on) enable(initial); else disable();
    registerMenu();
  }

  function toggle() {
    const next = !enabled;
    applyState(next, false);
    if (CONFIG.rememberPerSite) storeSet(SITE_KEY, next);
    toast(next ? ('Censoring ' + SITE) : ('Uncensored ' + SITE));
    return next;
  }

  let menuIds = [];
  function registerMenu() {
    if (typeof GM_registerMenuCommand !== 'function') return;
    if (window.top !== window.self) return;   // one set of menu entries, not one per frame
    if (typeof GM_unregisterMenuCommand === 'function') {
      for (const id of menuIds) { try { GM_unregisterMenuCommand(id); } catch (e) {} }
      menuIds = [];
    } else if (menuIds.length) {
      return;   // no way to replace the old entries, so leave the first ones in place
    }
    menuIds.push(GM_registerMenuCommand(
      enabled ? ('■ Stop censoring ' + SITE) : ('▶ Censor ' + SITE), toggle));
    if (enabled) {
      menuIds.push(GM_registerMenuCommand('↻ Re-jumble', rescramble));
    }
  }

  // Keep every tab and frame on this site in step with the switch.
  if (typeof GM_addValueChangeListener === 'function') {
    try {
      GM_addValueChangeListener(SITE_KEY, (name, oldVal, newVal) => {
        applyState(newVal === undefined ? CONFIG.defaultOn : !!newVal, false);
      });
    } catch (e) {}
  }

  /* ============================== tiny ui ============================== */

  let toastTimer = null;
  function toast(msg) {
    if (window.top !== window.self) return;   // only the top frame reports
    if (!uiHost) {
      uiHost = document.createElement('div');
      uiHost.setAttribute('data-censor-skip', '');
      uiHost.style.cssText = 'all:initial;position:fixed;z-index:2147483647;right:12px;bottom:12px;';
      const root = uiHost.attachShadow ? uiHost.attachShadow({ mode: 'open' }) : uiHost;
      const box = document.createElement('div');
      box.style.cssText =
        'font:600 12px/1.4 system-ui,sans-serif;color:#fff;background:#111;opacity:0;' +
        'padding:6px 10px;border-radius:6px;transition:opacity .15s;box-shadow:0 2px 10px rgba(0,0,0,.4)';
      root.appendChild(box);
      uiHost.__box = box;
    }
    if (!uiHost.isConnected) (document.body || document.documentElement).appendChild(uiHost);
    uiHost.__box.textContent = msg;
    uiHost.__box.style.opacity = '1';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { uiHost.__box.style.opacity = '0'; }, 1200);
  }

  function matches(e, k) {
    return !!e.key && e.key.toLowerCase() === k.key &&
      !!e.ctrlKey === !!k.ctrl && !!e.altKey === !!k.alt && !!e.shiftKey === !!k.shift;
  }

  window.addEventListener('keydown', (e) => {
    if (matches(e, CONFIG.keys.toggle)) {
      e.preventDefault();
      toggle();
    } else if (matches(e, CONFIG.keys.rescramble) && enabled) {
      e.preventDefault();
      rescramble();
      toast('Re-jumbled');
    }
  }, true);

  // debug / scripting handle. Defined on the page window too, where the console can
  // reach it; under a sandbox that write may be refused, which is not worth caring about.
  (function exposeHandle() {
    const api = {
      toggle: toggle, enable: enable, disable: disable, rescramble: rescramble,
      scramble: scramble, CONFIG: CONFIG, site: SITE,
      get enabled() { return enabled; },
    };
    const targets = [window];
    if (typeof unsafeWindow !== 'undefined' && unsafeWindow) targets.push(unsafeWindow);
    for (const t of targets) {
      try { Object.defineProperty(t, '__censor', { value: api, configurable: true }); } catch (e) {}
    }
  })();

  /* ============================== boot ============================== */

  // Late passes catch anything that slipped past the observer, plus images and
  // stylesheet-driven backgrounds that only resolve once the page has loaded.
  document.addEventListener('DOMContentLoaded', () => {
    if (enabled) { walk(document.documentElement); censorFavicon(); }
  });
  window.addEventListener('load', () => {
    if (enabled) { walk(document.documentElement); censorFavicon(); }
  });

  function start(stored) {
    applyState(stored === undefined || stored === null ? CONFIG.defaultOn : !!stored, true);
    registerMenu();   // applyState only re-registers when the state actually changed
  }

  const stored = CONFIG.rememberPerSite ? storeGet(SITE_KEY) : undefined;
  if (stored && typeof stored.then === 'function') {
    // Greasemonkey 4: we only learn the answer after the page has started drawing
    stored.then(start, () => start(undefined));
  } else {
    start(stored);
  }
})();
