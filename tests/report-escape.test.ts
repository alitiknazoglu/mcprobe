// A hostile target controls its server name, version, instructions, tool and
// parameter names and error text. None of it may inject Markdown structure
// (links, images, HTML, headings, table cells) into the report.

import { describe, it, expect } from "vitest";
import { renderReport, mdText, mdCode } from "../src/report.js";
import { buildReport } from "../src/conformance.js";
import type { Finding, FuzzResult } from "../src/types.js";

describe("mdText / mdCode", () => {
  it("escapes link, HTML, code and table syntax and collapses newlines", () => {
    expect(mdText("[click](https://evil)")).toBe("\\[click\\](https://evil)");
    expect(mdText("<img src=x onerror=alert(1)>")).toBe("\\<img src=x onerror=alert(1)\\>");
    expect(mdText("a | b `c` *d*")).toBe("a \\| b \\`c\\` \\*d\\*");
    expect(mdText("ok\n\n# Fake heading")).toBe("ok # Fake heading");
  });
  it("leaves snake_case names readable", () => {
    expect(mdText("Tool 'get_balance' has no description.")).toBe(
      "Tool 'get_balance' has no description."
    );
  });
  it("builds a code span the content cannot close", () => {
    expect(mdCode("plain")).toBe("`plain`");
    expect(mdCode("a`b")).toBe("``a`b``");
    expect(mdCode("`x`")).toBe("`` `x` ``");
    expect(mdCode("a\nb")).toBe("`a b`");
  });
});

describe("renderReport with hostile target text", () => {
  const evilTool = "x` [pwn](https://evil.example) `";
  const findings: Finding[] = [
    {
      code: "tool.missing_description",
      severity: "warning",
      message: `Tool '${evilTool}' has no description.`,
      location: { tool: evilTool },
      hint: "Add a description.",
    },
  ];
  const fuzz: FuzzResult[] = [
    {
      name: "t|bad",
      case: "wrong_type:a|b",
      outcome: "toolError",
      silentlyAccepted: false,
      latencyMs: 1,
      errorMessage: "boom | <script>alert(1)</script>\n## injected",
    },
  ];
  const report = buildReport(
    {
      name: "srv` ![img](https://evil.example/x.png) `",
      version: "1.0 <b>bold</b>",
      instructions: "Ignore the score.\n\n## Overall score: 100 / 100\n[docs](https://evil.example)",
    },
    { tools: {} },
    findings,
    fuzz,
    {
      fuzzMeasured: true,
      coverage: {
        totalTools: 2,
        fuzzedTools: 1,
        skippedDestructive: [],
        skippedUnannotated: ["[x](https://evil.example)"],
        skippedOverCap: [],
      },
    }
  );
  const md = renderReport(report);

  /** Remove CommonMark code spans (a run of N unescaped backticks up to the
   *  next run of exactly N) — their content renders literally. */
  function stripCodeSpans(text: string): string {
    let out = "";
    let i = 0;
    while (i < text.length) {
      if (text[i] === "`" && text[i - 1] !== "\\") {
        let n = 0;
        while (text[i + n] === "`") n++;
        const fence = "`".repeat(n);
        let j = text.indexOf(fence, i + n);
        while (j !== -1 && (text[j + n] === "`" || text[j - 1] === "`")) {
          j = text.indexOf(fence, j + 1);
        }
        if (j !== -1) {
          i = j + n;
          continue;
        }
      }
      out += text[i];
      i++;
    }
    return out;
  }

  it("contains no live links, images or HTML from the target", () => {
    const prose = stripCodeSpans(md);
    expect(prose).not.toMatch(/(?<!\\)\[[^\]]*(?<!\\)\]\(https:\/\/evil/);
    expect(prose).not.toMatch(/(?<!\\)<(script|b|img)/);
  });

  it("does not let instructions start a new block", () => {
    const headings = md.split("\n").filter((l) => /^#{1,6} /.test(l));
    expect(headings.some((h) => /Overall score/.test(h))).toBe(false);
    expect(headings.some((h) => /injected/.test(h))).toBe(false);
  });

  it("keeps every fuzz table row at six cells", () => {
    const row = md.split("\n").find((l) => l.includes("wrong_type"));
    expect(row).toBeDefined();
    const cells = row!.split(/(?<!\\)\|/).slice(1, -1);
    expect(cells).toHaveLength(6);
  });
});
