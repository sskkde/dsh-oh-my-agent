/**
 * Minimal type surface for the `@deepseek-ai/dsh-client-ui-primitives` client
 * package. At runtime the DSH web app resolves it through the ModuleLoader's
 * module table (same mechanism as `react`); these declarations exist only for
 * the offline `tsc` check, mirroring `react.d.ts`.
 */
declare module '@deepseek-ai/dsh-client-ui-primitives' {
  /** Anchored popup menu used by the native composer controls (e.g. permission select). */
  export function Menu(props: {
    open: boolean
    items: Array<{ id: string; label: unknown; icon?: unknown }>
    selectedId?: string
    onSelect: (id: string) => void
    onClose: () => void
    side?: 'top' | 'bottom'
    portal?: boolean
    anchor: unknown
  }): unknown
  export const IconChevronDownOutlineRegular: (props: { className?: string }) => unknown
  export const IconAgentPresetOutlineRegular: (props: Record<string, unknown>) => unknown
  export const IconPlanOutlineRegular: (props: Record<string, unknown>) => unknown
  export const IconPlayOutlineRegular: (props: Record<string, unknown>) => unknown
}
