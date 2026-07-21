import * as d3 from "d3";
import { extractPhotoStrip, kmeansLab } from "./photoPalette";

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
