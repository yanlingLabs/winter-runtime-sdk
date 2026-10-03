// A recorded input -> output corpus for `mirroredMetadataFields`: 2000 generated metadata objects mixing
// every projected field, unprojected fields and a stray `type`, each holding null/false/0/""/strings/
// numbers/arrays/objects, with the projection recorded for each (compared by deep equality).
import { expect, test } from "bun:test";
import { mirroredMetadataFields } from "../../src/run-home/artifacts.ts";
import corpus from "./__corpus__/metadata-projection.json";

test("the recorded corpus projects exactly as recorded", () => {
  const rows = corpus as Array<{ metadata: Record<string, unknown>; expected: Record<string, unknown> }>;
  expect(rows.length).toBe(2000);
  const mismatches = rows.filter((row) => !Bun.deepEquals(mirroredMetadataFields(row.metadata), row.expected, true));
  expect(mismatches).toEqual([]);
});
