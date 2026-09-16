// Reading an SVG into a backdrop layer: what comes out of the file, where it
// lands on the flat, and that it survives the trip through a URL.
import { parseSvg, rasterizeSvg, svgContent, fitSvgBox, tintSvg, simplifySvg,
  svgPointCount, parsePathData, MAX_SVG_PATHS } from "./svg";
import { encodeDoc, decodeDoc } from "./codec";
import { backdropDoc, flat, renderContent, kindLabel, docHasVector } from "./document";
import { compileBackdrop, COMPILE_SCALE } from "./compile";
import { render, screen, act, fireEvent, within } from "@testing-library/react";
import App from "../App";

const svg = (body, attrs = 'viewBox="0 0 100 100"') =>
  `<svg xmlns="http://www.w3.org/2000/svg" ${attrs}>${body}</svg>`;

// draw the content full-frame, so a grid cell is a fraction of the drawing
const full = (content) => ({ ...content, x: 0.5, y: 0, w: 1, h: 1 });

function grid(content, w = 20, h = 20) {
  const { cells } = rasterizeSvg(full(content), w, h, () => 0);
  return (col, row) => cells[row * w + col];
}

describe("parseSvg", () => {
  it("reads a filled rectangle and places it in the flat's own box", () => {
    // the top half of the viewBox, which is the TOP half of the flat too:
    // SVG counts y down from the top, a flat counts up from the waterline
    const res = parseSvg(svg('<rect x="0" y="0" width="100" height="50" fill="#204080"/>'));
    expect(res.error).toBeUndefined();
    expect(res.paths).toBe(1);
    expect(res.content.kind).toBe("svg");
    expect(res.content.paths[0].color).toBe("#204080");
    const at = grid(res.content);
    expect(at(10, 15)).toBe("#204080");     // upper rows
    expect(at(10, 4)).toBe(null);           // lower rows: nothing there
  });

  it("takes the aspect from the viewBox", () => {
    const res = parseSvg(svg("<rect width='200' height='50' fill='#000000'/>",
      'viewBox="0 0 200 50"'));
    expect(res.content.aspect).toBeCloseTo(4, 6);
  });

  it("applies transforms, including on a group", () => {
    const plain = parseSvg(svg('<rect x="0" y="0" width="20" height="20" fill="#111111"/>'));
    const moved = parseSvg(svg(
      '<g transform="translate(80 80)"><rect x="0" y="0" width="20" height="20" fill="#111111"/></g>'));
    const a = grid(plain.content), b = grid(moved.content);
    expect(a(1, 18)).toBe("#111111");       // top-left of the page = top-left, high row
    expect(a(18, 1)).toBe(null);
    expect(b(1, 18)).toBe(null);
    expect(b(18, 1)).toBe("#111111");       // bottom-right of the page = low row
  });

  it("keeps a hole under the even-odd rule", () => {
    const res = parseSvg(svg(
      '<path fill-rule="evenodd" fill="#c0c0c0" d="M10,10 H90 V90 H10 Z M35,35 H65 V65 H35 Z"/>'));
    expect(res.content.paths[0].even).toBe(true);
    const at = grid(res.content, 40, 40);
    expect(at(8, 20)).toBe("#c0c0c0");      // the ring
    expect(at(20, 20)).toBe(null);          // the counter
  });

  it("fills a nonzero path through its own overlap", () => {
    // the same two rings, wound the same way: nonzero fills the middle
    const res = parseSvg(svg(
      '<path fill="#c0c0c0" d="M10,10 H90 V90 H10 Z M35,35 H65 V65 H35 Z"/>'));
    expect(res.content.paths[0].even).toBe(false);
    expect(grid(res.content, 40, 40)(20, 20)).toBe("#c0c0c0");
  });

  it("turns a stroke into an outline rather than dropping the line", () => {
    const res = parseSvg(svg(
      '<line x1="0" y1="50" x2="100" y2="50" stroke="#ff0000" stroke-width="8"/>'));
    expect(res.error).toBeUndefined();
    const at = grid(res.content, 40, 40);
    expect(at(20, 20)).toBe("#ff0000");     // on the line
    expect(at(20, 4)).toBe(null);           // well off it
  });

  it("does not fill an open polyline", () => {
    const res = parseSvg(svg(
      '<polyline points="10,10 90,10 90,90" fill="#00ff00" stroke="none"/>'));
    expect(res.error).toBeDefined();
  });

  it("reads circles, ellipses and rounded rects", () => {
    for (const body of ['<circle cx="50" cy="50" r="40" fill="#123456"/>',
      '<ellipse cx="50" cy="50" rx="40" ry="30" fill="#123456"/>',
      '<rect x="10" y="10" width="80" height="80" rx="12" fill="#123456"/>']) {
      const res = parseSvg(svg(body));
      expect(res.error).toBeUndefined();
      expect(grid(res.content, 30, 30)(15, 15)).toBe("#123456");
    }
  });

  it("follows a <use> to what it points at", () => {
    const res = parseSvg(svg(
      '<defs><rect id="r" x="0" y="0" width="20" height="20" fill="#0a0b0c"/></defs>'
      + '<use href="#r" x="70" y="0"/>'));
    expect(res.error).toBeUndefined();
    expect(grid(res.content, 20, 20)(16, 18)).toBe("#0a0b0c");
  });

  it("averages a gradient down to the one colour a region can hold", () => {
    const res = parseSvg(svg(
      '<defs><linearGradient id="g"><stop stop-color="#000000"/>'
      + '<stop stop-color="#ffffff"/></linearGradient></defs>'
      + '<rect width="100" height="100" fill="url(#g)"/>'));
    expect(res.content.paths[0].color).toBe("#808080");
  });

  it("drops what it cannot show and says why", () => {
    expect(parseSvg("not an svg at all").error).toBeTruthy();
    expect(parseSvg(svg("<rect width='100' height='100' fill='none'/>")).error).toBeTruthy();
    expect(parseSvg(svg('<text x="10" y="10">Eden</text>')).error)
      .toMatch(/outlines/);
    expect(parseSvg(svg('<rect width="100" height="100" fill="#123456" opacity="0.01"/>')).error)
      .toBeTruthy();
    expect(parseSvg(svg('<rect width="100" height="100" fill="#123456" display="none"/>')).error)
      .toBeTruthy();
  });

  it("clips what the file's own frame hides", () => {
    // a backing slab far outside the artboard must not smear across the sky
    const res = parseSvg(svg(
      '<rect x="-4000" y="-4000" width="9000" height="3000" fill="#ff00ff"/>'
      + '<rect x="20" y="20" width="60" height="60" fill="#00ffff"/>'));
    expect(res.content.paths.every((p) => p.color !== "#ff00ff")).toBe(true);
  });

  it("holds the line on path and point counts", () => {
    const many = Array.from({ length: MAX_SVG_PATHS + 60 }, (_, i) =>
      `<rect x="${i % 90}" y="${(i * 7) % 90} " width="6" height="6" fill="#334455"/>`).join("");
    const res = parseSvg(svg(many));
    expect(res.paths).toBeLessThanOrEqual(MAX_SVG_PATHS);
    expect(res.dropped).toBeGreaterThan(0);
  });
});

