import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
} from "react";

import {
  nudgeScientSplitFraction,
  scientSplitFractionFromPointer,
  type ScientSplitAxis,
  type ScientSplitFractionBounds,
} from "./scientSplitFraction";

interface UseScientSplitOptions extends ScientSplitFractionBounds {
  readonly active: boolean;
  readonly axis?: ScientSplitAxis;
  readonly fraction: number;
  readonly keyboardStep: number;
  readonly onCommit: (fraction: number) => void;
}

interface DragState {
  readonly pointerId: number;
  readonly target: HTMLDivElement;
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  readonly startFraction: number;
  pendingFraction: number;
  frame: number | null;
}

/**
 * Fractional split behavior shared by Scient file surfaces. The inherited
 * right panel intentionally keeps both its component and pixel-width policy
 * unchanged; visual parity with its separator is guarded without coupling it
 * to this Scient-owned behavior.
 */
export function useScientSplit(options: UseScientSplitOptions) {
  const containerRef = useRef<HTMLDivElement>(null);
  const primaryPaneRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const axis = options.axis ?? "x";
  const bounds = useMemo(
    () => ({ minimum: options.minimum, fallback: options.fallback }),
    [options.fallback, options.minimum],
  );

  useLayoutEffect(() => {
    const pane = primaryPaneRef.current;
    if (pane === null || dragRef.current !== null) return;
    pane.style.flexBasis = options.active ? `${options.fraction * 100}%` : "";
  }, [options.active, options.fraction]);

  const releaseDrag = useCallback((drag: DragState) => {
    if (drag.frame !== null) cancelAnimationFrame(drag.frame);
    try {
      if (drag.target.hasPointerCapture(drag.pointerId)) {
        drag.target.releasePointerCapture(drag.pointerId);
      }
    } catch {
      // Pointer capture may already have been released by the browser.
    }
    document.body.style.removeProperty("cursor");
    document.body.style.removeProperty("user-select");
    dragRef.current = null;
  }, []);

  useEffect(
    () => () => {
      const drag = dragRef.current;
      if (drag !== null) releaseDrag(drag);
    },
    [releaseDrag],
  );

  useEffect(() => {
    if (options.active) return;
    const drag = dragRef.current;
    if (drag !== null) releaseDrag(drag);
    primaryPaneRef.current?.style.removeProperty("flex-basis");
  }, [options.active, releaseDrag]);

  useEffect(() => {
    const drag = dragRef.current;
    if (drag !== null) releaseDrag(drag);
  }, [axis, releaseDrag]);

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const container = containerRef.current;
      if (container === null || event.button !== 0) return;
      const rect = container.getBoundingClientRect();
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        return;
      }
      dragRef.current = {
        pointerId: event.pointerId,
        target: event.currentTarget,
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
        startFraction: options.fraction,
        pendingFraction: options.fraction,
        frame: null,
      };
      document.body.style.cursor = axis === "y" ? "row-resize" : "col-resize";
      document.body.style.userSelect = "none";
      event.preventDefault();
    },
    [axis, options.fraction],
  );

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (drag === null || drag.pointerId !== event.pointerId) return;
      event.preventDefault();
      drag.pendingFraction =
        axis === "y"
          ? scientSplitFractionFromPointer(
              {
                pointerY: event.clientY,
                top: drag.top,
                height: drag.height,
              },
              bounds,
            )
          : scientSplitFractionFromPointer(
              {
                pointerX: event.clientX,
                left: drag.left,
                width: drag.width,
              },
              bounds,
            );
      if (drag.frame !== null) return;
      drag.frame = requestAnimationFrame(() => {
        const active = dragRef.current;
        if (active === null) return;
        active.frame = null;
        primaryPaneRef.current?.style.setProperty("flex-basis", `${active.pendingFraction * 100}%`);
      });
    },
    [axis, bounds],
  );

  const onPointerUp = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (drag === null || drag.pointerId !== event.pointerId) return;
      const next = drag.pendingFraction;
      releaseDrag(drag);
      options.onCommit(next);
    },
    [options.onCommit, releaseDrag],
  );

  const onPointerCancel = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (drag === null || drag.pointerId !== event.pointerId) return;
      releaseDrag(drag);
      primaryPaneRef.current?.style.setProperty("flex-basis", `${drag.startFraction * 100}%`);
    },
    [releaseDrag],
  );

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      const next = nudgeScientSplitFraction(
        options.fraction,
        event.key,
        bounds,
        options.keyboardStep,
        axis,
      );
      if (next === null) return;
      event.preventDefault();
      options.onCommit(next);
    },
    [axis, bounds, options.fraction, options.keyboardStep, options.onCommit],
  );

  return {
    containerRef,
    primaryPaneRef,
    separatorHandlers: {
      onKeyDown,
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel,
    },
  } as const;
}
