// ------------------------------------------------------------------ //
//  SVG -> pixels
//
//  The browser's own rasterizer, reached through an <img>. Moved out of
//  WaterReflectionContours.jsx unchanged so the sand studio's PNG export is
//  the same operation as the water's: the preview, with more pixels.
// ------------------------------------------------------------------ //

// An <img> needs the markup to state its own pixel size: a viewBox alone leaves
// the intrinsic size to the browser, which is where a 300x150 default comes
// from. Same string, same picture — only sized.
export function sizedSvg(svg, w, h) {
  return svg.replace(/^<svg /, `<svg width="${w}" height="${h}" `);
}

// SVG string -> a canvas holding it at w x h.
//
// The picture goes through an <img> rather than being redrawn onto the canvas
// by hand, so the browser's own SVG rasterizer resolves it — the same one that
// composites the preview, with the same antialiasing, fill rules and clips. The
// raster is therefore the preview with more pixels, not a second renderer's
// opinion of it. The markup references nothing external, so the data URL counts
// as same-origin and the canvas stays untainted (toBlob throws otherwise).
//
// `into` reuses a canvas across calls, which is what the video export wants:
// one allocation for a couple of hundred frames rather than one apiece.
export function svgToCanvas(svg, w, h, into) {
  return new Promise((resolve, reject) => {
    let canvas = into || null, ctx = null;
    try {
      if (!canvas) canvas = document.createElement("canvas");
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;
      ctx = canvas.getContext("2d");
    } catch (e) { ctx = null; }
    // no 2D context (jsdom, a locked-down sandbox) means no rasterizer at all —
    // fail here rather than waiting on an onload that is never coming
    if (!ctx) { reject(new Error("no canvas")); return; }
    const img = new Image();
    img.onload = () => {
      try {
        // a reused canvas still holds the frame before this one; anything the
        // new picture does not cover should read as empty, not as a ghost
        ctx.clearRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas);
      } catch (e) { reject(e); }
    };
    img.onerror = () => reject(new Error("svg decode failed"));
    img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(sizedSvg(svg, w, h));
  });
}

// SVG string -> PNG blob at w x h.
export function svgToPngBlob(svg, w, h) {
  return svgToCanvas(svg, w, h).then((canvas) => new Promise((resolve, reject) => {
    if (!canvas.toBlob) { reject(new Error("no canvas")); return; }
    try {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("png encode failed"))), "image/png");
    } catch (e) { reject(e); }
  }));
}
