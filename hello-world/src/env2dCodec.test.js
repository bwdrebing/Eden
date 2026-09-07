import { encodeEnv2d, decodeEnv2d, MAX_PALETTE, MAX_CODE_LEN } from "./env2dCodec";

const stripes = (w, h, colors) => ({
  w, h,
  cells: Array.from({ length: w * h }, (_, p) => colors[Math.floor(p / w) % colors.length]),
});

describe("env2d URL codec", () => {
  test("round-trips a striped panorama exactly", () => {
    const env = stripes(84, 52, ["#9cc3e8", "#ffffff", "#27406b"]);
    const back = decodeEnv2d(encodeEnv2d(env));
    expect(back.w).toBe(84);
    expect(back.h).toBe(52);
    expect(back.cells).toEqual(env.cells);
  });

  test("round-trips hand-painted cells, including single-cell runs", () => {
    const env = stripes(12, 8, ["#112233", "#445566"]);
    env.cells[0] = "#ff0000";
    env.cells[37] = "#00ff00";
    env.cells[38] = "#112233";
    env.cells[env.cells.length - 1] = "#0000ff";
    const back = decodeEnv2d(encodeEnv2d(env));
    expect(back.cells).toEqual(env.cells);
  });

  test("a striped panorama encodes small enough to paste", () => {
    const code = encodeEnv2d(stripes(84, 52, ["#9cc3e8", "#ffffff", "#27406b", "#141d33"]));
    expect(code.length).toBeLessThan(600);
  });

  test("declines a panorama with more colors than the palette holds", () => {
    const w = 40, h = 40;
    const cells = Array.from({ length: w * h }, (_, p) =>
      "#" + (p % (MAX_PALETTE + 8) + 0x100000).toString(16).slice(0, 6));
    expect(encodeEnv2d({ w, h, cells })).toBeNull();
  });

  test("never returns a code past the length ceiling", () => {
    const code = encodeEnv2d(stripes(84, 52, ["#9cc3e8", "#ffffff"]));
    expect(code.length).toBeLessThanOrEqual(MAX_CODE_LEN);
  });

  test("normalizes color case so equal colors share one palette entry", () => {
    const env = { w: 2, h: 1, cells: ["#AABBCC", "#aabbcc"] };
    const code = encodeEnv2d(env);
    expect(code.split(".")[2]).toBe("aabbcc");
    expect(decodeEnv2d(code).cells).toEqual(["#aabbcc", "#aabbcc"]);
  });

  test("rejects junk instead of throwing", () => {
    for (const bad of ["", "nonsense", "2.2.aabbcc", "2.2.zzz.4*0", "2.2.aabbcc.3*0",
      "2.2.aabbcc.4*9", null, undefined, 42]) {
      expect(decodeEnv2d(bad)).toBeNull();
    }
  });

  test("declines malformed input instead of throwing", () => {
    expect(encodeEnv2d(null)).toBeNull();
    expect(encodeEnv2d({ w: 4, h: 4, cells: ["#000000"] })).toBeNull();
  });
});
