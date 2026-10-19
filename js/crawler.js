/**
 * crawler.js
 * ---------------------------------------------------------------------------
 * The spider simulation.
 *
 * Coordinate system
 *   The spider's body lives in DOCUMENT coordinates (x, y from the top of the
 *   page). That way its feet stay attached to words while the page scrolls.
 *   screen = document - scrollY. All DOM reads happen in update(); all DOM
 *   writes are queued and applied once in commit(); the canvas is drawn last.
 *
 * Legs
 *   Each leg is a two-bone chain solved with the law of cosines. Hips and rest
 *   feet are defined in body-local space, rotated by the body heading, and the
 *   knee is picked with a fixed sign per side (left/right).
 *
 * Gait
 *   Alternating tetrapod: L1 R2 L3 R4, then R1 L2 R3 L4. A leg steps when its
 *   planted foot drifts too far from its rest pose or the leg over-extends.
 *   Each swing is 120-180 ms with an eased lift/plant arc.
 *
 * Frame discipline
 *   update() only reads the DOM (rects, scroll, classes). It appends to write
 *   queues. commit() applies those writes. draw() uses cached values only.
 */

import { SpiderRenderer } from "./spider-draw.js";

const FEMUR = 58;
const TIBIA = 67;
const REACH = FEMUR + TIBIA;
const LEG_LENGTHS = { femur: FEMUR, tibia: TIBIA };

// Hip + rest-foot positions in body-local space. x = forward, y = right.
// (Negative y is the spider's left.) These produce the wide, technical stance.
const LEG_LAYOUT = [
  { hip: { x: 24, y: 24 }, foot: { x: 96, y: 86 } },   // front
  { hip: { x: 8, y: 27 }, foot: { x: 46, y: 108 } },
  { hip: { x: -8, y: 27 }, foot: { x: -44, y: 110 } },
  { hip: { x: -24, y: 24 }, foot: { x: -96, y: 90 } }, // rear
];

const MODELS = new Set([
  "transformer", "bert", "gpt", "gpt-2", "gpt-3", "gpt-4", "resnet", "lora",
  "cnn", "rnn", "lstm", "gru", "gan", "vae", "vit", "clip", "llama", "t5",
  "roberta", "albert", "xlnet", "electra", "bart", "unet", "yolo", "stable",
  "diffusion", "word2vec", "glove", "elmo", "seq2seq", "attention",
]);

const DATASETS = new Set([
  "imagenet", "wmt", "wmt14", "wmt16", "glue", "superglue", "squad", "coco",
  "mscoco", "mmlu", "cifar", "cifar-10", "cifar-100", "mnist", "wikitext",
  "ptb", "penn", "conll", "conll-2003", "librispeech", "ade20k", "cityscapes",
  "kitti", "openwebtext", "pile", "hellaswag", "arc", "gsm8k", "math",
]);

const CLAIM_WORDS = new Set([
  "propose", "proposes", "proposed", "introduce", "introduces", "introduced",
  "outperform", "outperforms", "outperformed", "novel", "novelty", "improve",
  "improves", "improved", "state-of-the-art", "sota", "demonstrate",
  "demonstrates", "we", "our", "results", "show", "shows", "find", "finds",
]);

const BOX_CLASSES = ["m-box-teal", "m-box-purple", "m-box-orange", "m-box-red", "m-box-green"];
const COLOR_CLASSES = ["m-color-teal", "m-color-purple", "m-color-orange", "m-color-red", "m-color-green"];

const INTENSITIES = {
  calm: { probability: 0.22, nearby: 0.0, row: 0.05, extra: 0 },
  normal: { probability: 0.5, nearby: 0.28, row: 0.12, extra: 1 },
  wild: { probability: 0.86, nearby: 0.58, row: 0.28, extra: 2 },
};

const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2);
const easeOutCubic = (t) => 1 - (1 - t) ** 3;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const lerp = (a, b, t) => a + (b - a) * t;
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const rand = (lo, hi) => lo + Math.random() * (hi - lo);

function notify(message, ms = 2100) {
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = message;
  el.classList.add("is-visible");
  clearTimeout(notify._timer);
  notify._timer = setTimeout(() => el.classList.remove("is-visible"), ms);
}

export class Crawler {
  constructor(loader) {
    this.loader = loader;
    this.canvas = document.getElementById("spider-canvas");
    this.renderer = new SpiderRenderer(this.canvas);

    this.viewport = { w: window.innerWidth, h: window.innerHeight };
    this.scrollY = window.scrollY;
    this.scrollX = window.scrollX;
    this.bounds = { left: 0, right: window.innerWidth, topDoc: 0, bottomDoc: 10000 };

    this.visible = false;
    this.paused = false;
    this.follow = true;
    this.intensity = "normal";
    this.level = "student";
    this.debug = new URLSearchParams(location.search).has("debug");

    this.body = { x: 0, y: 0, vx: 0, vy: 0 };
    this.bodyScreen = null;
    this.heading = Math.PI / 2;
    this.bob = 0;
    this.scale = 1;
    this.legs = [];
    this.gaitGroup = 0;

    this.target = null;
    this.mode = "wander";
    this.readingUntil = 0;
    this.nextTargetAt = 0;
    this.cursorDoc = null;
    this.chaseUntil = 0;
    this.clickLockUntil = 0;
    this.manualUntil = 0;
    this.lastAutoScrollAt = 0;
    this.pendingScroll = null;

    this.entrance = { phase: "none", startedAt: 0, fromY: 0, toY: 0, duration: 2300, landedAt: 0 };
    this.thread = null;
    this.trails = [];
    this.ripples = [];
    this.sparks = [];
    this.focus = null;
    this.pointTarget = null;
    this.pointingUntil = 0;
    this.pendingWrites = [];
    this.pendingEvents = [];
    this.pendingNotes = [];
    this.pendingHud = null;
    this.pendingSection = null;
    this.announcedSections = new Set();
    this.currentSection = null;
    this.reachedReferences = false;

    this.lastFrame = 0;
    this.fps = 60;
    this.fpsAccum = 0;
    this.fpsFrames = 0;
    this.running = false;
    this.wasDragging = false;

    this._onPointerMove = this.onPointerMove.bind(this);
    this._onPointerLeave = this.onPointerLeave.bind(this);
    this._onClick = this.onClick.bind(this);
    this._onKeyDown = this.onKeyDown.bind(this);
    this._onScroll = this.onScroll.bind(this);
    this._onResize = this.onResize.bind(this);
    this._onWheel = this.onWheel.bind(this);
  }

  /* ====================================================================== */
  /* lifecycle + controls                                                   */
  /* ====================================================================== */

