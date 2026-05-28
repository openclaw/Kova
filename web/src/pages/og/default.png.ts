import type { APIRoute } from "astro";
import { cardSvg, defaultCard, svgToPng } from "../../lib/og-card";

export const GET: APIRoute = async () => {
  const png = svgToPng(cardSvg(defaultCard));
  return new Response(png as unknown as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
};
