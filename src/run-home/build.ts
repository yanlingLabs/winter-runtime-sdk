// WS-21 §3: the run-home builder. Filled in by lane L2's tasks L2.1-L2.5; this is the signature L3
// compiles against from L2.0 on.
import { RuntimeSdkError } from "../errors.ts";
import type { RunHome, RunHomeInput } from "./types.ts";

/** Builds `<home>/cache/runs/<uuid>` for one generation (spec §3). */
export async function buildRunHome(input: RunHomeInput): Promise<RunHome> {
  void input;
  throw new RuntimeSdkError("winter-runtime-sdk: buildRunHome is declared (Contract A) and lands in L2.1");
}
