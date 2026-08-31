// ------------------------------------------------------------------ //
//  Video export: the animation, rendered slower than it plays
//
//  The preview animates by recomputing the whole water field every rAF tick,
//  which on a detailed scene is nowhere near 60 — sometimes nowhere near 1.
//  Nothing here makes that faster. What it does is decouple the render rate
//  from the playback rate: each frame is built at the phase it is *supposed*
//  to have, at whatever pace the machine can manage, and the file plays back
//  at a fixed 20fps. A scene that crawls at half a frame a second on screen
//  comes out smooth, having taken a few minutes to do it.
//
//  Which is why this cannot be a MediaRecorder on a captured canvas: that
//  records wall-clock time, so a slow render becomes a slow video. WebCodecs
//  lets a frame carry the timestamp we choose rather than the one it was
//  made at, and hands back encoded frames to put in an MP4 (see mp4.js).
// ------------------------------------------------------------------ //
import { muxMp4, MEDIA_TIMESCALE } from "./mp4";

// Fixed: the point of the export is a rate the preview cannot hit, and 20 is
// smooth enough for water while keeping a 10s render inside a few minutes.
export const VIDEO_FPS = 20;
export const VIDEO_MIN_SEC = 1;
export const VIDEO_MAX_SEC = 10;
export const VIDEO_DEFAULT_SEC = 3;

// Frame size, as a multiple of the SVG frame. Every step has to come out even
// on both axes — H.264 codes in 16x16 macroblocks and chroma is subsampled by
// two, so an odd dimension is rejected outright by some encoders.
export const VIDEO_SCALES = [1, 1.5, 2];
export const VIDEO_DEFAULT_SCALE = 1;
export function videoSize(scale, vbW, vbH) {
  const even = (n) => Math.max(2, Math.round(n / 2) * 2);
  return { w: even(vbW * scale), h: even(vbH * scale) };
}

// The preview's animation loop advances the wave phase by 0.12 * speed per
// animation frame, so at a full 60fps it covers 7.2 * speed of phase in a
// second. That — not the rate the machine actually managed — is the speed the
// scene was set up to look right at, and so the speed the file plays at.
export const PHASE_PER_TICK = 0.12;
export const TICKS_PER_SEC = 60;
export const PHASE_PER_SEC = PHASE_PER_TICK * TICKS_PER_SEC;

// The frames of a `seconds`-long export: how many, and the wave phase each
// one is rendered at. Frame 0 is t = 0, as asked; the last frame sits one
// frame short of the end, so the clip loops onto its own start rather than
// repeating a phase.
export function framePlan(seconds, speed, fps = VIDEO_FPS) {
  const secs = Math.max(VIDEO_MIN_SEC, Math.min(VIDEO_MAX_SEC, seconds));
  const count = Math.max(1, Math.round(secs * fps));
  const phaseAt = (i) => (i / fps) * PHASE_PER_SEC * (speed || 0);
  return { fps, count, seconds: count / fps, phaseAt, endPhase: phaseAt(count) };
}

// Flat color regions sound cheap to compress, and the near field is. The far
// field is the opposite: ribbons a pixel or two wide, all of them moving, which
// is exactly what a codec spends its bits deciding to throw away. At 0.2 bits
// per pixel the top of a grazing frame comes back visibly softer than the
// preview; 0.45 holds it. That is a big number for flat color and a 10s clip
// at the largest size is still under 20MB, which is the right way round for a
// file you export deliberately.
export const BITS_PER_PIXEL = 0.45;
export function videoBitrate(w, h, fps) {
  return Math.min(40e6, Math.max(2e6, Math.round(w * h * fps * BITS_PER_PIXEL)));
}

// What to offer the encoder, best first.
//
// H.264 is what an .mp4 is expected to contain and the only codec every
// player, editor and phone will open, so the whole High-through-Baseline
// ladder is tried before anything else. But not every build ships an H.264
// *encoder* — a Chromium without proprietary codecs is the common case, and
// it fails at `isConfigSupported` rather than at playback. VP9 in MP4 is a
// real, specified pairing that Chrome, Firefox, VLC and Windows all play, and
// it is the difference between a file and an error message. It is last for a
// reason: QuickTime and a lot of editing software will not touch it.
export const VIDEO_CODECS = [
  { codec: "avc1.640034", entry: "avc1" },
  { codec: "avc1.64002a", entry: "avc1" },
  { codec: "avc1.640028", entry: "avc1" },
  { codec: "avc1.4d0028", entry: "avc1" },
  { codec: "avc1.42e028", entry: "avc1" },
  { codec: "avc1.42001e", entry: "avc1" },
  { codec: "vp09.00.41.08", entry: "vp09" },
  { codec: "vp09.00.31.08", entry: "vp09" },
];

