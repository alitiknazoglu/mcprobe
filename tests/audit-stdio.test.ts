// Integration test for the stdio library entry: auditStdio() spawns the
// bundled demo target over stdio and produces a full conformance report —
// the same shape auditUrl() returns for HTTP servers.
//
// `pretest` (npm run build) builds the demo target first, so its binary at
// examples/demo-target/dist/index.js is present when this runs.

import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { auditStdio } from "../src/audit.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const demoBin = resolve(__dirname, "..", "examples/demo-target/dist/index.js");

describe("auditStdio (library entry)", () => {
  it("audits a local stdio server and returns a scored report", async () => {
    expect(existsSync(demoBin), `demo target not built: ${demoBin}`).toBe(true);

    // The demo target declares no annotations, so its tools need the opt-in.
    const report = await auditStdio("node", {
      args: [demoBin],
      fuzz: true,
      fuzzUnannotated: true,
    });

    // Same report contract as auditUrl.
    expect(typeof report.overall).toBe("number");
    expect(report.overall).toBeGreaterThanOrEqual(0);
    expect(report.overall).toBeLessThanOrEqual(100);
    expect(["A", "B", "C", "D", "F"]).toContain(report.grade);
    expect(report.dimensions.length).toBe(4);
    expect(report.server.name.length).toBeGreaterThan(0);

    // Fuzzing ran → behavioral dimensions are measured and coverage exists.
    expect(report.coverage).toBeDefined();
    expect(report.fuzz.length).toBeGreaterThan(0);
  }, 30_000);
});
