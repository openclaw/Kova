import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { dev } from "astro";

const webRoot = fileURLToPath(new URL("../", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

test("the matrix renders empty, beta-only, and populated stable catalogs", { timeout: 120_000 }, async (t) => {
  const fixture = JSON.parse(await readFile(join(webRoot, "src/content/releases/2026.5.26.json"), "utf8"));
  for (const catalog of ["empty", "beta-only", "stable"] as const) {
    await t.test(catalog, async () => {
      const root = await mkdtemp(join(tmpdir(), "kova-matrix-page-"));
      const web = join(root, "web");
      let server: Awaited<ReturnType<typeof dev>> | undefined;
      try {
        await mkdir(web);
        await cp(join(webRoot, "src"), join(web, "src"), { recursive: true });
        await cp(join(webRoot, "public"), join(web, "public"), { recursive: true });
        for (const file of ["astro.config.mjs", "package.json", "tsconfig.json"]) {
          await cp(join(webRoot, file), join(web, file));
        }
        await mkdir(join(root, "src"));
        await cp(join(repoRoot, "src/web-payload-contract.mjs"), join(root, "src/web-payload-contract.mjs"));
        await symlink(join(repoRoot, "node_modules"), join(root, "node_modules"), "dir");
        await symlink(join(webRoot, "node_modules"), join(web, "node_modules"), "dir");
        const content = join(web, "src/content/releases");
        await rm(content, { recursive: true });
        await mkdir(content);
        if (catalog !== "empty") {
          const release = { ...fixture, ver: catalog === "beta-only" ? "2026.5.26-beta.1" : fixture.ver };
          await writeFile(join(content, `${release.ver}.json`), JSON.stringify(release));
        }
        server = await dev({ root: web, logLevel: "silent", server: { host: "127.0.0.1", port: 0 } });
        const response = await fetch(`http://127.0.0.1:${server.address.port}/matrix`);
        const html = await response.text();
        assert.equal(response.status, 200, html.slice(0, 2000));
        assert.match(html, /Matrix · all releases/);
        if (catalog === "stable") {
          assert.match(html, /2026\.5\.26/);
          assert.match(html, /12 scenarios · 1 release · 5 samples\/scenario/);
          assert.match(html, /0\.59/);
          assert.match(html, /1\.96/);
          assert.doesNotMatch(html, /No stable releases yet/);
        } else {
          assert.match(html, /No stable releases yet/);
          assert.match(html, /0 scenarios · 0 releases/);
          assert.doesNotMatch(html, /2026\.5\.26/);
        }
      } finally {
        await server?.stop();
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});
