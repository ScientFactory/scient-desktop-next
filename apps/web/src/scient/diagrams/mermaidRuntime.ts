import { LRUCache } from "~/lib/lruCache";
import { dependencies } from "../../../package.json";
import {
  isMermaidSyntaxError,
  planMermaidRecovery,
  MAX_MERMAID_SOURCE_LENGTH,
  type MermaidRecovery,
} from "./mermaidRecovery";
export { MAX_MERMAID_SOURCE_LENGTH } from "./mermaidRecovery";

export const MERMAID_VERSION = dependencies.mermaid;

export type MermaidTheme = "light" | "dark";

export interface RenderedMermaidDiagram {
  readonly svg: string;
  readonly diagramType: string;
  readonly recovery?: MermaidRecovery;
}

const MAX_MERMAID_EDGES = 500;
const MAX_RENDER_CACHE_ENTRIES = 100;
const MAX_RENDER_CACHE_MEMORY_BYTES = 20 * 1024 * 1024;

interface CachedMermaidDiagram {
  readonly svgTemplate: string;
  readonly diagramType: string;
  readonly recovery?: MermaidRecovery;
}

let mermaidRuntimePromise: Promise<typeof import("mermaid")> | null = null;
let renderQueue: Promise<void> = Promise.resolve();
let renderSequence = 0;

const renderCache = new LRUCache<CachedMermaidDiagram>(
  MAX_RENDER_CACHE_ENTRIES,
  MAX_RENDER_CACHE_MEMORY_BYTES,
);
const inFlightRenders = new Map<string, Promise<CachedMermaidDiagram>>();

/** Mermaid is a large dependency, so it is requested only after a settled diagram enters view. */
export function getMermaidRuntimePromise(): Promise<typeof import("mermaid")> {
  mermaidRuntimePromise ??= import("mermaid");
  return mermaidRuntimePromise;
}

function nextRenderId(prefix: string): string {
  renderSequence += 1;
  return `scient-${prefix}-${renderSequence.toString(36)}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Cached Mermaid SVGs contain document-level ids for markers, masks, and
 * accessibility labels. Rebase every id and its fragment/list references so
 * two copies of the same diagram can coexist without cross-wiring their SVGs.
 */
export function rebaseMermaidSvgIds(svg: string, prefix: string): string {
  const idPattern = /\bid=(['"])([^'"\s<>]+)\1/g;
  const replacements = new Map<string, string>();
  let match: RegExpExecArray | null;
  let index = 0;

  while ((match = idPattern.exec(svg)) != null) {
    const currentId = match[2];
    if (currentId && !replacements.has(currentId)) {
      replacements.set(currentId, `${prefix}-${index.toString(36)}`);
      index += 1;
    }
  }

  if (replacements.size === 0) return svg;

  let rebased = svg.replace(idPattern, (fullMatch, quote: string, currentId: string) => {
    const replacement = replacements.get(currentId);
    return replacement == null ? fullMatch : `id=${quote}${replacement}${quote}`;
  });

  for (const [currentId, replacement] of replacements) {
    const fragmentPattern = new RegExp(`#${escapeRegExp(currentId)}(?![\\w:.-])`, "g");
    rebased = rebased.replace(fragmentPattern, `#${replacement}`);
  }

  const listReferencePattern = /\b(aria-labelledby|aria-describedby)=(["'])([^"']*)\2/g;
  rebased = rebased.replace(
    listReferencePattern,
    (fullMatch, attribute: string, quote: string, value: string) => {
      const tokens = value.split(/\s+/).map((token) => replacements.get(token) ?? token);
      return `${attribute}=${quote}${tokens.join(" ")}${quote}`;
    },
  );

  return rebased;
}

function validateSource(source: string): string {
  if (source.trim().length === 0) {
    throw new Error("The diagram source is empty.");
  }
  if (source.length > MAX_MERMAID_SOURCE_LENGTH) {
    throw new Error(
      `The diagram is too large to render (${source.length.toLocaleString()} characters; maximum ${MAX_MERMAID_SOURCE_LENGTH.toLocaleString()}).`,
    );
  }
  return source;
}

function renderCacheKey(source: string, theme: MermaidTheme): string {
  return `${theme}\u0000${source}`;
}

function estimateDiagramSize(source: string, rendered: CachedMermaidDiagram): number {
  return (
    source.length * 2 +
    rendered.svgTemplate.length * 2 +
    (rendered.recovery ? JSON.stringify(rendered.recovery).length * 2 : 0)
  );
}

/** Keep the parser's source excerpt/caret for repair, without exposing a stack trace. */
export class MermaidRenderError extends Error {
  readonly details: string;

  constructor(cause: unknown) {
    const detail =
      cause instanceof Error && cause.message.trim()
        ? cause.message.trim()
        : "Mermaid could not render this diagram.";
    super(detail.split("\n")[0]?.slice(0, 240), { cause });
    this.name = "MermaidRenderError";
    this.details = detail.length > 8_000 ? `${detail.slice(0, 8_000)}\n[Error truncated]` : detail;
  }
}

function enqueueRender<T>(operation: () => Promise<T>): Promise<T> {
  const result = renderQueue.then(operation, operation);
  renderQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

async function renderNativeTemplate(
  source: string,
  theme: MermaidTheme,
): Promise<CachedMermaidDiagram> {
  const { default: mermaid } = await getMermaidRuntimePromise();
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    suppressErrorRendering: true,
    // Mermaid 12 changes these defaults. Preserve existing diagrams' appearance;
    // authors can still opt into ELK/neo through valid Mermaid frontmatter.
    layout: "dagre",
    look: "classic",
    theme: theme === "dark" ? "dark" : "default",
    darkMode: theme === "dark",
    maxTextSize: MAX_MERMAID_SOURCE_LENGTH,
    maxEdges: MAX_MERMAID_EDGES,
    htmlLabels: true,
    forceLegacyMathML: true,
    fontFamily:
      'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    logLevel: "fatal",
  });

  const result = await mermaid.render(nextRenderId("render"), source);
  if (!result.svg.includes("<svg")) {
    throw new Error("Mermaid returned an invalid diagram.");
  }
  return { svgTemplate: result.svg, diagramType: result.diagramType };
}

