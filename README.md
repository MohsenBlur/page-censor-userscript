# page-censor-userscript

A browser userscript that censors a page completely: every visible letter becomes a random
letter, every digit a random digit, and every image, video, canvas, icon and background is
replaced with a blank placeholder.

The page keeps its shape — spacing, punctuation, word lengths, image dimensions and layout
all survive — so it still *looks* like the page it was. It just says nothing.

Useful for screenshots of real interfaces, screen sharing, demos and recordings where the
content is confidential but the layout is the point.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) or
   [Violentmonkey](https://violentmonkey.github.io/).
2. Open the dashboard → **Create a new script**.
3. Replace the template with the contents of [`total-censor.user.js`](total-censor.user.js)
   and save.

## Switching it on

**The script does nothing until you turn it on for a site.** Open the userscript manager's
toolbar popup, where it lists the scripts running on the page, and click the entry under
*Total Censor*:

- **▶ Censor example.com** — censors the page now
- **■ Stop censoring example.com** — puts the real page back
- **↻ Re-jumble** — new random text, same page

The choice is remembered per domain, so a site you switched on comes up censored on every
later visit until you switch it off again. Frames are keyed to the hostname of the *top*
page, so turning a site on also covers the embeds and widgets inside it.

`Ctrl+Alt+C` does the same as the menu entry, and `Ctrl+Alt+R` re-jumbles.

To have it censor everything by default instead, set `defaultOn: true` in `CONFIG` — the
per-site memory then records the sites you switch *off*.

## What gets censored

| Target | How |
| --- | --- |
| Text nodes | Each letter → random letter (case preserved), each digit → random digit. Spaces and punctuation are kept, so layout and word shapes survive. |
| Non-Latin text | Greek, Cyrillic, Hebrew, Arabic, Devanagari, Thai, Hiragana, Katakana, CJK and Hangul are replaced with random characters from the *same* script. |
| `<img>`, `<input type="image">`, `<picture>` | `src` is swapped for a placeholder drawn at the image's exact displayed size, so nothing reflows. |
| CSS `background-image` | Replaced with a flat panel. Plain gradients are left alone. |
| `mask-image` icons | Mask stripped and panelled. This is how Wikipedia, GitHub and most design systems draw their icons; without this step every icon silhouette leaks through. |
| Inline `<svg>` | Children hidden, placeholder on the root. |
| `<video>` | Paused, sources stripped, poster replaced with a placeholder. |
| `<canvas>` | Wiped, and re-wiped on an interval so apps that redraw don't win. |
| Tab title, favicon | Jumbled / blanked. |
| `alt`, `title`, `placeholder`, `aria-label` | Jumbled. |
| Input and textarea values | Jumbled (see caveats). |

A `MutationObserver` re-censors anything the page adds or overwrites afterwards, including
content inside open shadow roots. On a site that is switched on, the page is held invisible
until the first pass completes (with a 3 s failsafe) so there is no flash of real content.

## The placeholder

A flat panel with a 1px inset outline, plus a small photo mark on anything big enough to
carry one. The outline is the point: a gallery of images with no gaps between them still
reads as separate images rather than one big grey slab. Placeholders are drawn at each
image's *rendered* size, so the outline stays a crisp 1px on a thumbnail scaled down from a
large original.

Prefer the louder look? Set `placeholder.pattern: 'checker'` for a checkerboard fill, which
keeps the outline and the mark on top of it.

## Caveats

- **Form submissions.** Input values are jumbled in the DOM, so submitting a form sends the
  jumbled text. Set `text.inputValues: false` if that matters. The focused field is skipped
  so you can still type, and password fields are never touched.
- **`::before` / `::after` text.** CSS content isn't in the DOM and can't be jumbled. Their
  imagery is removed; set `text.blankPseudoText: true` to blank the text too.
- **Canvas.** Switching a site off restores text, images, backgrounds and attributes, but a
  wiped canvas can't be brought back — that needs a reload.
- **WebGL canvases** are hidden rather than panelled, since there's no 2D context to wipe.
- **Firefox cross-origin frames.** Frames resolve the top page's hostname through
  `location.ancestorOrigins`, which Firefox doesn't implement. There, a cross-origin frame
  falls back to its own hostname and is only censored if that domain is switched on too.

## Configuration

Everything lives in the `CONFIG` block at the top of the script:

```js
defaultOn: false,                        // true = censor every site unless switched off
rememberPerSite: true,                   // false = the toggle lasts only for this page load
skipHosts: ['mail.example.com'],         // never offer to censor these
placeholder: { fill, edge, glyph, showGlyph, pattern },
text:  { punctuation: false, inputValues: true, ... },
media: { images: true, backgrounds: true, canvas: true, iframes: false, ... },
keys:  { toggle: { key: 'c', ctrl: true, alt: true } },
```

## Testing

[`test-page.html`](test-page.html) exercises every censoring path — Latin and non-Latin text,
images with and without explicit dimensions, a gapless gallery, touching thumbnails, a CSS
background, an inline SVG, a canvas, form fields, a table, and content added after load. It
ships with a stand-in for the userscript manager: localStorage-backed GM storage and a panel
that renders the script's menu commands as buttons, so the whole switch-on flow works by
opening the file — no extension needed.
