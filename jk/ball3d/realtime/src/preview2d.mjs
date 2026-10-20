/**
 * Minimal 2D layout preview.
 *
 * It draws the **same** ``layout.mjs`` data the 3D scene renders -- boards,
 * hops, troughs, rows, rests and every channel's trigger reason -- as one
 * scroll-free schematic, plus a time strip with a playhead so a given moment
 * can be located.  It is a preview, not an editor.
 *
 * Bundled by ``tools/preview_build.mjs`` into a single self-contained HTML with
 * the plan inlined as ``window.__PLAN``; no network and no three.js.
 */

import * as L from "./layout.mjs";

const plan = window.__PLAN;
const seed = window.__LAYOUT_SEED ?? 0;

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  for (const child of children) node.append(child);
  return node;
}

/** Fit a canvas to its CSS box at device resolution and return its 2D context. */
function fit(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.max(1, Math.round(rect.width * dpr));
  canvas.height = Math.max(1, Math.round(rect.height * dpr));
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w: rect.width, h: rect.height };
}

const css = `
  :root { color-scheme: dark; }
  body { margin:0; background:#161a20; color:#cfd4db;
         font:13px/1.45 ui-monospace, Consolas, monospace; }
  header { padding:10px 14px; border-bottom:1px solid #2a3038; }
  header h1 { margin:0 0 2px; font-size:15px; }
  header .sub { color:#8b93a0; }
  main { display:flex; gap:12px; padding:12px; align-items:flex-start; }
  #routeWrap { flex:1 1 auto; min-width:0; }
  #route { width:100%; height:min(78vh, 900px); background:#20252c; border:1px solid #2a3038; }
  aside { flex:0 0 340px; max-height:82vh; overflow:auto; }
  aside h2 { font-size:13px; margin:0 0 6px; color:#e6ebf2; }
  .legend { display:flex; flex-wrap:wrap; gap:8px; margin:6px 0 12px; }
  .chip { display:inline-flex; align-items:center; gap:6px; }
  .swatch { width:12px; height:12px; border-radius:2px; display:inline-block; }
  table { width:100%; border-collapse:collapse; font-size:12px; }
  th, td { text-align:left; padding:2px 4px; border-bottom:1px solid #262c34; }
  .rest { color:#7f8894; }
  footer { position:sticky; bottom:0; background:#161a20; padding:8px 12px;
           border-top:1px solid #2a3038; display:flex; gap:10px; align-items:center; }
  #timeline { flex:1 1 auto; height:64px; background:#20252c; border:1px solid #2a3038; }
  button { background:#2b323c; color:#dfe5ec; border:1px solid #3a424e;
           border-radius:4px; padding:4px 10px; cursor:pointer; }
  input[type=range] { flex:0 0 240px; }
  #readout { min-width:210px; color:#9aa4b1; }
`;

function buildDom() {
  const style = el("style", { textContent: css });
  const header = el("header", {}, [
    el("h1", { textContent: `音乐装置 · 2D 编排预览 — ${plan.title || "(untitled)"}` }),
    el("div", {
      className: "sub",
      textContent: `${plan.key || ""} · ${plan.counts?.sounding ?? 0} 音符 · `
        + `${plan.counts?.rests ?? 0} 休止 · ${plan.tempo_qpm} qpm · `
        + `${plan.duration.toFixed(2)}s · layout seed ${seed}`,
    }),
  ]);
  const routeCanvas = el("canvas", { id: "route" });
  const aside = el("aside");
  const timelineCanvas = el("canvas", { id: "timeline" });
  const play = el("button", { textContent: "▶ 播放" });
  const slider = el("input", { type: "range", min: "0", max: "1000", value: "0" });
  const readout = el("div", { id: "readout" });
  const footer = el("footer", {}, [play, slider, readout]);
  const main = el("main", {}, [el("div", { id: "routeWrap" }, [routeCanvas]), aside]);
  document.head.append(style);
  document.body.append(header, main, footer);
  // the time strip is full width under the route, above the footer controls
  main.append(el("div", { style: "display:none" }, []));
  footer.insertBefore(timelineCanvas, play);
  return { routeCanvas, timelineCanvas, aside, play, slider, readout };
}

const layout = L.buildLayout(plan, { seed });
const dom = buildDom();

