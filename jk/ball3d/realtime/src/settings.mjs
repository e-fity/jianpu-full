/**
 * Editor settings: one schema for the browser panel, the export page, the Node
 * solve tool and the Python API.  Every value is plain data -- the module holds
 * no mutable task state, so two pages or two export tasks can never bleed
 * parameters into each other (the layout module itself is instantiated per
 * geometry config, see layout_kit.mjs).
 */

export const SCHEMA_VERSION = "web-editor-1";

/**
 * How many frames a clip of ``seconds`` at ``fps`` must contain.
 *
 * One formula for the whole pipeline: ``make_ball_video.expected_frames``,
 * ``render_scene.frame_count`` and the browser encoder all use
 * ``ceil(seconds * fps - 1e-9)``.  The tiny epsilon keeps a binary near-integer
 * (0.1 * 3, 175.8384615 * 30 written by repr) from being pushed up a frame by
 * its own floating-point representation, while a genuinely fractional duration
 * still rounds up: 0.501 s at 30 fps is 16 frames, not 15.
 */
export function expectedFrames(seconds, fps) {
  return Math.ceil(Number(seconds) * Number(fps) - 1e-9);
}

const f = (def, min, max, step, label, unit = "") =>
  ({ kind: "number", def, min, max, step, label, unit });
const c = (def, label) => ({ kind: "color", def, label });
const b = (def, label) => ({ kind: "boolean", def, label });

/** Geometry: every entry really re-solves the layout (see layout_kit.mjs). */
export const GEOMETRY_SCHEMA = {
  board_w: f(0.30, 0.24, 0.40, 0.01, "板宽", "m"),
  board_d: f(0.50, 0.28, 2.00, 0.01, "板长（伸出墙面）", "m"),
  ball_r: f(0.10, 0.07, 0.14, 0.005, "小球半径", "m"),
  spacing: f(0.34, 0.28, 0.50, 0.01, "板与板的间距", "m"),
  bounce: f(1.0, 0.5, 1.8, 0.05, "长音滑道尺寸", "x"),
};

/** Visual: every entry is applied to the exported scene, not only to the preview. */
export const VISUAL_SCHEMA = {
  board_color: c("#c0763c", "板色"),
  board_tint: f(0.0, 0.0, 1.0, 0.05, "彩色强度", ""),
  wood: f(1.0, 0.0, 1.0, 0.05, "木纹", ""),
  arm_color: c("#ddbf81", "金属颜色"),
  wall_color: c("#484c53", "墙色"),
  sun: f(1.8, 0.4, 3.0, 0.05, "主光", ""),
  exposure: f(0.95, 0.4, 1.8, 0.05, "曝光", ""),
  glow: f(1.0, 0.0, 2.0, 0.05, "击中光晕", ""),
  bloom: f(0.18, 0.0, 0.80, 0.02, "辉光", ""),
  shadows: b(true, "阴影"),
  zoom: f(1.0, 0.6, 1.6, 0.05, "镜头远近", "x"),
  oblique: f(0.0, -1.0, 1.0, 0.05, "斜视角", ""),
};

function defaultsOf(schema) {
  const out = {};
  for (const [k, s] of Object.entries(schema)) out[k] = s.def;
  return out;
}
/** The geometry that was delivered and reviewed in round 3. */
export function geometryDefaults() { return defaultsOf(GEOMETRY_SCHEMA); }
/** The look that was delivered and reviewed in round 3 (reference starting point). */
export function visualDefaults() { return defaultsOf(VISUAL_SCHEMA); }

export const VIDEO_SIZES = { "720x1280": [720, 1280], "1080x1920": [1080, 1920] };
export const VIDEO_FPS = [30, 60];
/** Reference bitrate at 720x1280 30 fps, the value the CLI has always used. */
export const BITRATE_REF = 8000000;
export const BITRATE_REF_PIXELS = 720 * 1280 * 30;

/** "匹配码率": scale the reference bitrate with pixels x fps (rounded to 0.1 Mbps). */
export function matchedBitrate(width, height, fps) {
  const raw = BITRATE_REF * (width * height * fps) / BITRATE_REF_PIXELS;
  return Math.round(raw / 100000) * 100000;
}
export const BITRATE_MIN = 200000;
export const BITRATE_MAX = 80000000;

export const TIME_MIN_SECONDS = 0.5;
export const TIME_MAX_SECONDS = 600.0;

const HEX = /^#[0-9a-fA-F]{6}$/;

