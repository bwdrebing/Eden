// ------------------------------------------------------------------ //
//  Minimal MP4 (ISO base media) muxer for H.264 samples
//
//  WebCodecs will hand us encoded H.264 frames and the decoder description
//  that goes with them, but nothing in the browser will put those in a
//  container. This is that container, and only that: one video track, no
//  audio, no fragments, no edit lists — the smallest tree of boxes a player
//  will accept.
//
//    ftyp                  brands, so a player knows what it is looking at
//    mdat                  every sample's bytes, back to back
//    moov > trak > mdia    the tables that say where those bytes are, how
//                          big each one is, how long it lasts, and which
//                          ones can be seeked to
//
//  `mdat` is written before `moov` because the sample tables have to name
//  absolute file offsets, and those are only knowable once the samples are
//  laid out. Since `moov` comes last, its own size does not shift them.
//
//  Everything here is a plain function over byte arrays, so it is testable
//  without a codec: build a file from fabricated samples and walk the tree.
// ------------------------------------------------------------------ //

// The movie header keeps its own coarser clock; the track's media clock is
// what actually times the frames. 90kHz is the usual choice and divides
// every frame rate we offer exactly (20fps -> 4500 ticks).
export const MEDIA_TIMESCALE = 90000;
const MOVIE_TIMESCALE = 1000;

function str4(s) {
  return new Uint8Array([s.charCodeAt(0), s.charCodeAt(1), s.charCodeAt(2), s.charCodeAt(3)]);
}
function u16(n) {
  return new Uint8Array([(n >> 8) & 255, n & 255]);
}
function u32(n) {
  return new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
}
function u32s(list) {
  const out = new Uint8Array(list.length * 4);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < list.length; i++) dv.setUint32(i * 4, list[i] >>> 0);
  return out;
}
function zeros(n) {
  return new Uint8Array(n);
}

