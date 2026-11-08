// The spawned target is untrusted code: it must not see the probe's own
// secrets. Unit-tests buildStdioEnv(), then proves it end to end by spawning
// a fixture server that echoes its environment back.

import { describe, it, expect, afterEach } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { buildStdioEnv, connectStdio, callTool } from "../src/target-client.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = resolve(__dirname, "fixtures/env-echo-server.mjs");

const SECRETS = {
  MCPROBE_TOKEN: "mcp_secret_ingest",
  MCPROBE_TARGET_TOKEN: "sk_secret_target",
  GITHUB_TOKEN: "ghp_secret",
  AWS_SECRET_ACCESS_KEY: "aws_secret",
};

describe("buildStdioEnv", () => {
  it("does not inherit arbitrary parent variables", () => {
    const env = buildStdioEnv(undefined, undefined, { ...SECRETS, PATH: "/bin" });
    for (const k of Object.keys(SECRETS)) expect(env).not.toHaveProperty(k);
  });

  it("keeps the SDK's minimal default environment (PATH)", () => {
    expect(buildStdioEnv()).toHaveProperty("PATH");
  });

  it("forwards only the parent variables named in passEnv", () => {
    const env = buildStdioEnv(undefined, ["GITHUB_TOKEN", "NOT_SET"], SECRETS);
    expect(env.GITHUB_TOKEN).toBe("ghp_secret");
    expect(env).not.toHaveProperty("MCPROBE_TOKEN");
    expect(env).not.toHaveProperty("NOT_SET");
  });

  it("applies explicit env last, so it can override the base", () => {
    const env = buildStdioEnv({ PATH: "/custom", FOO: "bar" }, ["GITHUB_TOKEN"], {
      GITHUB_TOKEN: "x",
    });
    expect(env.PATH).toBe("/custom");
    expect(env.FOO).toBe("bar");
  });
});

describe("connectStdio environment isolation (end to end)", () => {
  const saved: Record<string, string | undefined> = {};
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("a spawned target sees neither MCPROBE_* tokens nor other parent secrets", async () => {
    for (const [k, v] of Object.entries(SECRETS)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
    const conn = await connectStdio({
      command: process.execPath,
      args: [fixture],
      env: { EXPLICIT: "yes" },
      passEnv: ["GITHUB_TOKEN"],
    });
    try {
      const r = await callTool(conn, "env", {});
      expect(r.ok).toBe(true);
      const first = r.content[0] as { text: string };
      const seen = JSON.parse(first.text) as Record<string, string>;
      expect(seen).not.toHaveProperty("MCPROBE_TOKEN");
      expect(seen).not.toHaveProperty("MCPROBE_TARGET_TOKEN");
      expect(seen).not.toHaveProperty("AWS_SECRET_ACCESS_KEY");
      expect(seen.GITHUB_TOKEN).toBe("ghp_secret"); // explicitly forwarded
      expect(seen.EXPLICIT).toBe("yes");
    } finally {
      await conn.client.close();
    }
  });
});
