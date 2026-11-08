// probe_connect takes its command/env/url from an agent, which may be acting
// on a prompt injection. These tests pin the operator gate: stdio spawning is
// off unless MCPROBE_ALLOW_STDIO allows it, and URLs to loopback / private /
// metadata addresses are refused. Unit tests on the policy module, then an
// end-to-end check against the built probe over stdio.

import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  assertPublicUrl,
  checkStdioAllowed,
  classifyAddress,
  guardedFetch,
  readPassEnv,
  readStdioPolicy,
  readUrlPolicy,
} from "../src/connect-policy.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const probeBin = resolve(__dirname, "..", "dist/index.js");
const demoBin = resolve(__dirname, "..", "examples/demo-target/dist/index.js");

describe("stdio spawn gate", () => {
  it("is off when MCPROBE_ALLOW_STDIO is unset or blank", () => {
    expect(readStdioPolicy({})).toEqual({ mode: "off" });
    expect(readStdioPolicy({ MCPROBE_ALLOW_STDIO: "  " })).toEqual({ mode: "off" });
    expect(checkStdioAllowed({ mode: "off" }, "node", ["x.js"])).toMatch(/disabled/);
  });

  it('"*" allows any command', () => {
    const p = readStdioPolicy({ MCPROBE_ALLOW_STDIO: "*" });
    expect(checkStdioAllowed(p, "bash", ["-c", "anything"], { NODE_OPTIONS: "x" })).toBeNull();
  });

  it("an allowlist admits only exact command lines", () => {
    const p = readStdioPolicy({
      MCPROBE_ALLOW_STDIO: "node /srv/a.js ;  npx -y @acme/server ",
    });
    expect(checkStdioAllowed(p, "node", ["/srv/a.js"])).toBeNull();
    expect(checkStdioAllowed(p, "npx", ["-y", "@acme/server"])).toBeNull();
    expect(checkStdioAllowed(p, "node", ["/srv/b.js"])).toMatch(/not in MCPROBE_ALLOW_STDIO/);
    expect(checkStdioAllowed(p, "node", ["/srv/a.js", "--evil"])).toMatch(/not in/);
    expect(checkStdioAllowed(p, "node", ["-e", "process.exit()"])).toMatch(/not in/);
  });

  it("an allowlist refuses code-loading env vars", () => {
    const p = readStdioPolicy({ MCPROBE_ALLOW_STDIO: "node /srv/a.js" });
    for (const k of ["NODE_OPTIONS", "LD_PRELOAD", "DYLD_INSERT_LIBRARIES", "PATH", "PYTHONPATH"]) {
      expect(checkStdioAllowed(p, "node", ["/srv/a.js"], { [k]: "x" })).toMatch(/may not set/);
    }
    expect(checkStdioAllowed(p, "node", ["/srv/a.js"], { API_KEY: "x" })).toBeNull();
  });

  it("reads MCPROBE_PASS_ENV as a comma-separated list", () => {
    expect(readPassEnv({ MCPROBE_PASS_ENV: "A, B,,C " })).toEqual(["A", "B", "C"]);
    expect(readPassEnv({})).toEqual([]);
  });
});

