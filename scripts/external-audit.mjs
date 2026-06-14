// Generality proof for AC-7.
//
// Spawns the probe's stdio server, opens a connection to a real,
// third-party MCP server (the official @modelcontextprotocol/
// server-filesystem package, fetched on the fly via `npx -y`),
// runs `probe_report` with `fuzz: true`, and writes the rendered
// Markdown to `examples/transcripts/external-server.md`.
//
// Why npx, not a direct node path: AC-7 is a *generality* proof —
// the whole point is that the probe audits an MCP server it didn't
// ship. `npx -y -p <pkg> <bin>` fetches, caches, and runs the
// upstream package exactly as a third-party operator would.
//
// On failure: exits non-zero with a clear stderr message. If the
// npx fetch itself fails (e.g. the executor is offline), the
// transcript is written as a stub explaining the constraint — the
// plan permits this degraded path for AC-7 only.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { writeFile, mkdir, stat, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Paths + constants
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

const probeBin = resolve(repoRoot, "dist/index.js");
const transcriptPath = resolve(
  repoRoot,
  "examples/transcripts/external-server.md"
);
const allowedDir = "/tmp/mcp-fs-allowed";

const TARGET_PACKAGE = "@modelcontextprotocol/server-filesystem@latest";
const TARGET_BIN = "mcp-server-filesystem";

