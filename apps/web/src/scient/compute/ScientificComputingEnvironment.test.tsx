import { EnvironmentId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  readSettings: vi.fn(),
  updateSettings: vi.fn(),
  query: vi.fn(),
  updateAtom: {},
  toggle: null as null | ((enabled: boolean) => void),
  known: true,
  pending: false,
}));
vi.mock("~/state/environments", () => ({
  usePrimaryEnvironmentId: () => "local-server",
  useEnvironment: (id: string) => (mocks.known ? { environmentId: id, label: id } : null),
}));
vi.mock("~/hooks/useSettings", () => ({
  useEnvironmentSettings: (id: string) => {
    mocks.readSettings(id);
    return { schemaVersion: 1, languages: {} };
  },
}));
vi.mock("~/state/server", () => ({ serverEnvironment: { updateSettings: mocks.updateAtom } }));
vi.mock("~/state/compute", () => ({
  computeEnvironment: {
    runtimeInventory: (target: unknown) => {
      mocks.query(target);
      return {};
    },
    refreshRuntimeInventory: {},
    managedRuntime: () => null,
    verifyRuntime: {},
    manageRuntime: {},
    cancelManagedRuntime: {},
  },
}));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: (atom: unknown) => ({
    data:
      atom === null || mocks.pending
        ? undefined
        : {
            languages: [
              {
                descriptor: {
                  languageId: "matlab",
                  displayName: "MATLAB",
                  sourceExtensions: [".m"],
                  capabilities: [],
                },
                enabled: false,
                configuredExecutable: null,
                managedRuntime: null,
                toolkits: [],
                installations: [],
                failureMessage: null,
              },
            ],
          },
    isPending: mocks.pending,
    error: null,
    refresh: vi.fn(),
  }),
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (atom: unknown) => (atom === mocks.updateAtom ? mocks.updateSettings : vi.fn()),
}));
vi.mock("~/components/ui/switch", () => ({
  Switch: ({ onCheckedChange }: { onCheckedChange: (enabled: boolean) => void }) => {
    mocks.toggle = onCheckedChange;
    return <button type="button">Toggle</button>;
  },
}));
vi.mock("~/components/settings/settingsLayout", () => ({
  SettingsPageContainer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SettingsSection: ({
    children,
    headerAction,
  }: {
    children: ReactNode;
    headerAction?: ReactNode;
  }) => (
    <section>
      {headerAction}
      {children}
    </section>
  ),
  SettingsRow: ({
    title,
    description,
    control,
    children,
  }: {
    title?: ReactNode;
    description?: ReactNode;
    control?: ReactNode;
    children?: ReactNode;
  }) => (
    <div>
      {title}
      {description}
      {control}
      {children}
    </div>
  ),
}));

import { ScientificComputingSettings } from "./ScientificComputingSettings";

describe("Scientific Computing environment ownership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.known = true;
    mocks.pending = false;
    mocks.toggle = null;
    mocks.updateSettings.mockResolvedValue({ _tag: "Success", value: null });
  });

  it("reads, edits, and inspects the requested remote server, not the primary", () => {
    const markup = renderToStaticMarkup(
      <ScientificComputingSettings environmentId={EnvironmentId.make("remote-server")} />,
    );
    expect(markup).toContain("remote-server");
    expect(mocks.readSettings).toHaveBeenCalledWith("remote-server");
    mocks.toggle?.(true);
    expect(mocks.updateSettings).toHaveBeenCalledWith({
      environmentId: "remote-server",
      input: {
        patch: {
          scientificComputing: {
            schemaVersion: 1,
            languages: { matlab: { enabled: true, executable: "" } },
          },
        },
      },
    });
    expect(mocks.query).toHaveBeenCalledWith({
      environmentId: "remote-server",
      input: {},
    });
    expect(mocks.readSettings).not.toHaveBeenCalledWith("local-server");
  });

  it("uses the primary environment only when none was requested", () => {
    const markup = renderToStaticMarkup(<ScientificComputingSettings />);
    expect(mocks.readSettings).toHaveBeenCalledWith("local-server");
    expect(markup).not.toContain("More scientific tools are coming soon");
    expect(markup).toContain("Change runtime");
  });

  it("renders truthful language cards while the inventory is loading", () => {
    mocks.pending = true;
    const markup = renderToStaticMarkup(<ScientificComputingSettings />);
    expect(markup).toContain("Python");
    expect(markup).toContain("MATLAB");
    expect(markup).toContain("Checking…");
    expect(markup).not.toContain("Not detected");
  });

  it("does not fall back to local settings when the requested server is missing", () => {
    mocks.known = false;
    const markup = renderToStaticMarkup(
      <ScientificComputingSettings environmentId={EnvironmentId.make("removed-server")} />,
    );
    expect(markup).toContain("This server is unavailable");
    expect(mocks.readSettings).not.toHaveBeenCalled();
    expect(mocks.updateSettings).not.toHaveBeenCalled();
    expect(mocks.query).not.toHaveBeenCalled();
  });
});
