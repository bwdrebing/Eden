import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import App from "./App";
import { muxMp4, MEDIA_TIMESCALE } from "./mp4";
import {
  framePlan, videoSize, videoBitrate, formatDuration, etaSeconds, videoSupported,
  VIDEO_FPS, VIDEO_SCALES, VIDEO_MAX_SEC, PHASE_PER_SEC, PHASE_PER_TICK, TICKS_PER_SEC,
  VIDEO_CODECS, vp9Params,
} from "./videoExport";
import { buildSolid3D, RASTER_LEVELS } from "./WaterReflectionContours";
import { GRAZING_RIPPLES, buildScene } from "./sceneFixtures";

/* ------------------------------------------------------------------ *
 * Video export
 *
 * The export exists because the preview's frame rate is a property of the
 * machine and the scene, not of the animation — a detailed scene animates at
 * half a frame a second and still has to come out as smooth water. So what is
 * pinned here is the decoupling: frames timed by the phase they are due at
 * rather than the moment they were made, wrapped in a container a player will
 * actually open. jsdom has no encoder, which is also worth pinning: it comes
 * back as a message rather than a hang.
 * ------------------------------------------------------------------ */

const VB_W = 760, VB_H = 500;

// ---- the frame plan ------------------------------------------------

test("a clip starts at t = 0 and advances at the speed the preview means to", () => {
  const p = framePlan(3, 1);
  expect(p.fps).toBe(VIDEO_FPS);
  expect(p.count).toBe(60);
  expect(p.seconds).toBe(3);
  expect(p.phaseAt(0)).toBe(0);                     // "from t = 0", as asked
  // the preview advances 0.12 * speed per animation frame, so a second of
  // animation at a full 60fps is 7.2 of phase — that is the rate the file has
  // to play at, whatever the machine managed while rendering it
  expect(PHASE_PER_SEC).toBeCloseTo(PHASE_PER_TICK * TICKS_PER_SEC, 10);
  expect(p.phaseAt(VIDEO_FPS)).toBeCloseTo(PHASE_PER_SEC, 10);
  expect(p.endPhase).toBeCloseTo(3 * PHASE_PER_SEC, 10);
  // evenly spaced, and the last frame stops one short of the end so the clip
  // loops onto its own first frame
  expect(p.phaseAt(59)).toBeLessThan(p.endPhase);
  expect(p.phaseAt(1) - p.phaseAt(0)).toBeCloseTo(p.phaseAt(59) - p.phaseAt(58), 10);
});

test("speed scales the span covered, not the frame count", () => {
  const slow = framePlan(2, 0.5), fast = framePlan(2, 2);
  expect(slow.count).toBe(fast.count);
  expect(fast.endPhase).toBeCloseTo(4 * slow.endPhase, 10);
  expect(framePlan(2, 0).endPhase).toBe(0);         // a still, frame for frame
});

test("the length is clamped to what the slider offers", () => {
  expect(framePlan(0.1, 1).seconds).toBe(1);
  expect(framePlan(99, 1).seconds).toBe(VIDEO_MAX_SEC);
  expect(framePlan(10, 1).count).toBe(200);
});

test("every offered frame size is even on both axes and keeps the frame", () => {
  for (const scale of VIDEO_SCALES) {
    const { w, h } = videoSize(scale, VB_W, VB_H);
    // H.264 subsamples chroma by two: an odd dimension is refused outright
    expect(w % 2).toBe(0);
    expect(h % 2).toBe(0);
    expect(w / h).toBeCloseTo(VB_W / VB_H, 2);
  }
  expect(videoSize(1, VB_W, VB_H)).toEqual({ w: 760, h: 500 });
  expect(videoSize(1.5, VB_W, VB_H)).toEqual({ w: 1140, h: 750 });
  expect(videoBitrate(1140, 750, VIDEO_FPS)).toBeGreaterThan(1e6);
});

test("the progress readout rounds to something a person can use", () => {
  expect(formatDuration(9.4)).toBe("9s");
  expect(formatDuration(75)).toBe("1m 15s");
  expect(formatDuration(-3)).toBe("0s");
  expect(etaSeconds(0, 60, 0)).toBe(0);             // nothing measured yet
  expect(etaSeconds(60, 60, 30)).toBe(0);           // done
  expect(etaSeconds(20, 60, 10)).toBeCloseTo(20, 6); // half a second a frame
});

// ---- the container -------------------------------------------------

