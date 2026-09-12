// @vitest-environment happy-dom
import { act, createRef } from "react";
import { EnvironmentId, MessageId, ThreadId, type AssistantCitation } from "@t3tools/contracts";
import { collectAssistantCitations } from "@t3tools/shared/assistantCitations";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { ComposerHandleContext, type ComposerHandleRef } from "~/composerHandleContext";
import { toastManager } from "~/components/ui/toast";
import { AssistantCitationSource } from "~/components/chat/AssistantCitationSource";
import { formatAssistantCitationForComposer } from "~/composer-logic";
import { getSyntaxHighlighterPromise } from "~/lib/syntaxHighlighting";
import { MermaidDiagramCard } from "./MermaidDiagramCard";
import { buildMermaidRepairRequest } from "./mermaidRepair";
import { planMermaidRecovery } from "./mermaidRecovery";
import {
  MermaidRenderError,
  renderMermaidDiagram,
  type RenderedMermaidDiagram,
} from "./mermaidRuntime";

vi.mock("../presentation/useNearViewport", () => ({
  useNearViewport: () => ({ ref: null, isNearViewport: true }),
}));
vi.mock("~/components/ui/toast", () => ({ toastManager: { add: vi.fn() } }));
vi.mock("./mermaidRuntime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./mermaidRuntime")>()),
  renderMermaidDiagram: vi.fn(),
}));

