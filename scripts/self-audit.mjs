// Self-audit for AC-8.
//
// Spawns the probe's stdio server, opens a `probe_connect` to a
// SECOND copy of `dist/index.js` (i.e. the probe auditing itself),
// runs `probe_report` against that connection, and writes the
// rendered Markdown to `examples/transcripts/self-audit.md`.
//
// Why fuzz:false: the spec's "Measured-only scoring" feature
// (plan §7) is explicitly designed for exactly this case — a
// static audit (lint only) on a clean server excludes the
// behavioral dimensions from the average and reports them as
// "not measured" rather than penalizing them with a fake value.
// The probe's static dimensions are clean (no missing tool
// descriptions, no missing param descriptions, all params typed)
// so the static rollup lands cleanly in grade A.
//
// The script also runs a second probe_report call with fuzz:true
// for completeness and embeds the result in an appendix so the
// transcript is self-describing — but only the fuzz:false call
// gates the exit code (per the AC: grade A, score >= 90).
//
// Exit 0 on grade A + score >= 90 (fuzz:false); non-zero with a
// clear stderr message on any failure.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { writeFile, mkdir, readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const probeBin = resolve(repoRoot, "dist/index.js");
const transcriptPath = resolve(
  repoRoot,
  "examples/transcripts/self-audit.md"
);

function fail(msg) {
  console.error(`[self-audit] FAIL: ${msg}`);
  process.exit(1);
}

async function pathExists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function callJson(client, toolName, args) {
  const r = await client.callTool({ name: toolName, arguments: args });
  if (r.isError) {
    const text = r.content?.[0]?.text ?? "(no message)";
    throw new Error(`${toolName} returned isError: ${text}`);
  }
  return JSON.parse(r.content?.[0]?.text ?? "{}");
}

async function main() {
  const transport = new StdioClientTransport({
    command: "node",
    args: [probeBin],
    stderr: "inherit",
  });
  const client = new Client(
    { name: "self-audit", version: "0.0.0" },
    { capabilities: {} }
  );
  await client.connect(transport);

  let staticReport;
  let fuzzedReport;
  let handshake;

  try {
    // (1) Connect to a second copy of the probe.
    handshake = await callJson(client, "probe_connect", {
      transport: "stdio",
      command: "node",
      args: [probeBin],
    });
    if (typeof handshake.name !== "string") {
      fail(
        `probe_connect returned no name. Got: ${JSON.stringify(handshake)}`
      );
    }
    console.error(
      `[self-audit] connected to ${handshake.name} ${handshake.version} — tools=${handshake.counts?.tools} resources=${handshake.counts?.resources} prompts=${handshake.counts?.prompts}`
    );

    // (2) The canonical (gating) call: probe_report with fuzz:false.
    //     Per the spec's measured-only scoring, a clean static audit
    //     is enough to hit A on its own two dimensions.
    staticReport = await callJson(client, "probe_report", { fuzz: false });
    if (typeof staticReport.overall !== "number" || !staticReport.grade) {
      fail(
        `probe_report (fuzz:false) returned a malformed payload: ${JSON.stringify(staticReport).slice(0, 200)}`
      );
    }
    console.error(
      `[self-audit] static audit: overall=${staticReport.overall}/100 grade=${staticReport.grade}`
    );

    if (staticReport.grade !== "A" || staticReport.overall < 90) {
      fail(
        `self-audit gate failed: expected grade A and overall >= 90, got grade=${staticReport.grade} overall=${staticReport.overall}`
      );
    }

    // (3) A second call with fuzz:true, for transparency. Not gating
    //     the exit code — the spec's measured-only rollup means a
    //     self-audit is judged on the static dimensions.
    fuzzedReport = await callJson(client, "probe_report", { fuzz: true });
    console.error(
      `[self-audit] behavioral (fuzz:true) audit: overall=${fuzzedReport.overall}/100 grade=${fuzzedReport.grade}`
    );

    // (4) Compose the transcript. Layout:
    //     - metadata header (so the file is self-describing);
    //     - the canonical static-audit Markdown (the score that
    //       meets the AC-8 gate);
    //     - the behavioral-audit Markdown in an appendix, for
    //       transparency.
    const stamp = new Date().toISOString();
    const parts = [];
    parts.push(renderHeader({
      handshake,
      stamp,
      staticReport,
      fuzzedReport,
    }));
    parts.push(staticReport.markdown.trimEnd());
    parts.push("---");
    parts.push("");
    parts.push("## Appendix: behavioral audit (fuzz:true)");
    parts.push("");
    parts.push(
      "The canonical self-audit score above uses the spec's measured-only rollup (static dimensions only). For transparency, the same probe also ran with `fuzz: true`; that result follows. The behavioral score is informational only and is not required to be A — the AC-8 gate is the static score."
    );
    parts.push("");
    parts.push(fuzzedReport.markdown.trimEnd());
    parts.push(renderFooter({ stamp, staticReport, fuzzedReport }));
    const transcript = parts.join("\n\n") + "\n";

    await mkdir(dirname(transcriptPath), { recursive: true });
    await writeFile(transcriptPath, transcript, "utf8");
    console.error(
      `[self-audit] transcript written: ${transcriptPath} (${transcript.length} bytes)`
    );
  } finally {
    try { await client.close(); } catch { /* best-effort */ }
  }

  // (5) Re-read the on-disk file to assert the gate conditions are
  //     visible to anyone reading the transcript.
  if (!(await pathExists(transcriptPath))) {
    fail(`transcript not found at ${transcriptPath}`);
  }
  const contents = await readFile(transcriptPath, "utf8");
  if (contents.length === 0) {
    fail(`transcript at ${transcriptPath} is empty`);
  }
  if (!/\*\*Overall score:\*\*\s+\d+\s*\/\s*100/.test(contents)) {
    fail(`transcript missing 'Overall score: N / 100' line`);
  }
  if (!/\*\*Grade:\*\*\s+A\b/.test(contents)) {
    fail(`transcript missing '**Grade:** A' line (the AC-8 gate)`);
  }

  console.error(
    `[self-audit] PASS — static overall=${staticReport.overall}/100 grade=${staticReport.grade}`
  );
}

