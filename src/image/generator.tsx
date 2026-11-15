import satori from "satori";
import { Resvg, initWasm } from "@resvg/resvg-wasm";
import resvgWasm from "@resvg/resvg-wasm/index_bg.wasm";
import { WrappedTemplate } from "./template";
import type { WrappedStats } from "../types";
import { loadFonts } from "./fonts";
import { layout } from "./design-tokens";

export interface GeneratedImage {
  /** Full resolution PNG buffer for saving/clipboard */
  fullSize: Buffer;
  /** Scaled PNG buffer for terminal display (75% of full size) */
  displaySize: Buffer;
}

export async function generateImage(stats: WrappedStats): Promise<GeneratedImage> {
  await initWasm(Bun.file(resvgWasm).arrayBuffer());

  const svg = await satori(<WrappedTemplate stats={stats} logoDataUrl={LOGO_DATA_URL} />, {
    width: layout.canvas.width,
    height: layout.canvas.height,
    fonts: await loadFonts(),
  });

  const [fullSize, displaySize] = [1, 0.75].map((v) => {
    const resvg = new Resvg(svg, {
      fitTo: {
        mode: "zoom",
        value: v,
      },
    });
    return Buffer.from(resvg.render().asPng());
  });

  return { fullSize, displaySize };
}

// Original mark (not Google's Antigravity icon): a chevron lifting off through an orbit.
const LOGO_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="12 12 104 104">
  <defs>
    <linearGradient id="lift" x1="0" y1="1" x2="0" y2="0">
      <stop offset="0" stop-color="#22D3EE"/>
      <stop offset="0.55" stop-color="#A78BFA"/>
      <stop offset="1" stop-color="#F472B6"/>
    </linearGradient>
  </defs>
  <ellipse cx="64" cy="78" rx="46" ry="15" fill="none" stroke="#2B2D63" stroke-width="6"/>
  <path d="M64 18 L98 70 L80 70 L64 46 L48 70 L30 70 Z" fill="url(#lift)"/>
  <path d="M64 58 L84 88 L70 88 L64 79 L58 88 L44 88 Z" fill="url(#lift)" opacity="0.65"/>
  <path d="M18 78 A46 15 0 0 0 110 78" fill="none" stroke="#22D3EE" stroke-width="6" stroke-linecap="round"/>
  <circle cx="26" cy="30" r="3" fill="#EEEDFF"/>
  <circle cx="104" cy="24" r="2.5" fill="#C9C6F2"/>
  <circle cx="108" cy="104" r="2" fill="#9C98D6"/>
</svg>
`.trim();

const LOGO_DATA_URL = `data:image/svg+xml;base64,${Buffer.from(LOGO_SVG).toString("base64")}`;
