/**
 * Completeness and renderer checks shared by the browser export, the Node
 * orchestrator and the unit tests.
 *
 * The realtime renderer never muxes a half-finished export: the browser counts
 * the frames it handed to the encoder, the orchestrator compares that count
 * with the plan's own ``ceil(duration * fps)`` and refuses to write the video
 * on any mismatch or on any non-fatal encoder error.  A wrong frame count is a
 * failure (non-zero exit), never a shorter video.
 */

export class ExportIncomplete extends Error {
  constructor(message) {
    super(message);
    this.name = "ExportIncomplete";
  }
}

/**
 * ``make_ball_video.expected_frames`` / ``render_scene.frame_count``.
 *
 * Re-exported from ``settings.mjs`` on purpose: the panel, the API metadata and
 * the encoder must count frames with *one* function, otherwise a full song can
 * be described as 5275 frames while the encoder writes 5276.
 */
export { expectedFrames } from "./settings.mjs";

// --- bounded upload -----------------------------------------------------------
//
// The page hands the encoded MP4 back over a loopback POST.  While the DevTools
// Network domain is on, the browser mirrors every request body into a
// ``Network.requestWillBeSent`` protocol event whose body is the request body
// escaped into one JSON string -- measured at ~5.5x for binary data.  Playwright
// then has to turn that one message into a single JS string, and Node cannot
// hold more than 0x1fffffe8 characters, so a single 106 MB upload produced a
// ~583 MB message and killed the whole run with ERR_STRING_TOO_LONG *after* all
// 5276 frames had been encoded.
//
// Sending the video as bounded chunks keeps every protocol message a few MB.
// The server validates the sequence, every chunk's exact size and the declared
// total, so a truncated or reordered upload fails as a short file instead of
// being renamed into place.

/** Most bytes one upload request may carry (also the server's per-chunk cap). */
export const UPLOAD_CHUNK = 2 * 1024 * 1024;
/** Most bytes one whole upload may carry. */
export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;

/** Number of chunks a ``total``-byte upload is sent in. */
export function uploadChunks(total, chunk = UPLOAD_CHUNK) {
  if (!Number.isInteger(total) || total <= 0) {
    throw new Error(`upload size must be a positive whole number of bytes (got ${total})`);
  }
  if (!Number.isInteger(chunk) || chunk <= 0) {
    throw new Error(`upload chunk size must be positive (got ${chunk})`);
  }
  return Math.ceil(total / chunk);
}

/** Exact byte length of chunk ``seq`` of a ``total``-byte upload. */
export function uploadChunkSize(total, seq, chunk = UPLOAD_CHUNK) {
  const chunks = uploadChunks(total, chunk);
  if (!Number.isInteger(seq) || seq < 0 || seq >= chunks) {
    throw new Error(`chunk ${seq} is outside 0..${chunks - 1} of a ${total}-byte upload`);
  }
  return Math.min(chunk, total - seq * chunk);
}

/**
 * Fold one received chunk into the upload state, rejecting anything that would
 * produce a corrupt file: an undeclared or disagreeing total, a chunk count
 * that does not match the total, an out-of-order or repeated chunk, a chunk of
 * the wrong size (truncated or padded), or a completion whose byte count does
 * not add up.
 *
 * @param {{chunks: number|null, total: number|null, received: number, bytes: number, done?: boolean}} upload
 * @param {{seq: number, chunks: number, total: number, bytes: number}} chunk
 * @returns {object} the same state object, updated
 */
