// WS-18 W18-14 (P10b) — THE CLAUDE-READY STORE: the ONE place the official leg's `sessionStore.load()`
// stops returning the canonical entries verbatim and starts returning `toClaudeReady`'s pure copy.
//
// WHY A WRAPPER AND NOT A CHANGE TO THE CANONICAL STORE. The canonical transcript stays byte-pure —
// `toClaudeReady` is a PURE fold over what `load()` returns, never a write, and every append this
// branch makes still lands through the underlying store, untouched. Wrapping `load()` alone is what
// "the router wraps the sessionStore it hands the official leg" (spec, `official/options-template.ts:165`)
// means: appends and every other member of `SessionStore` pass straight through to the real store.
//
// WHAT THE COPY DOES (`toClaudeReady`, `@yanlinglabs/winter-provider-runtime`): translates legacy
// Winter compaction into Claude's native shape, stamps `message.id`/`type` on assistant entries that
// lack them, remaps a tool id the pinned artifact would reject, drops foreign `thinking`/
// `redacted_thinking` blocks the destination's replay domain cannot use, and adds per-message
// reasoning decorations for foreign assistant messages — all from the CANONICAL entries plus the
// provider-state sidecar, read fresh on every `load()` (never cached, never washed back).
import type { SessionKey, SessionStore, SessionStoreEntry } from "@yanlinglabs/winter-agent-sdk";
import { toClaudeReady, type ContinuityEndpoint } from "@yanlinglabs/winter-provider-runtime";
import type { MessageOrigin, ProviderStateRecord } from "@yanlinglabs/winter-provider-runtime";

export type { ProviderStateRecord };

export interface ClaudeReadyStoreDeps {
  /** The provider-state sidecar for `key`, read fresh — never cached across calls. */
  readSidecar(key: SessionKey): Promise<ProviderStateRecord[]>;
  /** Turns a stamped `MessageOrigin` into full endpoint facts (`createEndpointResolver`, or a host's own). */
  resolveEndpoint: (origin: MessageOrigin) => ContinuityEndpoint;
  /** What the destination — this official session itself — would run this on. */
  target: ContinuityEndpoint;
}

/**
 * Wraps `store` so `load()` returns `toClaudeReady(canonical entries, sidecar, { target, resolveEndpoint })`.
 *
 * `append` and every other member of `SessionStore` are the SAME functions the underlying store
 * exports — delegated explicitly, one per optional member, rather than by spreading `store` (a
 * class-instance store's methods live on its prototype, which a spread would silently drop). A store
 * with no `load()` result (`null`, an unknown session) returns `null` — there is nothing to make
 * Claude-ready out of.
 */
export function claudeReadyStore(store: SessionStore, deps: ClaudeReadyStoreDeps): SessionStore {
  const wrapped: SessionStore = {
    append: (key: SessionKey, entries: SessionStoreEntry[]) => store.append(key, entries),
    async load(key: SessionKey): Promise<SessionStoreEntry[] | null> {
      const canonical = await store.load(key);
      if (canonical === null) return null;
      const sidecar = await deps.readSidecar(key);
      const { entries } = toClaudeReady(canonical, sidecar, { target: deps.target, resolveEndpoint: deps.resolveEndpoint });
      return entries;
    },
  };
  if (store.listSessions !== undefined) wrapped.listSessions = (projectKey: string) => store.listSessions!(projectKey);
  if (store.listSessionSummaries !== undefined) wrapped.listSessionSummaries = (projectKey: string) => store.listSessionSummaries!(projectKey);
  if (store.delete !== undefined) wrapped.delete = (key: SessionKey) => store.delete!(key);
  if (store.listSubkeys !== undefined) wrapped.listSubkeys = (key: { projectKey: string; sessionId: string }) => store.listSubkeys!(key);
  return wrapped;
}
