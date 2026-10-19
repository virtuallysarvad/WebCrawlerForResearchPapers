# Paper Crawler

A browser app where a procedurally animated, inverse-kinematics spider drops onto a
real arXiv paper on a silk thread, walks across the text, plants its feet on actual
words, and leaves research-style annotations. As it enters each section, Claude
streams a short explanation into a dark glass panel on the right. Select any passage
and press `E` to have the spider run to it and Claude explain just that passage.

Plain HTML/CSS/JavaScript ES modules. No frameworks, no build step, no npm packages.
The backend is Python's standard library only.

---

## Quick start

```powershell
# 1. Download a paper (metadata + HTML into papers/)
python fetch_paper.py 1706.03762

# 2. Start the local server
python serve.py

# 3. Open http://localhost:5173
```

Two demo papers are already downloaded:

- `1706.03762` - Attention Is All You Need
- `1810.04805` - BERT: Pre-training of Deep Bidirectional Transformers

Download more (an arXiv ID or a full arXiv URL):

```powershell
python fetch_paper.py 2005.14165
python fetch_paper.py https://arxiv.org/abs/1512.03385
python fetch_paper.py --batch "1706.03762 1810.04805 2005.14165"
```

### Enable Claude

```powershell
Copy-Item .env.example .env
# Edit .env and set ANTHROPIC_API_KEY=sk-ant-...
python serve.py
```

`.env` and `cache/` are in `.gitignore`. The key is read only by `serve.py`; the
frontend calls `/api/explain` and never receives the key. The default model is
`claude-sonnet-4-5`, configurable with `CLAUDE_MODEL` in the environment or `.env`.

Without a key, the spider, word anchoring, markup effects and crawler notes all work.
The panel shows a clear "AI is off / no key" message instead of failing silently.

---

## Controls

| Input | Action |
| --- | --- |
| Move mouse over the paper | Spider chases the cursor |
| Click the paper | Send the spider to that point |
| `Space` | Pause / resume |
| `F` | Toggle camera follow |
| `T` | Toggle the TikTok-style title overlay |
| `1` / `2` / `3` | Markup intensity: calm / normal / wild |
| `B` / `S` / `R` | Explanation level: beginner / student / researcher |
| `E` | Explain the selected passage |
| `C` | Clear all persistent markup |
| `D` | Re-drop the spider from the top |
| `` ` `` | Debug IK overlay (also `?debug` in the URL) |

The camera follows at reading speed and stops before References. Manual scrolling
overrides auto-scroll for 2.5 seconds.

---

## Architecture in plain English

### 1. Getting the paper - `fetch_paper.py`

The browser cannot fetch `arxiv.org` due to CORS, so the paper is downloaded once:

1. Metadata comes from the arXiv Atom API (`export.arxiv.org/api/query`) and is
   parsed with `xml.etree.ElementTree`.
2. HTML is fetched from `https://arxiv.org/html/{id}`. If that has no usable HTML,
   the script falls back to `https://ar5iv.labs.arxiv.org/html/{id}`.
3. Relative `src` / `href` / `srcset` / `<object data>` URLs are rewritten to
   absolute URLs so figures still load from the local page. A `<base>` tag is added
   for anything the regex misses.
4. The result is saved as `papers/{id}.html` plus `papers/{id}.json`. The JSON is
   what `/api/papers` reads to populate the paper dropdown.
5. Requests use a descriptive User-Agent and a ~3 second politeness delay.
   `--batch` repeats this for several IDs.

If neither source provides HTML, the script prints a clear error: use a paper that
has an arXiv HTML or ar5iv version, or convert the PDF to HTML yourself.

### 2. Loading and annotating the page - `js/loader.js`

`PaperLoader` turns the saved HTML into a clean paper view:

- It clones the article, removes scripts/site chrome, rewrites relative asset URLs,
  and strips unsafe attributes. arXiv figures exported as `<object data="...svg">`
  are converted to `<img>` so they size and lazy-load like normal figures.
- The title, authors, date, category and arXiv link are rendered in a minimal header.
- Text blocks are found with a block selector (`p`, `li`, `td`, headings, captions).
  Only leaf blocks are wrapped so text is not duplicated.
