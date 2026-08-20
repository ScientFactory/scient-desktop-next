import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  ComputeExecutionRequestRecord,
  ComputeExecutionResultRecord,
  ComputeExecutionSource,
  ComputeSessionJournalEntry,
  ComputeSessionRecord,
  EMPTY_COMPUTE_SESSION_STORAGE,
} from "./record.ts";

const decodeSession = Schema.decodeUnknownSync(ComputeSessionRecord);
const encodeSession = Schema.encodeUnknownSync(ComputeSessionRecord);
const decodeSource = Schema.decodeUnknownSync(ComputeExecutionSource);
const decodeRequest = Schema.decodeUnknownSync(ComputeExecutionRequestRecord);
const decodeResult = Schema.decodeUnknownSync(ComputeExecutionResultRecord);
const decodeJournalEntry = Schema.decodeUnknownSync(ComputeSessionJournalEntry);

const OBSERVED_AT = "2026-08-20T09:00:00.000Z";

const session = {
  sessionId: "session-1",
  projectId: "project-1",
  label: "Analysis",
  languageId: "python",
  transportKind: "jupyter-bridge",
  workingDirectory: "/projects/one",
  runtime: null,
  identity: null,
  environmentFingerprint: null,
  generation: 1,
  status: "starting",
  activity: "idle",
  activeExecutionId: null,
  pendingCount: 0,
  storage: EMPTY_COMPUTE_SESSION_STORAGE,
  createdAt: OBSERVED_AT,
  lastActivityAt: OBSERVED_AT,
  closedAt: null,
  lostReason: null,
};

describe("compute session record", () => {
  it("survives a round trip through the form it is stored in", () => {
    const decoded = decodeSession(session);
    // The stored form is what a later version has to read back, so equality
    // with the input is the property under test, not merely that it decodes.
    expect(encodeSession(decoded)).toEqual(session);
  });

  it("carries the identity of what answered separately from the runtime that was asked for", () => {
    const decoded = decodeSession({
      ...session,
      status: "ready",
      runtime: {
        languageId: "python",
        source: "path",
        executable: "/usr/bin/python3",
        languageVersion: "3.12.13",
        architecture: "arm64",
        displayName: "Python 3.12.13",
      },
      identity: {
        languageId: "python",
        transportKind: "jupyter-bridge",
        protocolVersion: 1,
        languageVersion: "3.12.13",
        platform: "darwin",
        transportProcessId: 4001,
        runtimeProcessId: 4002,
      },
    });

    // Two processes, because stopping the session has to reach both and a
    // record that stored one would leak the other.
    expect(decoded.identity?.transportProcessId).toBe(4001);
    expect(decoded.identity?.runtimeProcessId).toBe(4002);
  });

  it("refuses a generation below the first one", () => {
    // Generation 0 would name a namespace that never existed, and a stale
    // command written against it could never be recognised as stale.
    expect(() => decodeSession({ ...session, generation: 0 })).toThrow();
  });

  it("refuses a negative pending count", () => {
    expect(() => decodeSession({ ...session, pendingCount: -1 })).toThrow();
  });

  it("refuses a stored status the lifecycle does not have", () => {
    expect(() => decodeSession({ ...session, status: "paused" })).toThrow();
  });

  it("refuses a timestamp that is not an instant", () => {
    expect(() => decodeSession({ ...session, createdAt: "yesterday" })).toThrow();
  });
});

