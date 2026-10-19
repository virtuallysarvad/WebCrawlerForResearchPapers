/**
 * loader.js
 * ---------------------------------------------------------------------------
 * Loads a downloaded arXiv HTML file, cleans it into a readable paper, detects
 * sections, and turns words into lazy `<span class="w">` footholds for the
 * spider. It also owns all DOM lookup helpers used by crawler.js / analyst.js.
 *
 * Design notes
 *  - Papers are fetched from papers/<id>.html by the local server. The browser
 *    cannot fetch arXiv directly because of CORS, hence fetch_paper.py.
 *  - Word wrapping is lazy: blocks register with an IntersectionObserver. This
 *    keeps a long paper fast because only words near the viewport become spans.
 *  - MathML is never wrapped. `annotation` nodes contain raw TeX and are
 *    excluded from extracted section text as well.
 *  - Sections are represented by their heading element and a DOM Range. We do
 *    not reparent the paper (LLM-generated HTML is fragile); the range gives us
 *    both the section text and a stable target for the camera/AI.
 */

import { Crawler } from "./crawler.js";
import { Analyst } from "./analyst.js";

export const TITLE_OVERLAY_TEXT = "I built a spider that reads ML papers for me";

const BLOCK_SELECTOR = [
  "p", "h1", "h2", "h3", "h4", "h5", "h6",
  "figcaption", "blockquote", "dd", "dt", "td", "th", "li",
  ".ltx_para", ".ltx_p", ".ltx_abstract",
].join(",");

const SKIP_WRAP_SELECTOR = [
  "math", "code", "pre", "script", "style", "svg", "textarea",
  "annotation", ".ltx_note_outer", "[contenteditable]",
].join(",");

const MAX_SECTION_CHARS = 12_000;

/* -------------------------------------------------------------------------- */
/* small utilities                                                             */
/* -------------------------------------------------------------------------- */

const normalizeSpace = (value) => (value || "").replace(/\s+/g, " ").trim();

