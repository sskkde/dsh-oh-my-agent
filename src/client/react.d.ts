/**
 * Minimal type surface for the `react` external used by the client bundle.
 * At runtime the DSH web app resolves `react` through the ModuleLoader's
 * require; these declarations exist only for the offline `tsc` type check.
 */
declare module 'react' {
  export interface ReactNode {}
  export function createElement(
    type: any,
    props?: Record<string, any> | null,
    ...children: any[]
  ): any
  export function useState<T>(initial: T | (() => T)): [T, (v: T | ((prev: T) => T)) => void]
  export function useCallback<T extends (...args: never[]) => unknown>(
    fn: T,
    deps: unknown[],
  ): T
  export function useEffect(fn: () => void | (() => void), deps?: unknown[]): void
}
