// @vitest-environment happy-dom
import { act, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { ComputeLanguageId, type ComputeRuntimeVerification } from "@t3tools/contracts";
import { ComputeInstallationRow } from "./ComputeInstallationRow";

const executable = "/managed/env/bin/python";
const verified = (path = executable): ComputeRuntimeVerification => ({
  profile: {
    languageId: ComputeLanguageId.make("python"),
    executable: path,
    source: "managed",
    languageVersion: "3.12.13",
    architecture: "arm64",
    displayName: "Python",
  },
  readiness: "ready",
  connection: "verified",
  message: null,
  missingRequirements: [],
  packages: [],
});
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe("installation row interactions", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let props: ComponentProps<typeof ComputeInstallationRow>;
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    props = {
      installation: { executable, source: "managed", version: "3.12.13", problem: null },
      languageName: "Python",
      selected: true,
      enabled: true,
      disabled: false,
      verificationKey: "g1",
      onTest: vi.fn(async () => verified()),
      onUse: vi.fn(),
      children: <button>Repair only this installation</button>,
    };
  });
  afterEach(async () => {
    await act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });
  const render = async () => {
    await act(() => root.render(<ComputeInstallationRow {...props} />));
  };
  const button = (text: string) => {
    const match = [...container.querySelectorAll("button")].find(
      (node) => node.textContent?.trim() === text,
    );
    expect(match, text).toBeDefined();
    return match!;
  };

  it("keeps paths and maintenance hidden until this installation is expanded", async () => {
    await render();
    expect(container.textContent).not.toContain(executable);
    expect(container.textContent).not.toContain("Repair only");
    expect(container.textContent).not.toContain("Test passed");
    await act(() => button("Details").click());
    expect(container.textContent).toContain(executable);
    expect(container.textContent).toContain("Repair only this installation");
    expect(button("Details").getAttribute("aria-expanded")).toBe("true");
  });

  it("keeps two installations independently expandable and independently tested", async () => {
    const other = {
      ...props,
      installation: {
        ...props.installation,
        executable: "/system/python",
        source: "path" as const,
      },
      selected: false,
      onTest: vi.fn(async () => verified("/system/python")),
      children: <span>System diagnostics</span>,
    };
    await act(() =>
      root.render(
        <>
          <ComputeInstallationRow {...props} />
          <ComputeInstallationRow {...other} />
        </>,
      ),
    );
    const rows = [...container.querySelectorAll<HTMLElement>("[data-compute-installation]")];
    await act(() =>
      rows[0]!.querySelector<HTMLButtonElement>('[data-slot="collapsible-trigger"]')!.click(),
    );
    expect(rows[0]!.textContent).toContain(executable);
    expect(rows[1]!.textContent).not.toContain("/system/python");
    await act(() =>
      rows[0]!.querySelector<HTMLButtonElement>('button[aria-label^="Test "]')!.click(),
    );
    expect(rows[0]!.textContent).toContain("Test passed");
    expect(rows[1]!.textContent).not.toContain("Test passed");
    expect(other.onTest).not.toHaveBeenCalled();
  });

  it("does not duplicate a test on rapid clicks and keeps retesting available", async () => {
    const pending = deferred<ComputeRuntimeVerification>();
    props.onTest = vi.fn(() => pending.promise);
    await render();
    const trigger = button("Test");
    await act(() => {
      trigger.click();
      trigger.click();
    });
    expect(props.onTest).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("Testing…");
    await act(() => pending.resolve(verified()));
    expect(container.textContent).toContain("Test passed");
    await act(() => button("Test passed").click());
    expect(props.onTest).toHaveBeenCalledTimes(2);
  });

  it.each(["refresh", "new generation", "disabled language"])(
    "ignores an old success after %s",
    async (reason) => {
      const pending = deferred<ComputeRuntimeVerification>();
      props.onTest = vi.fn(() => pending.promise);
      await render();
      await act(() => button("Test").click());
      props = {
        ...props,
        verificationKey: reason,
        ...(reason === "disabled language" ? { enabled: false } : {}),
      };
      await render();
      await act(() => pending.resolve(verified()));
      expect(container.textContent).not.toContain("Test passed");
    },
  );

  it("shows missing requirements while collapsed and never calls that a passed test", async () => {
    props.onTest = vi.fn(async (): Promise<ComputeRuntimeVerification> => ({
      ...verified(),
      readiness: "missing-requirement",
      message: "Install ipykernel in this environment.",
      missingRequirements: ["ipykernel"],
    }));
    await render();
    await act(() => button("Test").click());
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "Install ipykernel in this environment.",
    );
    expect(container.textContent).not.toContain("Test passed");
    expect(container.textContent).not.toContain(executable);
  });

  it("keeps a connection pass distinct from optional package diagnostics", async () => {
    props.onTest = vi.fn(async () => ({
      ...verified(),
      packages: [{ name: "pandas", version: null }],
    }));
    await render();
    await act(() => button("Test").click());
    expect(container.textContent).toContain("Test passed");
    expect(container.textContent).not.toContain("pandas");
    await act(() => button("Details").click());
    expect(container.textContent).toContain("pandas missing");
  });

  it("survives repeated success, failure, invalidation and retry without retaining stale results", async () => {
    for (let n = 0; n < 30; n += 1) {
      props = {
        ...props,
        verificationKey: `generation-${n}`,
        onTest: vi.fn(async () => {
          if (n % 2) throw new Error(`failure-${n}`);
          return verified();
        }),
      };
      await render();
      await act(() => button("Test").click());
      expect(container.textContent?.includes("Test passed")).toBe(n % 2 === 0);
      expect(container.querySelector('[role="alert"]')?.textContent ?? null).toBe(
        n % 2 ? `failure-${n}` : null,
      );
    }
  });
});
