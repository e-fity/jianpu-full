/**
 * Completeness checks: the rule that an incomplete export must fail loudly.
 *
 * ``checkExport`` is what stands between a broken browser run and a video file
 * that looks fine until someone watches the end of it, so every failure mode it
 * is supposed to catch is exercised here -- with no browser needed.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ExportIncomplete,
  MAX_UPLOAD_BYTES,
  UPLOAD_CHUNK,
  acceptUploadChunk,
  checkExport,
  expectedFrames,
  glInfo,
  isSoftwareRenderer,
  uploadChunkSize,
  uploadChunks,
} from "../src/verify.mjs";

const EXPECTED = 300;

/** A fake WebGL context: only the calls glInfo makes. */
function fakeGl({
  vendor = "WebKit",
  renderer = "WebKit WebGL",
  version = "WebGL 2.0 (OpenGL ES 3.0 Chromium)",
  unmaskedVendor = null,
  unmaskedRenderer = null,
  debugExtension = true,
  throws = false,
} = {}) {
  const DBG = { UNMASKED_VENDOR_WEBGL: 0x9245, UNMASKED_RENDERER_WEBGL: 0x9246 };
  const PARAMS = { VENDOR: 0x1f00, RENDERER: 0x1f01, VERSION: 0x1f02 };
  return {
    VENDOR: PARAMS.VENDOR,
    RENDERER: PARAMS.RENDERER,
    VERSION: PARAMS.VERSION,
    getExtension(name) {
      if (throws) throw new Error(`${name} blocked by the privacy settings`);
      return debugExtension && name === "WEBGL_debug_renderer_info" ? DBG : null;
    },
    getParameter(parameter) {
      switch (parameter) {
        case PARAMS.VENDOR: return vendor;
        case PARAMS.RENDERER: return renderer;
        case PARAMS.VERSION: return version;
        case DBG.UNMASKED_VENDOR_WEBGL: return unmaskedVendor;
        case DBG.UNMASKED_RENDERER_WEBGL: return unmaskedRenderer;
        default: return null;
      }
    },
  };
}

function goodReport(extra = {}) {
  return {
    frames: EXPECTED,
    expected: EXPECTED,
    bytes: 3_000_000,
    errors: [],
    ...extra,
  };
}

describe("expectedFrames", () => {
  it("is ceil(duration * fps), the formula both CLIs use", () => {
    assert.equal(expectedFrames(10.0, 30), 300);
    assert.equal(expectedFrames(0.5, 30), 15);
    assert.equal(expectedFrames(2.0, 24), 48);
    assert.equal(expectedFrames(0.03, 30), 1);
  });

  it("never counts a frame that starts at or after the duration", () => {
    for (const duration of [0.5, 9.9, 10.0, 12.3]) {
      for (const fps of [24, 30, 60]) {
        assert.ok(expectedFrames(duration, fps) - 1 < duration * fps);
      }
    }
  });
});

describe("glInfo", () => {
  it("reports the masked and unmasked renderer strings", () => {
    const info = glInfo(fakeGl({
      vendor: "Google Inc. (NVIDIA)",
      renderer: "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)",
      unmaskedVendor: "Google Inc. (NVIDIA)",
      unmaskedRenderer: "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)",
    }));
    assert.equal(info.version, "WebGL 2.0 (OpenGL ES 3.0 Chromium)");
    assert.match(info.unmaskedRenderer, /RTX 3060/);
    assert.equal(info.software, false);
  });

  it("detects a software renderer, which is the point of logging it", () => {
    const swiftshader = glInfo(fakeGl({
      unmaskedRenderer: "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)",
    }));
    assert.equal(swiftshader.software, true);
    const llvmpipe = glInfo(fakeGl({ renderer: "llvmpipe (LLVM 15.0.7, 256 bits)" }));
    assert.equal(llvmpipe.software, true);
    const basic = glInfo(fakeGl({ renderer: "Microsoft Basic Render Driver" }));
    assert.equal(basic.software, true);
  });

  it("survives a context without the debug extension, and one that throws", () => {
    const masked = glInfo(fakeGl({ debugExtension: false }));
    assert.equal(masked.unmaskedRenderer, null);
    assert.equal(masked.software, false); // "WebKit WebGL" is not a software marker
    assert.equal(masked.vendor, "WebKit");

    const blocked = glInfo(fakeGl({ throws: true }));
    assert.equal(blocked.unmaskedVendor, null);
    assert.equal(blocked.renderer, "WebKit WebGL");
  });

  it("treats a missing context as not-software", () => {
    assert.equal(isSoftwareRenderer(null), false);
    assert.equal(isSoftwareRenderer(undefined), false);
    assert.equal(isSoftwareRenderer({}), false);
  });
});