function readNumber(schema, key, value, errors, where) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    errors.push(where + "." + key + " 必须是有限数字（收到 " + JSON.stringify(value) + "）");
    return null;
  }
  const s = schema[key];
  if (value < s.min - 1e-12 || value > s.max + 1e-12) {
    errors.push(where + "." + key + " 超出范围 [" + s.min + ", " + s.max + "]（收到 " + value + "）");
    return null;
  }
  return value;
}

/**
 * Validate one settings object.  Returns {ok, value, errors, notes} where value
 * is a fresh frozen normalised copy -- never the same object the caller passed,
 * so a later edit of the caller cannot mutate a running task.
 */
export function normalizeSettings(input) {
  const errors = [];
  if (input !== undefined && input !== null && (typeof input !== "object"
      || Array.isArray(input))) {
    return {
      ok: false, value: Object.freeze({ schema: SCHEMA_VERSION,
        geometry: Object.freeze(geometryDefaults()),
        visuals: Object.freeze(visualDefaults()) }),
      errors: ["设置必须是一个对象（收到 " + JSON.stringify(input) + "）"], notes: [],
    };
  }
  const src = input || {};
  if (src.schema !== undefined && src.schema !== SCHEMA_VERSION) {
    errors.push("不支持的设置版本 " + JSON.stringify(src.schema)
      + "（本机为 " + SCHEMA_VERSION + "）");
  }
  for (const key of Object.keys(src)) {
    if (!["schema", "geometry", "visuals"].includes(key)) {
      errors.push("未知的设置段 " + JSON.stringify(key));
    }
  }
  const geometry = geometryDefaults();
  const visuals = visualDefaults();
  if (src.geometry !== undefined && src.geometry !== null
      && (typeof src.geometry !== "object" || Array.isArray(src.geometry))) {
    errors.push("geometry 必须是一个对象");
  } else {
    const g = src.geometry || {};
    for (const key of Object.keys(g)) {
      if (!(key in GEOMETRY_SCHEMA)) {
        errors.push("未知的几何参数 geometry." + key);
        continue;
      }
      if (g[key] === undefined || g[key] === null) continue; // absent = default
      const v = readNumber(GEOMETRY_SCHEMA, key, g[key], errors, "geometry");
      if (v !== null) geometry[key] = v;
    }
  }
  if (src.visuals !== undefined && src.visuals !== null
      && (typeof src.visuals !== "object" || Array.isArray(src.visuals))) {
    errors.push("visuals 必须是一个对象");
  }
  for (const [key, s] of Object.entries(VISUAL_SCHEMA)) {
    const raw = (src.visuals && typeof src.visuals === "object" && !Array.isArray(src.visuals))
      ? src.visuals[key] : undefined;
    if (raw === undefined || raw === null) continue;
    if (s.kind === "number") {
      const v = readNumber(VISUAL_SCHEMA, key, raw, errors, "visuals");
      if (v !== null) visuals[key] = v;
    } else if (s.kind === "boolean") {
      if (typeof raw !== "boolean") errors.push("visuals." + key + " 必须是 true/false");
      else visuals[key] = raw;
    } else if (typeof raw !== "string" || !HEX.test(raw)) {
      errors.push("visuals." + key + " 必须是 #rrggbb 颜色（收到 " + JSON.stringify(raw) + "）");
    } else visuals[key] = raw.toLowerCase();
  }
  if (src.visuals && typeof src.visuals === "object" && !Array.isArray(src.visuals)) {
    for (const key of Object.keys(src.visuals)) {
      if (!(key in VISUAL_SCHEMA)) errors.push("未知的视觉参数 visuals." + key);
    }
  }
  // Cross-check: a ball wider than 60% of the plank cannot sit on it without
  // swallowing the assembly; refuse instead of silently drawing a broken rest.
  if (geometry.ball_r > geometry.board_w * 0.6) {
    errors.push("小球半径 " + geometry.ball_r + " 对板宽 " + geometry.board_w
      + " 太大（须 <= 0.6 x 板宽）");
  }
  const value = Object.freeze({
    schema: SCHEMA_VERSION,
    geometry: Object.freeze(geometry),
    visuals: Object.freeze(visuals),
  });
  return { ok: errors.length === 0, value, errors, notes: [] };
}

