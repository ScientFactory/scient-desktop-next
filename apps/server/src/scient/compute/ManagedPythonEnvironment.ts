// @effect-diagnostics nodeBuiltinImport:off -- this is the app-private managed Python filesystem boundary.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  ComputeToolkitId,
  type ComputeToolkitId as ComputeToolkitIdType,
} from "@scientfactory/compute";
import * as Schema from "effect/Schema";

export const ManagedPythonSelection = Schema.Literals(["managed", "existing"]);
export type ManagedPythonSelection = typeof ManagedPythonSelection.Type;

const ManagedPythonGeneration = Schema.Struct({
  generationId: Schema.NonEmptyString.check(Schema.isMaxLength(128)),
  executableRelativePath: Schema.NonEmptyString.check(Schema.isMaxLength(1024)),
  toolkitIds: Schema.Array(ComputeToolkitId).check(Schema.isMaxLength(64)),
  toolkitRevision: Schema.NonEmptyString.check(Schema.isMaxLength(256)),
  pythonVersion: Schema.NonEmptyString.check(Schema.isMaxLength(64)),
  provisionerVersion: Schema.NonEmptyString.check(Schema.isMaxLength(64)),
  activatedAtEpochMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type ManagedPythonGeneration = typeof ManagedPythonGeneration.Type;

export const ManagedPythonEnvironmentRecord = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  selection: ManagedPythonSelection,
  active: ManagedPythonGeneration,
  previous: Schema.NullOr(ManagedPythonGeneration),
});
export type ManagedPythonEnvironmentRecord = typeof ManagedPythonEnvironmentRecord.Type;

export interface ManagedPythonEnvironmentStatus {
  readonly record: ManagedPythonEnvironmentRecord;
  readonly executable: string;
  readonly available: boolean;
}

export type ManagedPythonEnvironmentFailureReason =
  | "invalid-request"
  | "cancelled"
  | "provision-failed"
  | "verification-failed"
  | "activation-failed"
  | "remove-failed";

export class ManagedPythonEnvironmentError extends Error {
  readonly reason: ManagedPythonEnvironmentFailureReason;

  constructor(
    reason: ManagedPythonEnvironmentFailureReason,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ManagedPythonEnvironmentError";
    this.reason = reason;
  }
}

export type ManagedPythonProvisionPhase =
  | "downloading"
  | "installing-python"
  | "installing-packages"
  | "verifying";

export interface ManagedPythonProvisionProgress {
  readonly phase: ManagedPythonProvisionPhase;
  readonly downloadedBytes: number | null;
  readonly totalBytes: number | null;
}

export interface ManagedPythonProvisionInput {
  /** Final, fresh app-owned generation directory. Do not build elsewhere and move a venv. */
  readonly targetRoot: string;
  readonly toolkitIds: ReadonlyArray<ComputeToolkitIdType>;
  readonly toolkitRevision: string;
  readonly pythonVersion: string;
  readonly provisionerVersion: string;
  readonly signal: AbortSignal;
  readonly onProgress?: ((progress: ManagedPythonProvisionProgress) => void) | undefined;
}

export interface ManagedPythonProvisionResult {
  /** Executable location relative to targetRoot, such as `environment/bin/python`. */
  readonly executableRelativePath: string;
}

export interface ManagedPythonVerifyInput {
  readonly executable: string;
  readonly toolkitIds: ReadonlyArray<ComputeToolkitIdType>;
  readonly signal: AbortSignal;
  readonly onProgress?: ((progress: ManagedPythonProvisionProgress) => void) | undefined;
}

export interface ManagedPythonEnvironmentDependencies {
  readonly provision: (input: ManagedPythonProvisionInput) => Promise<ManagedPythonProvisionResult>;
  readonly verify: (input: ManagedPythonVerifyInput) => Promise<void>;
  readonly now?: (() => number) | undefined;
  readonly generationId?: (() => string) | undefined;
  readonly commitState?:
    | ((statePath: string, record: ManagedPythonEnvironmentRecord) => Promise<void>)
    | undefined;
  /** Injectable only so removal rollback can be proved without platform-specific permission tricks. */
  readonly removeTree?: ((root: string) => Promise<void>) | undefined;
}