export function slugify(value, fallback = "section") {
  const slug = (value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return slug || fallback;
}

export function normalizeForMatch(value) {
  return (value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[“”„]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[‐‑‒–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

export function looseForMatch(value) {
  return normalizeForMatch(value).replace(/[^a-z0-9%+.-]/g, "");
}

function textWithoutNoise(node) {
  if (!node) return "";
  const clone = node.cloneNode(true);
  clone.querySelectorAll("annotation, .ltx_note_outer, script, style, noscript").forEach((el) => el.remove());
  return normalizeSpace(clone.textContent);
}

function compareDocumentOrder(a, b) {
  if (a === b) return 0;
  const position = a.compareDocumentPosition(b);
  if (position & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
  if (position & Node.DOCUMENT_POSITION_PRECEDING) return 1;
  return 0;
}

let toastTimer = null;
export function toast(message, duration = 2200) {
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = message;
  el.classList.add("is-visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("is-visible"), duration);
}

/* -------------------------------------------------------------------------- */
/* PaperLoader                                                                 */
/* -------------------------------------------------------------------------- */

export class PaperLoader {
  constructor() {
    this.root = document.getElementById("paper-content");
    this.metaTitle = document.getElementById("meta-title");
    this.metaAuthors = document.getElementById("meta-authors");
    this.metaDate = document.getElementById("meta-date");
    this.metaCategory = document.getElementById("meta-category");
    this.metaLink = document.getElementById("meta-arxiv-link");
    this.select = document.getElementById("paper-select");
    this.loading = document.getElementById("loading");
    this.loadingText = document.getElementById("loading-text");

    this.papers = [];
    this.metadata = null;
    this.sections = [];
    this.blocks = [];
    this.words = [];
    this.observer = null;
    this._loadToken = 0;
    this._wrappedAll = false;
    this.status = { aiConfigured: false, model: "" };
  }

  /* ---------------------------------------------------------------------- */
  /* boot                                                                    */
  /* ---------------------------------------------------------------------- */

  async init() {
    try {
      const [papersResponse, statusResponse] = await Promise.all([
        fetch("/api/papers", { cache: "no-store" }),
        fetch("/api/status", { cache: "no-store" }),
      ]);
      if (papersResponse.ok) {
        const data = await papersResponse.json();
        this.papers = data.papers || [];
      }
      if (statusResponse.ok) {
        this.status = await statusResponse.json();
      }
    } catch {
      this.showFatal(
        "Could not reach the local server. Run <code>python serve.py</code> " +
        "and open <code>http://localhost:5173</code>."
      );
      return;
    }

    this.populateSelect();

    if (!this.papers.length) {
      this.showEmptyState();
      return;
    }

    const params = new URLSearchParams(location.search);
    const requested = params.get("paper");
    const remembered = localStorage.getItem("paperCrawler.paper");
    const preferred =
      this.papers.find((p) => p.paperKey === requested || p.id === requested) ||
      this.papers.find((p) => p.paperKey === remembered || p.id === remembered) ||
      this.papers.find((p) => p.id === "1706.03762") ||
      this.papers[0];

    if (requested) {
      // Keep switcher changes out of history; this is a single-page app.
    }

    await this.loadPaper(preferred.paperKey);
  }

  setLoading(text = "fetching the paper…", visible = true) {
    if (!this.loading) return;
    if (text) this.loadingText.textContent = text;
    this.loading.classList.toggle("is-hidden", !visible);
  }

  populateSelect() {
    if (!this.select) return;
    this.select.innerHTML = "";
    if (!this.papers.length) {
      const option = new Option("no papers yet", "");
      this.select.append(option);
      this.select.disabled = true;
      return;
    }
    this.select.disabled = false;
    for (const paper of this.papers) {
      const option = new Option(
        `${paper.id} — ${paper.title.length > 72 ? paper.title.slice(0, 70) + "…" : paper.title}`,
        paper.paperKey
      );
      this.select.append(option);
    }
    this.select.onchange = () => this.loadPaper(this.select.value);
  }

  showFatal(message) {
    if (!this.root) return;
    this.root.innerHTML = `<div class="paper-empty"><p class="paper-empty-kicker">Paper Crawler could not start.</p><p class="paper-error">${message}</p></div>`;
    this.setLoading("", false);
  }

  showEmptyState() {
    this.root.innerHTML = `
      <div class="paper-empty">
        <p class="paper-empty-kicker">No papers downloaded yet.</p>
        <p>Fetch the default paper (Attention Is All You Need):</p>
        <pre><code>python fetch_paper.py 1706.03762</code></pre>
        <p>Or a batch:</p>
        <pre><code>python fetch_paper.py --batch "1706.03762 1810.04805 2005.14165"</code></pre>
        <p>Then reload this page.</p>
      </div>`;
    this.setLoading("", false);
    document.dispatchEvent(new CustomEvent("paper:empty"));
  }

  /* ---------------------------------------------------------------------- */
  /* load + clean                                                           */
  /* ---------------------------------------------------------------------- */

  async loadPaper(paperKey) {
    const meta = this.papers.find((p) => p.paperKey === paperKey) || this.papers[0];
    if (!meta) return;
    const token = ++this._loadToken;

    this.setLoading("fetching the paper…", true);
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
    this._wrappedAll = false;
    this.sections = [];
    this.blocks = [];
    this.words = [];
    this.metadata = meta;
    this.updateMeta(meta);

    try {
      const response = await fetch(`papers/${encodeURIComponent(meta.htmlFile)}`, { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const html = await response.text();
      if (token !== this._loadToken) return;

      this.setLoading("cleaning the paper…", true);
      const parsed = new DOMParser().parseFromString(html, "text/html");
      const sourceUrl = meta.sourceHtmlUrl || `https://arxiv.org/html/${meta.id}`;
      const content = this.extractContent(parsed, sourceUrl);

      this.root.innerHTML = "";
      this.root.append(content);
      this.decorateContent(sourceUrl);

      await new Promise((resolve) => requestAnimationFrame(resolve));
      if (token !== this._loadToken) return;

      this.prepareDom();
      this.buildSections(meta);
      this.collectBlocks();
      this.assignSectionsToBlocks();
      this.startLazyWrapping();

      if (this.select) this.select.value = meta.paperKey;
      localStorage.setItem("paperCrawler.paper", meta.paperKey);
      const url = new URL(location.href);
      url.searchParams.set("paper", meta.paperKey);
      history.replaceState(null, "", url);

      this.setLoading("", false);
      window.scrollTo({ top: 0, behavior: "auto" });

      document.dispatchEvent(new CustomEvent("paper:loaded", {
        detail: { metadata: meta, sections: this.sections, loader: this },
      }));
    } catch (error) {
      console.error(error);
      this.showFatal(
        `Could not load <code>papers/${meta.htmlFile}</code> (${error.message}). ` +
        `Run <code>python fetch_paper.py ${meta.id}</code> and reload.`
      );
    }
  }

  extractContent(doc, sourceUrl) {
    const candidates = [
      doc.querySelector(".ltx_document"),
      doc.querySelector("article"),
      doc.querySelector(".ltx_page_content"),
      doc.querySelector("main"),
      doc.body,
    ];
    let content = candidates.find((el) => el && el.textContent.trim().length > 400) || candidates[0];
    if (!content) throw new Error("The HTML did not contain an article.");

    content = content.cloneNode(true);

    // Some arXiv exports embed figures as <object data="...svg">. Convert them
    // to <img> so the paper theme can size them and the sanitizer does not
    // have to drop the figure entirely.
    content.querySelectorAll("object").forEach((object) => {
      const fallback = object.querySelector("img[src], img[data-src]");
      const src = object.getAttribute("data") ||
        fallback?.getAttribute("src") ||
        fallback?.getAttribute("data-src");
      if (!src) {
        object.remove();
        return;
      }
      const img = content.ownerDocument.createElement("img");
      for (const attr of ["id", "class", "style", "width", "height", "role", "aria-label"]) {
        const value = object.getAttribute(attr);
        if (value) img.setAttribute(attr, value);
      }
      img.setAttribute("src", src);
      img.setAttribute("loading", "lazy");
      img.setAttribute("alt", fallback?.getAttribute("alt") || object.getAttribute("title") || "");
      object.replaceWith(img);
    });

    // Remove site chrome, scripts and anything that would fight the paper theme.
    content.querySelectorAll(
      "script, style, link, base, noscript, iframe, embed, form, " +
      "button, input, textarea, select, nav, .ltx_page_header, .ltx_page_footer, " +
      ".ltx_page_logo, .ltx_role_license, #watermark-tr, .ltx_note_outer"
    ).forEach((el) => el.remove());

    // Drop the original title/authors; the app renders its own minimal header.
    content.querySelectorAll(
      ".ltx_title_document, .ltx_authors, .ltx_author_notes, .ltx_dates, .ltx_title_abstract ~ .ltx_authors"
    ).forEach((el) => el.remove());

    // arXiv adds a red attribution paragraph above the title in some exports.
    content.querySelectorAll("p, .ltx_p").forEach((el) => {
      const text = el.textContent.trim();
      if (/^provided proper attribution is provided/i.test(text)) el.remove();
    });

    // Remove inline event handlers and dangerous URLs.
    content.querySelectorAll("*").forEach((el) => {
      for (const attr of [...el.attributes]) {
        const name = attr.name.toLowerCase();
        const value = (attr.value || "").trim().toLowerCase();
        if (name.startsWith("on") || name === "srcdoc") {
          el.removeAttribute(attr.name);
        } else if ((name === "href" || name === "src" || name === "xlink:href") && value.startsWith("javascript:")) {
          el.removeAttribute(attr.name);
        }
      }
      if (el.tagName === "A") {
        el.setAttribute("rel", "noopener noreferrer");
        if (el.getAttribute("href") && !el.getAttribute("href").startsWith("#")) {
          el.setAttribute("target", "_blank");
        }
      }
    });

    // Rewrite any remaining relative asset URLs against the original HTML.
    content.querySelectorAll("img, source, video, audio, a").forEach((el) => {
      for (const attr of ["src", "href", "poster"]) {
        const value = el.getAttribute(attr);
        if (!value) continue;
        if (/^(data:|blob:|mailto:|tel:|javascript:|#)/i.test(value)) continue;
        try {
          el.setAttribute(attr, new URL(value, sourceUrl).href);
        } catch {
          /* leave malformed URLs alone */
        }
      }
    });

    if (content.textContent.trim().length < 100) {
      throw new Error("The paper HTML was empty after cleaning.");
    }
    return content;
  }

  decorateContent(sourceUrl) {
    this.root.querySelectorAll("img").forEach((img) => {
      if (!img.getAttribute("src") && img.dataset.src) img.setAttribute("src", img.dataset.src);
      img.setAttribute("referrerpolicy", "no-referrer");
      img.setAttribute("decoding", "async");
      if (!img.hasAttribute("alt")) img.setAttribute("alt", "");
    });
    this.root.querySelectorAll("source").forEach((source) => {
      const srcset = source.getAttribute("srcset");
      if (!srcset) return;
      source.setAttribute("srcset", srcset.split(",").map((part) => {
        const bits = part.trim().split(/\s+/);
        if (!bits[0]) return part;
        try { bits[0] = new URL(bits[0], sourceUrl).href; } catch { /* keep */ }
        return bits.join(" ");
      }).join(", "));
    });
    this.root.querySelectorAll("a").forEach((a) => {
      if (!a.getAttribute("target")) return;
      if (a.getAttribute("href")?.startsWith("#")) a.removeAttribute("target");
    });
  }

  updateMeta(meta) {
    if (this.metaTitle) this.metaTitle.textContent = meta.title || meta.id;
    if (this.metaAuthors) {
      const authors = meta.authors || [];
      this.metaAuthors.textContent = authors.length
        ? authors.slice(0, 8).join(", ") + (authors.length > 8 ? ", et al." : "")
        : "Unknown authors";
    }
    if (this.metaDate) this.metaDate.textContent = meta.date || "undated";
    if (this.metaCategory) this.metaCategory.textContent = meta.category || "arXiv";
    if (this.metaLink) {
      this.metaLink.textContent = meta.id;
      this.metaLink.href = meta.absUrl || `https://arxiv.org/abs/${meta.id}`;
    }
    document.title = `${meta.title || "Paper"} · Paper Crawler`;
  }

  prepareDom() {
    this.root.classList.add("is-wrapping");
    requestAnimationFrame(() => this.root.classList.remove("is-wrapping"));
  }

  /* ---------------------------------------------------------------------- */
  /* sections                                                               */
  /* ---------------------------------------------------------------------- */

  headingLevel(el) {
    const classes = el.classList;
    if (classes.contains("ltx_title_section")) return 1;
    if (classes.contains("ltx_title_subsection")) return 2;
    if (classes.contains("ltx_title_subsubsection")) return 3;
    if (classes.contains("ltx_title_bibliography")) return 1;
    if (classes.contains("ltx_title_abstract")) return 1;
    const tag = el.tagName.toLowerCase();
    return Math.max(1, Number(tag.slice(1)) - 1);
  }

  isSectionHeading(el) {
    if (el.closest(".ltx_figure, .ltx_table, .ltx_note_outer")) return false;
    if (el.classList.contains("ltx_title_document")) return false;
    if (el.classList.contains("ltx_title_paragraph")) return false;
    if (el.classList.contains("ltx_title_abstract")) return false;
    if (el.matches(
      "h1, h2, h3, h4, h5, h6"
    )) {
      if (el.classList.contains("ltx_title_section") ||
          el.classList.contains("ltx_title_subsection") ||
          el.classList.contains("ltx_title_subsubsection") ||
          el.classList.contains("ltx_title_bibliography")) return true;
      // Plain semantic HTML papers (not LaTeXML) use h2/h3 for sections.
      return /^h[1-4]$/i.test(el.tagName) && normalizeSpace(el.textContent).length > 1;
    }
    return false;
  }

  buildSections(meta) {
    const abstractEl = this.root.querySelector(".ltx_abstract, #abstract1");
    const definitions = [];

    if (abstractEl) {
      const heading = abstractEl.querySelector(".ltx_title_abstract") || abstractEl;
      definitions.push({
        el: abstractEl,
        heading,
        level: 1,
        title: "Abstract",
        isAbstract: true,
      });
    } else if (meta.abstract) {
      // Synthetic abstract: useful for the TL;DR even if the HTML has no abstract
      // element. It has no DOM range, so it is never a walking target.
      definitions.push({
        el: null,
        heading: null,
        level: 1,
        title: "Abstract",
        isAbstract: true,
        syntheticText: meta.abstract,
      });
    }

    const headings = [...this.root.querySelectorAll("h1, h2, h3, h4, h5, h6")]
      .filter((el) => this.isSectionHeading(el))
      .filter((el) => !(abstractEl && abstractEl.contains(el)));

    for (const heading of headings) {
      const title = normalizeSpace(heading.textContent);
      if (!title) continue;
      definitions.push({
        el: heading,
        heading,
        level: this.headingLevel(heading),
        title,
        isReferences: /^(?:\d+(?:\.\d+)*\s*)?(references|bibliography)$/i.test(title) ||
          /^(references|bibliography)$/i.test(title),
      });
    }

    definitions.sort((a, b) => {
      if (!a.heading) return -1;
      if (!b.heading) return 1;
      return compareDocumentOrder(a.heading, b.heading);
    });

    // De-duplicate headings (some exporters nest an abstract heading inside a
    // section heading and we do not want two identical sections).
    const seen = new Set();
    const unique = [];
    for (const def of definitions) {
      const key = def.heading ? `${def.title}|${def.heading.id || ""}` : def.title;
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(def);
    }

    this.sections = unique.map((def, index) => {
      const slug = slugify(def.title, `section-${index}`);
      const section = {
        id: `sec-${index}`,
        index,
        slug,
        title: def.title,
        level: def.level,
        heading: def.heading,
        el: def.el || null,
        isAbstract: !!def.isAbstract,
        isReferences: !!def.isReferences,
        syntheticText: def.syntheticText || "",
        text: "",
        blocks: [],
        allBlocks: [],
        walkedBlocks: new Set(),
        walkedWords: 0,
      };
      return section;
    });

    // Make slugs unique (e.g. two unnumbered "Experiments" headings).
    const usedSlugs = new Map();
    this.sections.forEach((section, index) => {
      const count = usedSlugs.get(section.slug) || 0;
      usedSlugs.set(section.slug, count + 1);
      if (count) section.slug = `${section.slug}-${index}`;
    });

    // Build a DOM range for every section. A section's range runs from the end
    // of its heading to the next heading of the same or higher level, so a
    // top-level section includes its subsections.
    this.sections.forEach((section, index) => {
      if (!section.heading || !section.heading.isConnected) {
        section.text = section.syntheticText || "";
        return;
      }
      const range = document.createRange();
      const isAbstract = section.isAbstract;
      if (isAbstract) {
        if (section.heading === section.el) range.setStart(section.el, 0);
        else range.setStartAfter(section.heading);
        range.setEnd(section.el, section.el.childNodes.length);
        section.range = range;
        section.text = textWithoutNoise(range.cloneContents());
        return;
      }

      range.setStartAfter(section.heading);
      let endHeading = null;
      for (let j = index + 1; j < this.sections.length; j += 1) {
        const other = this.sections[j];
        if (other.heading && other.level <= section.level) {
          endHeading = other.heading;
          break;
        }
      }
      if (endHeading) range.setEndBefore(endHeading);
      else range.setEnd(this.root, this.root.childNodes.length);
      section.range = range;
      section.text = textWithoutNoise(range.cloneContents());
    });

    // Attach a top-level "References" helper for the camera stop logic.
    this.referencesSection = this.sections.find((s) => s.isReferences) || null;
    this.abstractSection = this.sections.find((s) => s.isAbstract) || null;
  }

  collectBlocks() {
    const candidates = [...this.root.querySelectorAll(BLOCK_SELECTOR)];
    this.blocks = candidates.filter((el) => {
      if (el.closest(SKIP_WRAP_SELECTOR)) return false;
      if (!normalizeSpace(el.textContent)) return false;
      // Keep leaf text blocks only; otherwise a parent and child both wrap and
      // section text is duplicated.
      const nested = el.querySelector("p, h1, h2, h3, h4, h5, h6, figcaption, li, td, th, .ltx_p, .ltx_para");
      if (nested && !/^H[1-6]$/.test(el.tagName)) return false;
      return true;
    });
    this.blocks.forEach((block) => {
      if (!block.dataset.sec) block.dataset.sec = "";
    });
  }

  assignSectionsToBlocks() {
    if (!this.sections.length) return;
    const realSections = this.sections.filter((s) => s.heading);
    const abstract = this.abstractSection;

    for (const block of this.blocks) {
      let best = abstract && abstract.el && (abstract.el === block || abstract.el.contains(block))
        ? abstract
        : null;

      for (const section of realSections) {
        if (section.isAbstract) continue;
        const heading = section.heading;
        if (heading === block || heading.contains(block)) {
          best = section;
          break;
        }
        if (heading.compareDocumentPosition(block) & Node.DOCUMENT_POSITION_FOLLOWING) {
          best = section;
        }
      }
      if (!best && abstract) best = abstract;
      if (best) {
        block.dataset.sec = best.id;
        best.blocks.push(block);
      }
    }

    // For section explanations, include blocks from the whole range (so a
    // top-level section includes walked paragraphs from its subsections).
    for (const section of this.sections) {
      if (!section.range) {
        section.allBlocks = section.blocks.slice();
        continue;
      }
      section.allBlocks = this.blocks.filter((block) => {
        try { return section.range.intersectsNode(block); } catch { return false; }
      });
    }
  }

  startLazyWrapping() {
    this.observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        this.wrapBlock(entry.target);
        this.observer.unobserve(entry.target);
      }
    }, { root: null, rootMargin: "1000px 0px 1000px 0px", threshold: 0 });

    // Observe every block, but only wrap the first couple immediately so the
    // abstract is ready for the spider. Everything else is wrapped just before
    // it scrolls into view.
    for (const block of this.blocks) {
      this.observer.observe(block);
    }
    this.blocks.slice(0, 3).forEach((block) => this.wrapBlock(block));
  }

  /* ---------------------------------------------------------------------- */
  /* word wrapping                                                          */
  /* ---------------------------------------------------------------------- */

  wrapBlock(block) {
    if (!block || !block.isConnected) return;
    if (block.dataset.wrapped === "1") return;
    block.dataset.wrapped = "1";

    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => {
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        if (parent.closest(SKIP_WRAP_SELECTOR)) return NodeFilter.FILTER_REJECT;
        if (parent.closest(".w")) return NodeFilter.FILTER_REJECT;
        if (!node.nodeValue || !/[\p{L}\p{N}]/u.test(node.nodeValue)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    const textNodes = [];
    let node;
    while ((node = walker.nextNode())) textNodes.push(node);

    for (const textNode of textNodes) {
      const text = textNode.nodeValue;
      if (!text) continue;
      const fragment = document.createDocumentFragment();
      const parts = text.split(/(\s+)/);
      for (const part of parts) {
        if (!part) continue;
        if (/^\s+$/.test(part)) {
          fragment.append(document.createTextNode(part));
          continue;
        }
        if (!/[\p{L}\p{N}]/u.test(part)) {
          fragment.append(document.createTextNode(part));
          continue;
        }
        const span = document.createElement("span");
        span.className = "w";
        span.textContent = part;
        if (block.dataset.sec) span.dataset.sec = block.dataset.sec;
        fragment.append(span);
      }
      textNode.replaceWith(fragment);
    }
    this.words = null;
  }

  wrapAll() {
    if (this._wrappedAll) return;
    for (const block of this.blocks) this.wrapBlock(block);
    this._wrappedAll = true;
  }

  getWords() {
    if (!this.words) this.words = [...this.root.querySelectorAll(".w")];
    return this.words;
  }

  invalidateWords() {
    this.words = null;
  }

  /* ---------------------------------------------------------------------- */
  /* section text + walking notes                                           */
  /* ---------------------------------------------------------------------- */

  getSectionText(section, limit = MAX_SECTION_CHARS) {
    if (!section) return "";
    if (!section.allBlocks?.length) {
      return (section.text || section.syntheticText || "").slice(0, limit);
    }

    const seen = new Set();
    const ordered = [];
    const walked = section.allBlocks.filter((block) => section.walkedBlocks.has(block));
    const rest = section.allBlocks.filter((block) => !section.walkedBlocks.has(block));
    for (const block of [...walked, ...rest]) {
      if (seen.has(block)) continue;
      seen.add(block);
      ordered.push(block);
    }

    let output = "";
    for (const block of ordered) {
      const text = textWithoutNoise(block);
      if (!text) continue;
      if (output.length + text.length + 2 > limit) {
        const remaining = limit - output.length - 2;
        if (remaining > 80) output += `${output ? "\n\n" : ""}${text.slice(0, remaining)}`;
        break;
      }
      output += `${output ? "\n\n" : ""}${text}`;
    }
    return output || (section.text || "").slice(0, limit);
  }

  sectionById(id) {
    return this.sections.find((section) => section.id === id) || null;
  }

  sectionForElement(element) {
    if (!element) return null;
    const holder = element.closest("[data-sec]");
    if (holder?.dataset.sec) return this.sectionById(holder.dataset.sec);
    return null;
  }

  noteWalked(span) {
    const section = this.sectionForElement(span);
    if (!section) return null;
    section.walkedWords += 1;
    const block = span.closest("p, li, td, th, figcaption, blockquote, h1, h2, h3, h4, h5, h6, .ltx_para");
    if (block) section.walkedBlocks.add(block);
    span.dataset.walked = "1";
    return section;
  }

  sectionAtDocY(yDoc) {
    if (!this.sections.length) return null;
    let current = this.sections[0];
    for (const section of this.sections) {
      const target = section.heading || section.el;
      if (!target || !target.isConnected) continue;
      const top = target.getBoundingClientRect().top + window.scrollY;
      if (top <= yDoc + 6) current = section;
      else break;
    }
    return current;
  }

  sectionAtViewport() {
    return this.sectionAtDocY(window.scrollY + innerHeight * 0.45);
  }

  getSectionTop(section) {
    const target = section?.heading || section?.el;
    if (!target || !target.isConnected) return null;
    return target.getBoundingClientRect().top + window.scrollY;
  }

  scrollToSection(section) {
    const target = section?.heading || section?.el;
    if (!target) return false;
    const top = target.getBoundingClientRect().top + window.scrollY - 150;
    window.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
    return true;
  }

  getPaperBounds() {
    const rect = this.root.getBoundingClientRect();
    return {
      left: rect.left,
      right: rect.right,
      topDoc: rect.top + window.scrollY,
      bottomDoc: rect.bottom + window.scrollY,
      width: rect.width,
    };
  }

  sentenceForSpan(span) {
    const block = span?.closest("p, li, td, th, figcaption, blockquote, .ltx_para");
    if (!block) return "";
    const full = normalizeSpace(block.textContent);
    const word = normalizeSpace(span.textContent);
    if (!full || !word) return full.slice(0, 240);

    // Find the span's character offset by walking text nodes in order, so
    // repeated words still map to the right sentence.
    let offset = 0;
    let found = -1;
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (node.parentElement === span || node.parentElement?.closest(".w") === span) {
        found = offset;
        break;
      }
      offset += node.nodeValue?.length || 0;
    }
    if (found < 0) found = full.indexOf(word);
    if (found < 0) return full.slice(0, 240);

    // The block text and raw offsets diverge due to collapsed whitespace; use
    // the word's position in the normalized text as a good approximation.
    const normalizedOffset = full.indexOf(word, Math.max(0, found - 5));
    const at = normalizedOffset >= 0 ? normalizedOffset : Math.max(0, found);
    const boundaries = /[.!?]\s+(?=[A-Z0-9“"'(])/g;
    let start = 0;
    let end = full.length;
    let match;
    while ((match = boundaries.exec(full))) {
      if (match.index + match[0].length <= at) start = match.index + match[0].length;
      else { end = match.index + 1; break; }
    }
    return full.slice(start, Math.min(end, start + 320)).trim();
  }

  /* ---------------------------------------------------------------------- */
  /* markup helpers                                                         */
  /* ---------------------------------------------------------------------- */

  clearMarkup() {
    let count = 0;
    this.root.querySelectorAll("[class]").forEach((el) => {
      let changed = false;
      for (const cls of [...el.classList]) {
        if (cls.startsWith("m-")) {
          el.classList.remove(cls);
          changed = true;
        }
      }
      if (el.classList.contains("is-foot")) {
        el.classList.remove("is-foot");
        changed = true;
      }
      if (changed) count += 1;
    });
    // Clean up empty class attributes and the raw data flag used by trails.
    this.root.querySelectorAll("[data-markup]").forEach((el) => el.removeAttribute("data-markup"));
    return count;
  }

  /* ---------------------------------------------------------------------- */
  /* phrase search (AI KEY -> spider target)                                */
  /* ---------------------------------------------------------------------- */

  findPhrase(phrase) {
    const target = normalizeSpace(phrase);
    if (!target) return null;
    const targetLoose = looseForMatch(target);
    if (!targetLoose) return null;

    let result = this.searchWords(target, targetLoose);
    if (result) return result;

    // KEY phrases are often in a section that has not been lazily wrapped yet.
    this.wrapAll();
    result = this.searchWords(target, targetLoose);
    if (result) return result;

    // Last resort: a distinctive numeric token from the phrase. This keeps the
    // spider pointing at *something* useful when Claude paraphrases slightly.
    const numeric = target.match(/\d+(?:[.,]\d+)?%?/);
    if (numeric) {
      this.wrapAll();
      const words = this.getWords();
      const span = words.find((word) => normalizeSpace(word.textContent) === numeric[0]);
      if (span) return this.resultForSpans([span], phrase);
    }
    return null;
  }

  searchWords(target, targetLoose) {
    const words = this.getWords();
    if (!words.length) return null;

    const targetTokens = target.split(/\s+/).filter(Boolean).slice(0, 18);
    const tokenCount = targetTokens.length;
    if (!tokenCount) return null;
    const maxWindow = Math.min(tokenCount + 3, 22);

    for (let start = 0; start < words.length; start += 1) {
      const firstLoose = looseForMatch(words[start].textContent);
      if (!firstLoose) continue;
      let combined = "";
      for (let size = 1; size <= maxWindow && start + size <= words.length; size += 1) {
        const word = words[start + size - 1];
        const part = normalizeSpace(word.textContent);
        combined += (combined ? " " : "") + part;
        if (looseForMatch(combined) === targetLoose) {
          return this.resultForSpans(words.slice(start, start + size), target);
        }
        if (size >= tokenCount && size > tokenCount + 2) break;
      }
    }
    return null;
  }

  resultForSpans(spans, phrase) {
    if (!spans.length) return null;
    const rects = spans.map((span) => span.getBoundingClientRect()).filter((r) => r.width || r.height);
    if (!rects.length) return null;
    const first = rects[0];
    const union = rects.reduce((acc, rect) => ({
      left: Math.min(acc.left, rect.left),
      top: Math.min(acc.top, rect.top),
      right: Math.max(acc.right, rect.right),
      bottom: Math.max(acc.bottom, rect.bottom),
    }), { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity });
    return {
      spans,
      rect: new DOMRect(first.left, first.top, first.width, first.height),
      unionRect: new DOMRect(union.left, union.top, union.right - union.left, union.bottom - union.top),
      phrase: normalizeSpace(phrase),
      section: this.sectionForElement(spans[0]),
    };
  }
}

/* -------------------------------------------------------------------------- */
/* bootstrap                                                                  */
/* -------------------------------------------------------------------------- */

async function boot() {
  // Title overlay text is configurable in exactly one constant.
  const overlayText = document.getElementById("title-overlay-text");
  if (overlayText) overlayText.textContent = TITLE_OVERLAY_TEXT;

  document.body.classList.remove("panel-collapsed");
  if (localStorage.getItem("paperCrawler.panel") === "collapsed") {
    document.body.classList.add("panel-collapsed");
  }
  const panelToggle = document.getElementById("panel-toggle");
  if (panelToggle) {
    panelToggle.setAttribute("aria-expanded", String(!document.body.classList.contains("panel-collapsed")));
    panelToggle.addEventListener("click", () => {
      document.body.classList.toggle("panel-collapsed");
      const collapsed = document.body.classList.contains("panel-collapsed");
      localStorage.setItem("paperCrawler.panel", collapsed ? "collapsed" : "open");
      panelToggle.setAttribute("aria-expanded", String(!collapsed));
      window.dispatchEvent(new Event("resize"));
    });
  }

  const loader = new PaperLoader();
  const crawler = new Crawler(loader);
  const analyst = new Analyst(loader, crawler);

  window.__paperLoader = loader;
  window.__crawler = crawler;
  window.__analyst = analyst;

  // Let the crawler and analyst know when a new paper has been rendered.
  document.addEventListener("paper:loaded", () => crawler.reset());
  document.addEventListener("paper:empty", () => crawler.hide());

  await loader.init();
  crawler.start();
  analyst.init();

  // Paper switcher keyboard shortcut + small UX niceties.
  document.addEventListener("keydown", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest("input, textarea, select, [contenteditable]")) return;
    if (event.key === "?" && !event.metaKey && !event.ctrlKey) {
      // Keep the native "?" behaviour (debug is enabled via ?debug in the URL),
      // but show a hint so the shortcut is discoverable.
      if (!new URLSearchParams(location.search).has("debug")) {
        toast("Add ?debug to the URL for the IK overlay");
      }
    }
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot, { once: true });
} else {
  boot();
}