function fail(msg) {
  console.error(`[external-audit] FAIL: ${msg}`);
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

function pad(s, n) {
  s = String(s);
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

// ---------------------------------------------------------------------------
// Pre-warm: ensure the npx cache has the package and a fresh,
// empty allowed-directory exists. We spawn npx briefly (just long
// enough to print its startup banner and prove the package was
// fetched), then kill it. Subsequent runs hit the cache and are
// fast.
// ---------------------------------------------------------------------------

async function prewarmNpx() {
  console.error(`[external-audit] pre-warming npx cache for ${TARGET_PACKAGE}...`);
  // Spawn the package binary directly with stdin closed and a hard
  // timeout; close() from the parent causes the child to exit.
  const { spawn } = await import("node:child_process");
  const child = spawn(
    "npx",
    ["-y", "-p", TARGET_PACKAGE, TARGET_BIN, allowedDir],
    { stdio: ["ignore", "pipe", "pipe"] }
  );
  // Wait briefly for the banner line that proves the package is
  // installed and the binary started.
  const banner = "Secure MCP Filesystem Server running on stdio";
  let buf = "";
  let resolved = false;
  const onData = (chunk) => {
    buf += chunk.toString("utf8");
    if (!resolved && buf.includes(banner)) {
      resolved = true;
      try { child.kill("SIGTERM"); } catch { /* ignore */ }
    }
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  // Hard timeout — never block the audit for more than 90s.
  const timer = setTimeout(() => {
    if (!resolved) {
      try { child.kill("SIGTERM"); } catch { /* ignore */ }
    }
  }, 90_000);
  await new Promise((resolveP) => {
    child.on("exit", () => resolveP());
    // If spawn itself errored (e.g. npx missing), exit fires too.
  });
  clearTimeout(timer);
  console.error(
    resolved
      ? `[external-audit] pre-warm OK (banner seen)`
      : `[external-audit] pre-warm timed out; continuing anyway`
  );
}

async function ensureAllowedDir() {
  await mkdir(allowedDir, { recursive: true });
}

// ---------------------------------------------------------------------------
// Main: spawn the probe, connect to the external target, run the
// report, write the transcript.
// ---------------------------------------------------------------------------

async function main() {
  await ensureAllowedDir();
  await prewarmNpx();

  const probeTransport = new StdioClientTransport({
    command: "node",
    args: [probeBin],
    stderr: "inherit",
  });
  const probe = new Client(
    { name: "external-audit", version: "0.0.0" },
    { capabilities: {} }
  );
  await probe.connect(probeTransport);

  let transcriptHeader = "";
  let transcriptFooter = "";
  let connectPayload;
  let reportPayload;

  try {
    // (1) Connect to the external third-party MCP server.
    const connectArgs = {
      transport: "stdio",
      command: "npx",
      args: [
        "-y",
        "-p",
        TARGET_PACKAGE,
        TARGET_BIN,
        allowedDir,
      ],
    };
    const connectResult = await probe.callTool({
      name: "probe_connect",
      arguments: connectArgs,
    });
    if (connectResult.isError) {
      const text = connectResult.content?.[0]?.text ?? "(no message)";
      transcriptHeader = renderDegradedTranscript(
        `probe_connect returned isError: ${text}`
      );
      await writeFile(transcriptPath, transcriptHeader, "utf8");
      fail(
        `probe_connect returned isError: ${text}. Transcript written to ${transcriptPath}.`
      );
    }
    connectPayload = JSON.parse(connectResult.content?.[0]?.text ?? "{}");
    if (typeof connectPayload.name !== "string") {
      fail(
        `probe_connect returned no name. Got: ${JSON.stringify(connectPayload)}`
      );
    }
    console.error(
      `[external-audit] connected to ${connectPayload.name} ${connectPayload.version} — tools=${connectPayload.counts?.tools} resources=${connectPayload.counts?.resources} prompts=${connectPayload.counts?.prompts}`
    );

    // (2) Run probe_report with fuzz: true.
    const reportResult = await probe.callTool({
      name: "probe_report",
      arguments: { fuzz: true },
    });
    if (reportResult.isError) {
      const text = reportResult.content?.[0]?.text ?? "(no message)";
      transcriptHeader = renderDegradedTranscript(
        `probe_report returned isError: ${text}`
      );
      await writeFile(transcriptPath, transcriptHeader, "utf8");
      fail(
        `probe_report returned isError: ${text}. Transcript written to ${transcriptPath}.`
      );
    }
    reportPayload = JSON.parse(reportResult.content?.[0]?.text ?? "{}");

    // (3) Verify the structured payload before writing the
    //     transcript. We require an overall score in 0..100 and a
    //     letter grade — these are the "report is real" signals.
    if (typeof reportPayload.overall !== "number") {
      fail(
        `probe_report returned no overall score. Got: ${JSON.stringify(reportPayload).slice(0, 200)}`
      );
    }
    if (!["A", "B", "C", "D", "F"].includes(reportPayload.grade)) {
      fail(
        `probe_report returned no letter grade. Got: ${JSON.stringify(reportPayload.grade)}`
      );
    }
    if (typeof reportPayload.markdown !== "string" || reportPayload.markdown.length === 0) {
      fail("probe_report returned empty markdown");
    }

    // (4) Compose and write the transcript. The transcript leads
    //     with a metadata header (so the file is self-describing),
    //     then embeds the rendered Markdown report verbatim.
    const stamp = new Date().toISOString();
    const parts = [];
    parts.push(renderTranscriptHeader({
      packageName: TARGET_PACKAGE,
      packageBin: TARGET_BIN,
      allowedDir,
      handshake: connectPayload,
      stamp,
    }));
    parts.push(reportPayload.markdown.trimEnd());
    parts.push(renderTranscriptFooter({
      stamp,
      overall: reportPayload.overall,
      grade: reportPayload.grade,
      dimensions: reportPayload.dimensions ?? [],
      findingsCount: Array.isArray(reportPayload.findings) ? reportPayload.findings.length : 0,
      fuzzCount: Array.isArray(reportPayload.fuzz) ? reportPayload.fuzz.length : 0,
    }));
    const transcript = parts.join("\n\n") + "\n";
    await mkdir(dirname(transcriptPath), { recursive: true });
    await writeFile(transcriptPath, transcript, "utf8");

    console.error(
      `[external-audit] transcript written: ${transcriptPath} (${transcript.length} bytes)`
    );
    console.error(
      `[external-audit] overall=${reportPayload.overall}/100 grade=${reportPayload.grade} tools=${connectPayload.counts?.tools} findings=${reportPayload.findings?.length ?? 0} fuzz=${reportPayload.fuzz?.length ?? 0}`
    );
  } finally {
    try {
      await probe.close();
    } catch {
      // best-effort
    }
  }

  // (5) Sanity-check the on-disk file before exiting 0.
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
  if (!/\*\*Grade:\*\*\s+[ABCDF]/.test(contents)) {
    fail(`transcript missing '**Grade:** X' line`);
  }

  console.error("[external-audit] PASS");
}

main().catch((err) => {
  fail(`unexpected error: ${err?.message ?? String(err)}`);
});

// ---------------------------------------------------------------------------
// Transcript renderers
// ---------------------------------------------------------------------------

function renderTranscriptHeader(ctx) {
  const h = ctx.handshake ?? {};
  const lines = [];
  lines.push(`# External MCP server audit — ${h.name ?? "(unknown)"}`);
  lines.push("");
  lines.push(
    `This transcript is the AC-7 **generality proof**: MCProbe (built from this repo) connected to a real, third-party MCP server fetched on the fly via \`npx -y -p ${ctx.packageName} ${ctx.packageBin}\` and scored it 0–100 against the four conformance dimensions.`
  );
  lines.push("");
  lines.push(`**Target package:** \`${ctx.packageName}\``);
  lines.push(`**Target binary:** \`${ctx.packageBin}\``);
  lines.push(`**Allowed directory:** \`${ctx.allowedDir}\``);
  lines.push(`**Target version:** ${h.version ?? "(unknown)"}`);
  lines.push(`**Audit timestamp (UTC):** ${ctx.stamp}`);
  if (h.capabilities && typeof h.capabilities === "object") {
    const keys = Object.keys(h.capabilities);
    if (keys.length > 0) {
      lines.push(`**Target capabilities:** ${keys.sort().join(", ")}`);
    }
  }
  if (h.counts) {
    lines.push(
      `**Tool count:** ${h.counts.tools} tool(s), ${h.counts.resources} resource(s), ${h.counts.prompts} prompt(s)`
    );
  }
  return lines.join("\n");
}

function renderTranscriptFooter(ctx) {
  const lines = [];
  lines.push(`---`);
  lines.push("");
  lines.push(`**Audit summary:** overall ${ctx.overall}/100, grade **${ctx.grade}**, ${ctx.findingsCount} lint finding(s), ${ctx.fuzzCount} fuzz case(s).`);
  if (Array.isArray(ctx.dimensions) && ctx.dimensions.length > 0) {
    lines.push("");
    lines.push(`**Per-dimension scores (out of 10):**`);
    lines.push("");
    lines.push("| Dimension | Score |");
    lines.push("| --- | --- |");
    for (const d of ctx.dimensions) {
      const score = d.notMeasured
        ? "not measured"
        : `${d.score} / 10`;
      lines.push(`| ${d.label} | ${score} |`);
    }
  }
  lines.push("");
  lines.push(`*Generated by MCProbe on ${ctx.stamp}.*`);
  return lines.join("\n");
}

function renderDegradedTranscript(reason) {
  return [
    `# External MCP server audit — degraded`,
    ``,
    `MCProbe could not produce a real audit against an external third-party MCP server because the upstream package fetch or connection failed in this environment.`,
    ``,
    `**Reason:** ${reason}`,
    ``,
    `When run in a network-enabled environment, this script would have fetched \`@modelcontextprotocol/server-filesystem@latest\` via \`npx -y -p <pkg> <bin>\` and written the rendered \`probe_report\` Markdown below.`,
    ``,
    `This degraded stub is the only path the spec permits for AC-7 to exit non-zero while still leaving a self-describing transcript on disk.`,
    ``,
  ].join("\n");
}
