import { describe, expect, it } from "vite-plus/test";

import {
  classifyToolActivity,
  collectToolFilePaths,
  deriveToolActivityPresentation,
  formatReadToolLabel,
  formatSearchToolLabel,
  mergeToolActivityData,
  structuredSearchToolInput,
} from "./toolActivity.ts";

describe("toolActivity", () => {
  it("normalizes command tools to a stable ran-command label", () => {
    expect(
      deriveToolActivityPresentation({
        itemType: "command_execution",
        title: "Terminal",
        detail: "Terminal",
        data: {
          command: "bun run lint",
        },
        fallbackSummary: "Terminal",
      }),
    ).toEqual({
      summary: "Ran command",
      detail: "bun run lint",
    });
  });

  it("uses structured file paths for read-file tools when available", () => {
    expect(
      deriveToolActivityPresentation({
        itemType: "dynamic_tool_call",
        title: "Read File",
        detail: "Read File",
        data: {
          kind: "read",
          locations: [{ path: "/tmp/app.ts" }],
        },
        fallbackSummary: "Read File",
      }),
    ).toEqual({
      summary: "Read file",
      detail: "/tmp/app.ts",
    });
    expect(
      deriveToolActivityPresentation({
        itemType: "dynamic_tool_call",
        title: "Read File",
        detail: "Read File",
        data: {
          kind: "read",
          rawInput: { file_path: "src/session-logic.ts" },
        },
        fallbackSummary: "Read File",
      }),
    ).toEqual({
      summary: "Read file",
      detail: "src/session-logic.ts",
    });
    expect(
      deriveToolActivityPresentation({
        itemType: "dynamic_tool_call",
        title: "Read File",
        data: {
          kind: "read",
          content: [{ type: "diff", path: "/workspace/src/index.ts", newText: "export {}\n" }],
        },
        fallbackSummary: "Read File",
      }),
    ).toEqual({
      summary: "Read file",
      detail: "/workspace/src/index.ts",
    });
    expect(
      deriveToolActivityPresentation({
        itemType: "dynamic_tool_call",
        title: "Read File",
        data: {
          kind: "read",
          rawOutput: { path: "/tmp/app.ts", content: "export const value = 1;\n" },
        },
        fallbackSummary: "Read File",
      }),
    ).toEqual({
      summary: "Read file",
      detail: "/tmp/app.ts",
    });
  });

  it("uses ACP rawInput and locations for a refreshed Cursor read", () => {
    expect(
      deriveToolActivityPresentation({
        itemType: "dynamic_tool_call",
        title: "Read src/env.ts",
        data: {
          kind: "read",
          rawInput: { path: "/Users/yashsingh/p/projects/ohseearr/src/env.ts" },
          locations: [{ path: "/Users/yashsingh/p/projects/ohseearr/src/env.ts" }],
        },
        fallbackSummary: "Read File",
      }),
    ).toEqual({
      summary: "Read file",
      detail: "/Users/yashsingh/p/projects/ohseearr/src/env.ts",
    });
  });

  it("does not invent a path when ACP omits locations and rawInput", () => {
    expect(
      deriveToolActivityPresentation({
        itemType: "dynamic_tool_call",
        title: ".claude/skills/unslop/SKILL.md",
        data: {
          kind: "read",
          rawInput: {},
        },
        fallbackSummary: "Read File",
      }),
    ).toEqual({
      summary: "Read file",
    });
  });

  it("drops duplicated generic read-file detail when no path is available", () => {
    expect(
      deriveToolActivityPresentation({
        itemType: "dynamic_tool_call",
        title: "Read File",
        detail: "Read File",
        data: {
          kind: "read",
          rawInput: {},
        },
        fallbackSummary: "Read File",
      }),
    ).toEqual({
      summary: "Read file",
    });
  });

  it("classifies tools by item type, kind, and tool name", () => {
    expect(
      classifyToolActivity({
        itemType: "command_execution",
        title: "ls -lt scripts/pdf_remediation/README.md",
      }),
    ).toBe("command");
    expect(
      classifyToolActivity({
        data: { kind: "execute", rawInput: { command: "find scripts -type f" } },
      }),
    ).toBe("command");
    expect(classifyToolActivity({ data: { kind: "read" } })).toBe("read");
    expect(classifyToolActivity({ data: { kind: "search" }, itemType: "web_search" })).toBe(
      "search",
    );
    expect(classifyToolActivity({ data: { toolName: "Glob" } })).toBe("search");
    expect(classifyToolActivity({ data: { toolName: "Read" } })).toBe("read");
    expect(classifyToolActivity({ title: "Read File" })).toBe("other");
    expect(
      classifyToolActivity({
        itemType: "file_change",
        requestKind: "command",
      }),
    ).toBe("file_change");
  });

  it("collects named path fields and ignores command strings and file bodies", () => {
    expect(
      collectToolFilePaths({
        kind: "execute",
        command: "ls -lt scripts/pdf_remediation/README.md",
        rawInput: { command: "ls -lt scripts/pdf_remediation/README.md" },
      }),
    ).toEqual([]);
    expect(
      collectToolFilePaths({
        kind: "read",
        rawOutput: { content: 'import * as Effect from "effect/Effect"\n' },
      }),
    ).toEqual([]);
    expect(
      collectToolFilePaths({
        kind: "read",
        content: [{ type: "diff", path: "/workspace/src/index.ts", newText: "export {}\n" }],
      }),
    ).toEqual(["/workspace/src/index.ts"]);
  });

  it("formats Cursor-style search labels from rawInput", () => {
    expect(
      formatSearchToolLabel({
        rawInput: {
          glob: "*.{ts,tsx,js,md,json}",
          path: "/Users/yashsingh/p/projects/t3chat-new",
        },
      }),
    ).toBe("Searched files *.{ts,tsx,js,md,json} in t3chat-new");
    expect(
      formatSearchToolLabel({
        rawInput: { pattern: "workEntryDisplayLabel", path: "apps/web/src" },
      }),
    ).toBe("Searched workEntryDisplayLabel in src");
    expect(formatSearchToolLabel({ rawInput: {} })).toBeUndefined();
  });

  it("copies Claude search args from input without taking write bodies", () => {
    expect(
      structuredSearchToolInput({
        toolName: "Grep",
        input: { pattern: "workEntryDisplayLabel", path: "apps/web/src" },
      }),
    ).toEqual({ pattern: "workEntryDisplayLabel", path: "apps/web/src" });
    expect(
      structuredSearchToolInput({
        toolName: "Edit",
        input: { file_path: "src/a.ts", old_string: "a", new_string: "b".repeat(80) },
      }),
    ).toBeUndefined();
  });

  it("formats read labels as a verb plus the path", () => {
    expect(formatReadToolLabel("src/env.ts")).toBe("Read src/env.ts");
    expect(formatReadToolLabel("src/env.ts", 2)).toBe("Read src/env.ts +2 more");
    expect(formatReadToolLabel("")).toBe("Read file");
  });

  it("keeps the first parsed rawInput when a later event is empty", () => {
    expect(
      mergeToolActivityData(
        { kind: "search", rawInput: { glob: "*.ts", path: "/tmp/app" } },
        { kind: "search", rawInput: {} },
      ),
    ).toEqual({
      kind: "search",
      rawInput: { glob: "*.ts", path: "/tmp/app" },
    });
  });
});
