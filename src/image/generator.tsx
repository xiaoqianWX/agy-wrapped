import satori from "satori";
import { Resvg, initWasm } from "@resvg/resvg-wasm";
import resvgWasm from "@resvg/resvg-wasm/index_bg.wasm";
import { WrappedTemplate } from "./template";
import type { WrappedStats } from "../types";
import { loadFonts } from "./fonts";
import { layout } from "./design-tokens";
import logoBase64 from "../../assets/images/antigravity-logo.base64.txt" with { type: "text" };

const LOGO_DATA_URL = `data:image/png;base64,${logoBase64.trim()}`;

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
