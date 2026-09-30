/**
 * DSH 0.1.7 removed the shared catch-all `'plugin'` message source. Every
 * producer now declares its own `kind` through the merge-extensible
 * `MessageSourceMap` (`@deepseek-ai/dsh-llm` message.d.ts: "each producer
 * declares its own `kind` in its own module; there is no shared catch-all
 * `plugin` kind").
 *
 * This module is that declaration for dsh-oh-my-agent, mirroring the shipped
 * `agent-instructions` / `skill-invocation` producers. It is types-only: the
 * runtime keeps no kind registry and consumers fall through unknown kinds, so
 * no host call is needed for the notice to round-trip through the session log.
 */

/**
 * Producer kind stamped on every user message the hook layer injects.
 *
 * A short stable noun rather than the scoped package id, matching the shipped
 * kinds (`agent-instructions`, `skill-invocation`, `ptc-mode`): the value is
 * durable in the session log, so it must not track package renames.
 */
export const OMO_MESSAGE_KIND = 'oh-my-agent'

/**
 * A one-off account of something that just happened. `notice`-form context
 * supersedes nothing and carries the one-line summary the transcript shows
 * without expanding the row (`ContextFormed` in dsh-llm's message.d.ts).
 */
export interface OmoNoticeSource {
  readonly kind: typeof OMO_MESSAGE_KIND
  readonly form: 'notice'
  /** One-line account, bounded by CONTEXT_SUMMARY_MAX_CHARS. */
  readonly summary: string
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** A notice injected by the dsh-oh-my-agent hook layer. */
    'oh-my-agent': OmoNoticeSource
  }
}