function concat(parts) {
  const n = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
// walk one level of the box tree between [start, end)
function boxes(file, start = 0, end = file.length) {
  const dv = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const out = {};
  let o = start;
  while (o + 8 <= end) {
    const size = dv.getUint32(o);
    if (size < 8) break;
    const type = String.fromCharCode(...file.slice(o + 4, o + 8));
    out[type] = { start: o, size, body: o + 8, end: o + size };
    o += size;
  }
  return out;
}
// descend a path of container boxes, e.g. find(f, "moov trak mdia minf stbl")
function find(file, path, start = 0, end = file.length) {
  let at = { body: start, end };
  let level = boxes(file, start, end);
  for (const type of path.split(" ")) {
    at = level[type];
    expect(at).toBeDefined();
    level = boxes(file, at.body, at.end);
  }
  return { box: at, children: level };
}
const u32At = (file, o) =>
  new DataView(file.buffer, file.byteOffset, file.byteLength).getUint32(o);

function fakeSamples(sizes, keys) {
  return sizes.map((n, i) => ({
    data: new Uint8Array(n).fill(i + 1),
    keyFrame: keys.includes(i),
    duration: MEDIA_TIMESCALE / VIDEO_FPS,
  }));
}

test("the muxed file is an MP4 whose tables point at the samples that are in it", () => {
  const samples = fakeSamples([40, 12, 9, 21, 7], [0, 3]);
  const description = new Uint8Array([1, 0x64, 0, 0x28, 0xff, 0xe1, 0, 4, 9, 8, 7, 6]);
  const file = concat(muxMp4({ width: 1140, height: 750, samples, description }));

  // ftyp first (a player identifies the file by it), then the payload, then
  // the tables — which name absolute offsets, so they have to come last
  const top = boxes(file);
  expect(Object.keys(top)).toEqual(["ftyp", "mdat", "moov"]);
  expect(top.ftyp.start).toBe(0);
  expect(top.mdat.size).toBe(8 + 40 + 12 + 9 + 21 + 7);
  expect(top.moov.end).toBe(file.length);           // nothing trailing, no gaps

  const stbl = find(file, "moov trak mdia minf stbl").children;

  // sizes and offsets: every sample is findable, byte for byte
  const stsz = stbl.stsz.body + 4;
  expect(u32At(file, stsz)).toBe(0);                // 0 = sizes are per-sample
  expect(u32At(file, stsz + 4)).toBe(samples.length);
  const stco = stbl.stco.body + 4;
  expect(u32At(file, stco)).toBe(samples.length);
  samples.forEach((s, i) => {
    expect(u32At(file, stsz + 8 + i * 4)).toBe(s.data.length);
    const at = u32At(file, stco + 4 + i * 4);
    expect(at).toBeGreaterThanOrEqual(top.mdat.body);
    expect(at + s.data.length).toBeLessThanOrEqual(top.mdat.end);
    expect(Array.from(file.slice(at, at + s.data.length))).toEqual(Array.from(s.data));
  });

  // a constant frame rate is one run-length entry, at 90kHz / 20fps
  const stts = stbl.stts.body + 4;
  expect(u32At(file, stts)).toBe(1);
  expect(u32At(file, stts + 4)).toBe(samples.length);
  expect(u32At(file, stts + 8)).toBe(4500);

  // only the keyframes are seekable, and sample numbers are 1-based
  const stss = stbl.stss.body + 4;
  expect(u32At(file, stss)).toBe(2);
  expect(u32At(file, stss + 4)).toBe(1);
  expect(u32At(file, stss + 8)).toBe(4);

  // the decoder gets the frame size and the description the encoder gave us
  // past stsd's version/flags and entry count, the one sample entry
  const avc1 = find(file, "avc1", stbl.stsd.body + 8, stbl.stsd.end).box;
  const dv = new DataView(file.buffer, file.byteOffset, file.byteLength);
  expect(dv.getUint16(avc1.body + 24)).toBe(1140);
  expect(dv.getUint16(avc1.body + 26)).toBe(750);
  const avcC = find(file, "avcC", avc1.body + 78, avc1.end).box;
  expect(Array.from(file.slice(avcC.body, avcC.end))).toEqual(Array.from(description));

  // the track is as long as the samples say it is: 5 frames at 20fps
  const mdhd = find(file, "moov trak mdia mdhd").box;
  expect(u32At(file, mdhd.body + 4 + 8)).toBe(MEDIA_TIMESCALE);
  expect(u32At(file, mdhd.body + 4 + 12)).toBe(5 * 4500);
  const tkhd = find(file, "moov trak tkhd").box;
  expect(u32At(file, tkhd.body + 4 + 16)).toBe(250);  // ms, on the movie clock
});

test("the VP9 fallback is the same file with a different sample entry", () => {
  const samples = fakeSamples([30, 11, 6], [0]);
  const file = concat(muxMp4({ width: 760, height: 500, samples,
    entry: "vp09", vp9: vp9Params("vp09.00.41.08") }));

  const top = boxes(file);
  expect(Object.keys(top)).toEqual(["ftyp", "mdat", "moov"]);
  // the avc1 brand would be a lie about what is inside
  expect(String.fromCharCode(...file.slice(top.ftyp.body + 8, top.ftyp.body + 12))).not.toBe("avc1");

  const stbl = find(file, "moov trak mdia minf stbl").children;
  const vp09 = find(file, "vp09", stbl.stsd.body + 8, stbl.stsd.end).box;
  const dv = new DataView(file.buffer, file.byteOffset, file.byteLength);
  expect(dv.getUint16(vp09.body + 24)).toBe(760);
  expect(dv.getUint16(vp09.body + 26)).toBe(500);
  // vpcC restates the codec string: profile 0, level 4.1, 8-bit
  const vpcC = find(file, "vpcC", vp09.body + 78, vp09.end).box;
  const rec = file.slice(vpcC.body + 4, vpcC.end);
  expect(rec[0]).toBe(0);
  expect(rec[1]).toBe(41);
  expect(rec[2] >> 4).toBe(8);

  // the tables do not care which codec wrote the samples
  const stco = stbl.stco.body + 4;
  expect(u32At(file, stco)).toBe(3);
  expect(u32At(file, stco + 4)).toBe(top.mdat.body);
});

test("a file with no samples or no description is refused, not written empty", () => {
  const d = new Uint8Array([1, 2, 3]);
  expect(() => muxMp4({ width: 16, height: 16, samples: [], description: d })).toThrow();
  expect(() => muxMp4({ width: 16, height: 16, samples: fakeSamples([4], [0]) })).toThrow();
  // VP9 without its configuration record, and a codec that is neither
  expect(() => muxMp4({ width: 16, height: 16, samples: fakeSamples([4], [0]), entry: "vp09" }))
    .toThrow();
  expect(() => muxMp4({ width: 16, height: 16, samples: fakeSamples([4], [0]),
    description: d, entry: "hev1" })).toThrow();
});

test("H.264 is what is tried first, whatever else is on offer", () => {
  // an .mp4 is expected to hold H.264, and it is the only codec here that
  // every player and editor opens — the VP9 entries exist so that a browser
  // without an H.264 *encoder* gets a file rather than an error
  const kinds = VIDEO_CODECS.map((c) => c.entry);
  expect(kinds[0]).toBe("avc1");
  expect(kinds.lastIndexOf("avc1")).toBeLessThan(kinds.indexOf("vp09"));
  expect(kinds).toContain("vp09");
  expect(vp9Params("vp09.00.41.08")).toEqual({ profile: 0, level: 41, bitDepth: 8 });
});

// ---- the frames themselves ----------------------------------------

test("consecutive video phases are genuinely different water", () => {
  const L = RASTER_LEVELS[0];
  const plan = framePlan(1, GRAZING_RIPPLES.speed);
  const at = (t) => {
    const { S, fieldSpec } = buildScene({ ...GRAZING_RIPPLES, manualTime: t });
    return buildSolid3D(S, fieldSpec, { gN: L.gN, BW: L.BW }).layers.map((l) => l.d);
  };
  const first = at(plan.phaseAt(0));
  const later = at(plan.phaseAt(4));               // a fifth of a second on
  expect(later.length).toBe(first.length);          // same bands, moved water
  expect(later.join("")).not.toBe(first.join(""));
}, 240000);

// ---- the panel -----------------------------------------------------

test("the export offers a length and says what it will cost, and jsdom cannot encode", async () => {
  expect(videoSupported()).toBe(false);            // no WebCodecs here

  render(<App />);
  expect(screen.getByText(/3\.0 s · 60 frames/)).toBeInTheDocument();
  expect(screen.getByText(/1140 × 750/)).toBeInTheDocument();

  const btn = screen.getByRole("button", { name: /^Export MP4/ });
  fireEvent.click(btn);
  await waitFor(() => expect(screen.getByText(/no video encoder/i)).toBeInTheDocument(),
    { timeout: 60000 });
  expect(screen.getByRole("button", { name: /^Export MP4/ })).toBeEnabled();
}, 120000);
