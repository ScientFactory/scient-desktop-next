// @effect-diagnostics nodeBuiltinImport:off -- execution-scoped project outputs are host files.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import type { ComputeImageMediaType } from "@scientfactory/compute";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { inspectComputeStaticImage } from "./ComputeStaticImage.ts";

const MAXIMUM_SCANNED_ENTRIES = 4_096;
const MAXIMUM_DIRECTORY_DEPTH = 8;
const MAXIMUM_IMAGES_PER_EXECUTION = 32;
const MAXIMUM_IMAGE_BYTES = 8 * 1024 * 1024;

const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".hg",
  ".svn",
  ".scient",
  ".scient-next",
  ".t3",
  ".venv",
  "__pycache__",
  "node_modules",
]);

class ProjectOutputObservationFailure extends Data.TaggedError("ProjectOutputObservationFailure")<{
  readonly cause: unknown;
}> {}

interface ProjectImageState {
  readonly size: bigint;
  readonly modifiedAt: bigint;
  readonly changedAt: bigint;
}

interface ProjectImageSnapshot {
  readonly files: ReadonlyMap<string, ProjectImageState>;
  readonly incomplete: boolean;
}

export interface ComputeProjectOutputObservation {
  readonly projectRoot: string;
  readonly baseline: ProjectImageSnapshot | null;
  readonly warnings: ReadonlyArray<string>;
}

export interface ObservedComputeProjectImage {
  readonly relativePath: string;
  readonly mediaType: ComputeImageMediaType;
  readonly contentHash: string;
  readonly bytes: Uint8Array;
  readonly width: number | null;
  readonly height: number | null;
}

export interface ComputeProjectOutputCollection {
  readonly images: ReadonlyArray<ObservedComputeProjectImage>;
  readonly warnings: ReadonlyArray<string>;
}

export interface ComputeProjectOutputLimits {
  readonly maximumBytes: number;
}

export interface ComputeProjectOutputObserverPort {
  readonly begin: (projectRoot: string) => Effect.Effect<ComputeProjectOutputObservation>;
  readonly collect: (
    observation: ComputeProjectOutputObservation,
    limits: ComputeProjectOutputLimits,
  ) => Effect.Effect<ComputeProjectOutputCollection>;
}

function imageMediaType(name: string): ComputeImageMediaType | null {
  switch (NodePath.extname(name).toLowerCase()) {
    case ".png":
      return "image/png";
    case ".svg":
      return "image/svg+xml";
    default:
      return null;
  }
}

function sameState(left: ProjectImageState | undefined, right: ProjectImageState): boolean {
  return (
    left !== undefined &&
    left.size === right.size &&
    left.modifiedAt === right.modifiedAt &&
    left.changedAt === right.changedAt
  );
}

function isInsideProjectRoot(projectRoot: string, candidate: string): boolean {
  const relative = NodePath.relative(projectRoot, candidate);
  return (
    relative.length > 0 &&
    relative !== ".." &&
    !relative.startsWith(`..${NodePath.sep}`) &&
    !NodePath.isAbsolute(relative)
  );
}