  start() {
    if (this.running) return;
    this.running = true;
    this.renderer.resize();
    this.viewport = { w: innerWidth, h: innerHeight };
    this.bindEvents();

    const frame = (now) => {
      if (!this.running) return;
      const dt = this.lastFrame ? Math.min((now - this.lastFrame) / 1000, 0.05) : 1 / 60;
      this.lastFrame = now;

      this.fpsAccum += dt;
      this.fpsFrames += 1;
      if (this.fpsAccum >= 0.5) {
        this.fps = Math.round(this.fpsFrames / this.fpsAccum);
        this.fpsAccum = 0;
        this.fpsFrames = 0;
      }

      this.update(now, dt);
      this.commit(now);
      this.renderer.render(this, now);
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }

  bindEvents() {
    window.addEventListener("pointermove", this._onPointerMove, { passive: true });
    window.addEventListener("pointerleave", this._onPointerLeave, { passive: true });
    window.addEventListener("click", this._onClick);
    window.addEventListener("keydown", this._onKeyDown);
    window.addEventListener("scroll", this._onScroll, { passive: true });
    window.addEventListener("wheel", this._onWheel, { passive: true });
    window.addEventListener("resize", this._onResize);

    document.getElementById("hud-pause")?.addEventListener("click", () => this.togglePause());
    document.getElementById("hud-follow")?.addEventListener("click", () => this.toggleFollow());
  }

  hide() {
    this.visible = false;
    this.renderer.render(this, performance.now());
  }

  reset(redrop = false) {
    if (!this.loader.sections.length) {
      this.visible = false;
      return;
    }
    const abstract = this.loader.abstractSection || this.loader.sections[0];
    const paper = this.loader.getPaperBounds();
    const top = this.loader.getSectionTop(abstract) ?? 160;
    const x = clamp((paper.left + paper.right) / 2, paper.left + 70, paper.right - 70);
    const landingY = Math.max(top + 34, 120);

    if (redrop) {
      window.scrollTo({ top: 0, behavior: "auto" });
      this.scrollY = 0;
    }

    this.visible = true;
    this.body = {
      x,
      y: -Math.max(230, this.viewport.h * 0.28),
      vx: 0,
      vy: 0,
    };
    this.heading = Math.PI / 2;
    this.bob = 0;
    this.scale = 0.92;
    this.target = null;
    this.mode = "wander";
    this.readingUntil = 0;
    this.nextTargetAt = 0;
    this.manualUntil = 0;
    this.pendingScroll = null;
    this.pointTarget = null;
    this.pointingUntil = 0;
    this.focus = null;
    this.currentSection = abstract;
    this.reachedReferences = false;
    this.announcedSections.clear();
    this.trails = [];
    this.ripples = [];
    this.sparks = [];
    this.pendingWrites = [];
    this.pendingEvents = [];
    this.pendingNotes = [];
    this.pendingSection = null;
    this.pendingHud = null;
    this.currentSection = abstract;

    this.entrance = {
      phase: "descend",
      startedAt: performance.now() + (redrop ? 100 : 250),
      fromY: this.body.y,
      toY: landingY,
      duration: 2250,
      landedAt: 0,
    };
    this.thread = {
      visible: true,
      snapped: false,
      anchorX: x,
      landedX: x,
      landedY: landingY,
      alpha: 1,
      fade: 1,
      sway: 6,
      phase: Math.random() * 10,
    };

    this.buildLegs();
    this.reachedReferences = false;
    this.setHudSection(abstract?.title || "paper");
    this.updatePaperBounds(true);

    // Camera always starts at the top for the entrance.
    if (redrop) this.queueScroll(0);
    this.pendingEvents.push({
      type: "crawler:dropped",
      detail: { metadata: this.loader.metadata, section: abstract },
    });
  }

  buildLegs() {
    const signs = {};
    // Pick a fixed knee direction per side by choosing the solution that points
    // further outward in the canonical rest pose. This is deterministic and
    // keeps the knees from flipping while the spider walks.
    for (const side of [-1, 1]) {
      const layout = LEG_LAYOUT[1];
      const hip = { x: layout.hip.x, y: side * layout.hip.y };
      const foot = { x: layout.foot.x, y: side * layout.foot.y };
      const kneeA = this.solveKnee(hip, foot, 1);
      const kneeB = this.solveKnee(hip, foot, -1);
      signs[side] = (side * kneeA.y >= side * kneeB.y) ? 1 : -1;
    }

    this.legs = [];
    for (const side of [-1, 1]) {
      for (let index = 0; index < 4; index += 1) {
        const layout = LEG_LAYOUT[index];
        const hipLocal = { x: layout.hip.x, y: side * layout.hip.y };
        const footLocal = { x: layout.foot.x, y: side * layout.foot.y };
        const group = (side === -1 ? index % 2 === 0 : index % 2 === 1) ? 0 : 1;
        const leg = {
          side: side === -1 ? "L" : "R",
          sideSign: side,
          index,
          group,
          hipLocal,
          footLocal,
          footDoc: { x: this.body.x + footLocal.x, y: this.body.y + footLocal.y },
          state: "planted",
          anchor: null,
          swing: null,
          kneeSign: signs[side],
          reach: REACH,
          stepThreshold: 30,
          lift: 0,
          hip: null,
          knee: null,
          foot: null,
          rest: null,
          anchored: false,
          pointing: false,
        };
        this.legs.push(leg);
      }
    }
  }

  togglePause() {
    this.paused = !this.paused;
    this.updateHud();
    notify(this.paused ? "paused — press Space to resume" : "crawling again");
  }

  toggleFollow() {
    this.follow = !this.follow;
    this.updateHud();
    notify(`camera follow ${this.follow ? "on" : "off"}`);
  }

  setIntensity(name) {
    if (!INTENSITIES[name]) return;
    this.intensity = name;
    this.updateHud();
    notify(`ink intensity: ${name}`);
  }

  setLevel(level) {
    this.level = level;
    this.updateHud();
  }

  toggleTitle() {
    const overlay = document.getElementById("title-overlay");
    if (!overlay) return;
    overlay.classList.toggle("is-visible");
    overlay.setAttribute("aria-hidden", String(!overlay.classList.contains("is-visible")));
  }

  clearMarkup() {
    const count = this.loader.clearMarkup();
    this.trails = [];
    this.sparks = [];
    this.focus = null;
    notify(count ? `cleared ${count} marked words` : "nothing marked yet");
  }

  updateHud() {
    const state = document.getElementById("hud-state");
    const level = document.getElementById("hud-level");
    const follow = document.getElementById("hud-follow");
    const pause = document.getElementById("hud-pause");
    if (state) state.textContent = this.paused ? "paused" : this.intensity;
    if (level) level.textContent = this.level;
    if (follow) follow.textContent = `follow: ${this.follow ? "on" : "off"}`;
    if (pause) pause.textContent = this.paused ? "resume" : "pause";
  }

  setHudSection(title) {
    this.pendingHud = title;
  }

  onPointerMove(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest("#topbar, #analyst-panel, #controls-hud, .toast, #loading, button, select, input, textarea, a")) return;
    const now = performance.now();
    this.cursorDoc = { x: event.clientX + scrollX, y: event.clientY + scrollY };
    this.chaseUntil = now + 1700;
    this.clickLockUntil = 0;
    this.readingUntil = 0;
  }

