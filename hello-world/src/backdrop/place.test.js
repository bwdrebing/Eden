import { magFrac, rayAngles, makeSkyPlace } from "./place";

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
