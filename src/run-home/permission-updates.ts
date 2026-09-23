// WS-21 §4.3 (F21): PERMISSION UPDATES ARE SESSION-ONLY, on both legs.
//
// A permission result's `updatedPermissions` names where each rule update is written. Every durable
// destination is a settings file the RUNTIME would write itself — and `localSettings` is the
// repository's own `<project dir>/settings.local.json`, for which the pinned runtime also appends a
// git exclude to the user's global excludes file (F21, measured). Under WS-21 the DAEMON writes every
// settings file (an "everywhere" answer to `sdk/settings.json`, an "in this project" answer to the
// local tier), so the router lets a runtime keep a rule for the SESSION and nothing longer: every
// destination other than `session` — the three settings tiers and `cliArg` — is rewritten to it.
//
// One function, both legs: the official bridge runs it over the broker's answer, and the Winter leg
// wraps the host's `canUseTool` with it. Logged once per process, names only (never a rule's content).
import type { PermissionResult } from "@yanlinglabs/winter-agent-sdk";

let warned = false;

/** Test-only: forget that the one-time warning was printed. */
export function resetSessionOnlyWarning(): void {
  warned = false;
}

/** `result` with every non-`session` update destination rewritten to `session`; by identity when nothing changes. */
export function sessionOnlyPermissionUpdates<T extends PermissionResult | null | undefined>(result: T): T {
  if (result === null || result === undefined || typeof result !== "object") return result;
  const updates = (result as { updatedPermissions?: unknown }).updatedPermissions;
  if (!Array.isArray(updates)) return result;
  const rewritten: string[] = [];
  const next = updates.map((update: unknown) => {
    if (update === null || typeof update !== "object") return update;
    const destination = (update as { destination?: unknown }).destination;
    if (destination === "session") return update;
    rewritten.push(String(destination));
    return { ...(update as Record<string, unknown>), destination: "session" };
  });
  if (rewritten.length === 0) return result;
  if (!warned) {
    warned = true;
    // eslint-disable-next-line no-console
    console.warn(
      `winter-runtime-sdk: a permission update asked for the ${[...new Set(rewritten)].join(", ")} destination; it was kept for this session only — the host writes every settings file itself (WS-21 §4.3). This is logged once per process.`,
    );
  }
  return { ...(result as object), updatedPermissions: next } as T;
}
