import { describe, expect, it } from "vite-plus/test";

import {
  initialPreviewImageTransitionState,
  previewImageSourceToken,
  reducePreviewImageTransition,
} from "./previewImageTransition";

const source = (name: string, revisionKey = name) => ({
  url: `/signed/${name}`,
  alt: name,
  revisionKey,
});

describe("preview image transitions", () => {
  it("keeps the last decoded image while a replacement loads", () => {
    const first = source("first");
    const second = source("second");
    let state = initialPreviewImageTransitionState(first);
    state = reducePreviewImageTransition(state, {
      _tag: "loaded",
      token: previewImageSourceToken(first),
    });
    state = reducePreviewImageTransition(state, { _tag: "source", source: second });
    expect(state.displayed).toEqual(first);
    expect(state.pending).toEqual(second);
  });

  it("ignores late loads and retains the last good image after failure", () => {
    const first = source("first");
    const second = source("second");
    const third = source("third");
    let state = reducePreviewImageTransition(initialPreviewImageTransitionState(first), {
      _tag: "loaded",
      token: previewImageSourceToken(first),
    });
    state = reducePreviewImageTransition(state, { _tag: "source", source: second });
    state = reducePreviewImageTransition(state, { _tag: "source", source: third });
    state = reducePreviewImageTransition(state, {
      _tag: "loaded",
      token: previewImageSourceToken(second),
    });
    expect(state.displayed).toEqual(first);
    state = reducePreviewImageTransition(state, {
      _tag: "failed",
      token: previewImageSourceToken(third),
    });
    expect(state).toEqual({ displayed: first, pending: null, failed: true });
  });

  it("accepts a renewed URL for the same content without changing its identity", () => {
    const first = source("first-url", "same-bytes");
    const renewed = source("renewed-url", "same-bytes");
    let state = reducePreviewImageTransition(initialPreviewImageTransitionState(first), {
      _tag: "loaded",
      token: previewImageSourceToken(first),
    });
    state = reducePreviewImageTransition(state, { _tag: "source", source: renewed });
    state = reducePreviewImageTransition(state, {
      _tag: "loaded",
      token: previewImageSourceToken(renewed),
    });
    expect(state.displayed).toEqual(renewed);
  });

  it("retries the same URL without changing its content identity", () => {
    const first = source("same-url", "same-bytes");
    const retry = { ...first, loadKey: "retry-1" };
    let state = reducePreviewImageTransition(initialPreviewImageTransitionState(first), {
      _tag: "failed",
      token: previewImageSourceToken(first),
    });
    state = reducePreviewImageTransition(state, { _tag: "source", source: retry });
    expect(state.pending).toEqual(retry);
    state = reducePreviewImageTransition(state, {
      _tag: "loaded",
      token: previewImageSourceToken(retry),
    });
    expect(state.displayed).toEqual(retry);
  });
});
