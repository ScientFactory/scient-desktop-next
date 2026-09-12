import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  ComputeSessionGeneration,
  ComputeSessionId,
  EnvironmentId,
  TERMINAL_COMPUTE_SESSION_STATUSES,
  type ComputeSessionRecord,
} from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { randomUUID } from "~/lib/utils";
import { resolveStorage } from "~/lib/storage";

const MAX_COMPUTE_CONTEXT_PATH_LENGTH = 32 * 1024;
export const MAX_COMPUTE_CONTEXT_ID_LENGTH = 32 * 1024;
const MAX_COMPUTE_CONTEXT_OWNER_KEY_LENGTH = 32 * 1024;

export const ComputeContextId = Schema.NonEmptyString.check(
  Schema.isMaxLength(MAX_COMPUTE_CONTEXT_ID_LENGTH),
).pipe(Schema.brand("ComputeContextId"));
export type ComputeContextId = typeof ComputeContextId.Type;

export type ComputeContextLifecycle =
  | "unbound"
  | "starting"
  | "live"
  | "closing"
  | "close-failed"
  | "terminal";

export interface ComputeContextBinding {
  readonly contextId: ComputeContextId;
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly ownerKey: string;
  readonly relativePath: string | null;
  readonly sessionId: ComputeSessionId | null;
  readonly generation: ComputeSessionGeneration | null;
  readonly lifecycle: ComputeContextLifecycle;
  readonly closeError: string | null;
}

interface ComputeContextStoreState {
  readonly bindings: Readonly<Record<string, ComputeContextBinding>>;
  observeSession: (
    contextId: ComputeContextId,
    session: Pick<ComputeSessionRecord, "sessionId" | "generation" | "status">,
  ) => void;
  ensureContext: (input: {
    readonly contextId: ComputeContextId;
    readonly environmentId: EnvironmentId;
    readonly cwd: string;
    readonly ownerKey: string;
    readonly relativePath?: string | null;
  }) => ComputeContextBinding;
  reserveSession: (input: {
    readonly contextId: ComputeContextId;
    readonly sessionId: ComputeSessionId;
    readonly generation?: ComputeSessionGeneration;
  }) => boolean;
  releasePendingReservation: (input: {
    readonly contextId: ComputeContextId;
    readonly sessionId: ComputeSessionId;
    readonly generation: ComputeSessionGeneration;
  }) => boolean;
  bindSession: (input: {
    readonly contextId: ComputeContextId;
    readonly sessionId: ComputeSessionId;
    readonly generation: ComputeSessionGeneration;
  }) => boolean;
  updateClosingGeneration: (input: {
    readonly contextId: ComputeContextId;
    readonly sessionId: ComputeSessionId;
    readonly generation: ComputeSessionGeneration;
  }) => boolean;
  markSessionTerminal: (input: {
    readonly contextId: ComputeContextId;
    readonly sessionId: ComputeSessionId;
    readonly generation: ComputeSessionGeneration;
    readonly lifecycle?: ComputeContextLifecycle;
  }) => boolean;
  markClosing: (contextId: ComputeContextId) => boolean;
  markCloseFailed: (input: {
    readonly contextId: ComputeContextId;
    readonly error: string;
  }) => boolean;
  clearCloseFailure: (contextId: ComputeContextId) => boolean;
  removeContext: (contextId: ComputeContextId) => boolean;
}

const INITIAL_GENERATION = ComputeSessionGeneration.make(1);
const COMPUTE_CONTEXT_STORAGE_KEY = "scient:compute-context-bindings:v1";
const MAX_TERMINAL_COMPUTE_CONTEXT_BINDINGS = 64;