describe("path data", () => {
  it("repeats an implicit command and closes on Z", () => {
    const { subs, open } = parsePathData("M0,0 10,0 10,10 Z");
    expect(subs).toHaveLength(1);
    expect(subs[0]).toEqual([0, 0, 10, 0, 10, 10]);
    expect(open[0]).toBe(false);
  });

  it("marks a path that was never closed as open", () => {
    expect(parsePathData("M0,0 L10,0").open[0]).toBe(true);
  });

  it("reflects the control point of a smooth curve", () => {
    const a = parsePathData("M0,0 C0,10 10,10 10,0 S20,-10 20,0", undefined, 100);
    const b = parsePathData("M0,0 C0,10 10,10 10,0 C10,-10 20,-10 20,0", undefined, 100);
    expect(a.subs[0]).toEqual(b.subs[0]);
  });

  it("flattens an arc into the ring", () => {
    const { subs } = parsePathData("M0,0 A10,10 0 0 1 20,0 Z", undefined, 1);
    expect(subs[0].length / 2).toBeGreaterThan(8);
    // sweep=1 is the positive angle direction, and SVG counts y down, so the
    // half circle bulges to negative y and only there
    const ys = subs[0].filter((_, i) => i % 2 === 1);
    expect(Math.min(...ys)).toBeCloseTo(-10, 1);
    expect(Math.max(...ys)).toBeCloseTo(0, 6);
  });
});

