import { describe, expect, it } from "vite-plus/test";
import type { OrchestrationThreadActivity } from "@t3tools/contracts";
import { projectActivityPayload } from "./ActivityPayloadProjection.ts";

function activity(payload: Record<string, unknown>): OrchestrationThreadActivity {
  return {
    id: "activity-1",
    tone: "tool",
    kind: "tool.completed",
    summary: "Tool",
    payload,
    turnId: null,
    createdAt: "2026-08-01T10:00:00.000Z",
  } as unknown as OrchestrationThreadActivity;
}

/**
 * Wire-survival regression: the slimming pass rewrites payload.data but must
 * never strip the top-level per-agent fields the subagent fold depends on.
 * If slimming ever moves to an allowlist over the whole payload, these
 * assertions are the tripwire.
 */
describe("projectActivityPayload", () => {
  it("preserves tool attribution (agentId/parentToolUseId) through data slimming", () => {
    const projected = projectActivityPayload(
      activity({
        itemType: "command_execution",
        agentId: "task-123",
        parentToolUseId: "toolu_abc",
        data: {
          toolName: "Bash",
          input: { command: "ls" },
          command: "ls",
          rawOutput: { content: "x".repeat(10) },
          somethingClientNeverReads: { big: "blob" },
        },
      }),
    );
    const payload = projected.payload as Record<string, unknown>;
    expect(payload.agentId).toBe("task-123");
    expect(payload.parentToolUseId).toBe("toolu_abc");
    // Slimming itself still applies to data.
    const data = payload.data as Record<string, unknown>;
    expect(data.somethingClientNeverReads).toBeUndefined();
  });

  it("keeps a bounded Codex command output summary", () => {
    const projected = projectActivityPayload(
      activity({
        itemType: "command_execution",
        data: {
          item: {
            command: "/bin/zsh -lc 'printf hello'",
            aggregatedOutput: `hello from codex\n${"x".repeat(5000)}`,
          },
        },
      }),
    );
    const data = (projected.payload as Record<string, unknown>).data as Record<string, unknown>;
    expect(data.item).toEqual({
      command: "/bin/zsh -lc 'printf hello'",
      aggregatedOutput: "hello from codex",
    });
    expect(JSON.stringify(projected.payload).length).toBeLessThan(500);
  });

  it("keeps preview normalization and fence-only fallback while scanning lines", () => {
    const preview = projectActivityPayload(
      activity({
        itemType: "command_execution",
        data: { rawOutput: `\`\`\`\n  actual\tresult  \n${"x".repeat(5000)}` },
      }),
    );
    const fences = projectActivityPayload(
      activity({
        itemType: "command_execution",
        data: { rawOutput: "```\r\n \t \n```\n" },
      }),
    );

    expect((preview.payload as { data: { rawOutput: unknown } }).data.rawOutput).toEqual({
      content: "actual result",
    });
    expect((fences.payload as { data: { rawOutput: unknown } }).data.rawOutput).toEqual({
      content: "2 lines",
    });
  });

  it("keeps bounded Claude and ACP command output summaries", () => {
    const claude = projectActivityPayload(
      activity({
        itemType: "command_execution",
        data: {
          command: "printf hello",
          rawOutput: { stdout: `hello from claude\n${"y".repeat(5000)}` },
        },
      }),
    );
    const acp = projectActivityPayload(
      activity({
        itemType: "command_execution",
        data: {
          command: "printf hello",
          content: [
            {
              type: "content",
              content: { type: "text", text: `hello from acp\n${"z".repeat(5000)}` },
            },
          ],
        },
      }),
    );

    const claudeData = (claude.payload as Record<string, unknown>).data as Record<string, unknown>;
    const acpData = (acp.payload as Record<string, unknown>).data as Record<string, unknown>;
    expect(claudeData.rawOutput).toEqual({ content: "hello from claude" });
    expect(acpData.rawOutput).toEqual({ content: "hello from acp" });
    expect(JSON.stringify(claude.payload).length).toBeLessThan(500);
    expect(JSON.stringify(acp.payload).length).toBeLessThan(500);
  });

  it("keeps bounded Claude command input and result summaries", () => {
    const claude = projectActivityPayload(
      activity({
        itemType: "command_execution",
        toolCallId: "claude-call-1",
        data: {
          toolName: "Bash",
          input: { command: "vp test run" },
          result: {
            type: "tool_result",
            content: [
              { type: "text", text: "tests passed" },
              { type: "text", text: "x".repeat(5_000) },
            ],
          },
        },
      }),
    );
    const openCode = projectActivityPayload(
      activity({
        itemType: "command_execution",
        toolCallId: "opencode-call-1",
        data: {
          tool: "bash",
          state: {
            status: "running",
            input: { command: "vp lint" },
            output: "x".repeat(5_000),
          },
        },
      }),
    );

    expect(claude.payload).toMatchObject({
      toolCallId: "claude-call-1",
      data: {
        toolName: "Bash",
        command: "vp test run",
        rawOutput: { content: "tests passed" },
      },
    });
    expect(openCode.payload).toMatchObject({
      toolCallId: "opencode-call-1",
      data: { command: "vp lint" },
    });
    expect(JSON.stringify(claude.payload).length).toBeLessThan(250);
    expect(JSON.stringify(openCode.payload).length).toBeLessThan(200);
  });

  it("keeps full Claude Read image paths through repeated projection", () => {
    const imagePath = `/workspace/${"nested folder/".repeat(16)}reference image.webp`;
    const projected = projectActivityPayload(
      activity({
        itemType: "dynamic_tool_call",
        detail: 'Read: {"file_path":"truncated..."}',
        data: {
          toolName: "Read",
          input: { file_path: imagePath },
          result: { content: "Image Size: 1280x720." },
        },
      }),
    );
    const projectedAgain = projectActivityPayload(projected);

    expect(projected.payload).toMatchObject({ data: { imagePath } });
    expect(projectedAgain.payload).toMatchObject({ data: { imagePath } });

    const textRead = projectActivityPayload(
      activity({
        itemType: "dynamic_tool_call",
        data: { toolName: "Read", input: { file_path: "/workspace/src/index.ts" } },
      }),
    );
    expect(textRead.payload).not.toMatchObject({ data: { imagePath: expect.anything() } });
    expect(textRead.payload).toMatchObject({
      data: { files: [{ path: "/workspace/src/index.ts" }] },
    });
  });

  it("records Cursor read-file rawInput even when it is an empty object", () => {
    const projected = projectActivityPayload(
      activity({
        itemType: "dynamic_tool_call",
        title: "Read file",
        data: {
          toolCallId: "tool-read-raw-input",
          kind: "read",
          rawInput: {},
          rawOutput: { content: "type Waiter = {};\n" },
        },
      }),
    );
    expect(projected.payload).toMatchObject({
      data: {
        kind: "read",
        toolCallId: "tool-read-raw-input",
        rawInput: {},
        rawOutput: { content: "type Waiter = {};" },
      },
    });
  });

  it("keeps files from a Cursor 2026.09.15 refreshed read title and rawInput", () => {
    const projected = projectActivityPayload(
      activity({
        itemType: "dynamic_tool_call",
        title: "Read src/env.ts",
        data: {
          toolCallId: "tool-read-refresh",
          kind: "read",
          rawInput: { path: "/Users/yashsingh/p/projects/ohseearr/src/env.ts" },
          locations: [{ path: "/Users/yashsingh/p/projects/ohseearr/src/env.ts" }],
        },
      }),
    );
    expect(projected.payload).toMatchObject({
      data: {
        kind: "read",
        rawInput: { path: "/Users/yashsingh/p/projects/ohseearr/src/env.ts" },
        files: [{ path: "/Users/yashsingh/p/projects/ohseearr/src/env.ts" }],
      },
    });
  });

  it("keeps a path from rawInput on a recorded read", () => {
    const projected = projectActivityPayload(
      activity({
        itemType: "dynamic_tool_call",
        title: "Read file",
        data: {
          toolCallId: "tool-read-raw-input-path",
          kind: "read",
          rawInput: { path: "/workspace/src/index.ts" },
          rawOutput: { content: "export const value = 1;\n" },
        },
      }),
    );
    expect(projected.payload).toMatchObject({
      data: {
        kind: "read",
        rawInput: { path: "/workspace/src/index.ts" },
        files: [{ path: "/workspace/src/index.ts" }],
      },
    });
  });

  it("keeps a bounded Cursor read-file body so the row can expand without a path", () => {
    const content = "type Waiter = {\n\tresolve: (release: () => void) => void;\n};";
    const projected = projectActivityPayload(
      activity({
        itemType: "dynamic_tool_call",
        title: "Read file",
        data: {
          toolCallId: "tool-read-body",
          kind: "read",
          rawInput: {},
          rawOutput: { content: `${content}\n` },
        },
      }),
    );
    expect(projected.payload).toMatchObject({
      data: {
        kind: "read",
        toolCallId: "tool-read-body",
        rawOutput: { content },
      },
    });
    const data = (projected.payload as { data?: Record<string, unknown> }).data;
    expect(data?.files).toBeUndefined();
  });

  it("keeps ACP read locations as file paths through slimming", () => {
    const projected = projectActivityPayload(
      activity({
        itemType: "dynamic_tool_call",
        title: "Read file",
        data: {
          toolCallId: "tool-read-1",
          kind: "read",
          locations: [{ path: "/tmp/app.ts" }],
          rawInput: {},
          rawOutput: { content: "---\nname: unslop\n" },
        },
      }),
    );
    expect(projected.payload).toMatchObject({
      data: {
        kind: "read",
        files: [{ path: "/tmp/app.ts" }],
      },
    });
    expect(
      (projected.payload as { data?: { rawOutput?: { content?: string } } }).data?.rawOutput
        ?.content,
    ).toBe("---\nname: unslop");
    expect(
      (projected.payload as { data?: { locations?: unknown } }).data?.locations,
    ).toBeUndefined();
  });

  it("keeps the path from an ACP content diff as the read/edit file", () => {
    const projected = projectActivityPayload(
      activity({
        itemType: "file_change",
        title: "Changed files",
        data: {
          toolCallId: "tool-edit-1",
          kind: "edit",
          rawInput: {},
          content: [
            {
              type: "diff",
              path: "/Users/yashsingh/p/projects/ohseearr/scripts/pdf_remediation/remediate.py",
              oldText: "old",
              newText: "new",
            },
          ],
        },
      }),
    );
    expect(projected.payload).toMatchObject({
      data: {
        kind: "edit",
        files: [
          { path: "/Users/yashsingh/p/projects/ohseearr/scripts/pdf_remediation/remediate.py" },
        ],
      },
    });
  });

  it("keeps a path carried on rawOutput for ACP reads", () => {
    const projected = projectActivityPayload(
      activity({
        itemType: "dynamic_tool_call",
        title: "Read file",
        data: {
          toolCallId: "tool-read-2",
          kind: "read",
          rawInput: {},
          rawOutput: {
            path: "/workspace/src/index.ts",
            content: 'import * as Effect from "effect/Effect"\n',
          },
        },
      }),
    );
    expect(projected.payload).toMatchObject({
      data: {
        kind: "read",
        files: [{ path: "/workspace/src/index.ts" }],
      },
    });
    expect(
      (projected.payload as { data?: { rawOutput?: { content?: string } } }).data?.rawOutput
        ?.content,
    ).toBe('import * as Effect from "effect/Effect"');
  });

  it("does not classify a path-like shell command as a changed file", () => {
    const command =
      "find scripts/pdf_remediation src/routes -type f \\( -name '*.py' -o -name '*.ts' \\) -mtime -1 -print0";
    const projected = projectActivityPayload(
      activity({
        itemType: "command_execution",
        title: "Ran command",
        detail: command,
        data: {
          toolCallId: "tool-find-1",
          kind: "execute",
          command,
          rawInput: { command },
        },
      }),
    );
    expect(projected.payload).toMatchObject({
      itemType: "command_execution",
      data: { kind: "execute", command },
    });
    expect((projected.payload as { data?: { files?: unknown } }).data?.files).toBeUndefined();
  });

  it("slims Codex-shaped mcp_tool_call items to rendered fields plus a result summary", () => {
    const projected = projectActivityPayload(
      activity({
        itemType: "mcp_tool_call",
        data: {
          item: {
            type: "mcpToolCall",
            id: "item-1",
            tool: "fetch_pr",
            server: "github",
            status: "completed",
            arguments: { pr: 42 },
            durationMs: 1200,
            result: {
              content: [{ type: "text", text: `PR body line one\n${"x".repeat(5000)}` }],
              structuredContent: { huge: "y".repeat(5000) },
            },
            _meta: { internal: true },
          },
        },
      }),
    );
    const data = (projected.payload as Record<string, unknown>).data as Record<string, unknown>;
    const item = data.item as Record<string, unknown>;
    expect(item.tool).toBe("fetch_pr");
    expect(item.server).toBe("github");
    expect(item.arguments).toEqual({ pr: 42 });
    expect(item._meta).toBeUndefined();
    expect(item.result).toEqual({ content: "PR body line one" });
    expect(JSON.stringify(projected.payload).length).toBeLessThan(500);
  });

  it("slims Claude-shaped mcp_tool_call data (toolName/input/result block)", () => {
    const projected = projectActivityPayload(
      activity({
        itemType: "mcp_tool_call",
        data: {
          toolName: "mcp__github__fetch_pr",
          input: { pr: 42 },
          result: {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: [{ type: "text", text: `first line of output\n${"z".repeat(5000)}` }],
          },
        },
      }),
    );
    const data = (projected.payload as Record<string, unknown>).data as Record<string, unknown>;
    expect(data.toolName).toBe("mcp__github__fetch_pr");
    expect(data.input).toEqual({ pr: 42 });
    expect(data.result).toEqual({ content: "first line of output" });
    expect(JSON.stringify(projected.payload).length).toBeLessThan(500);
  });

  it.each([
    {
      item: {
        server: "t3-code",
        tool: "preview_open",
        result: { structuredContent: { url: "https://example.com/" } },
      },
    },
    {
      toolName: "mcp__t3-code__preview_navigate",
      result: { content: '{"url":"https://example.com/"}' },
    },
    { tool: "t3-code_preview_status", state: { output: '{"url":"https://example.com/"}' } },
    {
      toolName: "mcp__t3_code__preview_snapshot",
      result: {
        content: [
          { type: "text", text: '{"url":"https://example.com/"}' },
          { type: "text", text: "Snapshot text was bounded. Omitted: accessibilityTree." },
        ],
      },
    },
    {
      toolName: "mcp__t3-code__preview_click",
      result: { content: '{"toolIcon":{"_tag":"website","pageUrl":"https://example.com/"}}' },
    },
    {
      toolName: "mcp__t3_code__preview_snapshot",
      result: { content: '{"url":"https://example.com/"}\n{"accessibilityTree":"truncated' },
    },
    ...[false, true].map((truncated) => ({
      toolName: "mcp__t3_code__preview_snapshot",
      result: {
        content: JSON.stringify({
          content: [{ type: "text", text: '{"url":"https://example.com/"}' }],
          structuredContent: { url: "https://example.com/", visibleText: "page" },
        }).slice(0, truncated ? -5 : undefined),
      },
    })),
    ...[
      "type",
      "press",
      "scroll",
      "resize",
      "set_appearance",
      "evaluate",
      "wait_for",
      "recording_start",
      "recording_stop",
    ].map((action) => ({
      toolName: `mcp__t3_code__preview_${action}`,
      result: { content: '{"toolIcon":{"_tag":"website","pageUrl":"https://example.com/"}}' },
    })),
  ])("preserves the preview page favicon through result slimming", (data) => {
    const projected = projectActivityPayload(activity({ itemType: "mcp_tool_call", data }));
    const icon = { _tag: "website", pageUrl: "https://example.com/" };
    expect(projected.payload).toMatchObject({ toolIcon: icon });
    expect(projectActivityPayload(projected).payload).toMatchObject({ toolIcon: icon });
  });

  it.each([
    { toolName: "mcp__other__preview_open", result: { content: '{"url":"https://example.com/"}' } },
    {
      toolName: "mcp__t3-code__preview_evaluate",
      result: { content: '{"url":"https://example.com/"}' },
    },
    {
      toolName: "mcp__t3-code__preview_open",
      result: { isError: true, content: '{"url":"https://example.com/"}' },
    },
    { toolName: "mcp__t3-code__preview_open", result: { content: "malformed JSON" } },
    { toolName: "mcp__t3-code__preview_open", result: { content: '{"url":"about:blank"}' } },
  ])("keeps the fallback for unrelated tools, failed navigation, and missing page URLs", (data) => {
    expect(
      projectActivityPayload(activity({ itemType: "mcp_tool_call", data })).payload,
    ).not.toHaveProperty("toolIcon");
  });

  it("passes task lifecycle payloads (no data field) through untouched", () => {
    const source = activity({
      taskId: "task-9",
      title: "Audit auth",
      role: "explorer",
      model: "opus",
      effort: "high",
      workflowName: "audit-flow",
      phases: [{ index: 0, title: "Audit" }],
      typedUsage: { totalTokens: 1200 },
      runHandles: { runId: "run-1", scriptPath: "/tmp/wf.js" },
      timelineBypass: true,
    });
    const projected = projectActivityPayload(source);
    expect(projected.payload).toEqual(source.payload);
  });
});