export function acceptUploadChunk(upload, chunk) {
  const { seq, chunks, total, bytes } = chunk;
  if (upload.done) throw new Error("the upload already completed");
  if (upload.total === null || upload.total === undefined) {
    if (!Number.isInteger(total) || total <= 0) {
      throw new Error(`upload declared ${total} bytes`);
    }
    if (total > MAX_UPLOAD_BYTES) {
      throw new Error(`upload of ${total} bytes exceeds ${MAX_UPLOAD_BYTES}`);
    }
    const expected = uploadChunks(total);
    if (chunks !== expected) {
      throw new Error(`upload says ${chunks} chunks, ${expected} cover ${total} bytes`);
    }
    upload.total = total;
    upload.chunks = chunks;
  } else if (total !== upload.total || chunks !== upload.chunks) {
    throw new Error(
      `upload changed size mid-flight: ${total} bytes in ${chunks} chunks, `
      + `expected ${upload.total} in ${upload.chunks}`,
    );
  }
  if (!Number.isInteger(seq) || seq < 0) throw new Error(`bad chunk number ${seq}`);
  if (seq < upload.received) {
    throw new Error(`chunk ${seq} arrived twice (already received ${upload.received})`);
  }
  if (seq > upload.received) {
    throw new Error(`chunk ${seq} arrived before chunk ${upload.received}`);
  }
  const want = Math.min(UPLOAD_CHUNK, upload.total - seq * UPLOAD_CHUNK);
  if (bytes !== want) {
    throw new Error(
      `chunk ${seq} carried ${bytes} bytes, expected ${want} `
      + "(truncated or padded upload)",
    );
  }
  upload.received += 1;
  upload.bytes += bytes;
  if (upload.received === upload.chunks) {
    if (upload.bytes !== upload.total) {
      throw new Error(`upload wrote ${upload.bytes} of ${upload.total} bytes`);
    }
    upload.done = true;
  }
  return upload;
}

/** Renderers that mean WebGL fell back to the CPU (detectable, not fatal). */
const SOFTWARE_PATTERNS = [
  /swiftshader/i,
  /llvmpipe/i,
  /\bsoftware\b/i,
  /microsoft basic render/i,
  /mesa offscreen/i,
  /google.*swiftshader/i,
];

/**
 * WebGL vendor/renderer strings, logged so software rendering is visible in the
 * run log.  Works on any object that quacks like a WebGL context, so it is
 * unit testable without a browser.
 */
export function glInfo(gl) {
  let unmaskedVendor = null;
  let unmaskedRenderer = null;
  try {
    const dbg = gl.getExtension("WEBGL_debug_renderer_info");
    if (dbg) {
      unmaskedVendor = gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL);
      unmaskedRenderer = gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL);
    }
  } catch {
    // the extension is optional; the masked strings below are always there
  }
  const info = {
    vendor: gl.getParameter(gl.VENDOR),
    renderer: gl.getParameter(gl.RENDERER),
    version: gl.getParameter(gl.VERSION),
    unmaskedVendor,
    unmaskedRenderer,
  };
  info.software = isSoftwareRenderer(info);
  return info;
}

export function isSoftwareRenderer(info) {
  if (!info) return false;
  const text = [info.renderer, info.unmaskedRenderer, info.vendor, info.unmaskedVendor]
    .filter((value) => typeof value === "string")
    .join(" | ");
  return SOFTWARE_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Throw unless the browser's report proves a complete export.
 *
 * ``report`` is the JSON the page POSTs after ``recorder.stop()``:
 * ``{frames, expected, bytes, errors: [...]}``.
 */
export function checkExport(report, expected) {
  if (!report) throw new ExportIncomplete("the export produced no report");
  if (report.error) {
    throw new ExportIncomplete(`browser export failed: ${report.error}`);
  }
  if (report.expected !== expected) {
    throw new ExportIncomplete(
      `the page was told to export ${report.expected} frames, the plan needs ${expected}`,
    );
  }
  if (report.frames !== expected) {
    throw new ExportIncomplete(
      `exported ${report.frames} of ${expected} frames`,
    );
  }
  if (!(report.bytes > 0)) {
    throw new ExportIncomplete(`exported ${report.bytes} bytes`);
  }
  if (Array.isArray(report.errors) && report.errors.length) {
    throw new ExportIncomplete(
      `${report.errors.length} encoder error(s): ${report.errors[0]}`,
    );
  }
  return report;
}
