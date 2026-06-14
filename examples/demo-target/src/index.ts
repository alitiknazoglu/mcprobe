// Deliberately flawed MCP target used to exercise MCProbe's lint and fuzz
// pipeline. The four tools below mirror the spec section §9a:
//   greet        — no description, untyped parameter
//   divide       — no type guard, silently returns NaN on bad input
//   set_mode     — enum param with no description, thin tool description
//   well_behaved — full description, validates input, returns isError on bad input

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer(
  {
    name: "demo-target",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// (1) greet — no description, untyped parameter.
server.tool(
  "greet",
  // intentionally omitted description to trigger tool.missing_description
  // intentionally omitted param description to trigger param.missing_description
  {
    name: z.any().optional(),
  },
  async (args) => {
    const name = (args as { name?: unknown }).name;
    return {
      content: [
        {
          type: "text" as const,
          text: `hello, ${String(name ?? "stranger")}`,
        },
      ],
    };
  }
);

// (2) divide — no type guard; silently returns NaN on bad input.
server.tool(
  "divide",
  "Divide two numbers and return the quotient.",
  {
    a: z.any().optional(),
    b: z.any().optional(),
  },
  async (args) => {
    const a = (args as { a?: unknown }).a;
    const b = (args as { b?: unknown }).b;
    // Intentional: no validation, no Number.isFinite guard.
    const result = Number(a) / Number(b);
    return {
      content: [
        { type: "text" as const, text: JSON.stringify({ result }) },
      ],
    };
  }
);

// (3) set_mode — enum param with no description, thin tool description.
server.tool(
  "set_mode", // intentionally short description; long enough to avoid tool.missing_description
  "Set mode.",
  {
    mode: z.enum(["fast", "safe", "verbose"]),
  },
  async (args) => {
    const mode = (args as { mode: string }).mode;
    return {
      content: [{ type: "text" as const, text: `mode=${mode}` }],
    };
  }
);

// (4) well_behaved — full description, validates input, returns isError on bad input.
server.tool(
  "well_behaved",
  "Echo the provided greeting message after validating that it is a non-empty string.",
  {
    greeting: z.string().min(1).describe("A non-empty greeting to echo back."),
  },
  async (args) => {
    const greeting = (args as { greeting: string }).greeting;
    if (typeof greeting !== "string" || greeting.length === 0) {
      return {
        isError: true,
        content: [
          { type: "text" as const, text: "greeting must be a non-empty string" },
        ],
      };
    }
    return {
      content: [{ type: "text" as const, text: greeting }],
    };
  }
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[demo-target] stdio server ready");
}

main().catch((err) => {
  console.error("[demo-target] fatal:", err);
  process.exit(1);
});
