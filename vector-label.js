/**
 * Render UI copy as SVG images so iOS Safari won't offer Look Up / text selection.
 * Returns an <img> (vector data-URI) — not a live text node.
 */
export function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const VEC_STYLES = {
  brand: { fontSize: 44, fontWeight: 700, fontFamily: "Georgia, 'Times New Roman', serif", fill: "#f3efe6", tracking: -0.02 },
  tagline: { fontSize: 13, fontWeight: 600, fontFamily: "system-ui, -apple-system, sans-serif", fill: "rgba(243,239,230,0.62)", tracking: 0.02 },
  display: { fontSize: 52, fontWeight: 500, fontFamily: "Georgia, 'Times New Roman', serif", fill: "#f3efe6", tracking: -0.02 },
  solfege: { fontSize: 22, fontWeight: 500, fontFamily: "Georgia, 'Times New Roman', serif", fill: "#e8c97a", tracking: 0 },
  npLabel: { fontSize: 11, fontWeight: 700, fontFamily: "system-ui, -apple-system, sans-serif", fill: "rgba(243,239,230,0.62)", tracking: 0.14 },
  modeName: { fontSize: 19, fontWeight: 600, fontFamily: "Georgia, 'Times New Roman', serif", fill: "#f3efe6", tracking: 0 },
  modeHint: { fontSize: 12, fontWeight: 600, fontFamily: "system-ui, -apple-system, sans-serif", fill: "rgba(243,239,230,0.62)", tracking: 0 },
  chip: { fontSize: 13, fontWeight: 700, fontFamily: "system-ui, -apple-system, sans-serif", fill: "#ddd6c8", tracking: 0 },
  button: { fontSize: 14, fontWeight: 700, fontFamily: "system-ui, -apple-system, sans-serif", fill: "#f3efe6", tracking: 0 },
  pedal: { fontSize: 12, fontWeight: 700, fontFamily: "system-ui, -apple-system, sans-serif", fill: "rgba(243,239,230,0.62)", tracking: 0.08 },
  title: { fontSize: 20, fontWeight: 600, fontFamily: "Georgia, 'Times New Roman', serif", fill: "#f3efe6", tracking: 0 },
  body: { fontSize: 14, fontWeight: 600, fontFamily: "system-ui, -apple-system, sans-serif", fill: "rgba(243,239,230,0.72)", tracking: 0 },
  field: { fontSize: 11, fontWeight: 700, fontFamily: "system-ui, -apple-system, sans-serif", fill: "rgba(243,239,230,0.62)", tracking: 0.12 },
  octave: { fontSize: 13, fontWeight: 700, fontFamily: "system-ui, -apple-system, sans-serif", fill: "rgba(243,239,230,0.62)", tracking: 0.04 },
  key: { fontSize: 10, fontWeight: 700, fontFamily: "system-ui, -apple-system, sans-serif", fill: "rgba(16,24,20,0.45)", tracking: 0 },
  syncName: { fontSize: 16, fontWeight: 600, fontFamily: "Georgia, 'Times New Roman', serif", fill: "#f3efe6", tracking: 0 },
  syncHint: { fontSize: 12, fontWeight: 600, fontFamily: "system-ui, -apple-system, sans-serif", fill: "rgba(243,239,230,0.62)", tracking: 0 },
  hint: { fontSize: 12, fontWeight: 600, fontFamily: "system-ui, -apple-system, sans-serif", fill: "rgba(243,239,230,0.62)", tracking: 0 },
  close: { fontSize: 14, fontWeight: 700, fontFamily: "system-ui, -apple-system, sans-serif", fill: "#e8c97a", tracking: 0 },
  partName: { fontSize: 11, fontWeight: 700, fontFamily: "system-ui, -apple-system, sans-serif", fill: "rgba(243,239,230,0.62)", tracking: 0.06 },
  partNote: { fontSize: 16, fontWeight: 500, fontFamily: "Georgia, 'Times New Roman', serif", fill: "#f3efe6", tracking: 0 },
};

function measureVecWidth(text, fontSize, fontFamily, fontWeight, tracking = 0) {
  const canvas = measureVecWidth._c || (measureVecWidth._c = document.createElement("canvas"));
  const ctx = canvas.getContext("2d");
  ctx.font = `${fontWeight} ${fontSize}px ${fontFamily}`;
  const letterSpacing = fontSize * tracking;
  if (!letterSpacing) return Math.ceil(ctx.measureText(text).width);
  // Approximate tracking
  let w = 0;
  for (const ch of text) w += ctx.measureText(ch).width + letterSpacing;
  return Math.ceil(w - letterSpacing);
}

function buildVectorSvg(text, styleName, { maxWidth = null, align = "left" } = {}) {
  const style = VEC_STYLES[styleName] || VEC_STYLES.body;
  const lines = String(text).split("\n");
  const fontSize = style.fontSize;
  const lineHeight = Math.ceil(fontSize * 1.35);
  let contentWidth = 0;
  const lineWidths = lines.map((line) => {
    const w = measureVecWidth(line, fontSize, style.fontFamily, style.fontWeight, style.tracking);
    contentWidth = Math.max(contentWidth, w);
    return w;
  });
  const width = Math.max(1, maxWidth || contentWidth + 2);
  const height = Math.max(lineHeight, lines.length * lineHeight);
  const fill = style.fill;
  const letterSpacing = style.tracking ? ` letter-spacing="${(style.tracking * fontSize).toFixed(2)}"` : "";

  const textNodes = lines
    .map((line, i) => {
      let x = 0;
      if (align === "center") x = (width - lineWidths[i]) / 2;
      if (align === "right") x = width - lineWidths[i];
      const y = Math.round(fontSize * 0.92 + i * lineHeight);
      return `<text x="${Math.max(0, x).toFixed(1)}" y="${y}" font-family="${escapeXml(style.fontFamily)}" font-size="${fontSize}" font-weight="${style.fontWeight}" fill="${fill}"${letterSpacing}>${escapeXml(line)}</text>`;
    })
    .join("");

  return {
    svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${textNodes}</svg>`,
    width,
    height,
  };
}

export function setVectorLabel(el, text, styleName = "body", opts = {}) {
  if (!el) return;
  const label = text == null || text === "" ? " " : String(text);
  const { svg, width, height } = buildVectorSvg(label, styleName, opts);
  let img = el.querySelector(":scope > img.vec-label");
  if (!img) {
    el.textContent = "";
    img = document.createElement("img");
    img.className = "vec-label";
    img.alt = "";
    img.draggable = false;
    img.setAttribute("aria-hidden", "true");
    el.appendChild(img);
  }
  img.width = width;
  img.height = height;
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  // Keep accessible name on the host control / region
  if (el.tagName === "BUTTON" || el.getAttribute("role") === "option") {
    el.setAttribute("aria-label", label.replace(/\n/g, " "));
  } else {
    el.setAttribute("aria-label", label.replace(/\n/g, " "));
  }
}

function vectorizeButton(el, styleName = "chip") {
  if (!el || el.dataset.vectorized === "1") return;
  const label = el.textContent.trim().replace(/\s+/g, " ");
  el.dataset.vectorized = "1";
  setVectorLabel(el, label, styleName);
}

function wrapMultiline(text, maxChars) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (next.length > maxChars && line) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines.join("\n");
}

export function setVectorBody(el, text, styleName = "body", maxChars = 42) {
  setVectorLabel(el, wrapMultiline(text, maxChars), styleName);
}
