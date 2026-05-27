import { defineConfig, fontProviders } from "astro/config";

export default defineConfig({
  site: "https://kova.openclaw.dev",
  trailingSlash: "ignore",
  build: {
    format: "directory",
  },
  devToolbar: { enabled: false },

  // Self-hosted fonts via Fontsource (stable Fonts API in Astro 6+).
  // Astro generates optimized fallbacks, preload links, and exposes each
  // family as a CSS variable.
  fonts: [
    {
      provider: fontProviders.fontsource(),
      name: "Geist",
      cssVariable: "--font-sans",
      weights: ["400", "500", "600"],
      styles: ["normal"],
      subsets: ["latin"],
    },
    {
      provider: fontProviders.fontsource(),
      name: "Geist Mono",
      cssVariable: "--font-mono",
      weights: ["400", "500"],
      styles: ["normal"],
      subsets: ["latin"],
    },
  ],
});