- Every word becomes `<span class="w" data-sec="...">`, except inside `<math>`,
  `<code>`, `<pre>`, `<svg>` and similar no-wrap containers.
- Wrapping is lazy: `IntersectionObserver` wraps blocks as they approach the
  viewport. A 30k-character paper does not create 30k spans up front.
- Sections are detected from headings (Abstract, numbered sections and subsections,
  References). Each section stores a DOM `Range`, its text, its blocks and the
  blocks the spider actually walked. `getSectionText()` puts walked paragraphs
  first, then the rest, trimmed to 12,000 characters for the AI request.
- `findPhrase()` normalizes quotes/dashes/whitespace and matches the exact phrase
  (or a short window of words) the AI returns as `KEY:`.

The dropdown calls `loadPaper()` live, cancels stale loads with a token, resets the
analyst panel, and updates `?paper=` in the URL and `localStorage`. The title-overlay
caption is the exported `TITLE_OVERLAY_TEXT` constant at the top of `js/loader.js`;
change that one string to reword it.

### 3. The spider - `js/crawler.js` + `js/spider-draw.js`

The spider lives in **document coordinates**; drawing subtracts `scrollX/scrollY`.
That is why its feet stay on words while the page scrolls.

**Body and entrance.** The body is a small glossy black thorax + abdomen with a
white eye dot and two palps. It starts above the viewport, descends on one silk
thread with legs tucked, lands on the title/abstract, then splays its legs. The
thread stays anchored to the top of the screen, sways, and snaps after the spider
walks far enough.

**Two-bone IK.** Each leg has a hip, a knee and a foot. Given hip and foot
positions, the law of cosines computes the knee:

```text
d      = clamp(distance(hip, foot), |femur - tibia| + 2, femur + tibia)
a      = (femur^2 - tibia^2 + d^2) / (2d)
h      = sqrt(max(0, femur^2 - a^2))
knee   = hip + along * a + perpendicular * h * kneeSide
```

`kneeSide` is fixed per leg, so left legs bend one way and right legs the other.
Feet are clamped to the paper's bounds and to the leg's reachable annulus.

**Gait.** Alternating tetrapod: `L1 R2 L3 R4`, then `R1 L2 R3 L4`. A leg wants to
step when its planted foot drifts too far from its rest pose or the leg is nearly
over-extended. Steps are 125-180 ms with an eased lift-swing-plant arc. The planted
foot behaves like a pivot: moving the body changes the leg angle without sliding
the foot across the paper.

**Word anchoring.** `document.elementFromPoint()` finds the nearest `.w` span, link
or table cell under a foot. The foot stores a reference to that element plus its
local offset inside it. Each frame the element's `getBoundingClientRect()` is read
again, so scrolling, reflow and window resizing keep the foot attached. If the word
disappears or moves too far, the leg releases and re-steps.

**Motion.** Wandering picks blocks below the body, adds a small noise wobble, and
pauses for 1.2-3.4 s to "read". Mouse movement and clicks temporarily switch to
faster chase/point modes.

### 4. Research markup - `js/crawler.js` + `css/style.css`

Every foot plant can annotate the touched word, nearby words, or the line:

- `.m-box-teal/purple/orange/red/green` - thin rectangles
- `.m-hl-orange` - solid orange bar, dark bold text, sometimes promoted to a line
- `.m-hl-purple` - purple bar with white monospace text, used on section headings
- `.m-hl-magenta` - hot-pink bar, sometimes stretched
- `.m-hl-cyan` - full-row cyan bar
- `.m-hl-green` - light-green highlighter
- `.m-blowup` - numbers enlarged 2-3x in orange/red
- `.m-rotate-green` - phrase rotated about -70 degrees in green
- `.m-color-text` / `.m-color-orange` - recolored text
- `.m-underline-red`, `.m-key`, `.m-standalone` - supporting effects

Markup classes persist, producing an annotation trail. `C` removes them all.

**Smart targeting:** words matching metrics/results, CamelCase or ALL-CAPS model
names, known dataset names, citation markers, equation numbers and claim phrases
are classified before markup. Smart words get roughly 3x the markup probability
(`smart 2.4` vs `ordinary 0.8`), so the spider appears to hunt for what matters.

