import type { Options, Query } from "@yanlinglabs/winter-agent-sdk";
import { createGuestRuntimeSpawn, GuestRuntimeError, type GuestLaunch, type GuestRuntimeProcessChannel, type GuestCleanupAttempt } from "./process.ts";

export const GUEST_QUERY_TRANSPORT_CONTRACT_VERSION = 1;
export type GuestQueryOptions = Pick<Options, "model" | "permissionMode" | "maxTurns" | "resume" | "persistSession" | "allowedTools" | "disallowedTools" | "abortController" | "stderr" | "maxBufferSize">;
const acceptedOptions = new Set(["model", "permissionMode", "maxTurns", "resume", "persistSession", "allowedTools", "disallowedTools", "abortController", "stderr", "maxBufferSize"]);
export interface GuestQueryTransport {
  readonly contractVersion: typeof GUEST_QUERY_TRANSPORT_CONTRACT_VERSION;
  query(args: { prompt: string | AsyncIterable<string>; options?: GuestQueryOptions }): Query;
  cleanupAttempts(): readonly GuestCleanupAttempt[];
  retryCleanup(launchAttemptId: string): Promise<boolean>;
}
/** Separate guest door: does not create a local RunHome, router directory or credential callback. */
export function createGuestQueryTransport(input: {
  peer: Pick<typeof import("@yanlinglabs/winter-agent-sdk"), "query">;
  launch: GuestLaunch;
  channel: GuestRuntimeProcessChannel;
  maxBufferedBytes?: number;
  startupTimeoutMs?: number;
  cleanupTimeoutMs?: number;
}): GuestQueryTransport {
  const spawn = createGuestRuntimeSpawn(input);
  const sessionId = input.launch.identity.sessionId;
  const cwd = input.launch.cwd;
  const brand = input.launch.brand === undefined ? undefined : Object.freeze({ ...input.launch.brand });
  return {
    contractVersion: GUEST_QUERY_TRANSPORT_CONTRACT_VERSION,
    cleanupAttempts: spawn.cleanupAttempts,
    retryCleanup: spawn.retryCleanup,
    query(args) {
      for (const key of Object.keys(args.options ?? {})) if (!acceptedOptions.has(key)) throw new GuestRuntimeError("unsupported_launch_config", `guest query option ${key} requires a separate admitted capability`);
      return input.peer.query({ prompt: args.prompt, options: { ...args.options, ...(brand ? { brand } : {}), sessionId, cwd, spawnClaudeCodeProcess: spawn } });
    },
  };
}
