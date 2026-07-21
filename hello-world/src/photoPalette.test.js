import * as d3 from "d3";
import { extractPhotoStrip, kmeansLab, measurePhotoStats, sceneFromStats,
  analyzePhoto } from "./photoPalette";

// build an ImageData-like object from a list of horizontal bands:
// [{ color: "#rrggbb", rows: N }, ...] top to bottom, with optional
// deterministic per-pixel noise so clustering has real work to do
function syntheticImage(bands, width = 40, noise = 0) {
  const height = bands.reduce((s, b) => s + b.rows, 0);
  const data = new Uint8ClampedArray(width * height * 4);
  let r = 0, seed = 42;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff - 0.5;
  };
  for (const b of bands) {
    const c = d3.rgb(b.color);
    for (let y = r; y < r + b.rows; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        data[i] = Math.max(0, Math.min(255, c.r + rand() * noise));
        data[i + 1] = Math.max(0, Math.min(255, c.g + rand() * noise));
        data[i + 2] = Math.max(0, Math.min(255, c.b + rand() * noise));
        data[i + 3] = 255;
      }
    }
    r += b.rows;
  }
  return { data, width, height };
}

const labDist = (a, b) => {
  const ca = d3.lab(a), cb = d3.lab(b);
  return Math.hypot(ca.l - cb.l, ca.a - cb.a, ca.b - cb.b);
};

describe("kmeansLab", () => {
  it("recovers well-separated clusters", () => {
    const pts = [];
    for (let i = 0; i < 50; i++) pts.push([10 + (i % 5) * 0.1, 0, 0]);
    for (let i = 0; i < 50; i++) pts.push([80 + (i % 5) * 0.1, 20, -20]);
    const { centers, labels } = kmeansLab(pts, 2);
    expect(centers).toHaveLength(2);
    // every point in one input blob got the same label
    expect(new Set(labels.slice(0, 50)).size).toBe(1);
    expect(new Set(labels.slice(50)).size).toBe(1);
    expect(labels[0]).not.toBe(labels[50]);
  });

  it("is deterministic", () => {
    const pts = d3.range(200).map((i) => [i % 90, (i * 7) % 40 - 20, (i * 13) % 50 - 25]);
    const a = kmeansLab(pts, 4);
    const b = kmeansLab(pts, 4);
    expect(a.centers).toEqual(b.centers);
    expect(Array.from(a.labels)).toEqual(Array.from(b.labels));
  });
});