async function snapshotProjectImages(projectRoot: string): Promise<ProjectImageSnapshot> {
  const files = new Map<string, ProjectImageState>();
  const directories = [{ absolutePath: projectRoot, relativePath: "", depth: 0 }];
  let scannedEntries = 0;

  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory === undefined) break;
    const remaining = MAXIMUM_SCANNED_ENTRIES - scannedEntries;
    if (remaining <= 0) return { files, incomplete: true };
    const entries: NodeFS.Dirent[] = [];
    let directoryIncomplete = false;
    try {
      const handle = await NodeFSP.opendir(directory.absolutePath);
      for await (const entry of handle) {
        if (entries.length >= remaining) {
          directoryIncomplete = true;
          break;
        }
        entries.push(entry);
      }
    } catch {
      return { files, incomplete: true };
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      scannedEntries += 1;
      if (scannedEntries > MAXIMUM_SCANNED_ENTRIES) {
        return { files, incomplete: true };
      }
      const relativePath = directory.relativePath
        ? `${directory.relativePath}/${entry.name}`
        : entry.name;
      const absolutePath = NodePath.join(directory.absolutePath, entry.name);
      if (entry.isDirectory()) {
        if (
          directory.depth < MAXIMUM_DIRECTORY_DEPTH &&
          !entry.name.startsWith(".") &&
          !IGNORED_DIRECTORIES.has(entry.name)
        ) {
          directories.push({
            absolutePath,
            relativePath,
            depth: directory.depth + 1,
          });
        }
        continue;
      }
      if (!entry.isFile() || imageMediaType(entry.name) === null) continue;
      try {
        const metadata = await NodeFSP.lstat(absolutePath, { bigint: true });
        if (!metadata.isFile()) continue;
        files.set(relativePath, {
          size: metadata.size,
          modifiedAt: metadata.mtimeNs,
          changedAt: metadata.ctimeNs,
        });
      } catch {
        // A file may disappear while an execution is still writing. The final
        // observation is authoritative for whether a complete file exists.
      }
    }
    if (directoryIncomplete) return { files, incomplete: true };
  }
  return { files, incomplete: false };
}

async function readObservedImage(
  projectRoot: string,
  relativePath: string,
): Promise<ObservedComputeProjectImage | string> {
  if (relativePath.length > 4_096) {
    return "A generated figure path exceeded Scient's retained provenance limit.";
  }
  const mediaType = imageMediaType(relativePath);
  if (mediaType === null) return `Generated file '${relativePath}' is not a supported figure.`;
  const absolutePath = NodePath.join(projectRoot, ...relativePath.split("/"));
  const noFollow = "O_NOFOLLOW" in NodeFS.constants ? NodeFS.constants.O_NOFOLLOW : 0;
  let file: NodeFSP.FileHandle | null = null;
  try {
    const pathMetadata = await NodeFSP.lstat(absolutePath, { bigint: true });
    if (!pathMetadata.isFile()) {
      return `Generated figure '${relativePath}' is not a regular file.`;
    }
    file = await NodeFSP.open(absolutePath, NodeFS.constants.O_RDONLY | noFollow);
    const canonicalPath = await NodeFSP.realpath(absolutePath);
    if (!isInsideProjectRoot(projectRoot, canonicalPath)) {
      return `Generated figure '${relativePath}' resolved outside the project.`;
    }
    const before = await file.stat({ bigint: true });
    const canonicalMetadata = await NodeFSP.lstat(canonicalPath, { bigint: true });
    if (
      !before.isFile() ||
      before.dev !== pathMetadata.dev ||
      before.ino !== pathMetadata.ino ||
      before.dev !== canonicalMetadata.dev ||
      before.ino !== canonicalMetadata.ino
    ) {
      return `Generated figure '${relativePath}' changed before it could be retained.`;
    }
    if (before.size > BigInt(MAXIMUM_IMAGE_BYTES)) {
      return `Generated figure '${relativePath}' exceeded the ${String(MAXIMUM_IMAGE_BYTES)}-byte limit.`;
    }
    const contents = new Uint8Array(await file.readFile());
    if (contents.byteLength > MAXIMUM_IMAGE_BYTES) {
      return `Generated figure '${relativePath}' exceeded the ${String(MAXIMUM_IMAGE_BYTES)}-byte limit.`;
    }
    const after = await file.stat({ bigint: true });
    if (
      after.size !== before.size ||
      after.mtimeNs !== before.mtimeNs ||
      after.ctimeNs !== before.ctimeNs
    ) {
      return `Generated figure '${relativePath}' changed while it was being retained.`;
    }
    const inspection = inspectComputeStaticImage(mediaType, contents);
    if (inspection === null) {
      return `Generated figure '${relativePath}' is not a valid ${mediaType === "image/png" ? "PNG" : "SVG"}.`;
    }
    const contentHash = `sha256:${NodeCrypto.createHash("sha256").update(contents).digest("hex")}`;
    return {
      relativePath,
      mediaType,
      contentHash,
      bytes: contents,
      width: inspection.width,
      height: inspection.height,
    };
  } catch {
    return `Generated figure '${relativePath}' could not be read safely.`;
  } finally {
    await file?.close().catch(() => undefined);
  }
}

