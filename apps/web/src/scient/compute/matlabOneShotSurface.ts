import { useSyncExternalStore } from "react";

const visibleByPath = new Map<string, boolean>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function showMatlabOneShotSurface(relativePath: string): void {
  visibleByPath.set(relativePath, true);
  emit();
}

export function hideMatlabOneShotSurface(relativePath: string): void {
  visibleByPath.delete(relativePath);
  emit();
}

export function isMatlabOneShotSurfaceVisible(relativePath: string | null): boolean {
  return relativePath !== null && visibleByPath.get(relativePath) === true;
}

export function useMatlabOneShotSurface(relativePath: string | null): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => isMatlabOneShotSurfaceVisible(relativePath),
    () => false,
  );
}
