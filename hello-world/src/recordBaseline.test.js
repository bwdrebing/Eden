// Not a test — the recorder for src/__fixtures__/segmentationBaseline.json,
// which backdropParity.test.js compares against. Skipped unless you ask for it:
//
//   EDEN_RECORD_BASELINE=1 CI=true npx react-scripts test \
//     --watchAll=false --testPathPattern recordBaseline
//
// Only run it when a change is MEANT to move the geometry, and only after the
// CLAUDE.md render gate — see the header of backdropParity.test.js.
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { buildSegmentation } from "./WaterReflectionContours";
import { paintedScene } from "./backdropScene";
import { compileBackdrop } from "./backdrop/compile";
import { docFromPanorama } from "./backdrop/document";

const sig = (s) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 16);

(process.env.EDEN_RECORD_BASELINE ? test : test.skip)("record", () => {
  const { S, env, azSpan } = paintedScene();
  const seg = buildSegmentation(S, compileBackdrop(docFromPanorama(env)), azSpan);
  const out = {
    note: process.env.EDEN_BASELINE_NOTE
      || "recorded from the pre-rearchitecture buildSegmentation; see backdropParity.test.js",
    bg: seg.bg,
    count: seg.count,
    twoD: seg.twoD,
    lo: +seg.lo.toFixed(6),
    hi: +seg.hi.toFixed(6),
    clipHash: sig(seg.clip),
    layers: seg.layers.map((l) => ({ color: l.color, len: l.d.length, hash: sig(l.d) })),
  };
  fs.writeFileSync(path.join(__dirname, "__fixtures__/segmentationBaseline.json"),
    JSON.stringify(out, null, 2) + "\n");
  expect(out.layers.length).toBeGreaterThan(0);
}, 300000);