const ComputeContextBindingFields = {
  contextId: ComputeContextId,
  environmentId: EnvironmentId,
  cwd: Schema.NonEmptyString.check(Schema.isMaxLength(MAX_COMPUTE_CONTEXT_PATH_LENGTH)),
  ownerKey: Schema.NonEmptyString.check(Schema.isMaxLength(MAX_COMPUTE_CONTEXT_OWNER_KEY_LENGTH)),
  relativePath: Schema.NullOr(
    Schema.String.check(Schema.isMaxLength(MAX_COMPUTE_CONTEXT_PATH_LENGTH)),
  ),
};
const PersistedComputeContextBindingSchema = Schema.Union([
  Schema.Struct({
    ...ComputeContextBindingFields,
    sessionId: Schema.Null,
    generation: Schema.Null,
    lifecycle: Schema.Literal("unbound"),
    closeError: Schema.Null,
  }),
  Schema.Struct({
    ...ComputeContextBindingFields,
    sessionId: ComputeSessionId,
    generation: ComputeSessionGeneration,
    lifecycle: Schema.Literals(["starting", "live", "closing", "terminal"]),
    closeError: Schema.Null,
  }),
  Schema.Struct({
    ...ComputeContextBindingFields,
    sessionId: ComputeSessionId,
    generation: ComputeSessionGeneration,
    lifecycle: Schema.Literal("close-failed"),
    closeError: Schema.NonEmptyString.check(Schema.isMaxLength(4096)),
  }),
]);
const PersistedComputeContextStateSchema = Schema.Struct({
  bindings: Schema.Record(Schema.String, Schema.Unknown),
});
const decodePersistedComputeContextState = Schema.decodeUnknownOption(
  PersistedComputeContextStateSchema,
);
const decodeComputeContextBinding = Schema.decodeUnknownOption(
  PersistedComputeContextBindingSchema,
);

function isBoundedStoredString(value: string, maxLength: number): boolean {
  return value.length > 0 && value.length <= maxLength;
}

function pruneTerminalBindings(
  bindings: Readonly<Record<string, ComputeContextBinding>>,
): Record<string, ComputeContextBinding> {
  const terminalIds = Object.entries(bindings)
    .filter(([, binding]) => binding.lifecycle === "terminal")
    .map(([contextId]) => contextId);
  if (terminalIds.length <= MAX_TERMINAL_COMPUTE_CONTEXT_BINDINGS) return { ...bindings };
  const next = { ...bindings };
  for (const contextId of terminalIds.slice(0, -MAX_TERMINAL_COMPUTE_CONTEXT_BINDINGS)) {
    delete next[contextId];
  }
  return next;
}

export function migratePersistedComputeContextState(persistedState: unknown): {
  bindings: Record<string, ComputeContextBinding>;
} {
  const decoded = decodePersistedComputeContextState(persistedState);
  if (Option.isNone(decoded)) return { bindings: {} };

  const bindings: Record<string, ComputeContextBinding> = {};
  for (const [key, rawBinding] of Object.entries(decoded.value.bindings)) {
    const decodedBinding = decodeComputeContextBinding(rawBinding);
    if (Option.isNone(decodedBinding)) continue;
    const binding = decodedBinding.value;
    if (
      key !== binding.contextId ||
      !isBoundedStoredString(key, MAX_COMPUTE_CONTEXT_ID_LENGTH) ||
      !isBoundedStoredString(binding.cwd, MAX_COMPUTE_CONTEXT_PATH_LENGTH) ||
      !isBoundedStoredString(binding.ownerKey, MAX_COMPUTE_CONTEXT_OWNER_KEY_LENGTH) ||
      (binding.relativePath !== null &&
        !isBoundedStoredString(binding.relativePath, MAX_COMPUTE_CONTEXT_PATH_LENGTH)) ||
      (binding.closeError !== null && binding.closeError.length > 4096)
    ) {
      continue;
    }
    bindings[key] = binding;
  }
  return { bindings: pruneTerminalBindings(bindings) };
}

export function createComputeContextId(): ComputeContextId {
  return ComputeContextId.make(randomUUID());
}

/** One default owner for one visible source tab; a separate standalone tab gets a fresh id. */
export function computeFileContextId(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: string;
  readonly cwd: string;
  readonly relativePath: string;
}): ComputeContextId {
  return ComputeContextId.make(
    `file:${encodeURIComponent(input.environmentId)}:${encodeURIComponent(input.threadId)}:${encodeURIComponent(input.cwd)}:${encodeURIComponent(input.relativePath)}`,
  );
}

export function computeContextBindingForSurface(input: {
  readonly contextId: ComputeContextId;
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly ownerKey?: string;
  readonly relativePath?: string | null;
}): ComputeContextBinding {
  return {
    contextId: input.contextId,
    environmentId: input.environmentId,
    cwd: input.cwd,
    ownerKey: input.ownerKey ?? input.contextId,
    relativePath: input.relativePath ?? null,
    sessionId: null,
    generation: null,
    lifecycle: "unbound",
    closeError: null,
  };
}