// A box is its own length, its four-character type, then its payload —
// which is usually more boxes. Children are byte arrays, already built.
function box(type, ...parts) {
  let len = 8;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  out.set(u32(len), 0);
  out.set(str4(type), 4);
  let o = 8;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
// A "full" box prefixes its payload with a version and 24 flag bits.
function fullBox(type, version, flags, ...parts) {
  return box(type, new Uint8Array([version, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255]),
    ...parts);
}

// the identity transform, in the 16.16 / 2.30 fixed point the spec uses
const UNITY_MATRIX = u32s([0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000]);

function mvhd(durationMs, nextTrackId) {
  return fullBox("mvhd", 0, 0,
    u32(0), u32(0),                       // created, modified (unset)
    u32(MOVIE_TIMESCALE), u32(durationMs),
    u32(0x00010000),                      // rate 1.0
    u16(0x0100),                          // volume 1.0
    zeros(2), zeros(8),                   // reserved
    UNITY_MATRIX, zeros(24),              // matrix, pre_defined
    u32(nextTrackId));
}

function tkhd(trackId, durationMs, width, height) {
  // flags 3 = track enabled + used in the presentation
  return fullBox("tkhd", 0, 3,
    u32(0), u32(0),
    u32(trackId), zeros(4), u32(durationMs),
    zeros(8),                             // reserved
    u16(0), u16(0),                       // layer, alternate group
    u16(0), zeros(2),                     // volume 0 (video), reserved
    UNITY_MATRIX,
    u32(width << 16), u32(height << 16)); // 16.16 display size
}

function mdhd(duration) {
  // 0x55C4 packs "und" into three 5-bit letters: the language is unset,
  // which is the honest answer for a track with no speech in it.
  return fullBox("mdhd", 0, 0,
    u32(0), u32(0), u32(MEDIA_TIMESCALE), u32(duration), u16(0x55c4), u16(0));
}

function hdlr() {
  return fullBox("hdlr", 0, 0,
    zeros(4), str4("vide"), zeros(12),
    new Uint8Array([...new TextEncoder().encode("VideoHandler"), 0]));
}

function dinf() {
  // one data reference, flagged self-contained: the samples are in this file
  return box("dinf", fullBox("dref", 0, 0, u32(1), fullBox("url ", 0, 1)));
}

// The sample entry a decoder reads before the first frame: the frame size,
// and the codec's own configuration record. The visual part is identical for
// every codec; only the trailing record differs — avcC (SPS/PPS, handed back
// by the encoder) for H.264, vpcC (a fixed handful of fields) for VP9.
function sampleEntry(type, width, height, config) {
  const name = new Uint8Array(32);
  return box(type,
    zeros(6), u16(1),                     // reserved, data reference index
    u16(0), u16(0), zeros(12),            // pre_defined, reserved
    u16(width), u16(height),
    u32(0x00480000), u32(0x00480000),     // 72dpi, both axes
    zeros(4), u16(1),                     // reserved, frame count
    name,                                 // compressor name (empty)
    u16(0x0018),                          // depth: colour, no alpha
    u16(0xffff),                          // pre_defined = -1
    config);
}

// VP9's configuration record. Unlike H.264 there is no bitstream header to
// carry over — the frames are self-describing — so this is just what the
// codec string already said, restated where a demuxer looks for it.
function vpcC(vp9) {
  return fullBox("vpcC", 1, 0, new Uint8Array([
    vp9.profile, vp9.level,
    ((vp9.bitDepth & 15) << 4) | (1 << 1),  // bit depth, 4:2:0 colocated, limited range
    1, 1, 1,                                // BT.709 primaries, transfer, matrix
    0, 0,                                   // no codec initialization data
  ]));
}

// Run-length the per-sample durations. A constant frame rate collapses to
// one entry; a dropped or stretched frame just adds another.
function stts(samples) {
  const runs = [];
  for (const s of samples) {
    const d = s.duration;
    const last = runs[runs.length - 1];
    if (last && last[1] === d) last[0]++;
    else runs.push([1, d]);
  }
  const flat = [];
  for (const [n, d] of runs) flat.push(n, d);
  return fullBox("stts", 0, 0, u32(runs.length), u32s(flat));
}

// Which samples a player may seek to. Every frame is stored, but only the
// keyframes can start a decode.
function stss(samples) {
  const keys = [];
  samples.forEach((s, i) => { if (s.keyFrame) keys.push(i + 1); });
  return fullBox("stss", 0, 0, u32(keys.length), u32s(keys));
}

function stbl(samples, offsets, width, height, entry) {
  // one sample per chunk keeps the offset table trivial and costs 4 bytes a
  // frame — nothing next to the frames themselves
  const sc = fullBox("stsc", 0, 0, u32(1), u32s([1, 1, 1]));
  const sz = fullBox("stsz", 0, 0, u32(0), u32(samples.length),
    u32s(samples.map((s) => s.data.length)));
  const big = offsets.length > 0 && offsets[offsets.length - 1] > 0xffffffff;
  const co = big
    ? fullBox("co64", 0, 0, u32(offsets.length), (() => {
        const out = new Uint8Array(offsets.length * 8);
        const dv = new DataView(out.buffer);
        // split by hand rather than through BigInt: an offset is a byte count
        // well inside the exact-integer range, and this stays ES5-plain
        offsets.forEach((v, i) => {
          dv.setUint32(i * 8, Math.floor(v / 4294967296));
          dv.setUint32(i * 8 + 4, v % 4294967296);
        });
        return out;
      })())
    : fullBox("stco", 0, 0, u32(offsets.length), u32s(offsets));
  return box("stbl",
    fullBox("stsd", 0, 0, u32(1), entry),
    stts(samples), stss(samples), sc, sz, co);
}

/**
 * Wrap encoded video samples in an MP4.
 *
 * @param width,height  coded frame size, in pixels
 * @param samples       [{ data: Uint8Array, keyFrame: boolean, duration }]
 *                      in decode order; duration is in MEDIA_TIMESCALE ticks
 * @param entry         "avc1" (H.264) or "vp09" (VP9)
 * @param description   the avcC record from the encoder's decoder config —
 *                      H.264 only, and required there
 * @param vp9           { profile, level, bitDepth } — VP9 only
 * @returns Uint8Array[] — the file, in the order the parts must be written
 *          (hand it straight to `new Blob(parts)`; nothing is copied twice)
 */
export function muxMp4({ width, height, samples, description, entry = "avc1", vp9 }) {
  if (!samples || !samples.length) throw new Error("no samples to mux");
  if (entry === "avc1" && (!description || !description.length))
    throw new Error("no avcC description");
  if (entry === "vp09" && !vp9) throw new Error("no VP9 configuration");
  if (entry !== "avc1" && entry !== "vp09") throw new Error("unknown sample entry " + entry);

  const stsdEntry = sampleEntry(entry, width, height,
    entry === "avc1" ? box("avcC", description) : vpcC(vp9));
  // the brands say what a player has to understand to open the file, so the
  // codec's own brand only belongs there when it is the codec inside
  const ftyp = box("ftyp", str4("isom"), u32(0x200),
    str4("isom"), str4("iso2"), str4(entry === "avc1" ? "avc1" : "mp41"), str4("mp41"));

  // mdat's payload starts 8 bytes into the box, which itself starts right
  // after ftyp — so every sample's absolute offset is known now.
  const payload = samples.reduce((n, s) => n + s.data.length, 0);
  const mdatHeader = new Uint8Array(8);
  mdatHeader.set(u32(payload + 8), 0);
  mdatHeader.set(str4("mdat"), 4);

  const offsets = [];
  let at = ftyp.length + 8;
  for (const s of samples) { offsets.push(at); at += s.data.length; }

  const duration = samples.reduce((n, s) => n + s.duration, 0);
  const durationMs = Math.round((duration / MEDIA_TIMESCALE) * MOVIE_TIMESCALE);

  const moov = box("moov",
    mvhd(durationMs, 2),
    box("trak",
      tkhd(1, durationMs, width, height),
      box("mdia", mdhd(duration), hdlr(),
        box("minf",
          fullBox("vmhd", 0, 1, u16(0), zeros(6)),
          dinf(),
          stbl(samples, offsets, width, height, stsdEntry)))));

  return [ftyp, mdatHeader, ...samples.map((s) => s.data), moov];
}