describe("compute execution source", () => {
  it("accepts a console execution with no locator at all", () => {
    expect(decodeSource({ _tag: "console" })).toEqual({ _tag: "console" });
  });

  it("accepts a document execution with a range", () => {
    const decoded = decodeSource({
      _tag: "document",
      origin: "selection",
      path: "notebooks/one.py",
      bufferState: "saved",
      revision: "3",
      range: { startLine: 10, startColumn: 0, endLine: 12, endColumn: 4 },
    });
    expect(decoded).toMatchObject({
      _tag: "document",
      origin: "selection",
      bufferState: "saved",
    });
  });

  it("accepts a document execution whose revision and range are unknown", () => {
    // An untracked buffer has neither. Requiring them would force a caller to
    // invent a revision, which is worse than recording that there was none.
    const decoded = decodeSource({
      _tag: "document",
      origin: "file",
      path: "scratch.py",
      bufferState: "dirty",
      revision: null,
      range: null,
    });
    expect(decoded).toMatchObject({ bufferState: "dirty", revision: null, range: null });
  });

  it("never stores a locator on a console execution, whatever it was handed", () => {
    // The union exists for this. Decoding drops what the member has no field
    // for, so a console execution cannot come back out carrying a path -- which
    // would leave a reader unable to tell a missing locator from a meaningless
    // one.
    expect(decodeSource({ _tag: "console", path: "scratch.py" })).toEqual({ _tag: "console" });
  });

  it("refuses a document execution with no path", () => {
    expect(() =>
      decodeSource({
        _tag: "document",
        origin: "file",
        bufferState: "saved",
        revision: null,
        range: null,
      }),
    ).toThrow();
  });

  it("requires the caller to say whether document bytes matched the saved file", () => {
    expect(() =>
      decodeSource({
        _tag: "document",
        origin: "selection",
        path: "notebooks/one.py",
        revision: "3",
        range: null,
      }),
    ).toThrow();
  });
});

describe("compute execution records", () => {
  const request = {
    executionId: "execution-1",
    sessionId: "session-1",
    generation: 1,
    code: "print(1)\n",
    codeHash: "sha256:abc",
    source: { _tag: "console" as const },
    submittedAt: OBSERVED_AT,
    environmentFingerprint: null,
  };

  it("stores the submitted code with the namespace it was written against", () => {
    const decoded = decodeRequest(request);
    expect(decoded.generation).toBe(1);
    expect(decoded.code).toBe("print(1)\n");
  });

  it("refuses code beyond the stream text bound", () => {
    // The same bound the wire has: a record that accepted more than a transport
    // could carry would be unsendable, and less would be unstorable.
    expect(() => decodeRequest({ ...request, code: "x".repeat(1024 * 1024 + 1) })).toThrow();
    expect(() => decodeRequest({ ...request, code: "é".repeat(600_000) })).toThrow();
  });

  it("keeps a result that has not started separate from one that has", () => {
    const queued = decodeResult({
      executionId: "execution-1",
      status: "queued",
      outcome: null,
      queuePosition: 2,
      startedAt: null,
      finishedAt: null,
      diagnostics: [],
      outputCount: 0,
      outputBytes: 0,
      truncated: false,
      failureReason: null,
    });
    expect(queued.queuePosition).toBe(2);
    expect(queued.startedAt).toBeNull();
  });

  it("bounds how many diagnostics one execution may store", () => {
    const diagnostic = { errorName: "ValueError", message: "bad", traceback: [] };
    expect(() =>
      decodeResult({
        executionId: "execution-1",
        status: "failed",
        outcome: "failed",
        queuePosition: null,
        startedAt: OBSERVED_AT,
        finishedAt: OBSERVED_AT,
        diagnostics: Array.from({ length: 65 }, () => diagnostic),
        outputCount: 1,
        outputBytes: 4,
        truncated: false,
        failureReason: null,
      }),
    ).toThrow();
  });
});

describe("compute session journal", () => {
  it("attributes an entry to a generation and, when there is one, an execution", () => {
    const decoded = decodeJournalEntry({
      sequence: 4,
      observedAt: OBSERVED_AT,
      event: "execution-started",
      generation: 2,
      executionId: "execution-1",
      detail: null,
    });
    expect(decoded).toMatchObject({ event: "execution-started", generation: 2 });
  });

  it("accepts a session-level entry with no execution", () => {
    const decoded = decodeJournalEntry({
      sequence: 0,
      observedAt: OBSERVED_AT,
      event: "session-created",
      generation: 1,
      executionId: null,
      detail: null,
    });
    expect(decoded.executionId).toBeNull();
  });

  it("refuses an event name it does not know", () => {
    // A closed set: an unrecognised entry read back after an upgrade should
    // fail loudly rather than be rendered as nothing.
    expect(() =>
      decodeJournalEntry({
        sequence: 0,
        observedAt: OBSERVED_AT,
        event: "session-vanished",
        generation: 1,
        executionId: null,
        detail: null,
      }),
    ).toThrow();
  });
});