// "vp09.<profile>.<level>.<bit depth>" — the same three numbers the vpcC box
// in the container has to restate.
export function vp9Params(codec) {
  const p = codec.split(".");
  return { profile: Number(p[1]) || 0, level: Number(p[2]) || 41, bitDepth: Number(p[3]) || 8 };
}

// WebCodecs is reached through `window` rather than as a bare identifier:
// there are still browsers without it, and this file is loaded by all of them.
const webcodecs = () => (typeof window === "undefined" ? {} : window);

export function videoSupported() {
  const w = webcodecs();
  return typeof w.VideoEncoder === "function" && typeof w.VideoFrame === "function";
}

// Ask the browser which of the profiles it will actually encode at this size.
// `isConfigSupported` is the only honest answer — a codec string alone says
// nothing about whether there is a hardware or software encoder behind it.
export async function pickConfig(width, height, fps, bitrate) {
  if (!videoSupported()) return null;
  for (const { codec, entry } of VIDEO_CODECS) {
    const config = { codec, width, height, bitrate, framerate: fps };
    // H.264 only: length-prefixed NAL units plus an avcC record, which is what
    // an MP4 sample entry wants; the annex-B alternative would need unpicking
    if (entry === "avc1") config.avc = { format: "avc" };
    try {
      const res = await webcodecs().VideoEncoder.isConfigSupported(config);
      if (res && res.supported) return { config: res.config || config, entry, codec };
    } catch (e) { /* unknown codec string: try the next */ }
  }
  return null;
}

// "4m 20s" / "35s" — an estimate this coarse has no business showing decimals
export function formatDuration(seconds) {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

// How much longer, from how long the frames so far took. Frames cost roughly
// the same as each other — same raster, same mesh — so the mean is a fair
// predictor after the first one or two.
export function etaSeconds(done, total, elapsed) {
  if (!done || done >= total) return 0;
  return (elapsed / done) * (total - done);
}

// yield to the event loop: lets the encoder drain and, more importantly, lets
// React paint the progress bar between frames
const tick = () => new Promise((r) => setTimeout(r, 0));

/**
 * Render and encode `count` frames into an MP4.
 *
 * @param renderFrame  async (i) => a canvas holding frame i, already drawn.
 *                     Called one frame at a time, in order.
 * @param onProgress   (done, total) after each frame is handed to the encoder
 * @param cancelled    () => boolean, polled between frames
 * @returns { parts, width, height, fps, count } or null if cancelled
 */
export async function encodeMp4({
  width, height, fps = VIDEO_FPS, count, renderFrame, onProgress, cancelled,
}) {
  if (!videoSupported()) throw new Error("no VideoEncoder");
  const bitrate = videoBitrate(width, height, fps);
  const picked = await pickConfig(width, height, fps, bitrate);
  if (!picked) throw new Error("this browser encodes neither H.264 nor VP9");
  const { config, entry, codec } = picked;

  const delta = Math.round(MEDIA_TIMESCALE / fps);
  const samples = [];
  let description = null;
  let failure = null;

  const { VideoEncoder, VideoFrame } = webcodecs();
  const encoder = new VideoEncoder({
    output: (chunk, meta) => {
      const d = meta && meta.decoderConfig && meta.decoderConfig.description;
      if (d && !description) {
        description = d instanceof ArrayBuffer
          ? new Uint8Array(d.slice(0))
          : new Uint8Array(d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength));
      }
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      samples.push({ data, keyFrame: chunk.type === "key", duration: delta });
    },
    error: (e) => { failure = e; },
  });
  encoder.configure(config);

  const stop = () => { try { encoder.close(); } catch (e) { /* already closed */ } };
  try {
    for (let i = 0; i < count; i++) {
      if (cancelled && cancelled()) { stop(); return null; }
      const canvas = await renderFrame(i);
      const frame = new VideoFrame(canvas, {
        timestamp: Math.round((i * 1e6) / fps),
        duration: Math.round(1e6 / fps),
      });
      try {
        // a keyframe every two seconds: enough for a player to scrub without
        // spending the bitrate on one per frame
        encoder.encode(frame, { keyFrame: i % (fps * 2) === 0 });
      } finally { frame.close(); }
      if (onProgress) onProgress(i + 1, count);
      if (failure) throw failure;
      // the render is the slow half, so the queue is normally empty — this is
      // only here for the case where it is not
      while (encoder.encodeQueueSize > 2) await tick();
      await tick();
    }
    await encoder.flush();
    if (failure) throw failure;
    if (!samples.length) throw new Error("the encoder produced no frames");
    // H.264 frames mean nothing without the SPS/PPS the encoder emitted with
    // the first of them; VP9 frames carry their own headers
    if (entry === "avc1" && !description)
      throw new Error("the encoder gave no decoder description");
    return {
      parts: muxMp4({
        width, height, samples, description, entry,
        vp9: entry === "vp09" ? vp9Params(codec) : null,
      }),
      width, height, fps, count, codec, entry,
    };
  } finally { stop(); }
}
