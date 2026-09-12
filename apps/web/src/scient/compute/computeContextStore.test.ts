import { ComputeSessionGeneration, ComputeSessionId, EnvironmentId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  computeFileContextId,
  computeSessionOwnerLabel,
  ensureComputeContext,
  migratePersistedComputeContextState,
  ownsLiveComputeSession,
  useComputeContextStore,
} from "./computeContextStore";

const environmentId = EnvironmentId.make("environment-1");

beforeEach(() => {
  useComputeContextStore.setState({ bindings: {} });
});

describe("compute context bindings", () => {
  it("identifies same-language sessions by their exact owner without crossing environments", () => {
    const contextId = computeFileContextId({
      environmentId,
      threadId: "thread-1",
      cwd: "/project",
      relativePath: "analysis.py",
    });
    ensureComputeContext({
      contextId,
      environmentId,
      cwd: "/project",
      relativePath: "analysis.py",
    });
    const first = { sessionId: ComputeSessionId.make("session-12345678"), label: "Python" };
    const second = { sessionId: ComputeSessionId.make("session-87654321"), label: "Python" };
    useComputeContextStore.getState().reserveSession({ contextId, sessionId: first.sessionId });
    expect(computeSessionOwnerLabel(first, environmentId, "/project")).toBe(
      "Python · analysis.py · 12345678",
    );
    expect(computeSessionOwnerLabel(second, environmentId, "/project")).toBe("Python · 87654321");
    expect(computeSessionOwnerLabel(first, EnvironmentId.make("another-host"), "/project")).toBe(
      "Python · 12345678",
    );
    expect(computeSessionOwnerLabel(first, environmentId, "/another-project")).toBe(
      "Python · 12345678",
    );
  });
  it("keeps same-file ownership stable without sharing independent contexts", () => {
    const fileContext = computeFileContextId({
      environmentId,
      threadId: "thread-1",
      cwd: "/project",
      relativePath: "analysis.py",
    });
    const secondContext = "standalone-2" as Parameters<typeof ensureComputeContext>[0]["contextId"];
    const first = ensureComputeContext({
      contextId: fileContext,
      environmentId,
      cwd: "/project",
      ownerKey: "file-owner",
      relativePath: "analysis.py",
    });
    const second = ensureComputeContext({
      contextId: secondContext,
      environmentId,
      cwd: "/project",
      ownerKey: "standalone-owner",
    });

    expect(first.contextId).not.toBe(second.contextId);
    expect(useComputeContextStore.getState().bindings).toHaveProperty(fileContext);
    expect(useComputeContextStore.getState().bindings).toHaveProperty(secondContext);
  });

  it("reuses a session generation for restart and allocates a fresh id after terminal", () => {
    const contextId = "context-1" as Parameters<typeof ensureComputeContext>[0]["contextId"];
    ensureComputeContext({
      contextId,
      environmentId,
      cwd: "/project",
      ownerKey: "owner",
    });
    const firstSession = ComputeSessionId.make("session-1");
    const secondSession = ComputeSessionId.make("session-2");
    const generation1 = ComputeSessionGeneration.make(1);
    const generation2 = ComputeSessionGeneration.make(2);
    const store = useComputeContextStore.getState();

    expect(store.reserveSession({ contextId, sessionId: firstSession })).toBe(true);
    expect(store.bindSession({ contextId, sessionId: firstSession, generation: generation1 })).toBe(
      true,
    );
    expect(store.bindSession({ contextId, sessionId: firstSession, generation: generation2 })).toBe(
      true,
    );
    expect(useComputeContextStore.getState().bindings[contextId]?.sessionId).toBe(firstSession);
    expect(
      useComputeContextStore.getState().markSessionTerminal({
        contextId,
        sessionId: firstSession,
        generation: generation2,
      }),
    ).toBe(true);
    expect(store.reserveSession({ contextId, sessionId: secondSession })).toBe(true);
    expect(useComputeContextStore.getState().bindings[contextId]?.sessionId).toBe(secondSession);
  });

  it("decodes only valid persisted bindings and bounds terminal retention", () => {
    const valid = (contextId: string, lifecycle: "terminal" | "live") => ({
      contextId,
      environmentId,
      cwd: "/project",
      ownerKey: contextId,
      relativePath: null,
      sessionId:
        lifecycle === "terminal" || lifecycle === "live"
          ? ComputeSessionId.make("session-1")
          : null,
      generation: lifecycle === "terminal" || lifecycle === "live" ? 1 : null,
      lifecycle,
      closeError: null,
    });
    const terminalBindings = Object.fromEntries(
      Array.from({ length: 66 }, (_, index) => {
        const id = `terminal-${index}`;
        return [id, valid(id, "terminal")];
      }),
    );
    const longLiveContextId = `file:${"x".repeat(2048)}`;

    const migrated = migratePersistedComputeContextState({
      bindings: {
        ...terminalBindings,
        malformed: { lifecycle: "terminal" },
        inconsistent: { ...valid("inconsistent", "live"), sessionId: null },
        [longLiveContextId]: valid(longLiveContextId, "live"),
      },
    });

    expect(Object.keys(migrated.bindings)).toHaveLength(65);
    expect(migrated.bindings[longLiveContextId]?.lifecycle).toBe("live");
    expect(migrated.bindings.malformed).toBeUndefined();
    expect(migrated.bindings.inconsistent).toBeUndefined();
    expect(migrated.bindings["terminal-0"]).toBeUndefined();
    expect(migrated.bindings["terminal-65"]?.lifecycle).toBe("terminal");
  });

  it("requires the exact live owner before submitting work", () => {
    const contextId = "context-owner" as Parameters<typeof ensureComputeContext>[0]["contextId"];
    ensureComputeContext({ contextId, environmentId, cwd: "/project", ownerKey: "owner" });
    const sessionId = ComputeSessionId.make("session-owner");
    const generation = ComputeSessionGeneration.make(1);
    useComputeContextStore.getState().reserveSession({ contextId, sessionId, generation });
    const session = { sessionId, generation };

    expect(useComputeContextStore.getState().reserveSession({ contextId, sessionId })).toBe(true);
    expect(
      useComputeContextStore
        .getState()
        .reserveSession({ contextId, sessionId: ComputeSessionId.make("other-session") }),
    ).toBe(false);
    expect(
      ownsLiveComputeSession(
        useComputeContextStore.getState().bindings[contextId] ?? null,
        session,
      ),
    ).toBe(false);
    useComputeContextStore.getState().bindSession({ contextId, sessionId, generation });
    expect(
      ownsLiveComputeSession(
        useComputeContextStore.getState().bindings[contextId] ?? null,
        session,
      ),
    ).toBe(true);
    useComputeContextStore.getState().markClosing(contextId);
    expect(
      ownsLiveComputeSession(
        useComputeContextStore.getState().bindings[contextId] ?? null,
        session,
      ),
    ).toBe(false);
  });

  it("releases only the matching pre-admission reservation", () => {
    const contextId = "capacity-owner" as Parameters<typeof ensureComputeContext>[0]["contextId"];
    ensureComputeContext({ contextId, environmentId, cwd: "/project", ownerKey: "owner" });
    const pendingSessionId = ComputeSessionId.make("pending-session");
    const pendingGeneration = ComputeSessionGeneration.make(1);
    const otherSessionId = ComputeSessionId.make("other-session");

    expect(
      useComputeContextStore.getState().reserveSession({
        contextId,
        sessionId: pendingSessionId,
        generation: pendingGeneration,
      }),
    ).toBe(true);
    expect(
      useComputeContextStore.getState().releasePendingReservation({
        contextId,
        sessionId: otherSessionId,
        generation: pendingGeneration,
      }),
    ).toBe(false);
    expect(useComputeContextStore.getState().bindings[contextId]?.sessionId).toBe(pendingSessionId);
    expect(
      useComputeContextStore.getState().releasePendingReservation({
        contextId,
        sessionId: pendingSessionId,
        generation: pendingGeneration,
      }),
    ).toBe(true);
    expect(useComputeContextStore.getState().bindings[contextId]).toMatchObject({
      lifecycle: "unbound",
      sessionId: null,
      generation: null,
    });
  });

  it("reconciles a restored owner without replay and never undoes closing", () => {
    const contextId = computeFileContextId({
      environmentId,
      threadId: "restored",
      cwd: "/project",
      relativePath: "run.py",
    });
    ensureComputeContext({ contextId, environmentId, cwd: "/project" });
    const sessionId = ComputeSessionId.make("restored-session");
    const generation = ComputeSessionGeneration.make(1);
    const store = useComputeContextStore.getState();
    store.reserveSession({ contextId, sessionId, generation });
    store.observeSession(contextId, { sessionId, generation, status: "ready" });
    expect(useComputeContextStore.getState().bindings[contextId]?.lifecycle).toBe("live");
    const stable = useComputeContextStore.getState();
    store.observeSession(contextId, { sessionId, generation, status: "ready" });
    expect(useComputeContextStore.getState()).toBe(stable);
    store.observeSession(contextId, {
      sessionId,
      generation: ComputeSessionGeneration.make(2),
      status: "ready",
    });
    store.observeSession(contextId, { sessionId, generation, status: "failed" });
    expect(useComputeContextStore.getState().bindings[contextId]?.lifecycle).toBe("live");
    store.markClosing(contextId);
    store.observeSession(contextId, {
      sessionId,
      generation: ComputeSessionGeneration.make(2),
      status: "stopped",
    });
    expect(useComputeContextStore.getState().bindings[contextId]?.lifecycle).toBe("closing");
  });

  it("validates even same-version storage on hydration", () => {
    const merge = useComputeContextStore.persist.getOptions().merge!;
    const current = useComputeContextStore.getState();
    const hydrated = merge({ bindings: { corrupt: { lifecycle: "live" } } }, current);
    expect(hydrated.bindings).toEqual({});
    expect(hydrated.observeSession).toBe(current.observeSession);
  });
});
