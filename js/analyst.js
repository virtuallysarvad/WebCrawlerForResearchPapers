/**
 * analyst.js
 * ---------------------------------------------------------------------------
 * The AI side of Paper Crawler.
 *
 *  - Streams section explanations from POST /api/explain (SSE over fetch).
 *  - Explains the abstract immediately as a TL;DR.
 *  - When a section changes, queues exactly one request at a time.
 *  - Finds the KEY phrase returned by Claude, asks the crawler to walk there,
 *    and applies the biggest markup.
 *  - "Explain this": select text + E sends just that passage.
 *  - Crawler Notes logs metrics/models/datasets touched by feet.
 *  - Exports Markdown (paper breakdown) and JSON (notes).
 *
 * The API key never reaches this file; it lives only in serve.py / .env.
 */

import { toast } from "./loader.js";

const MAX_TEXT = 12_000;

function download(filename, content, type = "text/plain;charset=utf-8") {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function slug(value) {
  return (value || "paper")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "paper";
}

function stripKeyLine(text) {
  const index = text.search(/(?:^|\n)\s*KEY:\s*/i);
  if (index >= 0) return text.slice(0, index).trimEnd();
  return text;
}

function shortModel(model) {
  if (!model) return "claude";
  return model.replace(/^claude-/, "").replace(/-\d{8}$/, "").slice(0, 20);
}

export class Analyst {
  constructor(loader, crawler) {
    this.loader = loader;
    this.crawler = crawler;

    this.currentEl = document.getElementById("explain-current");
    this.historyEl = document.getElementById("explain-history");
    this.notesEl = document.getElementById("notes-list");
    this.notesCount = document.getElementById("notes-count");
    this.aiStatus = document.getElementById("ai-status");
    this.historyHead = document.querySelector(".history-head");

    this.level = localStorage.getItem("paperCrawler.level") || "student";
    this.history = [];
    this.notes = [];
    this.currentEntry = null;
    this.currentSection = null;
    this.queue = [];
    this.active = null;
    this.controller = null;
    this.timeout = null;
    this.paperKey = null;
    this.explained = new Set();
    this.tabs = "explain";
    this._renderScheduled = false;
    this._tldrTimer = null;
    this.aiConfigured = false;

    this.handlePaperLoaded = this.handlePaperLoaded.bind(this);
    this.handleSection = this.handleSection.bind(this);
    this.handleTouch = this.handleTouch.bind(this);
    this.onKeyDown = this.onKeyDown.bind(this);

    document.addEventListener("paper:loaded", this.handlePaperLoaded);
    document.addEventListener("paper:empty", () => this.showNoPaper());
    document.addEventListener("crawler:section", this.handleSection);
    document.addEventListener("spider:touch", this.handleTouch);
    document.addEventListener("keydown", this.onKeyDown);
  }

  /* ====================================================================== */
  /* init + paper lifecycle                                                 */
  /* ====================================================================== */

  init() {
    this.aiConfigured = !!this.loader.status?.aiConfigured;
    this.applyStatus();
    this.bindUi();
    this.setLevel(this.level, { silent: true, reexplain: false });
    this.renderHistory();

    if (this.loader.sections.length && !this.paperKey) {
      this.handlePaperLoaded({
        detail: { metadata: this.loader.metadata, sections: this.loader.sections },
      });
    }
  }

  applyStatus() {
    if (!this.aiStatus) return;
    if (this.aiConfigured) {
      const model = this.loader.status?.model || "";
      this.aiStatus.textContent = shortModel(model);
      this.aiStatus.title = `Claude streaming via ${model || "the Anthropic Messages API"}`;
      this.aiStatus.classList.add("is-live");
      this.aiStatus.classList.remove("is-error");
    } else {
      this.aiStatus.textContent = "no api key";
      this.aiStatus.title = "Add ANTHROPIC_API_KEY to .env and restart serve.py";
      this.aiStatus.classList.add("is-error");
      this.aiStatus.classList.remove("is-live");
    }
  }

  bindUi() {
    document.querySelectorAll(".level-btn").forEach((button) => {
      button.addEventListener("click", () => this.setLevel(button.dataset.level));
    });

    document.querySelectorAll(".tab-btn").forEach((button) => {
      button.addEventListener("click", () => this.showTab(button.dataset.tab));
    });

    document.getElementById("export-btn")?.addEventListener("click", () => this.exportMarkdown());
    document.getElementById("export-notes")?.addEventListener("click", () => this.exportNotesJson());
    document.getElementById("clear-history")?.addEventListener("click", () => this.clearHistory());

    this.renderLevelButtons();
  }

  handlePaperLoaded(event) {
    const metadata = event.detail?.metadata || this.loader.metadata;
    const sections = event.detail?.sections || this.loader.sections;
    if (!metadata) return;

    if (this.paperKey === metadata.paperKey) return;
    this.paperKey = metadata.paperKey;
    this.loader.metadata = metadata;

    // One paper at a time: cancel any in-flight explanation and reset panels.
    this.abortActive();
    this.queue = [];
    this.history = [];
    this.notes = [];
    this.explained.clear();
    this.currentEntry = null;
    this.currentSection = sections.find((section) => section.isAbstract) || sections[0] || null;
    this.aiConfigured = !!this.loader.status?.aiConfigured;
    this.applyStatus();
    this.renderHistory();
    this.renderNotes();

    if (!this.aiConfigured) {
      this.showNoKeyMessage();
      return;
    }

    const abstract = sections.find((section) => section.isAbstract);
    clearTimeout(this._tldrTimer);
    if (abstract) {
      this._tldrTimer = setTimeout(() => {
        this.explainSection(abstract, { tldr: true, force: true });
      }, 420);
    } else {
      this.showPlaceholder("Waiting for the spider to reach the abstract…");
    }
  }

  showNoPaper() {
    this.showPlaceholder("Download a paper with python fetch_paper.py, then reload.");
  }

  abortActive() {
    if (this.controller) {
      try { this.controller.abort(); } catch { /* ignore */ }
    }
    clearTimeout(this.timeout);
    this.controller = null;
    this.active = null;
  }

  /* ====================================================================== */
  /* section / selection jobs                                               */
  /* ====================================================================== */

  handleSection(event) {
    const section = event.detail?.section;
    if (!section) return;
    this.currentSection = section;
    if (section.isReferences) return;
    if (!this.aiConfigured) return;
    const text = this.loader.getSectionText(section);
    if (!text || text.length < 120) return;
    if (section.isAbstract && this.explained.has(this.explanationKey(section))) return;
    this.enqueue({
      kind: "section",
      section,
      title: section.title,
      text,
      level: this.level,
      key: this.explanationKey(section),
    });
  }

  explanationKey(section) {
    return `${this.paperKey}:${section.slug}:${this.level}`;
  }

  explainSection(section, { tldr = false, force = false } = {}) {
    if (!section || section.isReferences) return;
    if (!this.aiConfigured) {
      this.showNoKeyMessage();
      return;
    }
    const text = this.loader.getSectionText(section);
    if (!text || !text.trim()) return;
    const key = this.explanationKey(section);
    if (!force && this.explained.has(key)) return;
    this.enqueue({
      kind: "section",
      section,
      title: tldr ? "TL;DR · Abstract" : section.title,
      text,
      level: this.level,
      tldr,
      key,
    });
  }

  explainSelection() {
    if (!this.aiConfigured) {
      this.showNoKeyMessage();
      return;
    }
    const selection = window.getSelection();
    const text = selection?.toString().replace(/\s+/g, " ").trim();
    if (!text || selection.isCollapsed) {
      toast("Select a passage in the paper, then press E");
      return;
    }
    const range = selection.getRangeAt(0);
    if (!this.loader.root.contains(range.commonAncestorContainer)) {
      toast("Select text inside the paper first");
      return;
    }
    if (text.length < 8) {
      toast("That selection is too short to explain");
      return;
    }
    if (text.length > MAX_TEXT) toast("Selection is long; sending the first 12,000 characters");

    const rect = range.getBoundingClientRect();
    const base = this.loader.sectionForElement(range.startContainer.parentElement || range.startContainer) ||
      this.loader.sectionAtDocY(rect.top + scrollY);
    const baseSlug = base?.slug || "passage";
    const docY = rect.top + scrollY;

    this.crawler.goToSelection(rect, "selection");
    const section = {
      id: `selection-${Date.now()}`,
      slug: `selection-${baseSlug}-${Math.random().toString(36).slice(2, 8)}`,
      title: "Selected passage",
      isAbstract: false,
      isReferences: false,
      baseTitle: base?.title || "paper",
    };
    this.enqueue({
      kind: "selection",
      section,
      title: `Selection · ${base?.title || "paper"}`,
      text: text.slice(0, MAX_TEXT),
      level: this.level,
      docY,
      key: `${this.paperKey}:selection:${text.slice(0, 40)}:${this.level}`,
    });
  }

  enqueue(job) {
    if (!this.aiConfigured) {
      this.showNoKeyMessage();
      return;
    }
    // Do not enqueue the same section/level twice (history or queue).
    if (job.kind === "section") {
      if (this.history.some((entry) => entry.key === job.key)) return;
      if (this.queue.some((queued) => queued.key === job.key)) return;
      if (this.active?.job?.key === job.key) return;
    }
    this.queue.push(job);
    this.pump();
  }

  pump() {
    if (this.active || !this.queue.length) return;
    const job = this.queue.shift();
    this.runJob(job);
  }

  async runJob(job) {
    const entry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      key: job.key,
      kind: job.kind,
      title: job.title,
      sectionTitle: job.section?.title || job.title,
      sectionId: job.section?.id || "",
      sectionSlug: job.section?.slug || "",
      baseTitle: job.section?.baseTitle || "",
      tldr: !!job.tldr,
      level: job.level || this.level,
      text: "",
      keyPhrase: "",
      cached: false,
      model: "",
      status: "streaming",
      error: "",
      startedAt: Date.now(),
      docY: job.docY ?? null,
    };
    this.active = { job, entry };
    this.currentEntry = entry;
    this.renderCurrent();
    this.updateActiveBadge();

    const controller = new AbortController();
    this.controller = controller;
    this.timeout = setTimeout(() => controller.abort("timeout"), 150_000);

    try {
      const response = await fetch("/api/explain", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          paperId: this.loader.metadata?.id || "paper",
          title: this.loader.metadata?.title || "the paper",
          section: job.kind === "selection" ? "selected passage" : job.section?.title || job.title,
          sectionSlug: job.section?.slug || "",
          text: job.text.slice(0, MAX_TEXT),
          level: job.level || this.level,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        let message = `HTTP ${response.status}`;
        try {
          const data = await response.json();
          message = data.error || message;
        } catch { /* ignore */ }
        throw new Error(message);
      }
      if (!response.body) throw new Error("Streaming is not supported by this browser.");

      await this.readStream(response.body, entry);
      if (entry.status === "streaming") entry.status = "done";
    } catch (error) {
      if (error.name === "AbortError") {
        if (entry.status === "streaming") {
          entry.status = "error";
          entry.error = error === "timeout" || String(error).includes("timeout")
            ? "The explanation timed out. Try again."
            : "Explanation cancelled.";
        }
      } else {
        entry.status = "error";
        entry.error = error.message || "Could not get an explanation.";
      }
    } finally {
      clearTimeout(this.timeout);
      this.timeout = null;
      if (this.controller === controller) this.controller = null;

      if (entry.status !== "error") {
        this.finishEntry(entry);
      } else {
        this.renderCurrent();
        this.updateActiveBadge(true);
      }

      this.active = null;
      this.pump();
    }
  }

  async readStream(body, entry) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let done = false;

    while (!done) {
      const result = await reader.read();
      if (result.done) break;
      buffer += decoder.decode(result.value, { stream: true });

      let match;
      while ((match = buffer.match(/\r?\n\r?\n/))) {
        const index = match.index;
        const block = buffer.slice(0, index);
        buffer = buffer.slice(index + match[0].length);
        const event = this.parseSseBlock(block);
        if (!event) continue;
        if (event.name === "meta") {
          entry.cached = !!event.data.cached;
          entry.model = event.data.model || "";
          this.renderCurrent();
        } else if (event.name === "delta") {
          entry.text += event.data.text || "";
          this.scheduleRenderCurrent();
        } else if (event.name === "error") {
          entry.status = "error";
          entry.error = event.data.message || "The API returned an error.";
          this.renderCurrent();
        } else if (event.name === "done") {
          if (event.data.key) entry.keyPhrase = event.data.key;
          entry.cached = !!event.data.cached;
          entry.status = entry.status === "error" ? "error" : "done";
          done = true;
          break;
        }
      }
    }

    if (entry.status === "streaming") entry.status = "done";
    const parsedKey = entry.text.match(/(?:^|\n)\s*KEY:\s*(.+?)\s*$/im);
    if (!entry.keyPhrase && parsedKey) entry.keyPhrase = parsedKey[1].trim();
  }

  parseSseBlock(block) {
    let name = "message";
    const dataLines = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("event:")) name = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    }
    if (!dataLines.length) return null;
    const raw = dataLines.join("\n");
    let data = raw;
    try { data = JSON.parse(raw); } catch { /* keep string */ }
    return { name, data };
  }

  finishEntry(entry) {
    if (entry.status === "done") {
      entry.text = stripKeyLine(entry.text);
      this.explained.add(entry.key);
      // Do not duplicate history entries for the same key.
      if (!this.history.some((item) => item.key === entry.key)) {
        this.history.unshift(entry);
        if (this.history.length > 40) this.history.length = 40;
      }
      this.currentEntry = entry;
      this.renderCurrent();
      this.renderHistory();
      this.updateActiveBadge();

      if (entry.keyPhrase) {
        // Let the card paint before the spider starts moving.
        setTimeout(() => {
          const found = this.crawler.pointToPhrase(entry.keyPhrase);
          if (!found) toast("Claude's KEY phrase was not found verbatim in the paper");
        }, 350);
      }
    }
  }

  scheduleRenderCurrent() {
    if (this._renderScheduled) return;
    this._renderScheduled = true;
    requestAnimationFrame(() => {
      this._renderScheduled = false;
      this.renderCurrent();
    });
  }

  /* ====================================================================== */
  /* panel rendering                                                        */
  /* ====================================================================== */

  showPlaceholder(message) {
    if (!this.currentEl) return;
    this.currentEl.innerHTML = "";
    const placeholder = document.createElement("div");
    placeholder.className = "explain-placeholder";
    placeholder.textContent = `▸ ${message}`;
    this.currentEl.append(placeholder);
  }

  showNoKeyMessage() {
    if (!this.currentEl) return;
    this.currentEl.innerHTML = "";
    const card = document.createElement("div");
    card.className = "explain-card is-current";
    const title = document.createElement("div");
    title.className = "card-meta";
    title.innerHTML = `<span class="card-title">AI is off</span><span>no key</span>`;
    const text = document.createElement("p");
    text.className = "card-text";
    text.textContent =
      "Add ANTHROPIC_API_KEY to a .env file in the project root, then restart " +
      "python serve.py and reload. The spider, word anchoring and markup all " +
      "work without AI — select a passage and press E once a key is configured.";
    card.append(title, text);
    this.currentEl.append(card);
    this.updateActiveBadge(true);
  }

  renderCurrent() {
    if (!this.currentEl) return;
    const entry = this.currentEntry;
    if (!entry) {
      if (!this.aiConfigured) this.showNoKeyMessage();
      else this.showPlaceholder("Waiting for the spider to reach the abstract…");
      return;
    }

    this.currentEl.innerHTML = "";
    const card = document.createElement("article");
    card.className = "explain-card is-current";

    const meta = document.createElement("div");
    meta.className = "card-meta";
    const title = document.createElement("span");
    title.className = "card-title";
    title.textContent = entry.title;
    const right = document.createElement("span");
    right.textContent = `${entry.cached ? "cached · " : ""}${entry.level}${entry.status === "streaming" ? " · typing" : ""}`;
    meta.append(title, right);

    const text = document.createElement("p");
    text.className = "card-text";
    text.textContent = stripKeyLine(entry.text);
    if (entry.status === "streaming") {
      const cursor = document.createElement("span");
      cursor.className = "typing-cursor";
      cursor.setAttribute("aria-hidden", "true");
      text.append(cursor);
    }

    card.append(meta, text);

    if (entry.status === "error") {
      const error = document.createElement("p");
      error.className = "card-text";
      error.style.color = "#ff9fa5";
      error.textContent = entry.error;
      card.append(error);
    }

    if (entry.keyPhrase) {
      const keyLine = document.createElement("div");
      keyLine.className = "key-line";
      keyLine.append(document.createTextNode("KEY: "));
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "key-chip";
      chip.textContent = entry.keyPhrase;
      chip.title = "Send the spider to this phrase";
      chip.addEventListener("click", () => {
        const found = this.crawler.pointToPhrase(entry.keyPhrase);
        if (!found) toast("That phrase is not in the paper text");
      });
      keyLine.append(chip);
      card.append(keyLine);
    }

    this.currentEl.append(card);
  }

  renderHistory() {
    if (!this.historyEl) return;
    this.historyEl.innerHTML = "";
    if (!this.history.length) {
      const empty = document.createElement("li");
      empty.className = "history-empty";
      empty.textContent = "Explanations will collect here as the spider crawls.";
      this.historyEl.append(empty);
      return;
    }
    for (const entry of this.history) {
      const li = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "history-item";

      const title = document.createElement("span");
      title.className = "hi-title";
      title.textContent = `${entry.tldr ? "TL;DR · " : ""}${entry.sectionTitle} · ${entry.level}${entry.cached ? " · cached" : ""}`;
      const snippet = document.createElement("span");
      snippet.className = "hi-snippet";
      snippet.textContent = (entry.keyPhrase ? `KEY: ${entry.keyPhrase} — ` : "") + stripKeyLine(entry.text).slice(0, 120);
      button.append(title, snippet);

      button.addEventListener("click", () => {
        this.currentEntry = entry;
        this.renderCurrent();
        if (entry.docY != null) {
          window.scrollTo({ top: Math.max(0, entry.docY - innerHeight * 0.35), behavior: "smooth" });
        } else {
          const section = this.loader.sectionById(entry.sectionId) ||
            this.loader.sections.find((candidate) => candidate.slug === entry.sectionSlug);
          if (section) this.loader.scrollToSection(section);
        }
      });
      li.append(button);
      this.historyEl.append(li);
    }
  }

  clearHistory() {
    this.abortActive();
    this.queue = [];
    this.history = [];
    this.currentEntry = null;
    this.explained.clear();
    this.renderHistory();
    if (this.aiConfigured) this.showPlaceholder("History cleared. Keep crawling.");
    else this.showNoKeyMessage();
  }

  showTab(name) {
    this.tabs = name;
    document.querySelectorAll(".tab-btn").forEach((button) => {
      const active = button.dataset.tab === name;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-selected", String(active));
    });
    document.querySelectorAll(".tab-pane").forEach((pane) => {
      const active = pane.id === `tab-${name}`;
      pane.classList.toggle("is-active", active);
      pane.hidden = !active;
    });
  }

  setLevel(level, { silent = false, reexplain = true } = {}) {
    if (!["beginner", "student", "researcher"].includes(level)) return;
    const changed = this.level !== level;
    this.level = level;
    localStorage.setItem("paperCrawler.level", level);
    this.renderLevelButtons();
    this.crawler.setLevel(level);
    if (!silent && changed) {
      toast(`explanation level: ${level}`);
      // Queue a fresh explanation at the new level for the section the spider
      // is in. serve.py caches per level, so switching back is free.
      if (this.aiConfigured && reexplain && this.currentSection && !this.currentSection.isReferences) {
        this.explainSection(this.currentSection, { force: true });
      }
    }
  }

  renderLevelButtons() {
    document.querySelectorAll(".level-btn").forEach((button) => {
      button.classList.toggle("is-active", button.dataset.level === this.level);
    });
  }

  updateActiveBadge(forceError = false) {
    if (!this.aiStatus) return;
    if (forceError && this.currentEntry?.status === "error") {
      this.aiStatus.textContent = "error";
      this.aiStatus.classList.add("is-error");
      this.aiStatus.classList.remove("is-live");
      return;
    }
    this.applyStatus();
  }

  /* ====================================================================== */
  /* crawler notes                                                          */
  /* ====================================================================== */

  handleTouch(event) {
    const detail = event.detail;
    if (!detail || !["metric", "model", "dataset"].includes(detail.kind)) return;
    const word = (detail.word || "").trim();
    if (!word) return;
    const dedupeKey = `${detail.kind}|${word.toLowerCase()}|${detail.sectionId}|${(detail.sentence || "").slice(0, 60)}`;
    const existing = this.notes.find((note) => note.dedupeKey === dedupeKey);
    if (existing) {
      existing.count += 1;
      existing.at = new Date().toISOString();
      this.renderNotes();
      return;
    }
    this.notes.unshift({
      word: word.slice(0, 160),
      kind: detail.kind,
      section: detail.section || "paper",
      sectionId: detail.sectionId || "",
      sentence: (detail.sentence || "").slice(0, 320),
      at: new Date().toISOString(),
      count: 1,
      dedupeKey,
    });
    if (this.notes.length > 240) this.notes.length = 240;
    this.renderNotes();
    this.notesCount?.classList.add("has-new");
    setTimeout(() => this.notesCount?.classList.remove("has-new"), 1200);
  }

  renderNotes() {
    if (!this.notesEl) return;
    if (this.notesCount) this.notesCount.textContent = String(this.notes.length);
    this.notesEl.innerHTML = "";
    if (!this.notes.length) {
      const empty = document.createElement("li");
      empty.className = "notes-empty";
      empty.textContent = "No notes yet. Let the spider crawl.";
      this.notesEl.append(empty);
      return;
    }
    for (const note of this.notes) {
      const li = document.createElement("li");
      li.className = "note-item";

      const top = document.createElement("div");
      top.className = "note-top";
      const word = document.createElement("span");
      word.className = "note-word";
      word.textContent = note.count > 1 ? `${note.word} ×${note.count}` : note.word;
      const kind = document.createElement("span");
      kind.className = "note-kind";
      kind.textContent = note.kind;
      top.append(word, kind);

      const section = document.createElement("div");
      section.className = "note-sec";
      section.textContent = note.section;

      const sentence = document.createElement("div");
      sentence.className = "note-sentence";
      sentence.textContent = note.sentence || "—";

      li.append(top, section, sentence);
      this.notesEl.append(li);
    }
  }

  /* ====================================================================== */
  /* export                                                                 */
  /* ====================================================================== */

  exportMarkdown() {
    const meta = this.loader.metadata;
    if (!meta) {
      toast("Load a paper before exporting");
      return;
    }
    const lines = [];
    lines.push(`# Paper breakdown — ${meta.title}`);
    lines.push("");
    lines.push(`arXiv: [${meta.id}](${meta.absUrl || `https://arxiv.org/abs/${meta.id}`})  `);
    lines.push(`Authors: ${(meta.authors || []).join(", ")}  `);
    lines.push(`Date: ${meta.date || "unknown"}  `);
    lines.push(`Exported: ${new Date().toISOString().slice(0, 10)}`);
    lines.push("");

    const tldr = this.history.find((entry) => entry.tldr);
    if (tldr) {
      lines.push("## TL;DR");
      lines.push("");
      lines.push(stripKeyLine(tldr.text));
      if (tldr.keyPhrase) {
        lines.push("");
        lines.push(`**KEY:** \`${tldr.keyPhrase}\``);
      }
      lines.push("");
    }

    const ordered = [...this.history].sort((a, b) => a.startedAt - b.startedAt);
    for (const entry of ordered) {
      if (entry.tldr) continue;
      lines.push(`## ${entry.sectionTitle}`);
      lines.push("");
      lines.push(stripKeyLine(entry.text));
      if (entry.keyPhrase) {
        lines.push("");
        lines.push(`**KEY:** \`${entry.keyPhrase}\``);
      }
      lines.push("");
    }

    if (this.notes.length) {
      lines.push("## Crawler notes — metrics, models & datasets");
      lines.push("");
      for (const note of this.notes) {
        lines.push(`- **${note.word}** (${note.kind}, ${note.section}) — ${note.sentence}`);
      }
      lines.push("");
    }

    if (!this.history.length && !this.notes.length) {
      lines.push("_No explanations yet. Configure an ANTHROPIC_API_KEY or let the spider crawl longer._");
      lines.push("");
    }

    const filename = `paper-breakdown-${slug(meta.id)}.md`;
    download(filename, lines.join("\n"), "text/markdown;charset=utf-8");
    toast("Markdown breakdown downloaded");
  }

  exportNotesJson() {
    const meta = this.loader.metadata;
    if (!meta) {
      toast("Load a paper before exporting");
      return;
    }
    const payload = {
      paper: {
        id: meta.id,
        title: meta.title,
        authors: meta.authors,
        date: meta.date,
        url: meta.absUrl,
      },
      exportedAt: new Date().toISOString(),
      notes: this.notes.map(({ dedupeKey, ...note }) => note),
    };
    download(
      `crawler-notes-${slug(meta.id)}.json`,
      JSON.stringify(payload, null, 2),
      "application/json;charset=utf-8"
    );
    toast("Crawler notes downloaded");
  }

  /* ====================================================================== */
  /* keyboard                                                               */
  /* ====================================================================== */

  onKeyDown(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest("input, textarea, select, [contenteditable]")) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.repeat) return;
    const key = event.key.toLowerCase();
    if (key === "e") {
      event.preventDefault();
      this.explainSelection();
    } else if (key === "b") {
      this.setLevel("beginner");
    } else if (key === "s") {
      this.setLevel("student");
    } else if (key === "r") {
      this.setLevel("researcher");
    }
  }
}
