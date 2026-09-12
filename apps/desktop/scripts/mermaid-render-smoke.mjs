// Real Chromium regression test; no visible windows or user profile. On Linux use xvfb-run.
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const STATE_ENV = "SCIENT_MERMAID_SMOKE_STATE";
const RENDERER_PROGRESS_PREFIX = "[scient-mermaid-smoke] ";

if (!process.versions.electron) {
  const { resolveElectronBinaryPath } = await import("./electron-launcher.mjs");
  const state = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-mermaid-smoke-"));
  const environment = { ...process.env, [STATE_ENV]: state };
  delete environment.ELECTRON_RUN_AS_NODE;
  let result;
  try {
    result = NodeChildProcess.spawnSync(
      resolveElectronBinaryPath(),
      [NodeURL.fileURLToPath(import.meta.url)],
      { env: environment, stdio: "inherit", timeout: 420_000, killSignal: "SIGTERM" },
    );
  } finally {
    // Vite and Electron own files in userData until the child is gone. Keeping
    // profile cleanup in the parent prevents races with Electron shutdown.
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
  const { app, BrowserWindow } = NodeModule.createRequire(import.meta.url)("electron");
  const state = process.env[STATE_ENV];
  NodeAssert.ok(state, `Missing ${STATE_ENV}`);
  app.setPath("userData", state);
  app.dock?.hide();
  app.on("window-all-closed", () => {});
  const webRoot = NodeURL.fileURLToPath(new URL("../../web/", import.meta.url));
  const webRequire = NodeModule.createRequire(new URL("../../web/package.json", import.meta.url));
  let server;
  let window;
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
    server.middlewares.use("/__mermaid_smoke", (_request, response) => {
      response.setHeader("Content-Type", "text/html");
      response.end(
        "<!doctype html><html><head><title>Mermaid regression</title></head><body></body></html>",
      );
    });
    await withTimeout(server.listen(), 45_000, () => `Timed out while ${phase}`);
    phase = "loading the Mermaid fixture corpus";
    const markdown = await NodeFSP.readFile(
      new URL("../../../docs/fixtures/scient-chat-diagrams.md", import.meta.url),
      "utf8",
    );
    const fixtures = [...markdown.matchAll(/^```mermaid[^\n]*\n([\s\S]*?)^```/gm)].map(
      (match) => match[1],
    );
    NodeAssert.ok(fixtures.length >= 15, "Fixture corpus must not silently disappear");
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
      window.loadURL(`${server.resolvedUrls.local[0]}__mermaid_smoke`),
      30_000,
      () => `Timed out while ${phase}`,
    );
    phase = "starting renderer assertions";
    const rendererPromise = window.webContents.executeJavaScript(
      `(${async function (sources, progressPrefix) {
        const progress = (message) => console.info(`${progressPrefix}${message}`);
        progress("loading renderer modules");
        const {
          renderMermaidDiagram,
          MermaidRenderError,
          MERMAID_VERSION,
          getMermaidRuntimePromise,
        } = await import("/src/scient/diagrams/mermaidRuntime.ts");
        const { prepareSvgForExport, copyMermaidPng } =
          await import("/src/scient/diagrams/mermaidExport.ts");
        function check(condition, message) {
          if (!condition) throw new Error(message);
        }
        const output = [];
        const pngFailures = [];
        window.desktopBridge = {
          copyPngToClipboard: async (bytes) => {
            check(
              bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71,
              "PNG encoding failed",
            );
          },
        };
        // The corpus ends with the two deliberately invalid cases. Exercise a
        // failed render first, proving it does not poison the shared render queue.
        progress("checking native failures and queue recovery");
        for (const source of sources.slice(-2)) {
          let error;
          try {
            await renderMermaidDiagram(source, "light");
          } catch (cause) {
            error = cause;
          }
          check(error instanceof Error, "Malformed/empty source unexpectedly rendered");
          if (source.trim()) {
            check(
              error instanceof MermaidRenderError && error.details.includes("\n"),
              "Full parser diagnostic was lost",
            );
          }
        }
        for (const theme of ["light", "dark"]) {
          for (const [index, source] of sources.slice(0, -2).entries()) {
            progress(`rendering native corpus ${theme}/${index + 1}/${sources.length - 2}`);
            const { svg, diagramType } = await renderMermaidDiagram(source, theme);
            // Match the card's HTML insertion, not XML parsing. Both Mermaid
            // 11 and 12 serialize HTML <br> labels that render correctly here
            // but are not well-formed standalone XML (recorded below).
            const node = new DOMParser().parseFromString(svg, "text/html");
            check(!node.querySelector("script"), "Script survived strict rendering");
            const dimensions = node
              .querySelector("svg")
              .getAttribute("viewBox")
              ?.split(/[ ,]+/)
              .map(Number);
            check(
              dimensions?.length === 4 &&
                dimensions.every(Number.isFinite) &&
                dimensions[2] > 0 &&
                dimensions[3] > 0,
              `Invalid dimensions: ${theme}/${index}`,
            );
            const exported = new DOMParser().parseFromString(
              prepareSvgForExport(svg, theme),
              "image/svg+xml",
            );
            check(
              !exported.querySelector("parsererror"),
              `Invalid standalone SVG export: ${theme}/${index}`,
            );
            output.push(`${theme}: ${diagramType}`);
            try {
              await copyMermaidPng(svg, theme);
            } catch (error) {
              pngFailures.push(`${theme}/${index}: ${error.message}`);
            }
          }
        }
        // Stress duplicates, theme serialization and cache ID rebasing together.
        progress("checking concurrent native cache consumers");
        const copies = await Promise.all(
          Array.from({ length: 48 }, (_, index) =>
            renderMermaidDiagram(
              `flowchart LR\n A --> B\n%% stress ${Math.floor(index / 4)}`,
              index % 2 ? "dark" : "light",
            ),
          ),
        );
        const ids = new Set();
        for (const { svg } of copies) {
          const node = new DOMParser().parseFromString(svg, "image/svg+xml");
          for (const element of node.querySelectorAll("[id]")) {
            check(!ids.has(element.id), "Cached diagrams reused DOM ids");
            ids.add(element.id);
          }
        }
        const { default: mermaid } = await getMermaidRuntimePromise();
        const { recoveryFixtures, unrecoverableFixtures, userRegressionFixtures } =
          await import("/src/scient/diagrams/mermaidRecovery.fixtures.ts");
        const { planMermaidRecovery } = await import("/src/scient/diagrams/mermaidRecovery.ts");
        const recoveryTimings = [];
        progress("checking user regression fixtures");
        for (const theme of ["light", "dark"]) {
          for (const fixture of userRegressionFixtures) {
            let result;
            let failure;
            try {
              result = await renderMermaidDiagram(fixture.source, theme);
            } catch (error) {
              failure = error;
            }
            const status = failure ? "error" : result.recovery ? "recovered" : "native";
            check(
              status === fixture.status,
              `User regression: ${fixture.name}/${theme}: ${status}`,
            );
            if (status === "recovered")
              check(
                result.recovery.source ===
                  fixture.source.replace("branchz feature", "branch feature"),
                "Git recovery changed more than the command typo",
              );
          }
        }
        progress("checking qualified recovery fixtures");
        for (const theme of ["light", "dark"]) {
          for (const fixture of recoveryFixtures) {
            progress(`recovering ${fixture.name}/${theme}`);
            const start = performance.now();
            let rendered;
            try {
              rendered = await renderMermaidDiagram(fixture.source, theme);
            } catch (error) {
              try {
                await mermaid.parse(fixture.expected);
              } catch (candidateError) {
                throw new Error(
                  `${fixture.name}/${theme} candidate failed: ${candidateError.message}`,
                  { cause: candidateError },
                );
              }
              throw new Error(`${fixture.name}/${theme}: ${error.details ?? error.message}`, {
                cause: error,
              });
            }
            check(
              rendered.recovery?.source === fixture.expected,
              `Recovery mismatch: ${fixture.name}/${theme}`,
            );
            check(
              rendered.recovery.originalSource === fixture.source,
              "Recovery lost original source",
            );
            const svg = new DOMParser()
              .parseFromString(rendered.svg, "text/html")
              .querySelector("svg");
            const bounds = svg?.getAttribute("viewBox")?.split(/[ ,]+/).map(Number);
            check(
              bounds?.length === 4 &&
                bounds.every(Number.isFinite) &&
                bounds[2] > 0 &&
                bounds[3] > 0,
              `Invalid recovered SVG: ${fixture.name}`,
            );
            check(!svg.querySelector("script"), "Recovered SVG lost strict sanitization");
            recoveryTimings.push({
              name: fixture.name,
              theme,
              ms: Math.round(performance.now() - start),
            });
            const native = await renderMermaidDiagram(fixture.expected, theme);
            check(!native.recovery, `Already corrected source was changed: ${fixture.name}`);
            check(
              rendered.diagramType === native.diagramType,
              "Recovery changed the diagram family",
            );
            if (fixture.shape) {
              const diagram = await mermaid.mermaidAPI.getDiagramFromText(rendered.recovery.source);
              const node = diagram.db.getVertices().get("A");
              check(
                node.type === fixture.shape && node.text === fixture.label,
                `Recovery changed shape or text: ${fixture.name}`,
              );
            }
            if (["nested literal quotes", "escaped literal quotes"].includes(fixture.name)) {
              check(
                svg.textContent.includes('Click "Save" now'),
                "Recovered quotes changed the visible label",
              );
            }
            if (["parallel node expression", "edge ID expression"].includes(fixture.name)) {
              const diagram = await mermaid.mermaidAPI.getDiagramFromText(fixture.expected);
              const edges = diagram.db.getEdges();
              if (fixture.name === "parallel node expression") {
                check(
                  JSON.stringify(edges.map(({ start, end }) => [start, end])) ===
                    JSON.stringify([
                      ["A", "C"],
                      ["B", "C"],
                    ]),
                  "Recovery changed parallel graph connectivity",
                );
              } else
                check(
                  edges.length === 1 &&
                    edges[0].id === "e1" &&
                    edges[0].start === "A" &&
                    edges[0].end === "B",
                  "Recovery lost named edge identity",
                );
            }
            if (fixture.name === "class short arrow") {
              const diagram = await mermaid.mermaidAPI.getDiagramFromText(fixture.expected);
              const relations = diagram.db.getRelations();
              check(
                relations.length === 1 && relations[0].id1 === "A" && relations[0].id2 === "B",
                "Class recovery changed relation endpoints",
              );
            }
            if (fixture.name === "sequence fullwidth colon") {
              const diagram = await mermaid.mermaidAPI.getDiagramFromText(fixture.expected);
              const messages = diagram.db.getMessages();
              check(
                messages.length === 1 &&
                  messages[0].from === "A" &&
                  messages[0].to === "B" &&
                  messages[0].message === "Hello",
                "Sequence recovery changed message routing or content",
              );
            }
            if (fixture.name === "pie spaced label") {
              const diagram = await mermaid.mermaidAPI.getDiagramFromText(fixture.expected);
              const values = diagram.db.getSections();
              check(
                values.size === 2 &&
                  values.get("Small dogs") === 10 &&
                  values.get("Big cats") === 20,
                "Pie recovery changed labels or values",
              );
            }
            if (fixture.name === "pie dash separator") {
              const diagram = await mermaid.mermaidAPI.getDiagramFromText(fixture.expected);
              const values = diagram.db.getSections();
              check(
                values.size === 3 &&
                  values.get("Dogs") === 40 &&
                  values.get("Cats") === 35 &&
                  values.get("Birds") === 25,
                "Pie dash recovery changed labels or values",
              );
            }
          }
        }
        progress("checking deliberately unrecoverable fixtures");
        for (const source of unrecoverableFixtures) {
          let error;
          try {
            await renderMermaidDiagram(source, "light");
          } catch (cause) {
            error = cause;
          }
          check(error instanceof Error, `Ambiguous source unexpectedly recovered: ${source}`);
          if (source.startsWith("flowchart LR\nN0 -> N1"))
            check(
              error.details.startsWith("Parse error"),
              "Candidate resource failure replaced the original syntax diagnostic",
            );
        }
        // Each correction alone still fails. Success requires the full plan.
        const combined = recoveryFixtures.find(
          (fixture) => fixture.name === "multiple independent issues",
        );
        const plan = planMermaidRecovery(combined.source);
        for (const change of plan.edits) {
          const partial =
            combined.source.slice(0, change.start) +
            change.replacement +
            combined.source.slice(change.end);
          check(
            (await mermaid.parse(partial, { suppressErrors: true })) === false,
            "Combined fixture no longer proves multiple required fixes",
          );
        }
        const literal = await mermaid.mermaidAPI.getDiagramFromText(
          "flowchart LR\nA[Use -> operator] --> B",
        );
        check(
          literal.db.getVertices().get("A").text === "Use -> operator",
          "Recovery changed a literal operator",
        );
        const styled = await mermaid.mermaidAPI.getDiagramFromText(
          recoveryFixtures.find((fixture) => fixture.name === "comments and styles").expected,
        );
        check(
          styled.db.getVertices().get("B").text === "C4Context",
          "Recovery renamed an unrelated label",
        );
        check(
          styled.db.getVertices().get("A").text === "Read (local)",
          "Quoting changed label text",
        );
        const pie = await mermaid.mermaidAPI.getDiagramFromText(
          recoveryFixtures.find((fixture) => fixture.name === "pie Unicode").expected,
        );
        check(
          pie.db.getSections().get("שלום（עולם）") === 10,
          "Recovery changed Unicode label or value",
        );
        const recoveryCopies = await Promise.all(
          Array.from({ length: 48 }, (_, index) =>
            renderMermaidDiagram(combined.source, index % 2 ? "light" : "dark"),
          ),
        );
        check(
          new Set(recoveryCopies.map((copy) => copy.svg)).size === 48,
          "Recovered cache reused DOM IDs",
        );
        const scanStart = performance.now();
        progress("checking bounded recovery scanning");
        const stressSource =
          "flowchart LR\n" + "A[Read (local)] -> B\n".repeat(120) + "%% " + "x".repeat(45_000);
        for (let iteration = 0; iteration < 200; iteration += 1) planMermaidRecovery(stressSource);
        const scanMs = performance.now() - scanStart;
        check(scanMs < 5_000, `Recovery scanner exceeded generous stress ceiling: ${scanMs}ms`);
        check(pngFailures.length === 0, `PNG export failed: ${pngFailures.join("; ")}`);
        const config = mermaid.mermaidAPI.getConfig();
        check(
          config.layout === "dagre" && config.look === "classic",
          "Upgrade changed layout/look defaults",
        );
        check(config.securityLevel === "strict", "Strict mode was lost");
        // Frontmatter/comments before the declaration are valid: guidance must
        // not demand the diagram declaration be the literal first line.
        await renderMermaidDiagram(
          "---\ntitle: Metadata\n---\n%% comment\nflowchart LR\n A --> B",
          "light",
        );
        const untrusted = await renderMermaidDiagram(
          'flowchart LR\n A["<script>alert(1)</script>Safe"] --> B',
          "light",
        );
        check(
          !new DOMParser().parseFromString(untrusted.svg, "text/html").querySelector("script"),
          "Untrusted script survived rendering",
        );
        progress("renderer assertions complete");
        return {
          version: MERMAID_VERSION,
          fixtures: output,
          concurrentCopies: copies.length,
          pngFailures,
          recovery: {
            fixtures: recoveryTimings,
            declined: unrecoverableFixtures.length,
            concurrentCopies: recoveryCopies.length,
            scans: 200,
            scanMs: Math.round(scanMs),
          },
        };
      }.toString()})(${JSON.stringify(fixtures)}, ${JSON.stringify(RENDERER_PROGRESS_PREFIX)})`,
    );
    const results = await withTimeout(
      rendererPromise,
      240_000,
      () => `Chromium Mermaid smoke test timed out while ${phase}`,
    );
    console.log(JSON.stringify(results, null, 2));
  } finally {
    phase = "closing the Chromium renderer";
    window?.destroy();
    if (server)
      await withTimeout(server.close(), 15_000, () => `Timed out while closing the Vite server`);
  }
}

void run().then(
  () => NodeModule.createRequire(import.meta.url)("electron").app.exit(0),
  (error) => {
    console.error(error);
    NodeModule.createRequire(import.meta.url)("electron").app.exit(1);
  },
);