For performance, `update()` only reads the DOM and appends desired class changes to
a write queue. `commit()` applies the queue once per frame after `draw()`.

### 5. AI explainer - `js/analyst.js` + `serve.py`

**Trigger.** On paper load, the abstract is queued immediately as a TL;DR. Each new
section the spider enters is queued with `{paperId, title, section, text, level,
sectionSlug}`. Only one request streams at a time; the rest wait in a queue.
Switching papers aborts the active request and clears the queue.

**Transport.** `POST /api/explain` returns `text/event-stream`:

```text
event: meta    {cached, model, level, section}
event: delta   {text}                  # one chunk at a time
event: error   {error}                 # no key, API error, timeout
event: done    {cached, key, section, level}
```

The browser parses SSE manually with `fetch` + `ReadableStream`, so the explanation
types out live. A timeout and `AbortController` prevent stuck requests.

**Prompt.** `serve.py` keeps the prompt in one `PROMPT_TEMPLATE` constant. It asks
for under 70 words, plain English, one analogy if useful, a key number/result, and
a final line beginning with `KEY:` containing an exact phrase copied from the text.

**Cache.** Results go to `cache/{paperId}_{sectionSlug}.json`. One file stores a
`levels` map (`beginner`/`student`/`researcher`), so changing level does not re-bill
for sections already generated at another level. Selection explanations use a
content hash (`sha1(text)[:8]`) in the file name. Writes are atomic. Cached responses
still stream through the same SSE path, marked `cached`.

**KEY targeting.** When `KEY:` arrives, the phrase is stripped from the visible
explanation, searched in the paper, and the spider walks to it. The phrase gets the
largest markup: orange box, orange text, key flash, and a 2-3x blow-up. If the phrase
is not found verbatim, a toast says so rather than guessing.

**Selection mode.** Select text inside the paper and press `E`. The spider runs to
the range, and the selection plus a little surrounding context is sent as its own
job. Very long selections are truncated to 12,000 characters with a toast.

**History and exports.** Every section/level explanation is kept in a scrollable
history. Clicking a history item scrolls back to that section or selection.
"Export notes" downloads Markdown with a title, TL;DR, each section, KEY phrases and
crawler notes. The Crawler Notes tab logs metrics/models/datasets the feet touched,
including section and surrounding sentence, and exports JSON.

### 6. Camera and performance

- The spider always progresses top to bottom. When its body is low in the viewport,
  the camera pushes the page down at a reading speed.
- Manual scrolling pauses the camera for 2.5 seconds.
- Auto-scroll is capped just before the References heading and `reachedReferences`
  is set; the spider can still wander visually but the camera does not read the
  bibliography.
- The render loop separates reads and writes. DOM reads happen in `update()`;
  queued class/attribute writes happen in `commit()`; canvas drawing is separate.
- Word wrapping is lazy, paper bounds are cached, shadows are cheap, and reveal /
  markup effects use CSS transforms and opacity rather than layout properties.
- On this machine (headless Chrome, software rendering) the loop measured roughly
  116-144 fps idle and about 56 fps while continuously moving across a long paper.
  A normal GPU-backed desktop browser should hold 60 fps.

---

## File map

```text
fetch_paper.py      arXiv metadata + HTML downloader and URL rewriter
papers/             saved {id}.html and {id}.json files
serve.py            static server, /api/papers, /api/status, /api/explain, cache
cache/              generated Claude explanations (git-ignored)
index.html          app shell: paper column, panel, canvas, HUD, overlays
css/style.css       paper theme, panel styling, all .m-* markup effects
js/loader.js        load/clean paper, detect sections, lazy word wrapping, phrase search
js/crawler.js       IK, gait, thread drop, foot anchoring, markup, camera, controls
js/spider-draw.js   canvas renderer for body, legs, thread, silk trails, ripples
js/analyst.js       SSE client, prompt jobs, panel, history, selection, exports, notes
```

Useful globals for debugging: `window.__paperLoader`, `window.__crawler`,
`window.__analyst`. Add `?debug` to draw IK lines, foot targets and step thresholds.

---

