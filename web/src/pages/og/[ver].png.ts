import type { APIRoute } from "astro";
import { allReleases } from "../../lib/releases";
import { cardSvg, releaseCard, svgToPng } from "../../lib/og-card";

export async function getStaticPaths() {
  const releases = await allReleases();
  return releases.map((r) => ({ params: { ver: r.ver }, props: { release: r } }));
}

export const GET: APIRoute = async ({ props }) => {
  const release = (props as { release: import("../../content.config").Release }).release;
  const svg = cardSvg(releaseCard(release));
  const png = svgToPng(svg);
  return new Response(png as unknown as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
};