const disabledObserver: ComputeProjectOutputObserverPort = {
  begin: (projectRoot) => Effect.succeed({ projectRoot, baseline: null, warnings: [] }),
  collect: () => Effect.succeed({ images: [], warnings: [] }),
};

export class ComputeProjectOutputObserver extends Context.Service<
  ComputeProjectOutputObserver,
  ComputeProjectOutputObserverPort
>()("t3/scient/compute/ComputeProjectOutputObserver") {}

const liveObserver: ComputeProjectOutputObserverPort = {
  begin: (projectRoot) =>
    Effect.tryPromise({
      try: async () => {
        const canonicalProjectRoot = await NodeFSP.realpath(projectRoot);
        return {
          canonicalProjectRoot,
          baseline: await snapshotProjectImages(canonicalProjectRoot),
        };
      },
      catch: (cause) => new ProjectOutputObservationFailure({ cause }),
    }).pipe(
      Effect.match({
        onFailure: () => ({
          projectRoot,
          baseline: null,
          warnings: ["Scient could not begin observing generated project figures."],
        }),
        onSuccess: ({ canonicalProjectRoot, baseline }) => ({
          projectRoot: canonicalProjectRoot,
          baseline,
          warnings: [],
        }),
      }),
    ),
  collect: (observation, limits) =>
    observation.baseline === null
      ? Effect.succeed({ images: [], warnings: observation.warnings })
      : Effect.tryPromise({
          try: () => snapshotProjectImages(observation.projectRoot),
          catch: (cause) => new ProjectOutputObservationFailure({ cause }),
        }).pipe(
          Effect.flatMap((after) => {
            if (observation.baseline?.incomplete || after.incomplete) {
              return Effect.succeed({
                images: [],
                warnings: [
                  ...observation.warnings,
                  "Generated figures were not attached because project observation reached its scan limit.",
                ],
              });
            }
            const changed = [...after.files.entries()]
              .filter(([path, state]) => !sameState(observation.baseline?.files.get(path), state))
              .map(([path]) => path)
              .toSorted();
            const countLimited = changed.slice(0, MAXIMUM_IMAGES_PER_EXECUTION);
            const limited: string[] = [];
            let plannedBytes = 0n;
            const maximumBytes = BigInt(Math.max(0, Math.floor(limits.maximumBytes)));
            for (const path of countLimited) {
              const size = after.files.get(path)?.size;
              if (size === undefined || plannedBytes + size > maximumBytes) continue;
              limited.push(path);
              plannedBytes += size;
            }
            return Effect.forEach(limited, (path) =>
              Effect.tryPromise({
                try: () => readObservedImage(observation.projectRoot, path),
                catch: (cause) => new ProjectOutputObservationFailure({ cause }),
              }),
            ).pipe(
              Effect.map((results) => {
                const images = results.filter(
                  (result): result is ObservedComputeProjectImage => typeof result !== "string",
                );
                const warnings = results.filter(
                  (result): result is string => typeof result === "string",
                );
                if (changed.length > countLimited.length) {
                  warnings.push(
                    `Only the first ${String(MAXIMUM_IMAGES_PER_EXECUTION)} generated figures were retained.`,
                  );
                }
                if (countLimited.length > limited.length) {
                  warnings.push(
                    "Some generated figures were not retained because the execution output limit was reached.",
                  );
                }
                return {
                  images,
                  warnings: [...observation.warnings, ...warnings],
                };
              }),
              Effect.orElseSucceed(() => ({
                images: [],
                warnings: [
                  ...observation.warnings,
                  "Scient could not safely retain generated project figures.",
                ],
              })),
            );
          }),
          Effect.orElseSucceed(() => ({
            images: [],
            warnings: [
              ...observation.warnings,
              "Scient could not finish observing generated project figures.",
            ],
          })),
        ),
};

export const disabledLayer = Layer.succeed(ComputeProjectOutputObserver, disabledObserver);
export const liveLayer = Layer.succeed(ComputeProjectOutputObserver, liveObserver);
