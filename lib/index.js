// dsh-nx registers one MCP row for Siemens NX (12, 2406, 2506).
//
// Unlike AutoCAD and SolidWorks, NX has no COM server to attach to: the MCP
// sidecar talks to a bridge journal running inside a *separate* batch NX
// process. That process is started and stopped by `dsh-nx serve`, which is what
// this row runs — so the row owns the whole lifecycle instead of assuming an
// application is already open.
import path from "node:path";
import * as McpClient from "@deepseek-ai/dsh-mcp-client";
import { exists, resolveLayout } from "./paths.mjs";
import { PKG_ROOT } from "./paths.mjs";

const LOG_PREFIX = "[dsh-nx]";
const say = (message) => console.error(`${LOG_PREFIX} ${message}`);

export const name = "dsh-nx";
export const inject = McpClient.inject;

export function apply(ctx) {
  const layout = resolveLayout();

  // Off by default on purpose. This row starts a *batch NX session* — NX is
  // busy for as long as the row lives, and booting dsh would otherwise wait for
  // NX every time. The skill works without it; turn the tools on when you want
  // an agent to drive NX directly.
  if (process.env.NX_ENABLE_MCP !== "1") {
    say("nx tools not registered (set NX_ENABLE_MCP=1 to enable; needs a free NX licence)");
    return;
  }

  if (!exists(layout.skillFile)) {
    throw new Error(
      `${LOG_PREFIX} the NX skill is not installed yet (${layout.skillFile}).\n` +
        `Run: dsh-nx install`,
    );
  }

  ctx.plugin(McpClient, {
    serverName: "nx",
    transport: "stdio",
    command: process.execPath,
    args: [path.join(PKG_ROOT, "bin", "dsh-nx.mjs"), "serve"],
    env: { NX_BASE_DIR: layout.baseDir },
    toolCallTimeoutMs: 600000,
    // A batch NX session takes a minute to come up. A row that cannot start
    // should say so rather than hand the agent tools that never answer.
    failOnStartupError: true,
    reconnect: { enabled: true, initialDelayMs: 1000, maxDelayMs: 60000, maxAttempts: 5 },
  });

  say(`registered nx (base ${layout.baseDir}, bridge started on demand)`);
}