async function renderTemplate(source: string, theme: MermaidTheme): Promise<CachedMermaidDiagram> {
  return enqueueRender(async () => {
    try {
      return await renderNativeTemplate(source, theme);
    } catch (originalError) {
      if (isMermaidSyntaxError(originalError)) {
        try {
          const recovery = planMermaidRecovery(source);
          if (recovery) {
            // One atomic candidate, containing every compatible edit. A later
            // parse/layout failure must not expose partial repairs or its error.
            const rendered = await renderNativeTemplate(recovery.source, theme);
            return { ...rendered, recovery };
          }
        } catch {
          // Preserve the original diagnostic, source and existing agent fallback.
        }
      }
      throw originalError;
    }
  });
}

async function getTemplate(source: string, theme: MermaidTheme): Promise<CachedMermaidDiagram> {
  const key = renderCacheKey(source, theme);
  const cached = renderCache.get(key);
  if (cached != null) return cached;

  const existing = inFlightRenders.get(key);
  if (existing != null) return existing;

  const pending = renderTemplate(source, theme)
    .then((rendered) => {
      renderCache.set(key, rendered, estimateDiagramSize(source, rendered));
      return rendered;
    })
    .finally(() => {
      inFlightRenders.delete(key);
    });
  inFlightRenders.set(key, pending);
  return pending;
}

export async function renderMermaidDiagram(
  unvalidatedSource: string,
  theme: MermaidTheme,
): Promise<RenderedMermaidDiagram> {
  const source = validateSource(unvalidatedSource);

  try {
    const template = await getTemplate(source, theme);
    return {
      svg: rebaseMermaidSvgIds(template.svgTemplate, nextRenderId("instance")),
      diagramType: template.diagramType,
      ...(template.recovery ? { recovery: template.recovery } : {}),
    };
  } catch (cause) {
    throw new MermaidRenderError(cause);
  }
}