// --- spatial view bounds -----------------------------------------------------
const points = layout.boards.map((b) => b.pos).concat([layout.pad.pos]);
const allSamples = [];
for (const seg of layout.segments) {
  for (let i = 0; i <= 16; i += 1) allSamples.push(L.transitionPoint(seg, i / 16));
}
const world = {
  x0: Math.min(...points.map((p) => p[0]), ...allSamples.map((p) => p[0])),
  x1: Math.max(...points.map((p) => p[0]), ...allSamples.map((p) => p[0])),
  y0: Math.min(...points.map((p) => p[1]), ...allSamples.map((p) => p[1])),
  y1: Math.max(...points.map((p) => p[1]), ...allSamples.map((p) => p[1])),
};
const spatial = { x0: world.x0 - 1, x1: world.x1 + 1, y0: world.y0 - 1, y1: world.y1 + 1 };

function makeMapper(w, h, box, pad = 24) {
  const sx = (w - 2 * pad) / Math.max(1e-6, box.x1 - box.x0);
  const sy = (h - 2 * pad) / Math.max(1e-6, box.y1 - box.y0);
  const s = Math.min(sx, sy);
  const cx = (box.x0 + box.x1) / 2;
  const cy = (box.y0 + box.y1) / 2;
  return {
    s,
    to: (p) => [w / 2 + (p[0] - cx) * s, h / 2 - (p[1] - cy) * s],
    len: (v) => v * s,
  };
}

function fmt(v, digits = 2) { return Number(v).toFixed(digits); }