export interface ManagedPythonEnvironmentInstallInput {
  readonly toolkitIds: ReadonlyArray<ComputeToolkitIdType>;
  readonly toolkitRevision: string;
  readonly pythonVersion: string;
  readonly provisionerVersion: string;
  readonly signal: AbortSignal;
  readonly onProgress?: ((progress: ManagedPythonProvisionProgress) => void) | undefined;
}

export interface ManagedPythonEnvironmentPaths {
  readonly environmentsRoot: string;
  readonly managedRoot: string;
  readonly statePath: string;
}

const decodeRecord = Schema.decodeUnknownSync(ManagedPythonEnvironmentRecord);
const encodeRecord = Schema.encodeSync(Schema.fromJsonString(ManagedPythonEnvironmentRecord));

export type ManagedPythonPurpose = "python" | "matlab-connection";

export function managedPythonEnvironmentPaths(
  computeDir: string,
  purpose: ManagedPythonPurpose = "python",
): ManagedPythonEnvironmentPaths {
  const environmentsRoot = NodePath.join(computeDir, "environments");
  const managedRoot = NodePath.join(environmentsRoot, purpose);
  return {
    environmentsRoot,
    managedRoot,
    statePath: NodePath.join(managedRoot, "active.json"),
  };
}

function isContained(root: string, candidate: string): boolean {
  const relative = NodePath.relative(NodePath.resolve(root), NodePath.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${NodePath.sep}`) && relative !== "..");
}

function validGenerationId(value: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u.test(value);
}

function generationRoot(managedRoot: string, generationId: string): string | null {
  if (!validGenerationId(generationId)) return null;
  const candidate = NodePath.join(managedRoot, `generation-${generationId}`);
  return isContained(managedRoot, candidate) ? candidate : null;
}

function executablePath(root: string, relativePath: string): string | null {
  if (NodePath.isAbsolute(relativePath) || relativePath.includes("\0")) return null;
  const candidate = NodePath.resolve(root, relativePath);
  return isContained(root, candidate) && candidate !== NodePath.resolve(root) ? candidate : null;
}

async function managedDirectorySafety(paths: ManagedPythonEnvironmentPaths): Promise<{
  readonly environmentsPresent: boolean;
  readonly managedPresent: boolean;
}> {
  const inspectDirectory = async (directory: string, label: string): Promise<boolean> => {
    const stat = await NodeFSP.lstat(directory).catch((cause: NodeJS.ErrnoException) => {
      if (cause.code === "ENOENT") return null;
      throw cause;
    });
    if (stat === null) return false;
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new ManagedPythonEnvironmentError(
        "activation-failed",
        `The ${label} path is not a private app-owned directory.`,
      );
    }
    return true;
  };

  const environmentsPresent = await inspectDirectory(
    paths.environmentsRoot,
    "managed environments",
  );
  if (!environmentsPresent) return { environmentsPresent: false, managedPresent: false };
  const managedPresent = await inspectDirectory(paths.managedRoot, "managed Python");
  if (!managedPresent) return { environmentsPresent: true, managedPresent: false };
  const canonicalEnvironments = await NodeFSP.realpath(paths.environmentsRoot);
  const canonicalManaged = await NodeFSP.realpath(paths.managedRoot);
  if (
    canonicalManaged === canonicalEnvironments ||
    !isContained(canonicalEnvironments, canonicalManaged)
  ) {
    throw new ManagedPythonEnvironmentError(
      "activation-failed",
      "The managed Python directory escaped the app-owned environments root.",
    );
  }
  return { environmentsPresent: true, managedPresent: true };
}

async function ensureManagedDirectories(paths: ManagedPythonEnvironmentPaths): Promise<void> {
  await NodeFSP.mkdir(paths.environmentsRoot, { recursive: true, mode: 0o700 });
  await NodeFSP.mkdir(paths.managedRoot, { recursive: true, mode: 0o700 });
  const safety = await managedDirectorySafety(paths);
  if (!safety.managedPresent) {
    throw new ManagedPythonEnvironmentError(
      "activation-failed",
      "Scient could not prepare its private managed Python directory.",
    );
  }
}

async function defaultCommitState(
  statePath: string,
  record: ManagedPythonEnvironmentRecord,
): Promise<void> {
  const temporary = `${statePath}.${NodeCrypto.randomUUID()}.tmp`;
  try {
    await NodeFSP.writeFile(temporary, `${encodeRecord(record)}\n`, { flag: "wx", mode: 0o600 });
    await NodeFSP.rename(temporary, statePath);
  } catch (cause) {
    await NodeFSP.rm(temporary, { force: true }).catch(() => undefined);
    throw cause;
  }
}

async function canonicalGeneration(
  managedRoot: string,
  generation: ManagedPythonGeneration,
): Promise<{ readonly generation: ManagedPythonGeneration; readonly executable: string } | null> {
  const lexicalRoot = generationRoot(managedRoot, generation.generationId);
  if (lexicalRoot === null) return null;
  const lexicalExecutable = executablePath(lexicalRoot, generation.executableRelativePath);
  if (lexicalExecutable === null) return null;
  try {
    const canonicalManagedRoot = await NodeFSP.realpath(managedRoot);
    const canonicalRoot = await NodeFSP.realpath(lexicalRoot);
    const canonicalExecutable = await NodeFSP.realpath(lexicalExecutable);
    if (
      !isContained(canonicalManagedRoot, canonicalRoot) ||
      !isContained(canonicalRoot, canonicalExecutable)
    ) {
      return null;
    }
    // Keep the lexical virtual-environment launcher. Its symlink may resolve to
    // the generation's private base Python, but invoking the resolved target
    // directly would discard the venv and therefore its locked packages.
    return { generation, executable: lexicalExecutable };
  } catch {
    return null;
  }
}

async function readRecord(
  paths: ManagedPythonEnvironmentPaths,
): Promise<ManagedPythonEnvironmentRecord | null> {
  try {
    return decodeRecord(JSON.parse(await NodeFSP.readFile(paths.statePath, "utf8")));
  } catch {
    return null;
  }
}

async function readStatus(
  paths: ManagedPythonEnvironmentPaths,
): Promise<ManagedPythonEnvironmentStatus | null> {
  if (!(await managedDirectorySafety(paths)).managedPresent) return null;
  const record = await readRecord(paths);
  if (record === null) return null;
  const root = generationRoot(paths.managedRoot, record.active.generationId);
  const executable =
    root === null ? null : executablePath(root, record.active.executableRelativePath);
  if (executable === null) return null;
  const active = await canonicalGeneration(paths.managedRoot, record.active);
  const previous =
    record.previous === null ? null : await canonicalGeneration(paths.managedRoot, record.previous);
  return {
    record: { ...record, previous: previous?.generation ?? null },
    executable,
    available: active !== null,
  };
}

/**
 * Transactional activation boundary for one app-owned Scientific Python.
 *
 * The provisioner builds directly in a fresh final generation path because a
 * Python environment may embed absolute paths and cannot safely be assembled
 * elsewhere and renamed. Discovery only sees a generation after its exact
 * executable passes verification and one atomic state replacement names it.
 * Existing project and system environments are never written or removed.
 */
export function makeManagedPythonEnvironmentManager(
  computeDir: string,
  dependencies: ManagedPythonEnvironmentDependencies,
  purpose: ManagedPythonPurpose = "python",
) {
  const now = dependencies.now ?? Date.now;
  const nextGenerationId = dependencies.generationId ?? (() => NodeCrypto.randomUUID());
  const commitState = dependencies.commitState ?? defaultCommitState;
  const removeTree =
    dependencies.removeTree ??
    ((root: string) => NodeFSP.rm(root, { recursive: true, force: true }));
  const paths = managedPythonEnvironmentPaths(computeDir, purpose);

  let mutationTail: Promise<void> = Promise.resolve();
  const serialize = async <A>(operation: () => Promise<A>): Promise<A> => {
    const previous = mutationTail;
    let release!: () => void;
    mutationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  };

  const inspect = async (): Promise<ManagedPythonEnvironmentStatus | null> =>
    await readStatus(paths);

  const cleanupAbandoned = async (record: ManagedPythonEnvironmentRecord | null): Promise<void> => {
    const safety = await managedDirectorySafety(paths);
    if (!safety.environmentsPresent) return;
    const keep = new Set(
      record === null
        ? []
        : [
            `generation-${record.active.generationId}`,
            ...(record.previous === null ? [] : [`generation-${record.previous.generationId}`]),
          ],
    );
    if (safety.managedPresent) {
      const entries = await NodeFSP.readdir(paths.managedRoot);
      await Promise.all(
        entries
          .filter((entry) => entry.startsWith("generation-") && !keep.has(entry))
          .map((entry) =>
            NodeFSP.rm(NodePath.join(paths.managedRoot, entry), {
              recursive: true,
              force: true,
            }).catch(() => undefined),
          ),
      );
    }
    const environmentEntries = await NodeFSP.readdir(paths.environmentsRoot).catch(
      (): string[] => [],
    );
    await Promise.all(
      environmentEntries
        .filter((entry) => entry.startsWith(`${purpose}.removing-`))
        .map((entry) =>
          NodeFSP.rm(NodePath.join(paths.environmentsRoot, entry), {
            recursive: true,
            force: true,
          }).catch(() => undefined),
        ),
    );
  };

  const reconcile = () =>
    serialize(async () => {
      const current = await readStatus(paths);
      await cleanupAbandoned(current?.record ?? null);
      return current;
    });

  const install = (input: ManagedPythonEnvironmentInstallInput) => {
    const toolkitIds = [...input.toolkitIds];
    return serialize(async () => {
      if (input.signal.aborted) {
        throw new ManagedPythonEnvironmentError(
          "cancelled",
          "The managed Python setup was cancelled before it started.",
        );
      }
      if (
        (purpose === "python" && toolkitIds.length === 0) ||
        new Set(toolkitIds).size !== toolkitIds.length
      ) {
        throw new ManagedPythonEnvironmentError(
          "invalid-request",
          "Choose at least one distinct Toolkit for the managed Python environment.",
        );
      }
      if (
        input.toolkitRevision.trim().length === 0 ||
        input.pythonVersion.trim().length === 0 ||
        input.provisionerVersion.trim().length === 0
      ) {
        throw new ManagedPythonEnvironmentError(
          "invalid-request",
          "Managed Python version metadata must be present before setup starts.",
        );
      }

      await ensureManagedDirectories(paths);
      const existing = await readStatus(paths);
      const generationId = nextGenerationId();
      const candidateRoot = generationRoot(paths.managedRoot, generationId);
      if (candidateRoot === null) {
        throw new ManagedPythonEnvironmentError(
          "invalid-request",
          "The managed Python generation identifier was invalid.",
        );
      }
      await NodeFSP.mkdir(candidateRoot, { recursive: false, mode: 0o700 }).catch((cause) => {
        throw new ManagedPythonEnvironmentError(
          "provision-failed",
          "Scient could not prepare a fresh managed Python generation.",
          { cause },
        );
      });

      let committed = false;
      try {
        const provisioned = await dependencies
          .provision({
            targetRoot: candidateRoot,
            toolkitIds,
            toolkitRevision: input.toolkitRevision,
            pythonVersion: input.pythonVersion,
            provisionerVersion: input.provisionerVersion,
            signal: input.signal,
            onProgress: input.onProgress,
          })
          .catch((cause) => {
            if (input.signal.aborted) {
              throw new ManagedPythonEnvironmentError(
                "cancelled",
                "The managed Python setup was cancelled.",
                { cause },
              );
            }
            throw new ManagedPythonEnvironmentError(
              "provision-failed",
              "Scient could not provision the managed Python environment.",
              { cause },
            );
          });
        if (input.signal.aborted) {
          throw new ManagedPythonEnvironmentError(
            "cancelled",
            "The managed Python setup was cancelled.",
          );
        }

        const lexicalExecutable = executablePath(candidateRoot, provisioned.executableRelativePath);
        if (lexicalExecutable === null) {
          throw new ManagedPythonEnvironmentError(
            "verification-failed",
            "The provisioner returned an executable outside its managed generation.",
          );
        }
        const canonicalRoot = await NodeFSP.realpath(candidateRoot).catch((cause) => {
          throw new ManagedPythonEnvironmentError(
            "verification-failed",
            "The managed Python generation was not present after provisioning.",
            { cause },
          );
        });
        const canonicalExecutable = await NodeFSP.realpath(lexicalExecutable).catch((cause) => {
          throw new ManagedPythonEnvironmentError(
            "verification-failed",
            "The managed Python executable was not present after provisioning.",
            { cause },
          );
        });
        const canonicalManagedRoot = await NodeFSP.realpath(paths.managedRoot).catch((cause) => {
          throw new ManagedPythonEnvironmentError(
            "verification-failed",
            "The managed Python directory was not present after provisioning.",
            { cause },
          );
        });
        if (
          !isContained(canonicalManagedRoot, canonicalRoot) ||
          !isContained(canonicalRoot, canonicalExecutable)
        ) {
          throw new ManagedPythonEnvironmentError(
            "verification-failed",
            "The managed Python executable escaped its app-owned generation.",
          );
        }

        await dependencies
          .verify({
            executable: lexicalExecutable,
            toolkitIds,
            signal: input.signal,
            onProgress: input.onProgress,
          })
          .catch((cause) => {
            if (input.signal.aborted) {
              throw new ManagedPythonEnvironmentError(
                "cancelled",
                "The managed Python setup was cancelled before activation.",
                { cause },
              );
            }
            throw new ManagedPythonEnvironmentError(
              "verification-failed",
              "The managed Python environment did not pass verification.",
              { cause },
            );
          });
        if (input.signal.aborted) {
          throw new ManagedPythonEnvironmentError(
            "cancelled",
            "The managed Python setup was cancelled before activation.",
          );
        }

        const active: ManagedPythonGeneration = {
          generationId,
          executableRelativePath: provisioned.executableRelativePath,
          toolkitIds,
          toolkitRevision: input.toolkitRevision,
          pythonVersion: input.pythonVersion,
          provisionerVersion: input.provisionerVersion,
          activatedAtEpochMs: now(),
        };
        const record: ManagedPythonEnvironmentRecord = {
          schemaVersion: 1,
          selection: existing?.record.selection ?? "managed",
          active,
          previous: existing?.record.active ?? null,
        };
        await commitState(paths.statePath, record).catch((cause) => {
          throw new ManagedPythonEnvironmentError(
            "activation-failed",
            "Scient could not activate the verified managed Python environment.",
            { cause },
          );
        });
        committed = true;
        // Do not delete displaced generations while this server may still
        // have sessions running from them. Startup reconciliation is the safe
        // collection point because no prior-process compute session survives
        // it. Failed unpublished candidates are still removed below.
        return {
          record,
          executable: lexicalExecutable,
          available: true,
        } satisfies ManagedPythonEnvironmentStatus;
      } finally {
        if (!committed) {
          await NodeFSP.rm(candidateRoot, { recursive: true, force: true }).catch(() => undefined);
        }
      }
    });
  };

  const select = (selection: ManagedPythonSelection) =>
    serialize(async () => {
      const current = await readStatus(paths);
      if (current === null) {
        if (selection === "existing") return null;
        throw new ManagedPythonEnvironmentError(
          "invalid-request",
          "Set up Scientific Python before selecting it.",
        );
      }
      if (current.record.selection === selection) return current;
      const record = { ...current.record, selection };
      await commitState(paths.statePath, record).catch((cause) => {
        throw new ManagedPythonEnvironmentError(
          "activation-failed",
          "Scient could not change the selected Python environment.",
          { cause },
        );
      });
      return { ...current, record } satisfies ManagedPythonEnvironmentStatus;
    });

  const remove = () =>
    serialize(async () => {
      const safety = await managedDirectorySafety(paths);
      if (!safety.managedPresent) return false;

      const tombstone = NodePath.join(
        paths.environmentsRoot,
        `${purpose}.removing-${NodeCrypto.randomUUID()}`,
      );
      await NodeFSP.rename(paths.managedRoot, tombstone).catch((cause) => {
        throw new ManagedPythonEnvironmentError(
          "remove-failed",
          "Scient could not prepare the managed Python environment for removal.",
          { cause },
        );
      });
      try {
        await removeTree(tombstone);
      } catch (cause) {
        try {
          await NodeFSP.rename(tombstone, paths.managedRoot);
        } catch (rollbackCause) {
          throw new ManagedPythonEnvironmentError(
            "remove-failed",
            "Scient could not remove the managed Python environment or restore it.",
            { cause: new AggregateError([cause, rollbackCause]) },
          );
        }
        throw new ManagedPythonEnvironmentError(
          "remove-failed",
          "Scient could not remove the managed Python environment; the previous environment was restored.",
          { cause },
        );
      }
      return true;
    });

  return { inspect, install, repair: install, reconcile, remove, select } as const;
}