function updateBinding(
  state: ComputeContextStoreState,
  contextId: ComputeContextId,
  update: (binding: ComputeContextBinding) => ComputeContextBinding,
): Partial<ComputeContextStoreState> | null {
  const current = state.bindings[contextId];
  if (current === undefined) return null;
  const next = update(current);
  if (next === current) return null;
  return { bindings: { ...state.bindings, [contextId]: next } };
}

export const useComputeContextStore = create<ComputeContextStoreState>()(
  persist(
    (set, get) => ({
      bindings: {},
      // Observation never starts, stops, or replays work. Reconcile a restored
      // owner with server facts, but only explicit close may confirm cleanup.
      observeSession: (contextId, session) => {
        set((state) => {
          const current = state.bindings[contextId];
          if (
            current === undefined ||
            current.sessionId !== session.sessionId ||
            current.generation === null ||
            session.generation < current.generation ||
            current.lifecycle === "closing" ||
            current.lifecycle === "close-failed" ||
            current.lifecycle === "terminal"
          )
            return state;
          const lifecycle = TERMINAL_COMPUTE_SESSION_STATUSES.has(session.status)
            ? "terminal"
            : session.status === "starting"
              ? "starting"
              : "live";
          if (current.lifecycle === lifecycle && current.generation === session.generation)
            return state;
          return {
            bindings: pruneTerminalBindings({
              ...state.bindings,
              [contextId]: {
                ...current,
                generation: session.generation,
                lifecycle,
                closeError: null,
              },
            }),
          };
        });
      },
      ensureContext: (input) => {
        const existing = get().bindings[input.contextId];
        if (existing !== undefined) return existing;
        const binding = computeContextBindingForSurface(input);
        set((state) => ({
          bindings: pruneTerminalBindings({ ...state.bindings, [input.contextId]: binding }),
        }));
        return binding;
      },
      reserveSession: (input) => {
        let reserved = false;
        set((state) => {
          const current = state.bindings[input.contextId];
          if (
            current === undefined ||
            current.lifecycle === "live" ||
            current.lifecycle === "closing" ||
            current.lifecycle === "close-failed"
          ) {
            return state;
          }
          if (current.lifecycle === "starting" && current.sessionId !== input.sessionId) {
            return state;
          }
          reserved = true;
          return {
            bindings: {
              ...state.bindings,
              [input.contextId]: {
                ...current,
                sessionId: input.sessionId,
                generation: input.generation ?? INITIAL_GENERATION,
                lifecycle: "starting",
                closeError: null,
              },
            },
          };
        });
        return reserved;
      },
      releasePendingReservation: (input) => {
        let released = false;
        set((state) => {
          const current = state.bindings[input.contextId];
          if (
            current === undefined ||
            current.lifecycle !== "starting" ||
            current.sessionId !== input.sessionId ||
            current.generation !== input.generation
          ) {
            return state;
          }
          released = true;
          return {
            bindings: {
              ...state.bindings,
              [input.contextId]: {
                ...current,
                sessionId: null,
                generation: null,
                lifecycle: "unbound",
                closeError: null,
              },
            },
          };
        });
        return released;
      },
      bindSession: (input) => {
        let bound = false;
        set((state) => {
          const current = state.bindings[input.contextId];
          if (
            current === undefined ||
            current.sessionId !== input.sessionId ||
            current.lifecycle === "closing" ||
            current.lifecycle === "close-failed" ||
            current.lifecycle === "terminal"
          ) {
            return state;
          }
          bound = true;
          return {
            bindings: {
              ...state.bindings,
              [input.contextId]: {
                ...current,
                generation: input.generation,
                lifecycle: "live",
                closeError: null,
              },
            },
          };
        });
        return bound;
      },
      updateClosingGeneration: (input) => {
        let updated = false;
        set((state) => {
          const current = state.bindings[input.contextId];
          if (
            current === undefined ||
            current.sessionId !== input.sessionId ||
            current.lifecycle !== "closing"
          ) {
            return state;
          }
          updated = true;
          return {
            bindings: {
              ...state.bindings,
              [input.contextId]: { ...current, generation: input.generation },
            },
          };
        });
        return updated;
      },
      markSessionTerminal: (input) => {
        let marked = false;
        set((state) => {
          const current = state.bindings[input.contextId];
          if (
            current === undefined ||
            current.sessionId !== input.sessionId ||
            current.generation !== input.generation
          ) {
            return state;
          }
          if (current.lifecycle === "close-failed") return state;
          if (current.lifecycle === "closing" && input.lifecycle !== "terminal") return state;
          marked = true;
          return {
            bindings: pruneTerminalBindings({
              ...state.bindings,
              [input.contextId]: {
                ...current,
                lifecycle: input.lifecycle ?? "terminal",
                closeError: null,
              },
            }),
          };
        });
        return marked;
      },
      markClosing: (contextId) => {
        let marked = false;
        set((state) => {
          const current = state.bindings[contextId];
          if (current === undefined || current.lifecycle === "closing") return state;
          marked = true;
          const next = updateBinding(state, contextId, (binding) => ({
            ...binding,
            lifecycle: "closing",
            closeError: null,
          }));
          return next ?? state;
        });
        return marked;
      },
      markCloseFailed: ({ contextId, error }) => {
        let marked = false;
        set((state) => {
          const current = state.bindings[contextId];
          if (current === undefined) return state;
          marked = true;
          const next = updateBinding(state, contextId, (binding) => ({
            ...binding,
            lifecycle: "close-failed",
            closeError: error,
          }));
          return next ?? state;
        });
        return marked;
      },
      clearCloseFailure: (contextId) => {
        let cleared = false;
        set((state) => {
          const current = state.bindings[contextId];
          if (current === undefined || current.lifecycle !== "close-failed") return state;
          cleared = true;
          const next = updateBinding(state, contextId, (binding) => ({
            ...binding,
            lifecycle: binding.sessionId === null ? "unbound" : "live",
            closeError: null,
          }));
          return next ?? state;
        });
        return cleared;
      },
      removeContext: (contextId) => {
        let removed = false;
        set((state) => {
          if (!(contextId in state.bindings)) return state;
          removed = true;
          const next = { ...state.bindings };
          delete next[contextId];
          return { bindings: next };
        });
        return removed;
      },
    }),
    {
      name: COMPUTE_CONTEXT_STORAGE_KEY,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      version: 2,
      migrate: (persistedState) => migratePersistedComputeContextState(persistedState),
      merge: (persistedState, currentState) => ({
        ...currentState,
        ...migratePersistedComputeContextState(persistedState),
      }),
      partialize: (state) => ({ bindings: pruneTerminalBindings(state.bindings) }),
    },
  ),
);

