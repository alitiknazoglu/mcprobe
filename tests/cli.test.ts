// CLI: argument parsing, the MCPROBE_TARGET_TOKEN + --stdio regression,
// --stdio quoting, push target redaction and ingest-endpoint checks.

import { describe, it, expect, afterEach } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  parseArgs,
  runCli,
  splitCommandLine,
  describeTargetForUpload,
  checkEndpoint,
} from "../src/cli.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const demoBin = resolve(__dirname, "..", "examples/demo-target/dist/index.js");

/** Run the CLI with stdout/stderr captured and env overrides applied. */
async function run(argv: string[], env: Record<string, string | undefined> = {}) {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  let stdout = "";
  let stderr = "";
  const ow = process.stdout.write;
  const ew = process.stderr.write;
  process.stdout.write = (s: string) => ((stdout += s), true);
  process.stderr.write = (s: string) => ((stderr += s), true);
  try {
    const code = await runCli(argv);
    return { code, stdout, stderr };
  } finally {
    process.stdout.write = ow;
    process.stderr.write = ew;
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe("MCPROBE_TARGET_TOKEN with --stdio (regression)", () => {
  it("parseArgs does not turn the env token into headers for a stdio target", () => {
    const a = parseArgs(["--stdio", "node server.js"], { MCPROBE_TARGET_TOKEN: "sk_x" });
    expect(a.headers).toBeUndefined();
  });

  it("still applies the env token to an HTTP target", () => {
    const a = parseArgs(["https://example.com/mcp"], { MCPROBE_TARGET_TOKEN: "sk_x" });
    expect(a.headers).toEqual({ Authorization: "Bearer sk_x" });
  });

  it("an explicit --bearer still wins for HTTP", () => {
    const a = parseArgs(["https://e.com/mcp", "--bearer", "flag"], {
      MCPROBE_TARGET_TOKEN: "env",
    });
    expect(a.headers?.Authorization).toBe("Bearer flag");
  });

  it("a stdio audit succeeds while MCPROBE_TARGET_TOKEN is set", async () => {
    const r = await run(["audit", "--stdio", `node ${demoBin}`, "--json"], {
      MCPROBE_TARGET_TOKEN: "sk_should_not_matter",
    });
    expect(r.stderr).not.toMatch(/--bearer\/--header apply to HTTP/);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).server.name).toBe("demo-target");
  });

  it("explicit --bearer with --stdio is still rejected", async () => {
    const r = await run(["audit", "--stdio", `node ${demoBin}`, "--bearer", "x"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/apply to HTTP targets/);
  });
});

describe("splitCommandLine", () => {
  it("splits on whitespace", () => {
    expect(splitCommandLine("  npx  -y @acme/srv ")).toEqual(["npx", "-y", "@acme/srv"]);
  });
  it("keeps quoted arguments together", () => {
    expect(splitCommandLine(`node "/path with space/s.js" --name 'a b'`)).toEqual([
      "node",
      "/path with space/s.js",
      "--name",
      "a b",
    ]);
  });
  it("handles escapes and empty quoted args", () => {
    expect(splitCommandLine(String.raw`echo a\ b "x\"y" ''`)).toEqual(["echo", "a b", 'x"y', ""]);
  });
  it("rejects an unterminated quote", () => {
    expect(() => splitCommandLine(`node "oops`)).toThrow(/unterminated/);
  });
});

describe("describeTargetForUpload", () => {
  const d = (stdio: string) => describeTargetForUpload({ stdio }, "/Users/alice");

  it("redacts the value after a secret-named flag", () => {
    expect(d("node s.js --api-key sk_live_abcdef123456")).toBe("stdio: node s.js --api-key ***");
    expect(d("node s.js --token=abc")).toBe("stdio: node s.js --token=***");
  });
  it("redacts secret-named NAME=value pairs", () => {
    expect(d("env GITHUB_TOKEN=ghp_xxx node s.js")).toBe("stdio: env GITHUB_TOKEN=*** node s.js");
  });
  it("redacts credential-shaped values and URL credentials", () => {
    expect(d("srv ghp_1234567890abcdef")).toBe("stdio: srv ***");
    expect(d("srv https://u:p@h.example/x?api_key=k")).toBe(
      "stdio: srv https://***@h.example/x?api_key=***"
    );
  });
  it("keeps ordinary args and shortens the home directory", () => {
    expect(d("npx -y @acme/sketch-mcp /Users/alice/proj/server.js --port 3000")).toBe(
      "stdio: npx -y @acme/sketch-mcp ~/proj/server.js --port 3000"
    );
  });
  it("redacts credentials in an HTTP target URL", () => {
    expect(describeTargetForUpload({ url: "https://h.example/mcp?token=abc" })).toBe(
      "https://h.example/mcp?token=***"
    );
  });
});

describe("checkEndpoint", () => {
  it("accepts https and loopback http", () => {
    expect(checkEndpoint("https://mcprobe.org/api/ingest")).toBeNull();
    expect(checkEndpoint("http://localhost:3000/api/ingest")).toBeNull();
    expect(checkEndpoint("http://127.0.0.1:3000/api/ingest")).toBeNull();
  });
  it("refuses plain http elsewhere and other schemes", () => {
    expect(checkEndpoint("http://mcprobe.org/api/ingest")).toMatch(/non-https/);
    expect(checkEndpoint("ftp://x/y")).toMatch(/non-https/);
    expect(checkEndpoint("nope")).toMatch(/invalid/);
  });
});

describe("push", () => {
  let close: (() => void) | undefined;
  afterEach(() => close?.());

  it("refuses a non-https --to before auditing", async () => {
    const r = await run(["push", "--stdio", `node ${demoBin}`, "--token", "t", "--to", "http://evil.example/x"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/non-https/);
  });

  it("refuses a non-https MCPROBE_API", async () => {
    const r = await run(["push", "--stdio", `node ${demoBin}`, "--token", "t"], {
      MCPROBE_API: "http://evil.example/x",
    });
    expect(r.code).toBe(2);
  });

  it("uploads a redacted target, never the raw command line", async () => {
    let body = "";
    const server = createServer((req, res) => {
      req.on("data", (c: unknown) => (body += String(c)));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ url: "http://localhost/r/1" }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    close = () => server.close();
    const { port } = server.address() as AddressInfo;

    const r = await run([
      "push",
      "--stdio",
      `node ${demoBin} --api-key sk_live_supersecret123`,
      "--token",
      "ingest-token",
      "--to",
      `http://127.0.0.1:${port}/api/ingest`,
    ]);
    expect(r.code).toBe(0);
    const sent = JSON.parse(body) as { target: string; transport: string };
    expect(sent.transport).toBe("stdio");
    expect(sent.target).toMatch(/^stdio: node .*index\.js --api-key \*\*\*$/);
    expect(body).not.toContain("sk_live_supersecret123");
  });
});