describe("checkExport", () => {
  it("accepts a complete export and returns the report", () => {
    const report = goodReport();
    assert.equal(checkExport(report, EXPECTED), report);
  });

  it("rejects a missing report", () => {
    for (const missing of [null, undefined]) {
      assert.throws(() => checkExport(missing, EXPECTED), (error) => {
        assert.ok(error instanceof ExportIncomplete);
        assert.ok(error instanceof Error);
        assert.match(error.message, /no report/);
        return true;
      });
    }
  });

  it("rejects a report the page itself failed to make", () => {
    assert.throws(
      () => checkExport(goodReport({ error: "VideoEncoder is unavailable" }), EXPECTED),
      (error) => {
        assert.match(error.message, /browser export failed: VideoEncoder/);
        return true;
      },
    );
  });

  it("rejects a frame count that is not the plan's", () => {
    // short: the encoder stopped early -- the classic silent failure
    assert.throws(
      () => checkExport(goodReport({ frames: 297 }), EXPECTED),
      /exported 297 of 300 frames/,
    );
    // long: an off-by-one in the drive loop
    assert.throws(
      () => checkExport(goodReport({ frames: 301 }), EXPECTED),
      /exported 301 of 300 frames/,
    );
  });

  it("rejects a page that was told to export a different count", () => {
    assert.throws(
      () => checkExport(goodReport({ expected: 299 }), EXPECTED),
      /told to export 299 frames, the plan needs 300/,
    );
  });

  it("rejects an empty (or missing) buffer", () => {
    for (const bytes of [0, null, undefined]) {
      assert.throws(() => checkExport(goodReport({ bytes }), EXPECTED), /bytes/);
    }
  });

  it("rejects a run that collected encoder errors, even with all frames", () => {
    assert.throws(
      () => checkExport(goodReport({ errors: ["a frame was dropped"] }), EXPECTED),
      /1 encoder error\(s\): a frame was dropped/,
    );
  });

  it("accepts a report that has no errors key at all", () => {
    const report = goodReport();
    delete report.errors;
    assert.equal(checkExport(report, EXPECTED), report);
  });
});