describe("a drawing in a document", () => {
  const drawing = () => parseSvg(svg(
    '<rect x="10" y="10" width="30" height="80" fill="#204080"/>'
    + '<circle cx="70" cy="40" r="20" fill="#e0d0a0"/>')).content;

  it("labels and scales like the other stated content", () => {
    const doc = backdropDoc([flat(drawing(), "Drawing")], 84, 52);
    expect(kindLabel(doc.flats[0].content)).toBe("svg · 2 paths");
    expect(docHasVector(doc)).toBe(true);
    expect(compileBackdrop(doc).scale).toBe(COMPILE_SCALE);
  });

  it("gives every path its own region, in the file's order", () => {
    const one = drawing();
    // both paths the same colour: under the old colour-keyed model they would
    // have fused into one region
    const tinted = tintSvg(one, "#204080");
    const compiled = compileBackdrop(backdropDoc([flat(tinted, "Drawing")], 84, 52));
    expect(compiled.count).toBeGreaterThanOrEqual(2);
  });

  it("renders through renderContent, so the preview sees it", () => {
    const cells = renderContent(full(drawing()), 40, 40);
    expect(cells.filter((c) => c === "#204080").length).toBeGreaterThan(20);
    expect(cells.filter((c) => c === "#e0d0a0").length).toBeGreaterThan(10);
  });

  it("round-trips through the URL", () => {
    const doc = backdropDoc([flat(drawing(), "Drawing")], 84, 52);
    const code = encodeDoc(doc);
    expect(code).toBeTruthy();
    const back = decodeDoc(code);
    const a = doc.flats[0].content, b = back.flats[0].content;
    expect(b.kind).toBe("svg");
    expect(b.paths).toHaveLength(a.paths.length);
    expect(b.paths[0].color).toBe(a.paths[0].color);
    expect(b.aspect).toBeCloseTo(a.aspect, 3);
    // the packing is 1/4096 of the flat, well under one contoured cell
    for (let k = 0; k < a.paths[0].subs[0].length; k++) {
      expect(b.paths[0].subs[0][k]).toBeCloseTo(a.paths[0].subs[0][k], 3);
    }
  });

  it("refuses a decoded drawing that is not one", () => {
    expect(decodeDoc(JSON.stringify({ v: 2, w: 84, h: 52,
      f: [{ n: "x", v: 1, k: "v", z: [0.5, 0, 1, 1, 1], i: [{ c: "112233", s: ["!!!!"] }] }] })))
      .toBe(null);
  });

  it("fits the box back to the file's proportions", () => {
    const one = { ...drawing(), h: 0.4, w: 0.9 };
    const fitted = fitSvgBox(one);
    expect(fitted.w / fitted.h).toBeCloseTo(one.aspect * (52 / 84), 5);
  });

  it("simplifies toward a link that fits", () => {
    const circle = parseSvg(svg('<circle cx="50" cy="50" r="45" fill="#112233"/>')).content;
    const coarse = simplifySvg(circle, 0.05);
    expect(svgPointCount(coarse)).toBeLessThan(svgPointCount(circle));
    expect(coarse.paths).toHaveLength(1);
  });

  it("keeps an empty drawing out of the document", () => {
    const empty = svgContent([], 1);
    expect(renderContent(empty, 8, 8).every((c) => c == null)).toBe(true);
  });
});

// ---- the panel -----------------------------------------------------
// The module above is covered on its own; this is the wiring — that choosing a
// file actually reaches the document, which is the half a saved scene depends on.
describe("importing a drawing in the studio", () => {
  // jsdom ships no 2D context, and the paint-2D canvas needs one to mount at
  // all. Only the two calls it makes are stubbed: nothing here asserts on what
  // the canvas draws, only on what the import put in the document.
  let realGetContext;
  beforeAll(() => {
    realGetContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function getContext() {
      return {
        createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
        putImageData: () => {},
      };
    };
  });
  afterAll(() => { HTMLCanvasElement.prototype.getContext = realGetContext; });

  test("a chosen file becomes a layer, and rides in the link", async () => {
    const { container } = render(<App />);
    fireEvent.click(screen.getByRole("tab", { name: /backdrop/i }));
    fireEvent.click(screen.getByRole("button", { name: /paint 2d/i }));

    const input = container.querySelector('input[type="file"][accept*="svg"]');
    expect(input).toBeTruthy();
    const file = new File([svg('<rect x="10" y="40" width="80" height="50" fill="#204080"/>')],
      "headland.svg", { type: "image/svg+xml" });
    await act(async () => {
      fireEvent.change(input, { target: { files: [file] } });
      await new Promise((r) => setTimeout(r, 0));
    });

    // the layer list names it after the file, and says what it holds
    expect(await screen.findByText("headland")).toBeInTheDocument();
    expect(screen.getByText(/svg · 1 path/)).toBeInTheDocument();
    // and the drawing's own panel is what the active layer shows
    expect(screen.getByRole("button", { name: /simplify/i })).toBeInTheDocument();

    await act(async () => { await new Promise(requestAnimationFrame); });
    const s = new URLSearchParams(window.location.search).get("s");
    const saved = JSON.parse(new TextDecoder().decode(
      Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0))));
    const back = decodeDoc(saved.reflection.bdoc);
    const drawing = back.flats.find((f) => f.content.kind === "svg");
    expect(drawing).toBeTruthy();
    expect(drawing.content.paths[0].color).toBe("#204080");
  }, 120000);   // mounting the studio renders the whole scene twice

  test("a file that holds no drawing says so and adds no layer", async () => {
    const { container } = render(<App />);
    fireEvent.click(screen.getByRole("tab", { name: /backdrop/i }));
    fireEvent.click(screen.getByRole("button", { name: /paint 2d/i }));
    const input = container.querySelector('input[type="file"][accept*="svg"]');
    // urlSettings.js caches the decoded slice in the module, so this studio
    // opens on whatever scene the test before it left — count rather than
    // assume an empty document
    const before = within(container).queryAllByText(/svg · /).length;
    await act(async () => {
      fireEvent.change(input, { target: { files: [
        new File(["<html>nope</html>"], "nope.svg", { type: "image/svg+xml" })] } });
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(await within(container).findByText(/could not be read as SVG/i)).toBeInTheDocument();
    expect(within(container).queryAllByText(/svg · /)).toHaveLength(before);
  }, 120000);
});