function drawRoute(t) {
  const { ctx, w, h } = fit(dom.routeCanvas);
  ctx.clearRect(0, 0, w, h);
  const map = makeMapper(w, h, spatial);
  const xy = (p) => map.to(p);

  // row backgrounds + labels
  for (const group of layout.groups) {
    const members = group.members.map((i) => layout.boards[i]);
    const xs = members.map((b) => b.pos[0]);
    const ys = members.map((b) => b.pos[1]);
    const a = xy([Math.min(...xs) - 0.5, Math.max(...ys) + 0.4]);
    const b = xy([Math.max(...xs) + 0.5, Math.min(...ys) - 0.4]);
    ctx.fillStyle = "rgba(255,255,255,0.03)";
    ctx.fillRect(a[0], a[1], b[0] - a[0], b[1] - a[1]);
    ctx.strokeStyle = "rgba(255,255,255,0.10)";
    ctx.setLineDash([4, 4]);
    ctx.strokeRect(a[0], a[1], b[0] - a[0], b[1] - a[1]);
    ctx.setLineDash([]);
    ctx.fillStyle = "#6f7885";
    ctx.fillText(`组 ${group.index} · ${group.shape} · ${group.reason}`, a[0] + 4, a[1] + 13);
  }

  // hops and channels
  for (const seg of layout.segments) {
    if (seg.kind === "hold") continue;
    const pts = [];
    for (let i = 0; i <= 24; i += 1) pts.push(xy(L.transitionPoint(seg, i / 24)));
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (const p of pts.slice(1)) ctx.lineTo(p[0], p[1]);
    if (seg.kind === "ride") {
      ctx.strokeStyle = "#ffcf70";
      ctx.lineWidth = 4;
    } else {
      ctx.strokeStyle = "rgba(210,220,235,0.45)";
      ctx.lineWidth = 1.5;
    }
    ctx.stroke();
  }

  // boards: drawn with the same tilt the 3D plank uses (canvas y is down, so
  // the plank's local +x direction is a rotation by +tilt here)
  for (const board of layout.boards) {
    const c = xy([board.pos[0], board.pos[1]]);
    ctx.save();
    ctx.translate(c[0], c[1]);
    ctx.rotate(board.tilt || 0);
    const bw = map.len(L.BOARD_W);
    const bh = Math.max(3, map.len(L.BOARD_H));
    const rgb = L.BOARD_PALETTE[board.palette % L.BOARD_PALETTE.length].rgb;
    ctx.fillStyle = `rgb(${rgb.map((v) => Math.round(Math.min(1, v) * 255)).join(",")})`;
    ctx.fillRect(-bw / 2, -bh / 2, bw, bh);
    ctx.strokeStyle = "rgba(0,0,0,0.55)";
    ctx.strokeRect(-bw / 2, -bh / 2, bw, bh);
    ctx.restore();
    // the support normal: the visible reason the ball turns here
    const n = board.normal || [0, 1, 0];
    ctx.strokeStyle = "rgba(255,244,214,0.5)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(c[0], c[1]);
    ctx.lineTo(c[0] + n[0] * 14, c[1] - n[1] * 14);
    ctx.stroke();
    // an active strike is drawn as a ring around the plank that gave the energy
    if (board.strike) {
      ctx.strokeStyle = "rgba(255,196,120,0.85)";
      ctx.beginPath();
      ctx.arc(c[0], c[1], map.len(L.BOARD_W) * 0.62, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.fillStyle = "#0d1014";
    ctx.font = "10px ui-monospace, monospace";
    ctx.fillText(`${board.n}`, c[0] - 3, c[1] + 3);
  }

  // pad
  const padP = xy([layout.pad.pos[0], layout.pad.top_y]);
  ctx.fillStyle = "#9aa4b1";
  ctx.fillRect(padP[0] - map.len(L.BOARD_W) / 2, padP[1] - 4, map.len(L.BOARD_W), 8);
  ctx.fillText("起点", padP[0] - 10, padP[1] - 8);

  // current position: playhead ball + highlight of the active board
  const ball = L.sampleBall(layout, t);
  const bp = xy(ball);
  const active = L.activeLanding(layout, t);
  if (active >= 0) {
    const board = layout.boards[active];
    const c = xy([board.pos[0], board.top_y]);
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(c[0], c[1], Math.max(8, map.len(L.BOARD_W) * 0.6), 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.fillStyle = "#fff4d6";
  ctx.beginPath();
  ctx.arc(bp[0], bp[1], Math.max(4, map.len(L.BALL_R)), 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "rgba(0,0,0,0.6)";
  ctx.stroke();
}

function drawTimeline(t) {
  const { ctx, w, h } = fit(dom.timelineCanvas);
  ctx.clearRect(0, 0, w, h);
  const pad = 8;
  const x = (time) => pad + (w - 2 * pad) * (time / Math.max(1e-6, plan.duration));
  const noteY = 12;
  const restY = 34;

  // rest bands (silent intervals)
  ctx.fillStyle = "rgba(127,136,148,0.28)";
  for (const rest of plan.rests || []) {
    const x0 = x(rest.onset_sec);
    const x1 = x(rest.onset_sec + rest.dur_sec);
    ctx.fillRect(x0, restY - 6, Math.max(1, x1 - x0), 12);
  }
  // sounding notes (onset ticks, width = duration)
  for (const event of plan.events || []) {
    if (event.kind !== "note") continue;
    const x0 = x(event.onset_sec);
    const x1 = x(event.onset_sec + event.dur_sec);
    ctx.fillStyle = "#5fd08a";
    ctx.fillRect(x0, noteY - 5, Math.max(1, x1 - x0), 10);
  }
  // channels: mark their trigger on the note/rest lanes
  for (const seg of layout.channels) {
    const x0 = x(seg.t0);
    const x1 = x(seg.t1);
    ctx.fillStyle = seg.reason.trigger === "rest"
      ? "rgba(87,208,255,0.30)" : "rgba(255,207,112,0.30)";
    ctx.fillRect(x0, restY + 10, Math.max(1, x1 - x0), 10);
  }
  // playhead
  ctx.strokeStyle = "#ff5f6d";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(x(t), 2);
  ctx.lineTo(x(t), h - 2);
  ctx.stroke();

  ctx.fillStyle = "#8b93a0";
  ctx.font = "10px ui-monospace, monospace";
  ctx.fillText("音符", pad, 10);
  ctx.fillText("休止", pad, restY + 4);
  ctx.fillText("滑槽", pad, restY + 18);
}

function renderAsides() {
  const aside = dom.aside;
  aside.replaceChildren();
  aside.append(el("h2", { textContent: "木板配色" }));
  const legend = el("div", { className: "legend" },
    L.BOARD_PALETTE.map((entry) => el("span", { className: "chip" }, [
      el("span", {
        className: "swatch",
        style: `background:rgb(${entry.rgb.map((v) => Math.round(Math.min(1, v) * 255)).join(",")})`,
      }),
      el("span", { textContent: entry.name }),
    ])));
  aside.append(legend);

  const t = layout.thresholds;
  aside.append(el("h2", { textContent: `滑槽（共 ${layout.channels.length} 条，阈值可审计）` }));
  if (!layout.channels.length) {
    aside.append(el("p", { className: "rest", textContent: "本曲没有符合条件的滑槽（短音/短休止不强行插槽）。" }));
  } else {
    const rows = [["#", "触发", "音长", "休止", "可用", "距离", "速度"]];
    layout.channels.forEach((seg, i) => {
      const r = seg.reason;
      rows.push([
        String(i), r.trigger === "rest" ? "休止" : "长音",
        fmt(r.note_dur), fmt(r.rest_sec), fmt(r.avail), fmt(r.dist), fmt(r.speed),
      ]);
    });
    const table = el("table");
    const thead = el("tr", {}, rows[0].map((h) => el("th", { textContent: h })));
    table.append(thead);
    for (const row of rows.slice(1)) {
      table.append(el("tr", {}, row.map((v) => el("td", { textContent: v }))));
    }
    aside.append(table);
  }

  const a = layout.audit;
  aside.append(el("h2", { textContent: "本轮运动模型（可审计）" }));
  aside.append(el("div", {
    className: "rest",
    textContent: `统一重力 ${a.gravity} m/s² · 每次自由飞行都是解析抛体 p(t)=p0+v0t+½gt² · `
      + `${a.transitions} 次过渡（${a.flights} 次飞行、${a.chutes} 条滑槽）· `
      + `主动击板 ${a.active_strikes} 次（e>1，板面可见弹动，记录速度增益）· `
      + `倾角上限 ${fmt(t.tilt_max)} rad · 最高顶点 ${fmt(a.max_apex)}m · `
      + `横向最大位移 ${fmt(a.lateral_max)}m · 球心穿板残留 ${a.clearance_fails} 次 · `
      + `相邻板相交 ${a.plank_overlaps} 对`,
  }));

  aside.append(el("h2", { textContent: "阈值" }));
  aside.append(el("div", {
    className: "rest",
    textContent: `长音 ≥ ${t.long_note_min}s · 休止 ≥ ${t.rest_channel_min}s · `
      + `可用 ≥ ${t.channel_min_time}s · 距离 ≥ ${t.channel_min_dist}m · `
      + `速度 ≤ ${t.max_channel_speed}m/s · 行休止 ≥ ${t.rest_group_min}s`,
  }));

  const plain = layout.segments.filter(
    (s) => s.kind === "hop" && s.reason?.fallback,
  );
  if (plain.length) {
    aside.append(el("h2", { textContent: `回退为跳跃的过渡（${plain.length}）` }));
    aside.append(el("div", {
      className: "rest",
      textContent: "这些过渡满足滑槽条件但速度或空间不合适，已回退为安全的无声跳跃。",
    }));
  }
}

// --- playback ----------------------------------------------------------------
let playing = false;
let cursor = 0;
let lastFrame = 0;

function draw() {
  drawRoute(cursor);
  drawTimeline(cursor);
  const landing = L.activeLanding(layout, cursor);
  const seg = layout.segments[L.segmentIndexAt(layout, cursor)];
  dom.readout.textContent = `t=${fmt(cursor)}s / ${fmt(plan.duration)}s · `
    + `片段=${seg ? seg.kind : "-"} · 最近落点=${landing >= 0 ? landing : "起点"}`;
}

function tick(now) {
  if (!playing) return;
  if (lastFrame) cursor += (now - lastFrame) / 1000;
  lastFrame = now;
  if (cursor >= plan.duration) { cursor = plan.duration; playing = false; dom.play.textContent = "▶ 播放"; }
  dom.slider.value = String(Math.round(1000 * cursor / Math.max(1e-6, plan.duration)));
  draw();
  if (playing) requestAnimationFrame(tick);
}

dom.play.addEventListener("click", () => {
  playing = !playing;
  dom.play.textContent = playing ? "⏸ 暂停" : "▶ 播放";
  if (playing) { lastFrame = 0; requestAnimationFrame(tick); }
});
dom.slider.addEventListener("input", () => {
  cursor = (Number(dom.slider.value) / 1000) * plan.duration;
  draw();
});
window.addEventListener("resize", draw);

renderAsides();
draw();