describe("extractPhotoStrip", () => {
  const BANDS = [
    { color: "#dfe8ef", rows: 20 },  // pale sky glints (top = horizon end)
    { color: "#6a8a64", rows: 30 },  // sage green
    { color: "#10301d", rows: 30 },  // dark treeline reflection (bottom)
  ];

  it("orders the strip top-of-photo -> horizon, bottom -> zenith", () => {
    const { strip } = extractPhotoStrip(syntheticImage(BANDS, 40, 10), 3);
    expect(strip).toHaveLength(64);
    expect(labDist(strip[0], "#dfe8ef")).toBeLessThan(6);
    expect(labDist(strip[63], "#10301d")).toBeLessThan(6);
    expect(labDist(strip[32], "#6a8a64")).toBeLessThan(6);
  });

  it("keeps band widths proportional to the photo's rows", () => {
    const { strip } = extractPhotoStrip(syntheticImage(BANDS, 40, 10), 3);
    const first = strip[0];
    const firstRun = strip.findIndex((c) => c !== first);
    // 20 of 80 rows -> about a quarter of the 64 cells
    expect(firstRun).toBeGreaterThanOrEqual(12);
    expect(firstRun).toBeLessThanOrEqual(20);
  });

  it("collapses to the distinct colors when k exceeds them", () => {
    const { strip, swatches } = extractPhotoStrip(syntheticImage(BANDS, 40, 2), 5);
    // noise is tiny, so extra clusters split bands into near-identical hexes;
    // the strip must still be three visually distinct runs top to bottom
    expect(labDist(strip[0], "#dfe8ef")).toBeLessThan(6);
    expect(labDist(strip[63], "#10301d")).toBeLessThan(6);
    expect(swatches.length).toBeGreaterThanOrEqual(3);
    expect(swatches.length).toBeLessThanOrEqual(5);
  });

  it("orders swatches horizon -> zenith and picks the darkest deep color", () => {
    const { swatches, deep } = extractPhotoStrip(syntheticImage(BANDS, 40, 10), 3);
    expect(labDist(swatches[0], "#dfe8ef")).toBeLessThan(6);
    expect(labDist(swatches[swatches.length - 1], "#10301d")).toBeLessThan(6);
    expect(labDist(deep, "#10301d")).toBeLessThan(6);
  });

  it("interleaves colors that are mixed within rows", () => {
    // every row is half glint, half green — like sun glitter threaded
    // through a reflection. The strip must carry BOTH colors as
    // alternating runs in roughly equal measure, not flatten to one.
    const width = 40, height = 80;
    const data = new Uint8ClampedArray(width * height * 4);
    const a = d3.rgb("#dfe8ef"), b = d3.rgb("#10301d");
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const c = (x + y) % 2 ? a : b; // checker: every row a 50/50 mix
        const i = (y * width + x) * 4;
        data[i] = c.r; data[i + 1] = c.g; data[i + 2] = c.b; data[i + 3] = 255;
      }
    }
    const { strip } = extractPhotoStrip({ data, width, height }, 2);
    const nearA = strip.filter((c) => labDist(c, "#dfe8ef") < 6).length;
    const nearB = strip.filter((c) => labDist(c, "#10301d") < 6).length;
    expect(nearA + nearB).toBe(64);
    expect(nearA).toBeGreaterThanOrEqual(24);
    expect(nearB).toBeGreaterThanOrEqual(24);
    let runs = 1;
    for (let i = 1; i < strip.length; i++) if (strip[i] !== strip[i - 1]) runs++;
    expect(runs).toBeGreaterThanOrEqual(10); // alternating, not two blocks
  });

  it("survives a photo shorter than the strip", () => {
    const { strip } = extractPhotoStrip(syntheticImage(
      [{ color: "#dfe8ef", rows: 10 }, { color: "#10301d", rows: 10 }], 30, 5), 2);
    expect(strip).toHaveLength(64);
    expect(labDist(strip[0], "#dfe8ef")).toBeLessThan(6);
    expect(labDist(strip[63], "#10301d")).toBeLessThan(6);
  });

  it("returns null for an empty image", () => {
    expect(extractPhotoStrip({ data: new Uint8ClampedArray(0), width: 0, height: 0 }, 4))
      .toBeNull();
  });
});

// label grid + fake Lab array (L follows the labels) for stats tests
function statsInput(fn, w, h) {
  const labels = new Int32Array(w * h);
  const labs = new Array(w * h);
  for (let r = 0; r < h; r++) {
    for (let x = 0; x < w; x++) {
      const v = fn(x, r);
      labels[r * w + x] = v;
      labs[r * w + x] = [v * 60 + 20, 0, 0];
    }
  }
  return { labs, labels };
}

describe("measurePhotoStats", () => {
  it("measures blob width and near/far growth", () => {
    // stripes 2px wide in the top half, 8px wide in the bottom half
    const w = 64, h = 64;
    const { labs, labels } = statsInput(
      (x, r) => (r < h / 2 ? Math.floor(x / 2) % 2 : Math.floor(x / 8) % 2), w, h);
    const s = measurePhotoStats(labs, labels, w, h);
    expect(s.blobFrac).toBeCloseTo(8 / 64, 1);
    expect(s.growth).toBeGreaterThan(2.5);
    expect(s.growth).toBeLessThan(5);
  });

  it("reads horizontal streaks as high anisotropy with a ~90° gradient", () => {
    const w = 64, h = 64;
    const { labs, labels } = statsInput((x, r) => Math.floor(r / 2) % 2, w, h);
    const s = measurePhotoStats(labs, labels, w, h);
    expect(s.aniso).toBeGreaterThan(8);
    expect(Math.abs(s.angle - 90)).toBeLessThan(5);
    expect(s.coherence).toBeGreaterThan(0.9);
  });

  it("reads round blobs as low anisotropy and low coherence", () => {
    const w = 64, h = 64;
    const { labs, labels } = statsInput(
      (x, r) => (Math.floor(x / 4) + Math.floor(r / 4)) % 2, w, h);
    const s = measurePhotoStats(labs, labels, w, h);
    expect(s.aniso).toBeGreaterThan(0.7);
    expect(s.aniso).toBeLessThan(1.5);
    expect(s.coherence).toBeLessThan(0.3);
  });
});

