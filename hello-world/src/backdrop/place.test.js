import { magFrac, rayAngles, makeSkyPlace, makePlanePlace, skyPlaceUnit, byDepth }
  from "./place";

const DEG = Math.PI / 180;
const dir = (elevDeg, azDeg) => {
  const e = elevDeg * DEG, a = azDeg * DEG;
  return [Math.cos(e) * Math.sin(a), Math.cos(e) * Math.cos(a), Math.sin(e)];
};

describe("ray angles", () => {
  test("straight up is the zenith, dead ahead is the horizon", () => {
    expect(rayAngles([0, 0, 1])[0]).toBeCloseTo(90, 6);
    expect(rayAngles([0, 1, 0])[0]).toBeCloseTo(0, 6);
    expect(rayAngles([0, 1, 0])[1]).toBeCloseTo(0, 6);
  });

  test("reads back the elevation and azimuth a direction was built from", () => {
    for (const [e, a] of [[0, 0], [12, -30], [45, 40], [-8, 17], [80, -75]]) {
      const [phi, psi] = rayAngles(dir(e, a));
      expect(phi).toBeCloseTo(e, 6);
      expect(psi).toBeCloseTo(a, 6);
    }
  });

  test("survives a direction whose z has drifted outside [-1, 1]", () => {
    expect(rayAngles([0, 0, 1 + 1e-12])[0]).toBeCloseTo(90, 6);
    expect(rayAngles([0, 0, -1.0000001])[0]).toBeCloseTo(-90, 6);
  });
});

describe("the sky flat", () => {
  const place = makeSkyPlace({ eLo: -5, eHi: 33, azSpan: 45, mag: 1, EW: 84, EH: 52 });

  test("the window's ends land on the grid's ends", () => {
    expect(place.row(-5)).toBeCloseTo(0, 9);
    expect(place.row(33)).toBeCloseTo(52, 9);
    expect(place.col(-45)).toBeCloseTo(0, 9);
    expect(place.col(45)).toBeCloseTo(84, 9);
  });

  test("the middle of the window is the middle of the grid", () => {
    expect(place.row(14)).toBeCloseTo(26, 9);
    expect(place.col(0)).toBeCloseTo(42, 9);
  });

  test("rays outside the window saturate on the edge cell", () => {
    // this is what makes paint above eHi smear over everything above it
    expect(place.row(60)).toBe(52);
    expect(place.row(-40)).toBe(0);
    expect(place.col(90)).toBe(84);
  });

  test("azimuth is clamped to the span before anything else sees it", () => {
    expect(place.clampAz(70)).toBe(45);
    expect(place.clampAz(-70)).toBe(-45);
    expect(place.clampAz(12)).toBe(12);
  });

  test("reflection detail compresses the window about its middle", () => {
    const zoomed = makeSkyPlace({ eLo: -5, eHi: 33, azSpan: 45, mag: 2, EW: 84, EH: 52 });
    expect(zoomed.row(14)).toBeCloseTo(26, 9);        // the middle stays put
    expect(zoomed.row(23.5)).toBeCloseTo(52, 9);      // half the window fills the grid
    expect(zoomed.row(4.5)).toBeCloseTo(0, 9);
  });

  test("magFrac at mag 1 is the identity", () => {
    for (const f of [0, 0.25, 0.5, 1]) expect(magFrac(f, 1)).toBe(f);
  });

  test("a zero-width window does not divide by zero", () => {
    const flat = makeSkyPlace({ eLo: 10, eHi: 10, azSpan: 45, mag: 1, EW: 84, EH: 52 });
    expect(Number.isFinite(flat.row(10))).toBe(true);
  });
});

describe("a flat at a finite distance", () => {
  const board = makePlanePlace({ distance: 10, width: 20, height: 6 });
  // a ray leaving the water at (x, y, 0) going up and away
  const ray = (dx, dy, dz) => {
    const n = Math.hypot(dx, dy, dz);
    return [dx / n, dy / n, dz / n];
  };

  test("a ray that reaches the board lands where the geometry says", () => {
    // straight ahead and gently up: 10 units out puts it 3 units up the board
    const hit = board.hit(0, 0, 0, ray(0, 1, 0.3));
    expect(hit).not.toBeNull();
    expect(hit[0]).toBeCloseTo(0.5, 6);         // dead centre across
    expect(hit[1]).toBeCloseTo(3 / 6, 6);       // 3 units up a 6-unit board
  });

  test("a ray that clears the top lands past the board, not nowhere", () => {
    // 45 degrees puts it 10 units up a 6-unit board. Being past an edge is an
    // edge, and edges want to be smooth, so the coordinate comes back as it is
    // and `edge` says how far outside it fell
    const over = board.hit(0, 0, 0, ray(0, 1, 1));
    expect(over[1]).toBeGreaterThan(1);
    expect(board.edge(over[0], over[1])).toBeLessThan(0);
    expect(board.edge(0.5, 0.5)).toBeGreaterThan(0);
  });

  test("a ray leaving from further out has further to fall", () => {
    // the parallax: the same direction from two places lands in two places
    const a = board.hit(0, 0, 0, ray(0, 1, 0.3));
    const b = board.hit(0, 5, 0, ray(0, 1, 0.3));
    expect(a[1]).toBeGreaterThan(b[1]);
  });

  test("the board slides across as the eye moves along the water", () => {
    const a = board.hit(-4, 0, 0, ray(0, 1, 0.2));
    const b = board.hit(4, 0, 0, ray(0, 1, 0.2));
    expect(a[0]).toBeLessThan(b[0]);
  });

  test("water beyond the board does not reflect it", () => {
    // this is the depth cue: not a fade, just a miss
    expect(board.hit(0, 20, 0, ray(0, 1, 0.5))).toBeNull();
  });

  test("a ray pointing back at the viewer never reaches it", () => {
    expect(board.hit(0, 0, 0, ray(0, -1, 0.5))).toBeNull();
    expect(board.hit(0, 0, 0, ray(1, 0, 0.5))).toBeNull();
  });

  test("a ray that misses to the side is off the board, smoothly", () => {
    const aside = board.hit(0, 0, 0, ray(3, 1, 0.5));
    expect(board.edge(aside[0], aside[1])).toBeLessThan(0);
  });

  test("the ray starts where the water actually is, not where it would be flat", () => {
    // with a lifted 3D surface the ray leaves the crest, not z = 0
    const flatWater = board.hit(0, 0, 0, ray(0, 1, 0.3));
    const onACrest = board.hit(0, 0, 1, ray(0, 1, 0.3));
    expect(onACrest[1]).toBeGreaterThan(flatWater[1]);
  });

  test("sorting puts the sky behind every board", () => {
    const places = [makePlanePlace({ distance: 8, width: 1, height: 1 }),
      skyPlaceUnit({ eLo: 0, eHi: 30, azSpan: 45 }),
      makePlanePlace({ distance: 40, width: 1, height: 1 })];
    expect(places.slice().sort(byDepth).map((p) => p.distance))
      .toEqual([Infinity, 40, 8]);
  });
});