describe("bounded upload", () => {
  // One 106 MB POST used to become a ~583 MB DevTools protocol message (the
  // browser mirrors request bodies into Network.requestWillBeSent), which Node
  // cannot hold as a string: ERR_STRING_TOO_LONG killed an export whose frames
  // had all been encoded.  These checks are what stands between a truncated or
  // reordered chunk series and a video that looks finished.

  function freshUpload() {
    return { received: 0, chunks: null, total: null, bytes: 0, done: false };
  }

  /** Send ``total`` bytes in chunks, optionally dropping/mangling one. */
  function sendAll(upload, total, { dropLast = false, sizeDelta = 0 } = {}) {
    const chunks = uploadChunks(total);
    for (let seq = 0; seq < chunks; seq += 1) {
      const size = uploadChunkSize(total, seq);
      if (dropLast && seq === chunks - 1) break;
      acceptUploadChunk(upload, { seq, chunks, total, bytes: size + sizeDelta });
    }
    return upload;
  }

  it("splits a large video into bounded chunks", () => {
    assert.equal(uploadChunks(1), 1);
    assert.equal(uploadChunks(UPLOAD_CHUNK), 1);
    assert.equal(uploadChunks(UPLOAD_CHUNK + 1), 2);
    // the real full-song export: 106,484,638 bytes
    assert.equal(uploadChunks(106_484_638), 51);
    assert.ok(UPLOAD_CHUNK * 5.5 < 64 * 1024 * 1024,
      "a mirrored chunk must stay far below the ~512 MiB string limit");
  });

  it("refuses a nonsense size or chunk", () => {
    for (const total of [0, -1, 1.5, NaN, null, undefined, "12"]) {
      assert.throws(() => uploadChunks(total), /positive whole number/);
    }
    assert.throws(() => uploadChunks(10, 0), /chunk size must be positive/);
  });

  it("reports the exact size of every chunk, last one included", () => {
    const total = 5 * UPLOAD_CHUNK + 7;
    const chunks = uploadChunks(total);
    assert.equal(chunks, 6);
    for (let seq = 0; seq < chunks - 1; seq += 1) {
      assert.equal(uploadChunkSize(total, seq), UPLOAD_CHUNK);
    }
    assert.equal(uploadChunkSize(total, chunks - 1), 7);
    assert.throws(() => uploadChunkSize(total, chunks), /outside/);
    assert.throws(() => uploadChunkSize(total, -1), /outside/);
  });

  it("completes only when every chunk of the declared total arrived", () => {
    const total = 2 * UPLOAD_CHUNK + 1234;
    const upload = sendAll(freshUpload(), total);
    assert.equal(upload.done, true);
    assert.equal(upload.received, 3);
    assert.equal(upload.bytes, total);
  });

  it("leaves a truncated series incomplete instead of finished", () => {
    const upload = sendAll(freshUpload(), 2 * UPLOAD_CHUNK, { dropLast: true });
    assert.equal(upload.done, false);
    assert.equal(upload.bytes, UPLOAD_CHUNK);
    assert.notEqual(upload.bytes, upload.total);
  });

  it("rejects a chunk of the wrong size (truncated or padded body)", () => {
    const total = UPLOAD_CHUNK + 10;
    assert.throws(
      () => sendAll(freshUpload(), total, { sizeDelta: -1 }),
      /expected \d+ \(truncated or padded upload\)/,
    );
  });

  it("rejects a repeated, skipped or reordered chunk", () => {
    const total = 3 * UPLOAD_CHUNK;
    const upload = freshUpload();
    acceptUploadChunk(upload, { seq: 0, chunks: 3, total, bytes: UPLOAD_CHUNK });
    assert.throws(
      () => acceptUploadChunk(upload, { seq: 0, chunks: 3, total, bytes: UPLOAD_CHUNK }),
      /arrived twice/,
    );
    // chunk 2 jumps the queue: chunk 1 was never acknowledged
    assert.throws(
      () => acceptUploadChunk(upload, { seq: 2, chunks: 3, total, bytes: UPLOAD_CHUNK }),
      /arrived before chunk 1/,
    );
  });

  it("rejects a chunk count that does not cover the declared total", () => {
    assert.throws(
      () => acceptUploadChunk(freshUpload(), {
        seq: 0, chunks: 2, total: 4 * UPLOAD_CHUNK, bytes: UPLOAD_CHUNK,
      }),
      /2 chunks, 4 cover/,
    );
  });

  it("rejects a nonsense total and one past the upload cap", () => {
    assert.throws(
      () => acceptUploadChunk(freshUpload(), { seq: 0, chunks: 1, total: 0, bytes: 0 }),
      /declared 0 bytes/,
    );
    assert.throws(
      () => acceptUploadChunk(freshUpload(), {
        seq: 0, chunks: 1, total: MAX_UPLOAD_BYTES + 2, bytes: UPLOAD_CHUNK,
      }),
      /exceeds/,
    );
  });

  it("rejects an upload that changes its declared size mid-flight", () => {
    const total = 2 * UPLOAD_CHUNK;
    const upload = sendAll(freshUpload(), total, { dropLast: true });
    assert.throws(
      () => acceptUploadChunk(upload, {
        seq: 1, chunks: 2, total: total + UPLOAD_CHUNK, bytes: UPLOAD_CHUNK,
      }),
      /changed size mid-flight/,
    );
  });

  it("refuses one more chunk after the upload completed", () => {
    const total = UPLOAD_CHUNK + 5;
    const upload = sendAll(freshUpload(), total);
    assert.equal(upload.done, true);
    assert.throws(
      () => acceptUploadChunk(upload, { seq: 2, chunks: 2, total, bytes: 5 }),
      /already completed/,
    );
  });
});