/** Validate the video part of an export task (kept separate from the look). */
export function normalizeVideo(input) {
  const errors = [];
  if (input !== undefined && input !== null
      && (typeof input !== "object" || Array.isArray(input))) {
    return { ok: false, value: null, errors: ["视频参数必须是一个对象（收到 "
      + JSON.stringify(input) + "）"] };
  }
  const src = input || {};
  const size = String(src.size === undefined ? "720x1280" : src.size);
  const fps = Number(src.fps === undefined ? 30 : src.fps);
  const start = Number(src.start === undefined ? 0 : src.start);
  const seconds = Number(src.seconds === undefined ? 10 : src.seconds);
  const bitrate = Number(src.bitrate === undefined ? 0 : src.bitrate);
  // Object.hasOwn, not `in`: "__proto__" (or "constructor") is on the prototype
  // chain and would otherwise be read as a real size name.
  if (!Object.hasOwn(VIDEO_SIZES, size)) {
    errors.push("size 必须是 " + Object.keys(VIDEO_SIZES).join(" 或 "));
  }
  if (!VIDEO_FPS.includes(fps)) errors.push("fps 必须是 " + VIDEO_FPS.join(" 或 "));
  if (!Number.isFinite(start) || start < 0) errors.push("start 必须 >= 0（收到 " + src.start + "）");
  if (!Number.isFinite(seconds) || seconds < TIME_MIN_SECONDS - 1e-9
      || seconds > TIME_MAX_SECONDS) {
    errors.push("seconds 必须在 [" + TIME_MIN_SECONDS + ", " + TIME_MAX_SECONDS
      + "]（收到 " + src.seconds + "）");
  }
  if (bitrate !== 0 && (!Number.isFinite(bitrate) || bitrate < BITRATE_MIN
      || bitrate > BITRATE_MAX)) {
    errors.push("码率必须在 [" + BITRATE_MIN + ", " + BITRATE_MAX + "]（收到 " + src.bitrate + "）");
  }
  const tuple = Object.hasOwn(VIDEO_SIZES, size) ? VIDEO_SIZES[size] : null;
  const [width, height] = (Array.isArray(tuple) && tuple.length === 2
    && tuple.every((v) => Number.isFinite(v))) ? tuple : [0, 0];
  // ceil(seconds * fps), the *same* contract as make_ball_video.expected_frames
  // and the browser encoder: a 175.8384615 s song at 30 fps is 5276 frames, and
  // rounding would ask for 5275 while the encoder produced 5276 (a hard failure).
  const frames = Math.max(1, expectedFrames(seconds, fps));
  const video = {
    size: size, width: width, height: height, fps: fps, start: start,
    seconds: seconds, frames: frames,
    bitrate: bitrate === 0
      ? (width ? matchedBitrate(width, height, fps) : BITRATE_REF) : Math.round(bitrate),
    bitrate_mode: bitrate === 0 ? "matched" : "custom",
  };
  if (!width) delete video.size;              // never echo an unusable size name
  const value = Object.freeze(video);
  return { ok: errors.length === 0, value: value, errors: errors };
}

/** The schema itself, for the Python side and for a drift test. */
export function schemaJson() {
  const strip = (schema) => {
    const out = {};
    for (const [k, s] of Object.entries(schema)) {
      const one = { kind: s.kind, def: s.def, label: s.label };
      if (s.kind === "number") {
        one.min = s.min; one.max = s.max; one.step = s.step; one.unit = s.unit;
      }
      out[k] = one;
    }
    return out;
  };
  return {
    version: SCHEMA_VERSION,
    geometry: strip(GEOMETRY_SCHEMA),
    visuals: strip(VISUAL_SCHEMA),
    video: {
      sizes: VIDEO_SIZES, fps: VIDEO_FPS,
      bitrate_ref: BITRATE_REF, bitrate_ref_pixels: BITRATE_REF_PIXELS,
      bitrate_min: BITRATE_MIN, bitrate_max: BITRATE_MAX,
      seconds_min: TIME_MIN_SECONDS, seconds_max: TIME_MAX_SECONDS,
    },
  };
}

export function hexToRgb(hex) {
  const m = HEX.exec(String(hex));
  if (!m) throw new Error("not a colour: " + hex);
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** The geometry constants a layout kit instance carries (report shape). */
export function sceneGeometry(kit) {
  return {
    board_w: kit.BOARD_W, board_h: kit.BOARD_H, board_d: kit.BOARD_D,
    ball_r: kit.BALL_R, contact_off: kit.CONTACT_OFF, dx_min: kit.DX_MIN,
    bounce_scale: kit.BOUNCE_SCALE, plank_gap_min: kit.PLANK_GAP_MIN,
  };
}