  onPointerLeave() {
    this.chaseUntil = 0;
  }

  onClick(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest("#topbar, #analyst-panel, #controls-hud, .toast, button, select, input, textarea, a")) return;
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed && selection.toString().trim()) return;
    const now = performance.now();
    this.cursorDoc = { x: event.clientX + scrollX, y: event.clientY + scrollY };
    this.clickLockUntil = now + 3500;
    this.chaseUntil = now + 3500;
    this.readingUntil = 0;
    this.ripples.push({ x: event.clientX, y: event.clientY, created: now });
    if (this.ripples.length > 6) this.ripples.shift();
  }

  onWheel() {
    this.manualUntil = performance.now() + 2500;
  }

  onScroll() {
    const now = performance.now();
    // Scroll events are also fired by our own camera. Compare against the last
    // programmatic destination so auto-scroll does not keep resetting the
    // manual-override timer.
    const expected = this._lastProgrammaticScroll;
    if (expected == null || Math.abs(window.scrollY - expected) > 2) {
      this.manualUntil = now + 2500;
    }
    this.scrollY = window.scrollY;
    this.scrollX = window.scrollX;
  }

  onResize() {
    this.viewport = { w: innerWidth, h: innerHeight };
    this.renderer.resize();
    this.updatePaperBounds(true);
    if (!this.loader.sections.length) return;
    if (!this.visible) return;
    this.body.x = clamp(this.body.x, this.bounds.left + 60, this.bounds.right - 60);
  }

  onKeyDown(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest("input, textarea, select, [contenteditable]")) return;
    const key = event.key;

    if (key === " " && !target?.closest("button, a, [role=button]")) {
      event.preventDefault();
      this.togglePause();
      return;
    }
    if (key === "f" || key === "F") { this.toggleFollow(); return; }
    if (key === "t" || key === "T") { this.toggleTitle(); return; }
    if (key === "c" || key === "C") { this.clearMarkup(); return; }
    if (key === "d" || key === "D") { this.reset(true); notify("re-dropping the spider"); return; }
    if (key === "1") { this.setIntensity("calm"); return; }
    if (key === "2") { this.setIntensity("normal"); return; }
    if (key === "3") { this.setIntensity("wild"); return; }
    if (key === "`") { this.debug = !this.debug; notify(`debug ${this.debug ? "on" : "off"}`); }
  }

  /* ====================================================================== */
  /* public AI + selection targets                                          */
  /* ====================================================================== */

  pointToPhrase(phrase) {
    if (!this.visible) return false;
    const result = this.loader.findPhrase(phrase);
    if (!result) return false;

    const rect = result.unionRect || result.rect;
    const now = performance.now();
    const center = {
      x: rect.left + rect.width / 2 + scrollX,
      y: rect.top + rect.height / 2 + scrollY,
    };
    this.pointTarget = center;
    this.pointingUntil = now + 6500;
    this.readingUntil = 0;
    this.nextTargetAt = now + 9000;
    this.focus = {
      spans: result.spans,
      rectScreen: result.rect,
      until: now + 6500,
    };

    // The biggest markup in the system: orange box + blow-up + a flash.
    result.spans.forEach((span, index) => {
      this.queueClass(span, "m-box-orange");
      this.queueClass(span, "m-color-orange");
      if (index === 0) {
        this.queueClass(span, "m-blowup");
        this.queueClass(span, "m-key");
      }
    });
    this.pendingEvents.push({
      type: "crawler:key",
      detail: { phrase: result.phrase, section: result.section?.title || "" },
    });
    notify(`Claude found: “${result.phrase.slice(0, 58)}”`, 3000);
    return true;
  }

  goToSelection(rect, label = "selection") {
    if (!this.visible || !rect) return;
    const now = performance.now();
    const center = {
      x: rect.left + rect.width / 2 + scrollX,
      y: rect.top + rect.height / 2 + scrollY,
    };
    this.pointTarget = center;
    this.pointingUntil = now + 4200;
    this.readingUntil = 0;
    this.focus = { spans: [], rectScreen: rect, until: now + 4200 };
    this.nextTargetAt = now + 6000;
    notify(`crawling to your ${label}`);
  }

  /* ====================================================================== */
  /* frame: update -> commit -> draw                                        */
  /* ====================================================================== */

  update(now, dt) {
    this.scrollY = window.scrollY;
    this.scrollX = window.scrollX;
    this.viewport = { w: innerWidth, h: innerHeight };
    this.updatePaperBounds(false);

    if (!this.visible) {
      this.bodyScreen = null;
      return;
    }

    if (this.entrance.phase === "descend" || this.entrance.phase === "landing") {
      this.updateEntrance(now);
      const stillEntering = this.entrance.phase === "descend" || this.entrance.phase === "landing";
      this.updateBodyScreen();
      this.updateAnchorPositions();
      this.computeLegs(now, stillEntering);
      this.updateFocus(now);
      this.updateThread(now);
      this.updateTrails(now);
      return;
    }

    if (!this.paused) {
      this.updateSection(now);
      this.updateFocus(now);
      this.chooseMovement(now, dt);
      this.updateGait(now, dt);
      this.updateAutoScroll(now, dt);
      this.updateThread(now);
    } else {
      this.updateAnchorPositions();
      this.updateFocus(now);
      this.updateThread(now);
    }

    this.updateBodyScreen();
    this.computeLegs(now, false);
    this.updateTrails(now);
    this.bob = Math.sin(now / 380) * 0.85 + Math.sin(now / 170) * 0.12;
    this.scale = lerp(this.scale, 1, Math.min(1, dt * 4));
    if (this.thread && !this.thread.snapped) {
      this.thread.alpha = Math.min(1, (this.thread.alpha ?? 1) + dt * 0.8);
    }
  }

  updatePaperBounds(force) {
    if (!force && performance.now() - (this._boundsAt || 0) < 450) return;
    this._boundsAt = performance.now();
    this.bounds = this.loader.getPaperBounds();
  }

  updateBodyScreen() {
    this.bodyScreen = {
      x: this.body.x - this.scrollX,
      y: this.body.y - this.scrollY,
    };
  }

  updateEntrance(now) {
    const e = this.entrance;
    if (now < e.startedAt) {
      this.bodyScreen = { x: this.body.x - scrollX, y: this.body.y - scrollY };
      return;
    }
    const t = clamp((now - e.startedAt) / e.duration, 0, 1);
    const eased = easeOutCubic(t);
    this.body.y = lerp(e.fromY, e.toY, eased);
    this.body.x += Math.sin(now / 700) * 0.12;
    this.heading = Math.PI / 2 + Math.sin(now / 1000) * 0.05;
    this.scale = lerp(0.85, 1, eased);
    this.thread.anchorX = this.thread.landedX;

    if (this.entrance.phase === "landing") {
      const landingT = clamp((now - e.landedAt) / 520, 0, 1);
      this.entrance.splay = lerp(0.58, 1, easeOutCubic(landingT));
      if (landingT >= 1) {
        this.entrance.phase = "done";
        this.body.y = e.toY;
        this.readingUntil = now + 800;
        this.nextTargetAt = now + 800;
        // Feet are now free targets; the gait will start snapping them to words.
        for (const leg of this.legs) {
          leg.footDoc = this.localToDoc(leg.footLocal, 1);
          leg.state = "planted";
        }
      }
      return;
    }

    if (t >= 1) {
      this.entrance.phase = "landing";
      this.entrance.landedAt = now;
      this.entrance.splay = 0.58;
      this.body.y = e.toY;
      this.body.vx = 0;
      this.body.vy = 0;
    }
  }

  updateThread(now) {
    if (!this.thread?.visible) return;
    if (this.thread.snapped) {
      this.thread.fade = Math.max(0, (this.thread.fade ?? 1) - 0.018);
      if (this.thread.fade <= 0) this.thread.visible = false;
      return;
    }
    if (this.entrance.phase !== "descend") {
      const moved = Math.hypot(this.body.x - this.thread.landedX, this.body.y - this.thread.landedY);
      if (moved > 175 || now - this.entrance.landedAt > 8000) {
        this.thread.snapped = true;
        this.thread.fade = 1;
        this.sparks.push({
          x: this.bodyScreen?.x || this.body.x,
          y: this.bodyScreen?.y || this.body.y,
          vx: rand(-1.6, 1.6),
          vy: rand(-1.2, 0.4),
          created: now,
          life: 700,
          color: "rgba(220,245,250,0.85)",
        });
      }
    }
  }

  updateSection(now) {
    if (now - (this._sectionAt || 0) < 260) return;
    this._sectionAt = now;
    const section = this.loader.sectionAtDocY(this.body.y);
    if (!section) return;
    if (section === this.currentSection) return;
    this.currentSection = section;
    this.setHudSection(section.title);
    this.pendingEvents.push({
      type: "crawler:section",
      detail: {
        section,
        id: section.id,
        title: section.title,
        slug: section.slug,
        isAbstract: section.isAbstract,
        isReferences: section.isReferences,
        text: this.loader.getSectionText(section),
      },
    });
  }

  chooseMovement(now, dt) {
    const chase = (this.chaseUntil > now && this.cursorDoc) || (this.clickLockUntil > now && this.cursorDoc);
    const pointing = this.pointTarget && now < this.pointingUntil;

    if (pointing) this.mode = "point";
    else if (chase) this.mode = "chase";
    else this.mode = "wander";

    let tx;
    let ty;
    if (pointing) {
      tx = this.pointTarget.x;
      ty = this.pointTarget.y - 54;
    } else if (chase) {
      tx = this.cursorDoc.x;
      ty = this.cursorDoc.y;
    } else {
      if (!this.target || now >= this.nextTargetAt) this.chooseWanderTarget(now);
      if (!this.target) return;
      tx = this.target.x;
      ty = this.target.y;
    }

    tx = clamp(tx, this.bounds.left + 55, this.bounds.right - 55);
    ty = clamp(ty, this.bounds.topDoc + 20, this.bounds.bottomDoc - 20);
    this.targetScreen = { x: tx - scrollX, y: ty - scrollY };

    const dx = tx - this.body.x;
    const dy = ty - this.body.y;
    const distance = Math.hypot(dx, dy);

    let desiredSpeed = 0;
    if (this.mode === "chase") desiredSpeed = 300;
    else if (this.mode === "point") desiredSpeed = 230;
    else desiredSpeed = 62;

    if (now < this.readingUntil) desiredSpeed = 0;
    if (this.mode === "wander" && distance < 34) {
      if (!this.readingUntil) {
        this.readingUntil = now + rand(1200, 3400);
        this.nextTargetAt = this.readingUntil + rand(200, 900);
      }
      desiredSpeed = 0;
    }
    if (this.mode === "point" && distance < 58) {
      desiredSpeed = 0;
      this.pointingUntil = Math.max(this.pointingUntil, now + 1800);
    }
    if (this.mode === "chase" && distance < 26) desiredSpeed = 0;

    // A little perlin-ish wander so the path is not a straight line.
    const wobble = this.mode === "wander" ? Math.sin(now / 520 + this.body.y / 130) * 8 : 0;

    let dvx = 0;
    let dvy = 0;
    if (distance > 0.001 && desiredSpeed > 0) {
      dvx = (dx / distance) * desiredSpeed + (dy / distance) * wobble;
      dvy = (dy / distance) * desiredSpeed - (dx / distance) * wobble;
    }

    const responsiveness = this.mode === "chase" ? 6.2 : 3.4;
    this.body.vx += (dvx - this.body.vx) * Math.min(1, dt * responsiveness);
    this.body.vy += (dvy - this.body.vy) * Math.min(1, dt * responsiveness);

    // Clamp speed.
    const speed = Math.hypot(this.body.vx, this.body.vy);
    const maxSpeed = this.mode === "chase" ? 360 : 105;
    if (speed > maxSpeed) {
      this.body.vx = (this.body.vx / speed) * maxSpeed;
      this.body.vy = (this.body.vy / speed) * maxSpeed;
    }

    this.body.x = clamp(this.body.x + this.body.vx * dt, this.bounds.left + 40, this.bounds.right - 40);
    this.body.y = clamp(this.body.y + this.body.vy * dt, this.bounds.topDoc + 8, this.bounds.bottomDoc - 8);

    // Heading follows velocity; when still it keeps a slow idle sway.
    if (speed > 4) {
      const targetHeading = Math.atan2(this.body.vy, this.body.vx);
      const difference = Math.atan2(
        Math.sin(targetHeading - this.heading),
        Math.cos(targetHeading - this.heading)
      );
      this.heading += difference * Math.min(1, dt * 7);
    } else {
      this.heading += Math.sin(now / 1200) * 0.0008;
    }
  }

  chooseWanderTarget(now) {
    const current = this.loader.sectionAtDocY(this.body.y) || this.currentSection;
    const blocks = current?.allBlocks?.length ? current.allBlocks : this.loader.blocks;
    if (!blocks?.length) {
      this.target = { x: rand(this.bounds.left + 80, this.bounds.right - 80), y: this.body.y + 160 };
      this.nextTargetAt = now + 2600;
      return;
    }

    const candidates = [];
    const bodyY = this.body.y;
    for (const block of blocks) {
      if (!block.isConnected) continue;
      const rect = block.getBoundingClientRect();
      if (!rect.width || !rect.height) continue;
      const top = rect.top + scrollY;
      const bottom = rect.bottom + scrollY;
      if (bottom < bodyY - 180) continue;
      if (top > bodyY + 720) continue;
      // Prefer blocks below the body: the spider reads top to bottom.
      const below = top >= bodyY - 20;
      const weight = below ? (1.8 - Math.min(1, (top - bodyY) / 720)) : 0.28;
      candidates.push({ block, rect, top, bottom, weight });
    }

    if (!candidates.length) {
      const index = this.loader.sections.indexOf(current);
      const next = this.loader.sections[index + 1];
      if (next) {
        const top = this.loader.getSectionTop(next);
        if (top != null) {
          this.target = {
            x: rand(this.bounds.left + 70, this.bounds.right - 70),
            y: Math.max(bodyY + 70, top + 50),
          };
          this.nextTargetAt = now + 3200;
          return;
        }
      }
      this.target = {
        x: rand(this.bounds.left + 80, this.bounds.right - 80),
        y: Math.min(this.bounds.bottomDoc - 20, bodyY + rand(100, 260)),
      };
      this.nextTargetAt = now + 2800;
      return;
    }

    const totalWeight = candidates.reduce((sum, c) => sum + c.weight, 0);
    let roll = Math.random() * totalWeight;
    let chosen = candidates[candidates.length - 1];
    for (const candidate of candidates) {
      roll -= candidate.weight;
      if (roll <= 0) { chosen = candidate; break; }
    }

    const rect = chosen.rect;
    const x = rand(rect.left + scrollX + 18, rect.right + scrollX - 18);
    const lineHeight = Math.min(rect.height, 120);
    const y = rect.top + scrollY + rand(lineHeight * 0.18, lineHeight * 0.78);
    this.target = { x, y };
    this.readingUntil = 0;
    this.nextTargetAt = now + rand(2600, 5200);
  }

  /* ====================================================================== */
  /* auto-scroll / camera                                                   */
  /* ====================================================================== */

  updateAutoScroll(now, dt) {
    if (!this.follow || now < this.manualUntil) return;

    const screenY = this.body.y - this.scrollY;
    const h = this.viewport.h;
    let desired = this.scrollY;

    if (this.mode === "chase" || this.mode === "point") {
      // Keep a travelling spider in view, even when the target is above.
      if (screenY < h * 0.18) desired = this.body.y - h * 0.42;
      else if (screenY > h * 0.78) desired = this.body.y - h * 0.45;
      else return;
    } else if (screenY < -h * 0.1) {
      // After the manual-scroll grace period, bring the spider back into view.
      desired = this.body.y - h * 0.45;
    } else if (screenY > h * 0.56) {
      // Slow, reading-speed camera. The spider's body drives the scroll.
      const push = Math.min(58 * dt, Math.max(0, screenY - h * 0.54));
      desired = this.scrollY + push;
    } else {
      return;
    }

    const refs = this.loader.referencesSection;
    if (refs) {
      const refTop = this.loader.getSectionTop(refs);
      if (refTop != null) {
        const limit = Math.max(0, refTop - h * 0.38);
        desired = Math.min(desired, limit);
        this.reachedReferences = this.scrollY >= limit - 2;
      }
    }

    const maxScroll = Math.max(0, document.documentElement.scrollHeight - h);
    desired = clamp(desired, 0, maxScroll);
    if (Math.abs(desired - this.scrollY) > 0.35) {
      this.pendingScroll = desired;
    }
  }

  queueScroll(value) {
    this.pendingScroll = value;
  }

  /* ====================================================================== */
  /* legs, IK and gait                                                      */
  /* ====================================================================== */

  localToDoc(local, scale = 1) {
    const cos = Math.cos(this.heading);
    const sin = Math.sin(this.heading);
    const forward = { x: cos, y: sin };
    const right = { x: -sin, y: cos };
    return {
      x: this.body.x + (local.x * forward.x + local.y * right.x) * scale,
      y: this.body.y + (local.x * forward.y + local.y * right.y) * scale,
    };
  }

  solveKnee(hip, foot, sign) {
    const dx = foot.x - hip.x;
    const dy = foot.y - hip.y;
    const d = Math.max(0.001, Math.hypot(dx, dy));
    const a = (d * d + FEMUR * FEMUR - TIBIA * TIBIA) / (2 * d);
    const h = Math.sqrt(Math.max(0, FEMUR * FEMUR - a * a));
    const ux = dx / d;
    const uy = dy / d;
    const base = { x: hip.x + ux * a, y: hip.y + uy * a };
    return { x: base.x + (-uy) * h * sign, y: base.y + ux * h * sign };
  }

  updateAnchorPositions() {
    for (const leg of this.legs) {
      if (leg.anchor) {
        const point = this.anchorPoint(leg.anchor);
        if (point) {
          leg.footDoc = point;
          leg.anchored = true;
        } else {
          leg.anchor = null;
          leg.anchored = false;
        }
      }
    }
  }

  anchorPoint(anchor) {
    const el = anchor?.el;
    if (!el || !el.isConnected) return null;
    const rects = el.getClientRects();
    if (!rects.length) return null;
    const rect = rects[0];
    if (rect.width < 1 && rect.height < 1) return null;
    return {
      x: rect.left + scrollX + rect.width * anchor.rx,
      y: rect.top + scrollY + rect.height * anchor.ry,
    };
  }

  updateGait(now, dt) {
    const swinging = this.legs.filter((leg) => leg.state === "swing");

    // Update swings first.
    for (const leg of this.legs) {
      if (leg.state !== "swing") continue;
      const swing = leg.swing;
      const t = clamp((now - swing.startedAt) / swing.duration, 0, 1);
      const eased = easeInOut(t);
      const start = swing.startDoc;
      let end = swing.endDoc;

      if (swing.anchor) {
        const tracked = this.anchorPoint(swing.anchor);
        if (tracked) {
          swing.endDoc = tracked;
          end = tracked;
        } else {
          swing.anchor = null;
        }
      }

      leg.lift = Math.sin(Math.PI * t) * swing.lift;
      leg.footDoc = {
        x: lerp(start.x, end.x, eased),
        y: lerp(start.y, end.y, eased),
      };

      if (t >= 1) {
        leg.state = "planted";
        leg.lift = 0;
        leg.footDoc = { ...end };
        if (swing.anchor && this.anchorPoint(swing.anchor)) {
          leg.anchor = swing.anchor;
          leg.anchored = true;
          this.onFootPlant(leg, leg.anchor, now);
        } else {
          leg.anchor = null;
          leg.anchored = false;
          if (Math.random() < 0.35) this.onFootPlant(leg, null, now);
        }
        leg.swing = null;
      }
    }

    const currentSwinging = this.legs.filter((leg) => leg.state === "swing");
    if (currentSwinging.length >= 4) return;

    // Determine which legs want to step.
    const wants = [];
    for (const leg of this.legs) {
      if (leg.state === "swing") continue;
      if (leg.pointing) continue;
      const hip = this.localToDoc(leg.hipLocal);
      const rest = this.localToDoc(leg.footLocal);
      leg.rest = rest;
      const footScreen = { x: leg.footDoc.x - scrollX, y: leg.footDoc.y - scrollY };
      const restScreen = { x: rest.x - scrollX, y: rest.y - scrollY };
      const drift = Math.hypot(footScreen.x - restScreen.x, footScreen.y - restScreen.y);
      const reachUse = Math.hypot(hip.x - leg.footDoc.x, hip.y - leg.footDoc.y);
      leg.stepThreshold = 28 + Math.min(22, Math.hypot(this.body.vx, this.body.vy) * 0.12);
      const overExtended = reachUse > REACH * 0.93;
      if (drift > leg.stepThreshold || overExtended) {
        wants.push(leg);
      }
    }
    if (!wants.length) return;

    const active = wants.filter((leg) => leg.group === this.gaitGroup);
    let toStart = active;
    if (!active.length) {
      this.gaitGroup ^= 1;
      toStart = wants.filter((leg) => leg.group === this.gaitGroup);
    }
    // At most one swing per group per beat, so the gait reads as a tetrapod
    // rather than the whole animal exploding at once.
    if (currentSwinging.some((leg) => leg.group === this.gaitGroup)) return;

    const first = toStart[0];
    if (first) this.startSwing(first, now);
  }

  startSwing(leg, now) {
    const rest = this.localToDoc(leg.footLocal);
    const restScreen = { x: rest.x - scrollX, y: rest.y - scrollY };
    const anchor = this.findFootAnchor(restScreen.x, restScreen.y);
    const endDoc = anchor ? this.anchorPoint(anchor) || rest : rest;
    leg.state = "swing";
    leg.anchored = false;
    leg.anchor = null;
    leg.swing = {
      startDoc: { ...leg.footDoc },
      endDoc,
      anchor,
      startedAt: now,
      duration: rand(125, 180),
      lift: rand(11, 24) + (leg.index === 0 ? 3 : 0),
    };
  }

  findFootAnchor(x, y) {
    const tryPoint = (px, py) => {
      if (px < 0 || py < 0 || px > innerWidth || py > innerHeight) return null;
      const el = document.elementFromPoint(px, py);
      if (!el) return null;
      if (el.closest("#analyst-panel, #topbar, #controls-hud")) return null;
      const word = el.closest(".w");
      if (word) return this.makeAnchor(word, px, py, "word");
      const cell = el.closest("td, th");
      if (cell) return this.makeAnchor(cell, px, py, "cell");
      const link = el.closest("a");
      if (link) return this.makeAnchor(link, px, py, "link");
      return null;
    };

    let anchor = tryPoint(x, y);
    if (anchor) return anchor;

    const rings = [4, 9, 15, 22, 30, 40];
    const directions = 8;
    for (const radius of rings) {
      for (let i = 0; i < directions; i += 1) {
        const angle = (Math.PI * 2 * i) / directions + radius * 0.11;
        anchor = tryPoint(x + Math.cos(angle) * radius, y + Math.sin(angle) * radius);
        if (anchor && anchor.kind === "word") return anchor;
      }
    }
    return anchor;
  }

  makeAnchor(el, x, y, kind) {
    const rects = el.getClientRects();
    if (!rects.length) return null;
    // Clamp to the nearest rect if the element wraps across lines.
    let rect = rects[0];
    let best = Infinity;
    for (const candidate of rects) {
      const cx = clamp(x, candidate.left, candidate.right);
      const cy = clamp(y, candidate.top, candidate.bottom);
      const d = Math.hypot(cx - x, cy - y);
      if (d < best) { best = d; rect = candidate; }
    }
    if (rect.width < 1 || rect.height < 1) return null;
    const px = clamp(x, rect.left + 2, rect.right - 2);
    const py = clamp(y, rect.top + rect.height * 0.35, rect.top + rect.height * 0.92);
    return {
      el,
      kind,
      rx: clamp((px - rect.left) / rect.width, 0.08, 0.92),
      ry: clamp((py - rect.top) / rect.height, 0.25, 0.9),
    };
  }

  computeLegs(now, entrance) {
    const pointing = this.pointingUntil > now && this.pointTarget;
    let pointLeg = null;
    if (pointing) {
      const dx = this.pointTarget.x - this.body.x;
      const dy = this.pointTarget.y - this.body.y;
      const left = dx * -Math.sin(this.heading) + dy * Math.cos(this.heading);
      pointLeg = this.legs.find((leg) => leg.index === 0 && leg.sideSign === (left >= 0 ? 1 : -1)) ||
        this.legs.find((leg) => leg.index === 0);
    }

    for (const leg of this.legs) {
      const hipDoc = this.localToDoc(leg.hipLocal);
      leg.rest = this.localToDoc(leg.footLocal);

      if (entrance) {
        // Legs are gathered during the thread drop, then splay open on landing.
        // 0.58 keeps the foot outside the two-bone chain's minimum reach, which
        // avoids the IK singularity that would fling the knees outward.
        const tuck = this.entrance.phase === "landing" ? (this.entrance.splay ?? 0.58) : 0.58;
        leg.footDoc = this.localToDoc(
          { x: leg.footLocal.x * tuck, y: leg.footLocal.y * tuck },
          1
        );
        leg.lift = 0;
      } else if (leg.anchor) {
        const tracked = this.anchorPoint(leg.anchor);
        if (tracked) leg.footDoc = tracked;
        else { leg.anchor = null; leg.anchored = false; }
      }

      if (pointing && leg === pointLeg) {
        const angle = Math.atan2(this.pointTarget.y - this.body.y, this.pointTarget.x - this.body.x);
        const target = {
          x: this.body.x + Math.cos(angle) * REACH * 0.88,
          y: this.body.y + Math.sin(angle) * REACH * 0.88,
        };
        leg.footDoc = {
          x: lerp(leg.footDoc.x, target.x, 0.35),
          y: lerp(leg.footDoc.y, target.y, 0.35),
        };
        leg.pointing = true;
      } else {
        leg.pointing = false;
      }

      leg.hip = { x: hipDoc.x - scrollX, y: hipDoc.y - scrollY };
      const footScreen = {
        x: leg.footDoc.x - scrollX,
        y: leg.footDoc.y - scrollY - leg.lift,
      };
      let dx = footScreen.x - leg.hip.x;
      let dy = footScreen.y - leg.hip.y;
      let d = Math.hypot(dx, dy);
      if (d < 0.001) { dx = 1; dy = 0; d = 1; }
      // Keep the target inside the annulus the two-bone chain can actually
      // reach: [|femur-tibia|, femur+tibia]. Without the lower clamp, a tucked
      // foot would make the knee shoot out to the opposite side.
      const minReach = Math.abs(FEMUR - TIBIA) + 2;
      if (d < minReach) {
        const scale = minReach / d;
        dx *= scale;
        dy *= scale;
        footScreen.x = leg.hip.x + dx;
        footScreen.y = leg.hip.y + dy;
        d = minReach;
      } else if (d > REACH - 0.5) {
        const scale = (REACH - 0.5) / d;
        dx *= scale;
        dy *= scale;
        footScreen.x = leg.hip.x + dx;
        footScreen.y = leg.hip.y + dy;
        d = REACH - 0.5;
      }
      const dClamped = Math.max(1, d);
      const a = (dClamped * dClamped + FEMUR * FEMUR - TIBIA * TIBIA) / (2 * dClamped);
      const h = Math.sqrt(Math.max(0, FEMUR * FEMUR - a * a));
      const ux = dx / dClamped;
      const uy = dy / dClamped;
      leg.knee = {
        x: leg.hip.x + ux * a + (-uy) * h * leg.kneeSign,
        y: leg.hip.y + uy * a + ux * h * leg.kneeSign,
      };
      leg.foot = {
        x: leg.hip.x + dx,
        y: leg.hip.y + dy,
      };
    }
  }

  /* ====================================================================== */
  /* planting + research markup                                             */
  /* ====================================================================== */

  onFootPlant(leg, anchor, now) {
    if (!anchor) return;
    const el = anchor.el;
    const section = this.loader.sectionForElement(el);
    this.queueNote(el);

    // Faint silk from abdomen to recently touched words.
    const point = this.anchorPoint(anchor);
    if (point && now - (this._lastTrailAt || 0) > 420) {
      this._lastTrailAt = now;
      this.trails.push({
        toDoc: point,
        el,
        created: now,
        life: 9000,
        seed: Math.random() * 6,
      });
      if (this.trails.length > 5) this.trails.shift();
    }

    const text = (el.textContent || "").trim();
    if (!text) return;
    if (this.loader.sectionForElement(el)?.isReferences && Math.random() < 0.7) return;

    const token = text.split(/\s+/)[0].replace(/^[^\p{L}\p{N}[(]+|[^\p{L}\p{N})\]]+$/gu, "");
    if (!token) return;
    const info = this.classifyToken(token, el);
    const config = INTENSITIES[this.intensity] || INTENSITIES.normal;

    // Smart words get ink roughly 3x more often than ordinary words.
    const chance = config.probability * (info.smart ? 2.4 : 0.8);
    if (Math.random() > chance) return;

    const effect = this.chooseEffect(info, el, config);
    if (effect) this.applyEffect(el, effect, info);

    if (config.nearby && Math.random() < config.nearby) this.markNearby(el, info, config);
    if (config.row && Math.random() < config.row) this.markRow(el);

    if (info.smart) {
      this.sparks.push({
        x: point ? point.x - scrollX : 0,
        y: point ? point.y - scrollY : 0,
        vx: rand(-1, 1),
        vy: rand(-1.4, -0.1),
        created: now,
        life: 520,
        color: info.kind === "metric" ? "#ff7a3d" : "#19c3d6",
      });
      const noteWord = text
        .replace(/^[^\p{L}\p{N}[(]+|[^\p{L}\p{N})\]]+$/gu, "")
        .trim()
        .slice(0, 160) || clean;
      this.pendingEvents.push({
        type: "spider:touch",
        detail: {
          word: noteWord,
          kind: info.kind,
          section: section?.title || "paper",
          sectionId: section?.id || "",
          sentence: this.loader.sentenceForSpan(el) || "",
        },
      });
    }
  }

  classifyToken(token, el) {
    const clean = token.replace(/^[^\p{L}\p{N}[(]+|[^\p{L}\p{N})\]]+$/gu, "");
    const lower = clean.toLowerCase();
    const block = el.closest("p, li, td, th, figcaption, h1, h2, h3, h4, h5, h6, .ltx_para");
    const context = block ? block.textContent.slice(0, 500) : clean;
    const isHeading = !!el.closest("h1, h2, h3, h4, h5, h6");
    const nextWords = [];
    let sibling = el.nextElementSibling;
    let guard = 0;
    while (sibling && guard < 4) {
      if (sibling.classList?.contains("w")) nextWords.push(sibling.textContent);
      sibling = sibling.nextElementSibling;
      guard += 1;
    }
    const lookahead = `${clean} ${nextWords.join(" ")}`;

    if (isHeading) return { kind: "heading", smart: true, score: 3 };
    if (DATASETS.has(lower) || (lower === "2014" && /wmt/i.test(context))) {
      return { kind: "dataset", smart: true, score: 3 };
    }
    if (MODELS.has(lower) ||
        /^[A-Z][a-z0-9]*(?:[A-Z][a-z0-9]*)+$/.test(clean) ||
        (/^[A-Z0-9-]{2,8}$/.test(clean) && /[A-Z]/.test(clean) && !/^(I|A|THE|OF|AND|IN|ON|FOR)$/.test(clean))) {
      return { kind: "model", smart: true, score: 3 };
    }
    if (/\d/.test(clean) && (
      /%|bleu|f1|accuracy|precision|recall|points?|hours?|days?|gpus?|parameters?|billion|million/i.test(lookahead) ||
      /\d+\.\d+/.test(clean)
    )) {
      return { kind: "metric", smart: true, score: 3 };
    }
    if (/^[\[(]\d+(?:[-,–]\d+)*[\])][.,;:]?$/.test(clean) || /^\(\d+\)$/.test(clean)) {
      return { kind: "citation", smart: true, score: 3 };
    }
    if (CLAIM_WORDS.has(lower) && lower !== "we" && lower !== "our" && lower !== "results") {
      return { kind: "claim", smart: true, score: 2.2 };
    }
    if (CLAIM_WORDS.has(lower) && /\b(propose|introduce|outperform|novel|show|demonstrate)\b/i.test(context)) {
      return { kind: "claim", smart: true, score: 2.2 };
    }
    return { kind: "word", smart: false, score: 1 };
  }

  chooseEffect(info, el, config) {
    const options = [];
    const add = (cls, weight) => options.push({ cls, weight });

    if (info.kind === "heading") {
      add("m-hl-purple", 16);
      add("m-box-purple", 4);
    } else if (info.kind === "metric") {
      add("m-hl-orange", 9);
      add("m-blowup", 7);
      add("m-box-orange", 5);
      add("m-hl-magenta", 3);
      add("m-color-red", 2);
    } else if (info.kind === "model") {
      add("m-hl-magenta", 6);
      add("m-box-purple", 4);
      add("m-box-teal", 4);
      add("m-color-purple", 3);
      add("m-hl-cyan", 2);
    } else if (info.kind === "dataset") {
      add("m-hl-magenta", 5);
      add("m-box-teal", 4);
      add("m-hl-orange", 3);
      add("m-color-teal", 3);
    } else if (info.kind === "citation") {
      add("m-box-red", 6);
      add("m-color-red", 4);
      add("m-underline-red", 2);
      add("m-box-purple", 2);
    } else if (info.kind === "claim") {
      add("m-hl-green", 7);
      add("m-rotate-green", 3);
      add("m-color-green", 4);
      add("m-underline-teal", 2);
    } else {
      add("m-box-teal", 5);
      add("m-box-purple", 3);
      add("m-box-orange", 3);
      add("m-box-red", 2);
      add("m-box-green", 2);
      add("m-hl-green", 3);
      add("m-color-teal", 2);
      add("m-hl-magenta", 1.5);
      add("m-hl-cyan", 1);
      add("m-rotate-green", 0.8);
      if (/\d/.test(el.textContent)) add("m-blowup", 2);
    }

    const total = options.reduce((sum, option) => sum + option.weight, 0);
    let roll = Math.random() * total;
    let chosen = options[options.length - 1];
    for (const option of options) {
      roll -= option.weight;
      if (roll <= 0) { chosen = option; break; }
    }
    return chosen?.cls || null;
  }

  applyEffect(el, cls, info) {
    this.queueClass(el, cls);

    if (cls === "m-blowup") {
      this.queueClass(el, Math.random() < 0.5 ? "m-color-red" : "m-color-orange");
      this.queueClass(el, "m-blowup-soft");
    }
    if (cls === "m-hl-orange" && Math.random() < 0.13) {
      this.queueClass(el, "m-standalone");
    }
    if (cls === "m-hl-magenta" && Math.random() < 0.2) {
      this.queueClass(el, "m-stretch");
    }
    if (cls === "m-hl-green" && Math.random() < 0.15) {
      this.queueClass(el, "m-standalone");
    }
    if (cls.startsWith("m-box-") && Math.random() < 0.12) {
      this.queueClass(el, "m-underline-red");
    }
  }

  markNearby(el, info, config) {
    const block = el.closest("p, li, td, th, figcaption, .ltx_para");
    if (!block) return;
    const words = [...block.querySelectorAll(".w")];
    const index = words.indexOf(el);
    if (index < 0) return;
    const offsets = [-2, -1, 1, 2, 3];
    const picked = offsets
      .map((offset) => words[index + offset])
      .filter(Boolean)
      .filter(() => Math.random() < 0.55);
    for (const word of picked.slice(0, config.extra + 1)) {
      const cls = info.kind === "metric"
        ? (Math.random() < 0.4 ? "m-hl-magenta" : "m-box-orange")
        : (Math.random() < 0.5 ? "m-box-teal" : "m-hl-green");
      this.queueClass(word, cls);
    }
  }

  markRow(el) {
    const block = el.closest("p, li, td, th, figcaption, .ltx_para");
    if (!block) return;
    for (const word of block.querySelectorAll(".w")) this.queueClass(word, "m-hl-cyan");
  }

  queueClass(el, cls) {
    if (!el || !cls) return;
    if (el.classList.contains(cls)) return;
    this.pendingWrites.push({ el, cls, add: true });
  }

  queueNote(el) {
    this.pendingNotes.push(el);
  }

  /* ====================================================================== */
  /* focus, trails, commit                                                  */
  /* ====================================================================== */

  updateFocus(now) {
    if (!this.focus) return;
    if (now > this.focus.until) {
      this.focus = null;
      return;
    }
    if (this.focus.spans?.length) {
      const rects = this.focus.spans
        .filter((span) => span.isConnected)
        .map((span) => span.getBoundingClientRect())
        .filter((rect) => rect.width || rect.height);
      if (rects.length) {
        const union = rects.reduce((acc, rect) => ({
          left: Math.min(acc.left, rect.left),
          top: Math.min(acc.top, rect.top),
          right: Math.max(acc.right, rect.right),
          bottom: Math.max(acc.bottom, rect.bottom),
        }), { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity });
        this.focus.rectScreen = {
          left: union.left,
          top: union.top,
          width: union.right - union.left,
          height: union.bottom - union.top,
        };
      }
    }
  }

  updateTrails(now) {
    if (!this.trails.length) return;
    this.trails = this.trails.filter((trail) => now - trail.created < trail.life);
    for (const trail of this.trails) {
      if (trail.el && trail.el.isConnected) {
        const point = this.anchorPoint({ el: trail.el, rx: 0.5, ry: 0.75 });
        if (point) trail.toDoc = point;
      }
      trail.screenPoint = { x: trail.toDoc.x - scrollX, y: trail.toDoc.y - scrollY };
    }
  }

  commit(now) {
    // DOM writes are applied here, once per frame.
    if (this.pendingWrites.length) {
      const seen = new Set();
      for (const write of this.pendingWrites) {
        if (!write.el?.isConnected) continue;
        const key = `${write.el.dataset.wid || ""}|${write.cls}`;
        if (seen.has(key)) continue;
        seen.add(key);
        try { write.el.classList.add(write.cls); } catch { /* ignore */ }
      }
      this.pendingWrites.length = 0;
    }

    if (this.pendingNotes.length) {
      for (const el of this.pendingNotes) {
        try { this.loader.noteWalked(el); } catch { /* ignore */ }
      }
      this.pendingNotes.length = 0;
    }

    if (this.pendingScroll != null) {
      const target = this.pendingScroll;
      this.pendingScroll = null;
      this.lastAutoScrollAt = performance.now();
      this._lastProgrammaticScroll = target;
      window.scrollTo({ top: target, behavior: "instant" });
      this.scrollY = window.scrollY;
      this.scrollX = window.scrollX;
    }

    if (this.pendingHud != null) {
      const el = document.getElementById("crawl-section");
      if (el) el.textContent = this.pendingHud;
      this.pendingHud = null;
    }

    if (this.pendingEvents.length) {
      for (const event of this.pendingEvents) {
        document.dispatchEvent(new CustomEvent(event.type, { detail: event.detail }));
      }
      this.pendingEvents.length = 0;
    }

    this.updateHud();
  }

  /* ====================================================================== */
  /* debug                                                                  */
  /* ====================================================================== */

  debugInfo() {
    return {
      mode: this.mode,
      speed: Math.hypot(this.body.vx, this.body.vy),
      bodyX: this.body.x,
      bodyY: this.body.y - scrollY,
      fps: this.fps,
      section: this.currentSection?.title || "—",
      legLengths: LEG_LENGTHS,
    };
  }
}
