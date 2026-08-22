export interface PreviewImageSource {
  readonly url: string;
  readonly alt: string;
  /** Stable content identity. URL-only callers still reset when their source changes. */
  readonly revisionKey?: string;
  /** Forces a fresh decode attempt without claiming the rendered bytes changed. */
  readonly loadKey?: string;
}

export interface PreviewImageTransitionState {
  readonly displayed: PreviewImageSource | null;
  readonly pending: PreviewImageSource | null;
  readonly failed: boolean;
}

export type PreviewImageTransitionAction =
  | { readonly _tag: "source"; readonly source: PreviewImageSource }
  | { readonly _tag: "loaded"; readonly token: string }
  | { readonly _tag: "failed"; readonly token: string };

export function previewImageSourceToken(source: PreviewImageSource): string {
  return JSON.stringify([source.revisionKey ?? source.url, source.url, source.loadKey ?? null]);
}

export function initialPreviewImageTransitionState(
  source: PreviewImageSource,
): PreviewImageTransitionState {
  return { displayed: null, pending: source, failed: false };
}

/**
 * Keeps the last successfully decoded image visible until its replacement is
 * ready. Load events carry a source token, so a late response from an older
 * signed URL cannot replace a newer revision.
 */
export function reducePreviewImageTransition(
  state: PreviewImageTransitionState,
  action: PreviewImageTransitionAction,
): PreviewImageTransitionState {
  switch (action._tag) {
    case "source": {
      const token = previewImageSourceToken(action.source);
      if (state.pending && previewImageSourceToken(state.pending) === token) {
        return state.pending.alt === action.source.alt
          ? state
          : { ...state, pending: action.source };
      }
      if (!state.pending && state.displayed && previewImageSourceToken(state.displayed) === token) {
        return state.displayed.alt === action.source.alt
          ? state
          : { ...state, displayed: action.source };
      }
      return { ...state, pending: action.source, failed: false };
    }
    case "loaded":
      return state.pending && previewImageSourceToken(state.pending) === action.token
        ? { displayed: state.pending, pending: null, failed: false }
        : state;
    case "failed":
      return state.pending && previewImageSourceToken(state.pending) === action.token
        ? { ...state, pending: null, failed: true }
        : state;
  }
}