describe("URL guard", () => {
  const strict = { allowPrivate: false };
  const lax = { allowPrivate: true };
  const resolveTo = (addrs: string[]) => async () => addrs;

  it("classifies addresses", () => {
    expect(classifyAddress("8.8.8.8")).toBe("public");
    expect(classifyAddress("127.0.0.1")).toBe("private");
    expect(classifyAddress("10.1.2.3")).toBe("private");
    expect(classifyAddress("172.20.0.1")).toBe("private");
    expect(classifyAddress("192.168.1.1")).toBe("private");
    expect(classifyAddress("169.254.169.254")).toBe("linkLocal");
    expect(classifyAddress("::1")).toBe("private");
    expect(classifyAddress("fd00::1")).toBe("private");
    expect(classifyAddress("fe80::1")).toBe("linkLocal");
    expect(classifyAddress("::ffff:127.0.0.1")).toBe("private");
    expect(classifyAddress("::ffff:a9fe:a9fe")).toBe("linkLocal");
    expect(classifyAddress("2606:4700::1111")).toBe("public");
  });

  it("refuses non-http schemes", async () => {
    await expect(assertPublicUrl("file:///etc/passwd", lax)).rejects.toThrow(/scheme/);
  });

  it("refuses loopback/private targets by default and allows them on opt-in", async () => {
    await expect(assertPublicUrl("http://127.0.0.1:8080/mcp", strict)).rejects.toThrow(/private/);
    await expect(assertPublicUrl("http://localhost:8080/mcp", strict)).rejects.toThrow(/local/);
    await expect(assertPublicUrl("http://[::1]/mcp", strict)).rejects.toThrow(/private/);
    await expect(assertPublicUrl("http://127.0.0.1:8080/mcp", lax)).resolves.toBeUndefined();
    await expect(assertPublicUrl("http://localhost:8080/mcp", lax)).resolves.toBeUndefined();
  });

  it("always refuses link-local / cloud metadata, even on opt-in", async () => {
    await expect(assertPublicUrl("http://169.254.169.254/latest", lax)).rejects.toThrow(/link-local/);
    await expect(assertPublicUrl("http://metadata.google.internal/", lax)).rejects.toThrow(/metadata/);
  });

  it("checks every address a hostname resolves to", async () => {
    await expect(
      assertPublicUrl("https://ok.example/mcp", strict, resolveTo(["93.184.216.34"]))
    ).resolves.toBeUndefined();
    await expect(
      assertPublicUrl("https://evil.example/mcp", strict, resolveTo(["93.184.216.34", "10.0.0.5"]))
    ).rejects.toThrow(/private/);
  });

  it("guardedFetch re-checks each request and refuses redirects", async () => {
    const seen: unknown[] = [];
    const base = (async (_u: unknown, init?: unknown) => {
      seen.push(init);
      return {} as Response;
    }) as unknown as Parameters<typeof guardedFetch>[1];
    const f = guardedFetch(strict, base);
    await expect(f("http://10.0.0.1/mcp", {})).rejects.toThrow(/private/);
    expect(seen).toHaveLength(0);
    await f("http://8.8.8.8/mcp", { method: "POST" });
    expect(seen[0]).toMatchObject({ method: "POST", redirect: "error" });
  });

  it("reads MCPROBE_ALLOW_PRIVATE_URLS", () => {
    expect(readUrlPolicy({}).allowPrivate).toBe(false);
    expect(readUrlPolicy({ MCPROBE_ALLOW_PRIVATE_URLS: "1" }).allowPrivate).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// End to end: the built probe, driven over stdio like a real host would.
// ---------------------------------------------------------------------------

async function withProbe<T>(
  extraEnv: Record<string, string>,
  fn: (c: Client) => Promise<T>
): Promise<T> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [probeBin],
    env: { ...getDefaultEnvironment(), ...extraEnv },
    stderr: "pipe",
  });
  const client = new Client({ name: "policy-test", version: "0.0.0" });
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

function text(r: unknown): string {
  const c = (r as { content?: Array<{ text?: string }> }).content ?? [];
  return c.map((p) => p.text ?? "").join("\n");
}

describe("probe_connect gate (end to end)", () => {
  it("refuses stdio spawning when the operator has not opted in", async () => {
    await withProbe({}, async (c) => {
      const r = await c.callTool({
        name: "probe_connect",
        arguments: { transport: "stdio", command: process.execPath, args: [demoBin] },
      });
      expect(r.isError).toBe(true);
      expect(text(r)).toMatch(/MCPROBE_ALLOW_STDIO/);
    });
  });

  it("spawns an allowlisted command line and refuses any other", async () => {
    await withProbe({ MCPROBE_ALLOW_STDIO: `${process.execPath} ${demoBin}` }, async (c) => {
      const okRes = await c.callTool({
        name: "probe_connect",
        arguments: { transport: "stdio", command: process.execPath, args: [demoBin] },
      });
      expect(okRes.isError).toBeFalsy();

      const bad = await c.callTool({
        name: "probe_connect",
        arguments: { transport: "stdio", command: process.execPath, args: ["-e", "1"] },
      });
      expect(bad.isError).toBe(true);
      expect(text(bad)).toMatch(/not in MCPROBE_ALLOW_STDIO/);
      await c.callTool({ name: "probe_disconnect", arguments: {} });
    });
  });

  it("refuses an http url on a loopback address by default", async () => {
    await withProbe({}, async (c) => {
      const r = await c.callTool({
        name: "probe_connect",
        arguments: { transport: "http", url: "http://127.0.0.1:9/mcp" },
      });
      expect(r.isError).toBe(true);
      expect(text(r)).toMatch(/MCPROBE_ALLOW_PRIVATE_URLS/);
    });
  });
});
