# page-censor-userscript

A browser userscript that censors a page completely: every visible letter becomes a random
letter, every digit a random digit, and every image, video, canvas, icon and background
becomes a checkerboard.

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

It runs at `document-start` on every page and inside every frame.

## Hotkeys

| Key | Action |
| --- | --- |
| `Ctrl+Alt+C` | Toggle censorship on/off |
| `Ctrl+Alt+R` | Re-jumble with fresh randomness |

Both are also available from the userscript manager's menu.

## What gets censored

| Target | How |
| --- | --- |
| Text nodes | Each letter → random letter (case preserved), each digit → random digit. Spaces and punctuation are kept, so layout and word shapes survive. |
| Non-Latin text | Greek, Cyrillic, Hebrew, Arabic, Devanagari, Thai, Hiragana, Katakana, CJK and Hangul are replaced with random characters from the *same* script. |
| `<img>`, `<input type="image">`, `<picture>` | `src` is swapped for a checkerboard SVG generated at the image's real intrinsic size, so nothing reflows. |
| CSS `background-image` | Replaced with a checkerboard gradient. Plain gradients are left alone. |
| `mask-image` icons | Mask stripped and checkerboarded. This is how Wikipedia, GitHub and most design systems draw their icons; without this step every icon silhouette leaks through. |
| Inline `<svg>` | Children hidden, checkerboard on the root. |
| `<video>` | Paused, sources stripped, poster replaced with a checkerboard. |
| `<canvas>` | Checkerboard painted into the 2D context, and repainted on an interval so apps that redraw don't win. |
| Tab title, favicon | Jumbled / checkerboarded. |
| `alt`, `title`, `placeholder`, `aria-label` | Jumbled. |
| Input and textarea values | Jumbled (see caveats). |

A `MutationObserver` re-censors anything the page adds or overwrites afterwards, including
content inside open shadow roots. The page is held invisible until the first pass completes
(with a 3 s failsafe) so there is no flash of real content on load.

## Caveats

- **Form submissions.** Input values are jumbled in the DOM, so submitting a form sends the
  jumbled text. Set `text.inputValues: false` if that matters. The focused field is skipped
  so you can still type, and password fields are never touched.
- **`::before` / `::after` text.** CSS content isn't in the DOM and can't be jumbled. Their
  imagery is removed; set `text.blankPseudoText: true` to blank the text too.
- **Canvas.** Toggling off restores text, images, backgrounds and attributes, but a canvas
  can't be un-painted — that needs a reload.
- **WebGL canvases** are hidden rather than checkerboarded, since there's no 2D context to
  paint into.

## Configuration

Everything lives in the `CONFIG` block at the top of the script:

```js
checker: { size: 14, light: '#d8d8d8', dark: '#8a8a8a' },   // checkerboard look
skipHosts: ['mail.example.com'],                            // leave these sites alone
text:  { punctuation: false, inputValues: true, ... },      // per-feature switches
media: { images: true, backgrounds: true, canvas: true, iframes: false, ... },
keys:  { toggle: { key: 'c', ctrl: true, alt: true } },     // hotkeys
```

## Testing

[`test-page.html`](test-page.html) exercises every censoring path — Latin and non-Latin text,
`<img>` with and without explicit dimensions, a CSS background, an inline SVG, a canvas, form
fields, a table, and content added after load. Open it with the userscript enabled, or serve
the folder and load the script with a `<script>` tag.
