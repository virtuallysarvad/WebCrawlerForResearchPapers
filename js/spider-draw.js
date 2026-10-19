/**
 * spider-draw.js
 * ---------------------------------------------------------------------------
 * All canvas drawing lives here. The crawler owns the simulation and hands us
 * screen-space points; the renderer only draws, so it never touches the DOM.
 *
 * Visual language: glossy black thorax + abdomen, cyan two-segment legs with
 * red knee/foot dots, two short palps, thin silk. Minimal and technical.
 */

const COLORS = {
  leg: "#19c3d6",
  legGlow: "rgba(25, 195, 214, 0.55)",
  joint: "#e0303a",
  body: "#090b0e",
  bodyHi: "#3b4048",
  silk: "rgba(55, 67, 78, 0.30)",
  silkBright: "rgba(220, 245, 250, 0.55)",
  orange: "#ff7a3d",
};

export class SpiderRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas?.getContext("2d", { alpha: true });
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.width = 0;
    this.height = 0;
  }

  resize() {
    if (!this.canvas) return;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.width = window.innerWidth;
    this.height = window.innerHeight;
    this.canvas.width = Math.round(this.width * this.dpr);
    this.canvas.height = Math.round(this.height * this.dpr);
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  render(crawler, now = performance.now()) {
    const ctx = this.ctx;
    if (!ctx) return;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);

    if (!crawler.visible || !crawler.bodyScreen) return;
    const body = crawler.bodyScreen;

    // Silk trails go behind the animal.
    this.drawTrails(ctx, crawler, now);
    this.drawThread(ctx, crawler, now);

    // Legs are drawn behind the body. Back legs slightly dimmer.
    const legs = crawler.legs || [];
    for (const leg of legs) this.drawLeg(ctx, leg, crawler, false);

    this.drawPalps(ctx, crawler);
    this.drawBody(ctx, crawler, body);
    for (const leg of legs) this.drawLegDots(ctx, leg, crawler);

    this.drawFocus(ctx, crawler, now);
    this.drawRipples(ctx, crawler, now);
    this.drawSparks(ctx, crawler, now);
    if (crawler.debug) this.drawDebug(ctx, crawler);
  }

  /* ---------------------------------------------------------------------- */
  /* body + legs                                                            */
  /* ---------------------------------------------------------------------- */

  drawBody(ctx, crawler, body) {
    const { heading, bob = 0, scale = 1 } = crawler;
    const forward = { x: Math.cos(heading), y: Math.sin(heading) };
    const right = { x: -Math.sin(heading), y: Math.cos(heading) };
    const y = body.y + bob;

    ctx.save();
    ctx.translate(body.x, y);
    ctx.rotate(heading);
    ctx.scale(scale, scale);

    // Soft ground shadow.
    ctx.save();
    ctx.globalAlpha = 0.16;
    ctx.fillStyle = "#000";
    ctx.beginPath();
    ctx.ellipse(-6, 7, 30, 15, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // Abdomen (behind).
    const abdomenGradient = ctx.createRadialGradient(8, -7, 1, 0, 0, 34);
    abdomenGradient.addColorStop(0, "#4a5059");
    abdomenGradient.addColorStop(0.28, "#22262b");
    abdomenGradient.addColorStop(0.72, "#0a0c0f");
    abdomenGradient.addColorStop(1, "#040506");
    ctx.fillStyle = abdomenGradient;
    ctx.beginPath();
    ctx.ellipse(-20, 0, 24, 15.5, 0, 0, Math.PI * 2);
    ctx.fill();

    // A thin glossy highlight on the abdomen.
    ctx.strokeStyle = "rgba(255,255,255,0.22)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.ellipse(-20, -1, 18, 10, 0, Math.PI * 1.08, Math.PI * 1.72);
    ctx.stroke();

    // Thorax (front).
    const thoraxGradient = ctx.createRadialGradient(10, -5, 1, 4, 0, 16);
    thoraxGradient.addColorStop(0, "#565d66");
    thoraxGradient.addColorStop(0.35, "#20242a");
    thoraxGradient.addColorStop(1, "#07090b");
    ctx.fillStyle = thoraxGradient;
    ctx.beginPath();
    ctx.ellipse(7, 0, 15, 11.5, 0, 0, Math.PI * 2);
    ctx.fill();

    // Waist.
    ctx.strokeStyle = "rgba(0,0,0,0.7)";
    ctx.lineWidth = 3.2;
    ctx.beginPath();
    ctx.moveTo(-4, -4);
    ctx.quadraticCurveTo(0, 0, -4, 4);
    ctx.stroke();

    // Tiny white eye dot.
    ctx.fillStyle = "rgba(255,255,255,0.96)";
    ctx.beginPath();
    ctx.arc(14, -3.6, 1.55, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,0.34)";
    ctx.beginPath();
    ctx.arc(14, 2.4, 0.9, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }

  drawLeg(ctx, leg, crawler, dim) {
    if (!leg.hip || !leg.knee || !leg.foot) return;
    const { hip, knee, foot } = leg;
    const alpha = dim ? 0.45 : 0.92;

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    // A glow only while stepping; static legs skip shadowBlur because it is
    // the most expensive part of the 8-leg draw on a large canvas.
    ctx.shadowColor = COLORS.legGlow;
    ctx.shadowBlur = leg.swing ? 6 : 0;
    ctx.strokeStyle = COLORS.leg;
    ctx.lineWidth = leg.swing ? 1.8 : 1.55;

    ctx.beginPath();
    ctx.moveTo(hip.x, hip.y);
    ctx.lineTo(knee.x, knee.y);
    ctx.lineTo(foot.x, foot.y);
    ctx.stroke();

    // Fine highlight, gives the leg a slightly tubular look.
    ctx.globalAlpha = alpha * 0.35;
    ctx.shadowBlur = 0;
    ctx.strokeStyle = "#d7fbff";
    ctx.lineWidth = 0.55;
    ctx.beginPath();
    ctx.moveTo(hip.x, hip.y - 0.5);
    ctx.lineTo(knee.x, knee.y - 0.5);
    ctx.lineTo(foot.x, foot.y - 0.5);
    ctx.stroke();
    ctx.restore();
  }

  drawLegDots(ctx, leg, crawler) {
    if (!leg.knee || !leg.foot) return;
    const swing = leg.swing ? 1 : 0;

    // Knee dot.
    ctx.save();
    ctx.fillStyle = COLORS.joint;
    ctx.shadowColor = "rgba(224, 48, 58, 0.5)";
    ctx.shadowBlur = swing ? 6 : 3;
    ctx.beginPath();
    ctx.arc(leg.knee.x, leg.knee.y, 1.75, 0, Math.PI * 2);
    ctx.fill();

    // Foot dot (a little bigger; this is where the ink lands).
    ctx.beginPath();
    ctx.arc(leg.foot.x, leg.foot.y, leg.anchored ? 2.4 : 2, 0, Math.PI * 2);
    ctx.fill();

    // Shadow of a lifted foot, so a step reads as a step.
    if (leg.lift > 1) {
      ctx.globalAlpha = 0.18;
      ctx.fillStyle = "#000";
      ctx.beginPath();
      ctx.ellipse(leg.foot.x, leg.foot.y + leg.lift, 3.5, 1.6, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  drawPalps(ctx, crawler) {
    const { bodyScreen: body, heading, bob = 0, scale = 1 } = crawler;
    if (!body) return;
    const forward = { x: Math.cos(heading), y: Math.sin(heading) };
    const right = { x: -Math.sin(heading), y: Math.cos(heading) };
    const t = performance.now() / 520;

    ctx.save();
    ctx.translate(body.x, body.y + bob);
    ctx.rotate(heading);
    ctx.scale(scale, scale);
    ctx.strokeStyle = COLORS.leg;
    ctx.fillStyle = COLORS.joint;
    ctx.lineWidth = 1.1;
    ctx.globalAlpha = 0.85;
    ctx.lineCap = "round";

    for (const side of [-1, 1]) {
      const wobble = Math.sin(t + side) * 1.6;
      const baseX = 16;
      const baseY = side * 5;
      const midX = 24;
      const midY = side * (9 + wobble * 0.25);
      const tipX = 29;
      const tipY = side * (7 + wobble);
      ctx.beginPath();
      ctx.moveTo(baseX, baseY);
      ctx.quadraticCurveTo(midX, midY + side * 2, tipX, tipY);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(tipX, tipY, 1.1, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  /* ---------------------------------------------------------------------- */
  /* silk                                                                   */
  /* ---------------------------------------------------------------------- */

  drawTrails(ctx, crawler, now) {
    if (!crawler.trails?.length) return;
    const body = crawler.bodyScreen;
    if (!body) return;

    ctx.save();
    ctx.lineCap = "round";
    for (const trail of crawler.trails) {
      const age = (now - trail.created) / 1000;
      if (age > trail.life) continue;
      const fade = 1 - age / trail.life;
      const end = trail.screenPoint;
      if (!end) continue;
      const mx = (body.x + end.x) / 2;
      const my = (body.y + end.y) / 2 + 8 + Math.sin(now / 900 + trail.seed) * 2;
      ctx.strokeStyle = `rgba(55, 67, 78, ${0.26 * fade})`;
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      ctx.moveTo(body.x, body.y + 8);
      ctx.quadraticCurveTo(mx, my, end.x, end.y);
      ctx.stroke();
      ctx.fillStyle = `rgba(224, 48, 58, ${0.5 * fade})`;
      ctx.beginPath();
      ctx.arc(end.x, end.y, 1.1, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  drawThread(ctx, crawler, now) {
    const thread = crawler.thread;
    const body = crawler.bodyScreen;
    if (!thread || !body || !thread.visible) return;
    const sway = Math.sin(now / 620 + thread.phase) * (thread.sway || 5);

    ctx.save();
    ctx.lineCap = "round";
    if (thread.snapped) {
      const alpha = Math.max(0, thread.fade);
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = COLORS.silkBright;
      ctx.lineWidth = 0.9;
      ctx.beginPath();
      ctx.moveTo(body.x, body.y - 8);
      ctx.quadraticCurveTo(body.x + sway, body.y - 24, body.x + sway * 0.4, body.y - 34);
      ctx.stroke();
      ctx.restore();
      return;
    }

    const anchorX = thread.anchorX;
    const anchorY = -12;
    const cx = (anchorX + body.x) / 2 + sway;
    const cy = (anchorY + body.y) / 2;
    ctx.globalAlpha = Math.max(0, thread.alpha ?? 1);
    ctx.strokeStyle = COLORS.silkBright;
    ctx.shadowColor = "rgba(240, 250, 255, 0.55)";
    ctx.shadowBlur = 4;
    ctx.lineWidth = 0.9;
    ctx.beginPath();
    ctx.moveTo(anchorX, anchorY);
    ctx.quadraticCurveTo(cx, cy, body.x, body.y - 8);
    ctx.stroke();

    // A subtle double-strand highlight.
    ctx.globalAlpha *= 0.4;
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 0.4;
    ctx.beginPath();
    ctx.moveTo(anchorX + 0.8, anchorY);
    ctx.quadraticCurveTo(cx + 0.7, cy, body.x + 0.6, body.y - 8);
    ctx.stroke();
    ctx.restore();
  }

  /* ---------------------------------------------------------------------- */
  /* attention + effects                                                    */
  /* ---------------------------------------------------------------------- */

  drawFocus(ctx, crawler, now) {
    const focus = crawler.focus;
    if (!focus || now > focus.until) return;
    const rect = focus.rectScreen;
    if (!rect) return;
    const remaining = focus.until - now;
    const alpha = Math.min(1, remaining / 500) * (0.55 + Math.sin(now / 180) * 0.18);
    const pad = 5 + Math.sin(now / 260) * 2;

    ctx.save();
    ctx.strokeStyle = `rgba(255, 122, 61, ${alpha})`;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 4]);
    ctx.lineDashOffset = -now / 45;
    ctx.beginPath();
    ctx.roundRect(rect.left - pad, rect.top - pad, rect.width + pad * 2, rect.height + pad * 2, 4);
    ctx.stroke();
    ctx.restore();
  }

  drawRipples(ctx, crawler, now) {
    if (!crawler.ripples?.length) return;
    ctx.save();
    for (const ripple of crawler.ripples) {
      const age = (now - ripple.created) / 700;
      if (age > 1) continue;
      ctx.strokeStyle = `rgba(25, 195, 214, ${0.45 * (1 - age)})`;
      ctx.lineWidth = 1.1;
      ctx.beginPath();
      ctx.arc(ripple.x, ripple.y, 5 + age * 28, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  drawSparks(ctx, crawler, now) {
    if (!crawler.sparks?.length) return;
    ctx.save();
    for (const spark of crawler.sparks) {
      const age = (now - spark.created) / spark.life;
      if (age > 1) continue;
      ctx.globalAlpha = 1 - age;
      ctx.fillStyle = spark.color;
      const dx = spark.vx * age * 18;
      const dy = spark.vy * age * 18 + age * age * 16;
      ctx.beginPath();
      ctx.arc(spark.x + dx, spark.y + dy, 1.4 * (1 - age * 0.5), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  /* ---------------------------------------------------------------------- */
  /* debug overlay                                                          */
  /* ---------------------------------------------------------------------- */

  drawDebug(ctx, crawler) {
    ctx.save();
    ctx.font = "9px ui-monospace, Consolas, monospace";
    ctx.lineWidth = 0.8;

    for (const leg of crawler.legs || []) {
      if (!leg.hip) continue;
      // Max reach.
      ctx.strokeStyle = "rgba(123, 44, 255, 0.30)";
      ctx.setLineDash([3, 5]);
      ctx.beginPath();
      ctx.arc(leg.hip.x, leg.hip.y, leg.reach, 0, Math.PI * 2);
      ctx.stroke();

      // Hip -> desired foot.
      if (leg.rest) {
        ctx.strokeStyle = "rgba(255, 122, 61, 0.45)";
        ctx.setLineDash([2, 3]);
        ctx.beginPath();
        ctx.moveTo(leg.hip.x, leg.hip.y);
        ctx.lineTo(leg.rest.x, leg.rest.y);
        ctx.stroke();
        ctx.fillStyle = "rgba(255, 122, 61, 0.9)";
        ctx.beginPath();
        ctx.arc(leg.rest.x, leg.rest.y, 2.2, 0, Math.PI * 2);
        ctx.fill();
      }

      // Step threshold around the planted foot.
      if (leg.foot && leg.state === "planted") {
        ctx.strokeStyle = "rgba(25, 195, 214, 0.28)";
        ctx.setLineDash([2, 4]);
        ctx.beginPath();
        ctx.arc(leg.foot.x, leg.foot.y, leg.stepThreshold, 0, Math.PI * 2);
        ctx.stroke();
      }

      if (leg.hip) {
        ctx.fillStyle = "rgba(255,255,255,0.7)";
        ctx.fillText(`${leg.side}${leg.index}`, leg.hip.x + 4, leg.hip.y - 4);
      }
    }

    // Body target and velocity.
    if (crawler.targetScreen) {
      ctx.strokeStyle = "rgba(25, 195, 214, 0.55)";
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.moveTo(crawler.bodyScreen.x, crawler.bodyScreen.y);
      ctx.lineTo(crawler.targetScreen.x, crawler.targetScreen.y);
      ctx.stroke();
      ctx.fillStyle = "rgba(25, 195, 214, 0.8)";
      ctx.beginPath();
      ctx.arc(crawler.targetScreen.x, crawler.targetScreen.y, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }

    // Stats.
    ctx.setLineDash([]);
    ctx.fillStyle = "rgba(20, 22, 27, 0.82)";
    ctx.fillRect(12, 70, 224, 58);
    ctx.fillStyle = "#bff8ff";
    ctx.font = "10px ui-monospace, Consolas, monospace";
    const info = crawler.debugInfo();
    ctx.fillText(`mode ${info.mode}  speed ${info.speed.toFixed(0)}`, 20, 87);
    ctx.fillText(`body ${info.bodyX.toFixed(0)},${info.bodyY.toFixed(0)}  ${info.fps} fps`, 20, 101);
    ctx.fillText(`section ${info.section}`, 20, 115);
    ctx.restore();
  }
}