export function getComputeContext(contextId: ComputeContextId): ComputeContextBinding | null {
  return useComputeContextStore.getState().bindings[contextId] ?? null;
}

/** Presentation only: commands always use the full session id and generation. */
export function computeSessionOwnerLabel(
  session: Pick<ComputeSessionRecord, "sessionId" | "label">,
  environmentId: EnvironmentId,
  cwd: string,
): string {
  const owner = Object.values(useComputeContextStore.getState().bindings).find(
    (binding) =>
      binding.environmentId === environmentId &&
      binding.cwd === cwd &&
      binding.sessionId === session.sessionId,
  );
  const identity = session.sessionId.slice(-8);
  return owner?.relativePath
    ? `${session.label} · ${owner.relativePath} · ${identity}`
    : `${session.label} · ${identity}`;
}

export function ownsLiveComputeSession(
  binding: Pick<ComputeContextBinding, "sessionId" | "generation" | "lifecycle"> | null,
  session: Pick<ComputeSessionRecord, "sessionId" | "generation">,
): boolean {
  return (
    binding?.lifecycle === "live" &&
    binding.sessionId === session.sessionId &&
    binding.generation === session.generation
  );
}

export function ensureComputeContext(input: {
  readonly contextId: ComputeContextId;
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly ownerKey?: string;
  readonly relativePath?: string | null;
}): ComputeContextBinding {
  return useComputeContextStore.getState().ensureContext({
    ...input,
    ownerKey: input.ownerKey ?? input.contextId,
  });
}

export const INITIAL_COMPUTE_CONTEXT_GENERATION = INITIAL_GENERATION;