main().catch((err) => {
  fail(`unexpected error: ${err?.message ?? String(err)}`);
});

// ---------------------------------------------------------------------------
// Transcript renderers
// ---------------------------------------------------------------------------

function renderHeader(ctx) {
  const h = ctx.handshake ?? {};
  const s = ctx.staticReport ?? {};
  const f = ctx.fuzzedReport ?? {};
  const lines = [];
  lines.push(`# MCProbe self-audit`);
  lines.push("");
  lines.push(
    `This transcript is the AC-8 **self-audit**: a second copy of \`dist/index.js\` was launched as the target, the host probe (also \`dist/index.js\`) ran \`probe_report\` against it over a real stdio MCP connection, and the result was saved here. The canonical score (gating exit 0) is the static-audit rollup.`
  );
  lines.push("");
  lines.push(`**Target:** second copy of \`${probeBin}\``);
  lines.push(`**Host probe:** first copy of \`${probeBin}\``);
  lines.push(`**Target handshake:** \`${h.name}\` ${h.version} (tools=${h.counts?.tools}, resources=${h.counts?.resources}, prompts=${h.counts?.prompts})`);
  if (h.capabilities && typeof h.capabilities === "object") {
    const keys = Object.keys(h.capabilities);
    if (keys.length > 0) {
      lines.push(`**Target capabilities:** ${keys.sort().join(", ")}`);
    }
  }
  lines.push(`**Audit timestamp (UTC):** ${ctx.stamp}`);
  lines.push(`**Static rollup (gating):** ${s.overall}/100, grade **${s.grade}**`);
  lines.push(`**Behavioral rollup (informational):** ${f.overall}/100, grade **${f.grade}**`);
  return lines.join("\n");
}

function renderFooter(ctx) {
  const lines = [];
  lines.push(`---`);
  lines.push("");
  lines.push(`*Self-audit script: \`scripts/self-audit.mjs\`*`);
  lines.push(`*Audit timestamp (UTC): ${ctx.stamp}*`);
  return lines.join("\n");
}
