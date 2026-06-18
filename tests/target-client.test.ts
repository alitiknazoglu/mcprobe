// Unit tests for safeList() in src/target-client.ts.
//
// Introspection (listing a target's tools/resources/prompts during connect)
// must never crash the probe. Regression for the case where a target does not
// implement an optional method and stays silent instead of returning
// "method not found": the SDK times out (-32001), and that error must be
// swallowed into an empty list rather than escaping and killing the connect.

import { describe, it, expect } from "vitest";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { safeList } from "../src/target-client.js";

/** Build a stub Client whose list* methods are overridden per test. */
function fakeClient(overrides: Partial<Record<string, unknown>>): Client {
  return {
    listTools: async () => ({ tools: [] }),
    listResources: async () => ({ resources: [] }),
    listPrompts: async () => ({ prompts: [] }),
    ...overrides,
  } as unknown as Client;
}

describe("safeList", () => {
  it("returns the listed items on success", async () => {
    const client = fakeClient({
      listTools: async () => ({ tools: [{ name: "a" }, { name: "b" }] }),
    });
    expect(await safeList(client, "tools")).toHaveLength(2);
  });

  it("returns [] when the server times out (-32001) instead of throwing", async () => {
    const client = fakeClient({
      listResources: async () => {
        throw new Error("MCP error -32001: Request timed out");
      },
    });
    await expect(safeList(client, "resources")).resolves.toEqual([]);
  });

  it("returns [] when the method is not implemented (-32601)", async () => {
    const client = fakeClient({
      listPrompts: async () => {
        throw new Error("MCP error -32601: Method not found");
      },
    });
    await expect(safeList(client, "prompts")).resolves.toEqual([]);
  });

  it("returns [] on any unexpected transport error", async () => {
    const client = fakeClient({
      listResources: async () => {
        throw new Error("socket hang up");
      },
    });
    await expect(safeList(client, "resources")).resolves.toEqual([]);
  });
});