describe("sceneFromStats", () => {
  const base = { blobFrac: 0.2, growth: 1, aniso: 1, angle: 90, coherence: 0 };

  it("maps bigger blobs to a longer wavelength, respecting slider bounds", () => {
    const small = sceneFromStats({ ...base, blobFrac: 0.05 });
    const big = sceneFromStats({ ...base, blobFrac: 0.5 });
    expect(small.wavelength).toBeLessThan(big.wavelength);
    expect(small.wavelength).toBeGreaterThanOrEqual(0.6);
    expect(big.wavelength).toBeLessThanOrEqual(7);
  });

  it("maps stronger near-to-far shrink to a lower (grazing) pitch", () => {
    const flat = sceneFromStats({ ...base, growth: 1 });
    const grazing = sceneFromStats({ ...base, growth: 4 });
    expect(grazing.pitchDeg).toBeLessThan(flat.pitchDeg);
    expect(grazing.pitchDeg).toBeGreaterThanOrEqual(6);
    expect(flat.pitchDeg).toBeLessThanOrEqual(50);
  });

  it("maps streakiness to strength and sharpness within slider ranges", () => {
    const calm = sceneFromStats({ ...base, aniso: 1 });
    const streaky = sceneFromStats({ ...base, aniso: 6 });
    expect(streaky.strength).toBeGreaterThan(calm.strength);
    expect(streaky.strength).toBeLessThanOrEqual(1);
    expect(streaky.sharp).toBeGreaterThan(calm.sharp);
    expect(streaky.sharp).toBeLessThanOrEqual(0.7);
  });

  it("only rotates the heading when the orientation is coherent", () => {
    expect(sceneFromStats({ ...base, angle: 70, coherence: 0.1 }).dirOffset).toBe(0);
    expect(sceneFromStats({ ...base, angle: 70, coherence: 0.8 }).dirOffset).toBeCloseTo(20);
    expect(sceneFromStats({ ...base, angle: 90, coherence: 0.8 }).dirOffset).toBeCloseTo(0);
  });

  it("mutes the swell for directionless chop, keeps it for coherent stripes", () => {
    expect(sceneFromStats({ ...base, coherence: 0.1 }).swellMix).toBe(0);
    expect(sceneFromStats({ ...base, coherence: 0.7 }).swellMix).toBe(1);
    const mid = sceneFromStats({ ...base, coherence: 0.35 }).swellMix;
    expect(mid).toBeGreaterThan(0.2);
    expect(mid).toBeLessThan(0.8);
  });
});

describe("analyzePhoto", () => {
  it("returns palette and scene from one pass", () => {
    const img = syntheticImage([
      { color: "#dfe8ef", rows: 20 }, { color: "#6a8a64", rows: 30 },
      { color: "#10301d", rows: 30 }], 40, 10);
    const res = analyzePhoto(img, 3);
    expect(res.strip).toHaveLength(64);
    expect(res.scene.wavelength).toBeGreaterThanOrEqual(0.6);
    expect(res.scene.pitchDeg).toBeGreaterThanOrEqual(6);
    expect(res.stats.aniso).toBeGreaterThan(1); // pure horizontal bands
  });

  it("returns null for an empty image", () => {
    expect(analyzePhoto({ data: new Uint8ClampedArray(0), width: 0, height: 0 }, 4)).toBeNull();
  });
});
