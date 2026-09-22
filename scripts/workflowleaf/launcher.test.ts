// @effect-diagnostics nodeBuiltinImport:off
// The launcher is a shell script, so the test builds a checkout on disk and runs it.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

const launcher = NodePath.join(import.meta.dirname, "bin", "wl");
const checkouts: string[] = [];

/** A checkout with the launcher in place, a lockfile, and whatever was installed. */
function checkout(installed: string | null): string {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "wl-launcher-"));
  checkouts.push(root);
  const bin = NodePath.join(root, "scripts", "workflowleaf", "bin");
  NodeFS.mkdirSync(bin, { recursive: true });
  NodeFS.copyFileSync(launcher, NodePath.join(bin, "wl"));
  NodeFS.writeFileSync(NodePath.join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  if (installed !== null) {
    NodeFS.mkdirSync(NodePath.join(root, "node_modules", ".pnpm"), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(root, "node_modules", ".pnpm", "lock.yaml"), installed);
  }
  // Stands in for the CLI, so a launcher that gets past its checks says so.
  const cli = NodePath.join(root, "packages", "workflowleaf-runtime", "src");
  NodeFS.mkdirSync(cli, { recursive: true });
  NodeFS.writeFileSync(NodePath.join(cli, "bin.ts"), "console.log('cli ran');\n");
  return root;
}

function run(root: string) {
  return NodeChildProcess.spawnSync(
    "sh",
    [NodePath.join(root, "scripts", "workflowleaf", "bin", "wl")],
    {
      encoding: "utf8",
    },
  );
}

afterEach(() => {
  for (const root of checkouts.splice(0)) NodeFS.rmSync(root, { recursive: true, force: true });
});

describe("the wl launcher", () => {
  it("names the fix when the checkout was never installed", () => {
    const result = run(checkout(null));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("has no dependencies installed");
    expect(result.stderr).toContain("pnpm install --frozen-lockfile");
  });

  it("names the fix when the lockfile moved since the install", () => {
    const result = run(checkout("lockfileVersion: '8.0'\n"));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("changed since its dependencies were installed");
  });

  it("runs the CLI when the install matches the lockfile", () => {
    const result = run(checkout("lockfileVersion: '9.0'\n"));
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("cli ran");
  });
});