function pendingRender() {
  let resolve!: (result: RenderedMermaidDiagram) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<RenderedMermaidDiagram>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe("Mermaid error recovery", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let draft: string;
  let composer: ComposerHandleRef;
  const diagnostic = "Parse error on line 2:\nA[\n ^\nExpected closing bracket";
  const source = "flowchart LR\nA[";
  const writeText = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    writeText.mockReset().mockResolvedValue(undefined);
    vi.mocked(toastManager.add).mockReset();
    vi.mocked(renderMermaidDiagram)
      .mockReset()
      .mockRejectedValue(new MermaidRenderError(new Error(diagnostic)));
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    draft = "An existing draft";
    composer = {
      current: {
        readSnapshot: () => ({ value: draft }),
        citeAssistantText: vi.fn((citation: AssistantCitation) => {
          draft += ` ${formatAssistantCitationForComposer(citation, citation.comment)}`;
          return true;
        }),
        focusAtEnd: vi.fn(),
      },
    } as unknown as ComposerHandleRef;
  });
  afterEach(async () => {
    await act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  async function render(text = source, theme: "light" | "dark" = "light", withComposer = true) {
    await act(() =>
      root.render(
        <ComposerHandleContext value={withComposer ? composer : null}>
          <div data-assistant-citation-viewport>
            <AssistantCitationSource
              messageId={MessageId.make("assistant")}
              threadRef={{
                environmentId: EnvironmentId.make("local"),
                threadId: ThreadId.make("thread"),
              }}
              itemKey="assistant"
              listRef={createRef()}
              request={null}
            >
              <MermaidDiagramCard source={text} language="mermaid" title={null} theme={theme} />
            </AssistantCitationSource>
          </div>
        </ComposerHandleContext>,
      ),
    );
  }
  function button(label: string) {
    const found = [...container.querySelectorAll("button")].find(
      (item) => item.getAttribute("aria-label") === label || item.textContent === label,
    );
    expect(found, label).toBeDefined();
    return found!;
  }
  async function menuAction(label: string) {
    await act(() => button("More diagram actions").click());
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (node) => node.textContent === label,
    );
    expect(item, label).toBeDefined();
    await act(() => item!.click());
  }

  it("offers a reviewable request and preserves the original diagram and draft", async () => {
    await render();
    const ask = button("Ask agent to fix");
    await act(() => ask.click());
    await act(() => ask.click());
    const citations = collectAssistantCitations(draft);
    expect(citations).toHaveLength(1);
    expect(draft.startsWith("An existing draft ")).toBe(true);
    expect(citations[0]!.citation.text).toBe(source);
    expect(citations[0]!.citation.comment).toContain(diagnostic);
    expect(composer.current!.citeAssistantText).toHaveBeenCalledTimes(1);
    expect(container.textContent).not.toContain("Request added");
    expect(toastManager.add).not.toHaveBeenCalled();
    expect(container.textContent).toContain(source);
    expect(renderMermaidDiagram).toHaveBeenCalledTimes(1);
  });

  it("copies the same full diagnostic and source even outside a composer", async () => {
    await render(source, "light", false);
    expect(container.querySelector('[aria-label="Ask agent to fix"]')).toBeNull();
    await act(() => button("Copy error and source").click());
    expect(writeText).toHaveBeenCalledWith(buildMermaidRepairRequest(source, diagnostic));
    expect(container.textContent).toContain("Error and source copied");
  });

  it("cites the shared source block without changing native selection", async () => {
    await render();
    const nativeSelection = window.getSelection()!;
    const range = document.createRange();
    range.selectNodeContents(container.querySelector('[aria-label="Diagram error"]')!);
    nativeSelection.removeAllRanges();
    nativeSelection.addRange(range);
    await act(() => button("Ask agent to fix").click());
    const citation = collectAssistantCitations(draft)[0]!.citation;
    expect(citation.text).toBe(source);
    expect(citation.comment).toContain(diagnostic);
    expect(nativeSelection.getRangeAt(0)).toBe(range);
    expect(toastManager.add).not.toHaveBeenCalled();
    nativeSelection.removeAllRanges();
  });

  it("does not offer a citation action for a document preview sharing a composer", async () => {
    await act(() =>
      root.render(
        <ComposerHandleContext value={composer}>
          <MermaidDiagramCard source={source} language="mermaid" title={null} theme="light" />
        </ComposerHandleContext>,
      ),
    );
    expect(container.querySelector('[aria-label="Ask agent to fix"]')).toBeNull();
    expect(button("Copy error and source")).toBeDefined();
  });

  it("reports unavailable composer and rejected clipboard without losing source", async () => {
    composer.current = null;
    writeText.mockRejectedValue(new Error("permission denied"));
    await render();
    await act(() => button("Ask agent to fix").click());
    expect(toastManager.add).toHaveBeenCalledWith(
      expect.objectContaining({ title: "The composer is unavailable right now." }),
    );
    await act(() => button("Copy error and source").click());
    expect(toastManager.add).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Unable to copy the error and source." }),
    );
    expect(container.textContent).not.toContain("Unable to copy");
    expect(draft).toBe("An existing draft");
    expect(container.textContent).toContain(source);
  });

  it("keeps the editable error source mounted throughout correction and retry", async () => {
    const cleanup = vi.fn();
    const editor = { open: false, mount: vi.fn(() => cleanup) };
    const renderEditor = async (text: string) => {
      await act(() =>
        root.render(
          <MermaidDiagramCard
            source={text}
            sourceEditor={editor}
            language="mermaid"
            title={null}
            theme="light"
          />,
        ),
      );
    };
    await renderEditor(source);
    expect(editor.mount).toHaveBeenCalledTimes(1);
    const pending = pendingRender();
    vi.mocked(renderMermaidDiagram).mockReturnValueOnce(pending.promise);
    await renderEditor(`${source}correcting`);
    expect(cleanup).not.toHaveBeenCalled();
    expect(editor.mount).toHaveBeenCalledTimes(1);
    await act(() => pending.reject(new MermaidRenderError(new Error("Still incomplete"))));
    expect(cleanup).not.toHaveBeenCalled();
    await act(() => button("Retry diagram").click());
    expect(editor.mount).toHaveBeenCalledTimes(1);
  });

  it("handles unavailable clipboard and settling a render after unmount", async () => {
    await render();
    vi.stubGlobal("navigator", {});
    await act(() => button("Copy error and source").click());
    expect(toastManager.add).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Clipboard access is unavailable." }),
    );
    const pending = pendingRender();
    vi.mocked(renderMermaidDiagram).mockReturnValueOnce(pending.promise);
    await render(`${source}next`);
    await act(() => root.render(null));
    await act(() => pending.reject(new Error("Late error")));
    expect(container.textContent).toBe("");
  });

  it.each(["source", "theme", "retry"] as const)(
    "disables stale repair actions during a %s change",
    async (change) => {
      await render();
      const pending = pendingRender();
      vi.mocked(renderMermaidDiagram).mockReturnValueOnce(pending.promise);
      if (change === "retry") await act(() => button("Retry diagram").click());
      else
        await render(
          change === "source" ? `${source}new` : source,
          change === "theme" ? "dark" : "light",
        );
      expect(button("Ask agent to fix").disabled).toBe(true);
      expect(button("Copy error and source").disabled).toBe(true);
      expect(container.textContent).not.toContain("Parse error on line 2");
      await act(() => button("Ask agent to fix").click());
      expect(draft).toBe("An existing draft");
      await act(() => pending.reject(new MermaidRenderError(new Error("New error"))));
      expect(button("Ask agent to fix").disabled).toBe(false);
      await act(() => button("Ask agent to fix").click());
      expect(collectAssistantCitations(draft)[0]!.citation.comment).toContain("New error");
      expect(collectAssistantCitations(draft)[0]!.citation.comment).not.toContain(diagnostic);
    },
  );

  it("keeps recovery beside the error and directly above the shared code block", async () => {
    await render();
    const figure = container.querySelector('[role="figure"]')!;
    const errorRow = container.querySelector('[aria-label="Diagram error"]')!;
    const toolbar = container.querySelector('[aria-label="Diagram recovery"]')!;
    const codeBlock = container.querySelector(".chat-markdown-codeblock")!;
    const copy = button("Copy error and source");
    const initialChildren = [...figure.children];
    expect(errorRow.contains(toolbar)).toBe(true);
    expect(toolbar.contains(copy)).toBe(true);
    expect(toolbar.contains(button("Ask agent to fix"))).toBe(true);
    expect(toolbar.contains(button("Retry diagram"))).toBe(true);
    expect(container.querySelector('[aria-label="More diagram actions"]')).toBeNull();
    expect(container.querySelector('[aria-label="Diagram actions"]')).toBeNull();
    expect(errorRow.nextElementSibling).toBe(codeBlock);
    expect(codeBlock.classList.contains("my-0")).toBe(true);
    expect(codeBlock.className).not.toContain("my-[0.65rem]");
    expect(container.querySelector(".scient-mermaid-source")).toBeNull();
    expect(copy.textContent).toBe("");
    expect(copy.className).toContain("chat-markdown-chrome-action");
    vi.useFakeTimers();
    await act(() => copy.click());
    expect(copy.querySelector(".lucide-check")).not.toBeNull();
    expect([...figure.children]).toEqual(initialChildren);
    expect(container.querySelector('[aria-live="polite"]')?.className).toBe("sr-only");
    await act(() => vi.advanceTimersByTime(1501));
    expect(copy.querySelector(".lucide-check")).toBeNull();
    expect([...figure.children]).toEqual(initialChildren);
    expect(toastManager.add).not.toHaveBeenCalled();
  });

  it("keeps one fixed-height error line during retry, with no obsolete diagnostic", async () => {
    await render();
    const errorRow = container.querySelector('[aria-label="Diagram error"]')!;
    const summary = errorRow.firstElementChild!;
    const children = [...errorRow.children];
    const pending = pendingRender();
    vi.mocked(renderMermaidDiagram).mockReturnValueOnce(pending.promise);
    await act(() => button("Retry diagram").click());
    expect(container.querySelector('[aria-label="Diagram error"]')).toBe(errorRow);
    expect([...errorRow.children]).toEqual(children);
    expect(summary.textContent).toBe("Rendering diagram…");
    expect(summary.getAttribute("title")).toBeNull();
    expect(summary.className).toContain("truncate");
    await act(() => pending.reject(new MermaidRenderError(new Error(diagnostic))));
    expect([...errorRow.children]).toEqual(children);
    expect(summary.textContent).toBe("Parse error on line 2:");
  });

  it("exposes normal source copy and wrapping without changing repair context", async () => {
    await render();
    const codeBlock = container.querySelector(".chat-markdown-codeblock")!;
    expect(codeBlock.getAttribute("data-language")).toBe("mermaid");
    expect(codeBlock.querySelector(".chat-markdown-codeblock-header")).not.toBeNull();
    const wrapped = codeBlock.getAttribute("data-wrap") === "true";
    await act(() => button(wrapped ? "Disable line wrap" : "Wrap lines").click());
    expect(codeBlock.getAttribute("data-wrap")).toBe(String(!wrapped));
    await act(() => button("Copy code").click());
    expect(writeText).toHaveBeenCalledWith(source);
    await act(() => button("Ask agent to fix").click());
    expect(collectAssistantCitations(draft)[0]!.citation.text).toBe(source);
    const pending = pendingRender();
    vi.mocked(renderMermaidDiagram).mockReturnValueOnce(pending.promise);
    await act(() => button("Retry diagram").click());
    await act(() => pending.reject(new MermaidRenderError(new Error(diagnostic))));
    expect(container.querySelector(".chat-markdown-codeblock")).toBe(codeBlock);
    expect(codeBlock.getAttribute("data-wrap")).toBe(String(!wrapped));
  });

  it.each(["light", "dark"] as const)(
    "uses the normal language header and highlighting in %s appearance",
    async (theme) => {
      await getSyntaxHighlighterPromise("mermaid");
      const original = 'flowchart LR\nA["שלום <start> & end"\n';
      await render(original, theme);
      const codeBlock = container.querySelector(".chat-markdown-codeblock")!;
      const header = codeBlock.querySelector(".chat-markdown-codeblock-header")!;
      expect(
        header.querySelector('[aria-label="Language: mermaid"]') ??
          [...header.querySelectorAll("span")].find((node) => node.textContent === "mermaid"),
      ).toBeTruthy();
      expect(codeBlock.querySelector(".chat-markdown-shiki .shiki code")?.textContent).toBe(
        original,
      );
      await act(() => button("Copy code").click());
      expect(writeText).toHaveBeenCalledWith(original);
    },
  );

  it("preserves the successful diagram toolbar and source controls", async () => {
    vi.mocked(renderMermaidDiagram).mockResolvedValueOnce({
      svg: "<svg><text>A valid diagram</text></svg>",
      diagramType: "flowchart",
    });
    const valid = "flowchart LR\nA --> B";
    await render(valid);
    expect(button("Expand diagram").disabled).toBe(false);
    expect(container.querySelector('[aria-label="Diagram error"]')).toBeNull();
    expect(container.querySelector(".chat-markdown-codeblock")).toBeNull();
    await menuAction("Show source");
    const sourcePreview = container.querySelector(".scient-mermaid-source")!;
    expect(sourcePreview.textContent).toBe(valid);
    expect(sourcePreview.parentElement!.hidden).toBe(false);
    await menuAction("Copy source");
    expect(writeText).toHaveBeenCalledWith(valid);
    await menuAction("Hide source");
    expect(sourcePreview.parentElement!.hidden).toBe(true);
    expect(container.textContent).toContain("A valid diagram");
  });

  it("ignores out-of-order results and removes an old SVG when inputs change", async () => {
    const first = pendingRender();
    const second = pendingRender();
    vi.mocked(renderMermaidDiagram)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    await render("flowchart LR\nA --> B");
    await render("flowchart LR\nC --> D");
    await act(() =>
      second.resolve({ svg: "<svg><text>Latest diagram</text></svg>", diagramType: "flowchart" }),
    );
    await act(() => first.reject(new Error("Old error")));
    expect(container.textContent).toContain("Latest diagram");
    expect(container.textContent).not.toContain("Old error");
    const third = pendingRender();
    vi.mocked(renderMermaidDiagram).mockReturnValueOnce(third.promise);
    await render("flowchart LR\nC --> D", "dark");
    expect(container.textContent).not.toContain("Latest diagram");
    expect(container.textContent).toContain("Rendering diagram");
    await act(() =>
      third.resolve({ svg: "<svg><text>Dark diagram</text></svg>", diagramType: "flowchart" }),
    );
    expect(container.textContent).toContain("Dark diagram");
  });

  it("keeps recovered source explicit and never changes original copy, citations, or source preview", async () => {
    const original = "flowchart LR\nA[Read (local)] -> B";
    const recovery = planMermaidRecovery(original)!;
    vi.mocked(renderMermaidDiagram).mockResolvedValue({
      svg: "<svg><text>Read (local)</text></svg>",
      diagramType: "flowchart-v2",
      recovery,
    });
    await render(original);
    const figure = container.querySelector('[role="figure"]')!;
    expect(figure.getAttribute("data-markdown-copy")).toContain(original);
    expect(figure.getAttribute("data-markdown-copy")).not.toContain(recovery.source);
    expect(container.querySelector('[aria-label="Diagram error"]')).toBeNull();
    expect(container.querySelector('[aria-label="Ask agent to fix"]')).toBeNull();
    const children = [...figure.children];
    await menuAction("Copy recovered source");
    expect(writeText).toHaveBeenLastCalledWith(recovery.source);
    expect([...figure.children]).toEqual(children);
    await menuAction("Copy original source");
    expect(writeText).toHaveBeenLastCalledWith(original);
    await menuAction("Show source");
    expect(container.querySelector(".scient-mermaid-source")?.textContent).toBe(original);
    expect(toastManager.add).not.toHaveBeenCalled();
    expect(draft).toBe("An existing draft");
  });

  it("keeps the original document editor mounted when a recovered result arrives", async () => {
    const original = "flowchart LR\nA -> B";
    const cleanup = vi.fn();
    const editor = { open: true, mount: vi.fn(() => cleanup) };
    const pending = pendingRender();
    vi.mocked(renderMermaidDiagram).mockReturnValue(pending.promise);
    await act(() =>
      root.render(
        <MermaidDiagramCard
          source={original}
          sourceEditor={editor}
          language="mermaid"
          title={null}
          theme="light"
        />,
      ),
    );
    expect(editor.mount).toHaveBeenCalledTimes(1);
    await act(() =>
      pending.resolve({
        svg: "<svg/>",
        diagramType: "flowchart",
        recovery: planMermaidRecovery(original)!,
      }),
    );
    expect(cleanup).not.toHaveBeenCalled();
    expect(editor.mount).toHaveBeenCalledTimes(1);
  });

  it("never exposes recovered source from a stale source or theme", async () => {
    const original = "flowchart LR\nA -> B";
    const stale = pendingRender();
    const current = pendingRender();
    vi.mocked(renderMermaidDiagram)
      .mockReturnValueOnce(stale.promise)
      .mockReturnValueOnce(current.promise);
    await render(original);
    await render("flowchart LR\nC --> D", "dark");
    await act(() =>
      stale.resolve({
        svg: "<svg>Old recovered</svg>",
        diagramType: "flowchart",
        recovery: planMermaidRecovery(original)!,
      }),
    );
    expect(container.textContent).not.toContain("Old recovered");
    await act(() => button("More diagram actions").click());
    expect(document.body.textContent).not.toContain("Copy recovered source");
    await act(() => button("More diagram actions").click());
    await act(() => current.reject(new MermaidRenderError(new Error(diagnostic))));
    await act(() => button("Copy error and source").click());
    expect(writeText).toHaveBeenLastCalledWith(
      buildMermaidRepairRequest("flowchart LR\nC --> D", diagnostic),
    );
  });
});