## API reference (backend)

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/papers` | Papers found in `papers/`, newest first |
| `GET` | `/api/status` | AI configured, model, levels, paper count |
| `GET` | `/api/cache` | Count and names of cached explanation files |
| `POST` | `/api/explain` | SSE explanation stream |

`POST /api/explain` validates and truncates input, sanitizes the paper ID and cache
slug, and rejects `.env`, `cache/` and `.git/` as static paths.

---

## Tests and checks

Requires Python 3.9+ and a modern browser. Node is optional and only used for the
syntax check below.

```powershell
# Python syntax
python -m py_compile fetch_paper.py serve.py

# JavaScript syntax (optional; Node is not a runtime dependency)
node --check js/loader.js
node --check js/crawler.js
node --check js/spider-draw.js
node --check js/analyst.js

# Start the server and inspect status
python serve.py
curl.exe http://localhost:5173/api/status
curl.exe http://localhost:5173/api/papers
```

Manual smoke test:

1. Open `http://localhost:5173/?paper=1706.03762`.
2. You should see a white paper, serif text, MathML equations, figures and a spider
   descending on a thread onto the abstract.
3. Move the mouse; the spider chases it. Click; it runs to the click and leaves a
   ripple.
4. Let it crawl, or press `D` to re-drop. Markup should accumulate; `C` clears it.
5. Scroll down and back up; feet should track their words rather than detach.
6. Press `Space`, `F`, `T`, `1/2/3`, `B/S/R`, `E`, `C`, `D`, `` ` `` and check each.
7. Switch to `1810.04805` in the dropdown. Title, sections, figures, math and panel
   reset without a reload.
8. Select a sentence and press `E`. Without a key the panel shows a clear no-key
   message; with a key the selection is explained.
9. With a key, let the spider enter sections and confirm SSE typing, cached badges,
   KEY targeting, history entries, Markdown export and JSON notes export.
10. Scroll to References and confirm the camera stops just above that heading.

There is no automated test suite; the app was verified with headless Chrome using
the Chrome DevTools Protocol for load, section detection, lazy wrapping, figure
loading, live paper switching, mouse chase/click, keyboard controls, panel
collapse, exports, selection errors, cache reads, and the References camera cap.

---

## Five famous ML papers to try

| Paper | arXiv ID |
| --- | --- |
| Attention Is All You Need (Transformer) | `1706.03762` |
| BERT: Pre-training of Deep Bidirectional Transformers | `1810.04805` |
| Language Models are Few-Shot Learners (GPT-3) | `2005.14165` |
| Deep Residual Learning for Image Recognition (ResNet) | `1512.03385` |
| LoRA: Low-Rank Adaptation of Large Language Models | `2106.09685` |

Other good tests: GANs (`1406.2661`), AlphaFold 2 (`2105.08371`), CLIP (`2103.00020`),
and Chain-of-Thought Prompting (`2201.11903`).

Older papers are more likely to need the ar5iv fallback (or to have no usable HTML).

---

## Known limitations

- **Live Claude output was not validated with a real key in this environment.**
  The server's no-key path, cached SSE path, dummy-key 401 path, request queue,
  prompt construction and SSE parsing were tested. Provide a real
  `ANTHROPIC_API_KEY` to exercise the live Anthropic call end to end.
- HTML availability depends on arXiv/ar5iv. Some papers have only a PDF; the fetcher
  prints a clear error instead of inventing content.
- Figure images are loaded from arXiv at runtime (the downloaded HTML stores absolute
  URLs). Offline use will show the paper text but not remote figures.
- MathML depends on native browser support. Current Chrome, Edge, Firefox and Safari
  render it; unusual LaTeX macros may still degrade.
- Layout and controls are designed for desktop mouse + keyboard. There is no
  touch-specific gesture layer.
- Headless software rendering measured ~56 fps during continuous movement. The
  read/write split and lazy wrapping are aimed at 60 fps on a normal GPU-backed
  browser, but performance varies by machine and paper length.
- The explanation cache is per paper/section/level. Editing the prompt does not
  invalidate existing cache entries; delete `cache/` to regenerate.
- The spider's marking is intentionally probabilistic. A given run will annotate
  different words, which is part of the effect but means screenshots are not
  byte-for-byte reproducible.
