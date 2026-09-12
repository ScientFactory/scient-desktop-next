// Real SVG/XML decoding and PNG encoding. No visible window, user data or clipboard writes.
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const require = NodeModule.createRequire(import.meta.url);
const STATE_ENV = "SCIENT_SVG_EXPORT_SMOKE_STATE";
const RENDERER_PROGRESS_PREFIX = "[scient-svg-export-smoke] ";

if (!process.versions.electron) {
  const state = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-svg-export-"));
  const environment = { ...process.env, [STATE_ENV]: state };
  delete environment.ELECTRON_RUN_AS_NODE;
  // Use the dependency runtime, never the Scient launcher or a user's app.
  // GitHub's Linux runner does not support Electron's OS sandbox. This flag
  // is limited to this disposable test process; renderer web security stays on.
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone regression harness has no Effect runtime.
  const args = NodeOS.platform() === "linux" && process.env.CI ? ["--no-sandbox"] : [];
  let result;
  try {
    result = NodeChildProcess.spawnSync(
      require("electron"),
      [...args, NodeURL.fileURLToPath(import.meta.url)],
      { env: environment, stdio: "inherit", timeout: 360_000, killSignal: "SIGTERM" },
    );
  } finally {
    // Electron and Vite keep files open inside userData while the child is
    // alive. The parent owns cleanup so removal begins only after child exit.
    NodeFS.rmSync(state, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}

async function withTimeout(promise, timeoutMs, describeTimeout) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(describeTimeout())), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function run() {
  const { app, BrowserWindow } = require("electron");
  const state = process.env[STATE_ENV];
  NodeAssert.ok(state, `Missing ${STATE_ENV}`);
  app.setPath("userData", state);
  app.dock?.hide();
  app.on("window-all-closed", () => {});
  const webRoot = NodeURL.fileURLToPath(new URL("../../web/", import.meta.url));
  const webRequire = NodeModule.createRequire(new URL("../../web/package.json", import.meta.url));
  let server;
  let window;
  let externalRequests = 0;
  let phase = "starting Vite";
  try {
    const { createServer } = await import(webRequire.resolve("vite"));
    server = await createServer({
      configFile: false,
      root: webRoot,
      logLevel: "error",
      appType: "custom",
      cacheDir: NodePath.join(state, "vite"),
      resolve: { alias: { "~": NodePath.join(webRoot, "src") } },
      server: { host: "127.0.0.1", port: 0 },
      optimizeDeps: { include: ["mermaid"] },
    });
    let savedImage = Buffer.alloc(0);
    let savedType = "image/svg+xml";
    server.middlewares.use("/__saved_svg", (request, response) => {
      if (request.method === "POST") {
        const chunks = [];
        request.on("data", (chunk) => chunks.push(chunk));
        request.on("end", () => {
          savedImage = Buffer.concat(chunks);
          savedType = request.headers["content-type"] ?? "image/svg+xml";
          response.end("ok");
        });
      } else {
        response.setHeader("Content-Type", savedType);
        response.end(savedImage);
      }
    });
    server.middlewares.use("/__external_image", (_request, response) => {
      externalRequests += 1;
      response.statusCode = 404;
      response.end();
    });
    server.middlewares.use("/__svg_export", (_request, response) => {
      response.setHeader("Content-Type", "text/html");
      response.setHeader(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; img-src 'self' blob: data: http: https:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; connect-src 'self' ws:",
      );
      response.end("<!doctype html><html><head><meta charset=utf-8></head><body></body></html>");
    });
    await withTimeout(server.listen(), 45_000, () => `Timed out while ${phase}`);
    phase = "loading the export corpus";
    const corpus = await NodeFSP.readFile(
      new URL("../../../docs/fixtures/scient-chat-diagrams.md", import.meta.url),
      "utf8",
    );
    const sources = [...corpus.matchAll(/^```mermaid[^\n]*\n([\s\S]*?)^```/gm)]
      .map((match) => match[1])
      .slice(0, -2);
    NodeAssert.ok(sources.length >= 13, "The export corpus must not silently disappear");
    phase = "waiting for Electron";
    await withTimeout(app.whenReady(), 30_000, () => `Timed out while ${phase}`);
    phase = "creating the Chromium renderer";
    window = new BrowserWindow({
      show: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    window.webContents.on("console-message", (details) => {
      const message = details.message;
      if (typeof message === "string" && message.startsWith(RENDERER_PROGRESS_PREFIX))
        phase = message.slice(RENDERER_PROGRESS_PREFIX.length);
    });
    await withTimeout(
      window.loadURL(`${server.resolvedUrls.local[0]}__svg_export`),
      30_000,
      () => `Timed out while ${phase}`,
    );
    phase = "starting renderer assertions";
    const rendererPromise = window.webContents.executeJavaScript(
      `(${async function (sources, progressPrefix) {
        const progress = (message) => console.info(`${progressPrefix}${message}`);
        progress("loading renderer modules");
        const { renderMermaidDiagram } = await import("/src/scient/diagrams/mermaidRuntime.ts");
        const { prepareSvgForExport, copyMermaidPng, downloadMermaidPng, downloadMermaidSvg } =
          await import("/src/scient/diagrams/mermaidExport.ts");
        const { copyStaticImage } = await import("/src/components/preview/staticImageActions.ts");
        const { loadCanvasImage } = await import("/src/scient/presentation/loadCanvasImage.ts");
        const check = (condition, message) => {
          if (!condition) throw new Error(message);
        };
        let copied;
        let downloaded;
        const blobs = new Map();
        const createObjectURL = URL.createObjectURL.bind(URL);
        const revokeObjectURL = URL.revokeObjectURL.bind(URL);
        URL.createObjectURL = (blob) => {
          const url = createObjectURL(blob);
          blobs.set(url, blob);
          return url;
        };
        URL.revokeObjectURL = (url) => {
          blobs.delete(url);
          revokeObjectURL(url);
        };
        // Capture only the output boundaries; serialization, decoding and canvas are real.
        window.desktopBridge = {
          copyPngToClipboard: async (bytes) => {
            copied = new Blob([bytes], { type: "image/png" });
          },
        };
        HTMLAnchorElement.prototype.click = function () {
          downloaded = { name: this.download, blob: blobs.get(this.href) };
        };
        const serializer = new XMLSerializer();
        const parse = (source) => new DOMParser().parseFromString(source, "image/svg+xml");
        async function pixels(blob) {
          const bytes = new Uint8Array(await blob.arrayBuffer());
          check(
            bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71,
            "Invalid PNG",
          );
          const image = await createImageBitmap(blob);
          const canvas = document.createElement("canvas");
          canvas.width = image.width;
          canvas.height = image.height;
          try {
            check(
              canvas.width <= 8192 &&
                canvas.height <= 8192 &&
                canvas.width * canvas.height <= 16777216,
              "PNG exceeds limits",
            );
            const ctx = canvas.getContext("2d");
            ctx.drawImage(image, 0, 0);
            const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
            let hash = 2166136261;
            for (const byte of data) hash = Math.imul(hash ^ byte, 16777619);
            return { hash, width: canvas.width, height: canvas.height };
          } finally {
            image.close();
            canvas.width = canvas.height = 1;
          }
        }
        const cases = [];
        for (const theme of ["light", "dark"])
          for (const [index, source] of sources.entries()) {
            progress(`rendering diagram ${theme}/${index + 1}/${sources.length}`);
            const { svg } = await renderMermaidDiagram(source, theme);
            downloadMermaidSvg(svg, "export-check", theme);
            check(downloaded.name === "export-check.svg", "Wrong SVG filename");
            const exported = await downloaded.blob.text();
            const parsed = parse(exported);
            check(!parsed.querySelector("parsererror"), `Invalid exported XML: ${theme}/${index}`);
            const original = new DOMParser().parseFromString(svg, "text/html").querySelector("svg");
            const comparison = parsed.documentElement.cloneNode(true);
            check(comparison.firstElementChild.localName === "style", "Export style missing");
            comparison.firstElementChild.remove();
            check(original.textContent === comparison.textContent, "Label text changed");
            const structure = (root) =>
              [root, ...root.querySelectorAll("*")].map((node) => [
                node.localName,
                node.namespaceURI,
                [...node.attributes]
                  // HTML parses a literal xmlns attribute differently from XML;
                  // compare the actual element namespaces, not their declarations.
                  .filter(
                    (attribute) =>
                      attribute.namespaceURI !== "http://www.w3.org/2000/xmlns/" &&
                      attribute.name !== "xmlns",
                  )
                  .map((attribute) => [
                    attribute.localName,
                    attribute.namespaceURI,
                    attribute.value,
                  ])
                  .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
              ]);
            const originalStructure = structure(original);
            const exportedStructure = structure(comparison);
            check(originalStructure.length === exportedStructure.length, "SVG elements changed");
            for (const [index, element] of originalStructure.entries())
              check(
                JSON.stringify(element) === JSON.stringify(exportedStructure[index]),
                `SVG structure changed: ${JSON.stringify(element)} -> ${JSON.stringify(exportedStructure[index])}`,
              );
            const math = parsed.querySelector("math");
            if (math)
              check(
                math.namespaceURI === "http://www.w3.org/1998/Math/MathML",
                "MathML namespace lost",
              );
            for (const div of parsed.querySelectorAll("foreignObject div"))
              check(div.namespaceURI === "http://www.w3.org/1999/xhtml", "HTML namespace lost");
            await copyMermaidPng(svg, theme);
            const png = await pixels(copied);
            progress(`checking PNG download ${theme}/${index + 1}/${sources.length}`);
            await downloadMermaidPng(svg, "export-check", theme);
            check(downloaded.name === "export-check.png", "Wrong PNG filename");
            check((await pixels(downloaded.blob)).hash === png.hash, "Copy and download diverged");
            // A valid PNG is insufficient: prove text/HTML labels actually painted.
            for (const label of parsed.querySelectorAll("foreignObject, text")) label.remove();
            await copyMermaidPng(serializer.serializeToString(parsed.documentElement), theme);
            check(
              (await pixels(copied)).hash !== png.hash,
              `Labels absent from PNG: ${theme}/${index}`,
            );
            await fetch("/__saved_svg", {
              method: "POST",
              body: new Blob([exported], { type: "image/svg+xml" }),
            });
            progress(`checking saved SVG copy ${theme}/${index + 1}/${sources.length}`);
            await copyStaticImage(`${location.origin}/__saved_svg`);
            await pixels(copied);
            cases.push(`${theme}/${index}`);
          }
        progress("checking SVG line breaks and Unicode");
        const breaks =
          '<svg viewBox="0 0 300 100"><foreignObject width="300" height="100"><div xmlns="http://www.w3.org/1999/xhtml">שלום &amp; α 😀<br>second&nbsp;line<br/>third</div></foreignObject></svg>';
        const parsed = parse(prepareSvgForExport(breaks, "light"));
        check(
          !parsed.querySelector("parsererror") && parsed.querySelectorAll("br").length === 2,
          "HTML line breaks did not become XML",
        );
        check(
          parsed.querySelector("div").textContent === "שלום & α 😀second\u00a0linethird",
          "Unicode or entities lost",
        );
        await copyMermaidPng(breaks, "light");
        await pixels(copied);
        let rejected = false;
        try {
          prepareSvgForExport("<svg><text>\u0001</text></svg>", "light");
        } catch {
          rejected = true;
        }
        check(rejected, "Invalid XML codepoint was exported");
        progress("checking bounded raster dimensions");
        await copyMermaidPng(
          '<svg viewBox="0 0 1000000 1000000"><rect width="1000000" height="1000000" fill="red"/></svg>',
          "light",
        );
        const bounded = await pixels(copied);
        // Native image mode must remain non-interactive, even for an arbitrary saved SVG.
        progress("checking untrusted SVG isolation");
        const untrusted = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><script>window.__exportScriptRan=true</script><foreignObject width="100" height="100"><div xmlns="http://www.w3.org/1999/xhtml"><img src="${location.origin}/__external_image" onerror="window.__exportScriptRan=true"/></div></foreignObject></svg>`;
        const image = await loadCanvasImage(new Blob([untrusted], { type: "image/svg+xml" }));
        const canvas = document.createElement("canvas");
        canvas.getContext("2d").drawImage(image, 0, 0);
        canvas.getContext("2d").getImageData(0, 0, 1, 1);
        canvas.width = canvas.height = 1;
        check(!window.__exportScriptRan, "SVG image executed code");
        progress("checking concurrent SVG decoding");
        await Promise.all(
          Array.from({ length: 24 }, async (_, index) => {
            const red = index % 2 ? 255 : 0;
            const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><foreignObject width="2" height="2"><div xmlns="http://www.w3.org/1999/xhtml" style="width:2px;height:2px;background:rgb(${red},0,0)"></div></foreignObject></svg>`;
            const image = await loadCanvasImage(new Blob([svg], { type: "image/svg+xml" }));
            const c = document.createElement("canvas");
            c.width = c.height = 2;
            try {
              const ctx = c.getContext("2d");
              ctx.drawImage(image, 0, 0);
              check(
                ctx.getImageData(0, 0, 1, 1).data[0] === red,
                "Concurrent SVG images crossed results",
              );
            } finally {
              c.width = c.height = 1;
            }
          }),
        );
        progress("checking raster image copy");
        const raster = document.createElement("canvas");
        raster.width = raster.height = 4;
        raster.getContext("2d").fillRect(0, 0, 4, 4);
        for (const type of ["image/png", "image/jpeg"]) {
          const blob = await new Promise((resolve) => raster.toBlob(resolve, type));
          await fetch("/__saved_svg", { method: "POST", body: blob });
          await copyStaticImage(`${location.origin}/__saved_svg`);
          const result = await pixels(copied);
          check(result.width === 4 && result.height === 4, "Raster image copy regressed");
        }
        raster.width = raster.height = 1;
        progress("renderer assertions complete");
        return {
          diagramThemeCases: cases.length,
          svgPngDownloadAndCopy: "passed",
          savedSvgCopy: "passed",
          concurrentSvgImages: 24,
          rasterCopy: "PNG and JPEG passed",
          bounded,
        };
      }.toString()})(${JSON.stringify(sources)}, ${JSON.stringify(RENDERER_PROGRESS_PREFIX)})`,
    );
    const results = await withTimeout(
      rendererPromise,
      180_000,
      () => `Chromium export smoke test timed out while ${phase}`,
    );
    NodeAssert.equal(externalRequests, 0, "SVG image fetched external resources");
    console.log(
      JSON.stringify(
        {
          ...results,
          electron: process.versions.electron,
          chromium: process.versions.chrome,
          externalRequests,
        },
        null,
        2,
      ),
    );
  } finally {
    phase = "closing the Chromium renderer";
    window?.destroy();
    if (server)
      await withTimeout(server.close(), 15_000, () => `Timed out while closing the Vite server`);
  }
}

void run().then(
  () => require("electron").app.exit(0),
  (error) => {
    console.error(error);
    require("electron").app.exit(1);
  },
);
