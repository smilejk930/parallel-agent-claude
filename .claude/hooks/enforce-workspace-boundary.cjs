#!/usr/bin/env node
/*
 * PreToolUse hook — workspace boundary enforcement.
 *
 * Blocks any Write / Edit / NotebookEdit / Bash / PowerShell call whose target
 * path resolves outside CLAUDE_PROJECT_DIR (the trusted workspace).
 *
 * Stdin:  { tool_name, tool_input, ... } as JSON.
 * Exit 0: allow.
 * Exit 2 + stderr: block (Claude reads the stderr message).
 *
 * This is the harness-enforced layer. Even if the model's instructions are
 * truncated, ignored, or contradicted by a subagent prompt, this hook still
 * fires before the tool runs.
 */

const path = require("path");

const WORKSPACE = path.resolve(process.env.CLAUDE_PROJECT_DIR || process.cwd());
const WORKSPACE_KEY = WORKSPACE.replace(/\\/g, "/").toLowerCase();

let buf = "";
process.stdin.on("data", (c) => (buf += c));
process.stdin.on("end", () => {
  let event;
  try {
    event = JSON.parse(buf);
  } catch (e) {
    // Don't block on malformed input — just surface the issue.
    process.stderr.write(
      `[workspace-boundary] could not parse hook payload: ${e.message}\n`
    );
    process.exit(0);
  }

  const tool = event.tool_name;
  const inp = event.tool_input || {};

  const isInside = (raw) => {
    if (!raw) return true;
    const abs = path.isAbsolute(raw) ? raw : path.resolve(WORKSPACE, raw);
    const norm = path.resolve(abs).replace(/\\/g, "/").toLowerCase();
    return norm === WORKSPACE_KEY || norm.startsWith(WORKSPACE_KEY + "/");
  };

  const block = (reason, offending) => {
    process.stderr.write(
      [
        "[workspace-boundary] BLOCKED",
        `Reason  : ${reason}`,
        `Path    : ${offending || "(see reason)"}`,
        `Workspace: ${WORKSPACE}`,
        "",
        "You may only read/write files inside the trusted workspace.",
        "If you genuinely need to work outside it, STOP and ask the user",
        "to explicitly expand trust. Do not work around this hook.",
        "",
      ].join("\n")
    );
    process.exit(2);
  };

  // ── File-tool gates ──────────────────────────────────────────────────────
  if (tool === "Write" || tool === "Edit") {
    if (!isInside(inp.file_path)) {
      return block(`${tool} target outside workspace`, inp.file_path);
    }
  }
  if (tool === "NotebookEdit") {
    if (!isInside(inp.notebook_path)) {
      return block("NotebookEdit target outside workspace", inp.notebook_path);
    }
  }

  // ── Shell-tool gates ─────────────────────────────────────────────────────
  if (tool === "Bash" || tool === "PowerShell") {
    const cmd = String(inp.command || "");

    // 1) Any Windows drive-letter absolute path (e.g. D:\tmp, C:/Users/...).
    //    Reject if the resolved path falls outside the workspace.
    const winRe = /([a-zA-Z]:[\\/][^\s"'`;|&()<>]*)/g;
    let m;
    while ((m = winRe.exec(cmd)) !== null) {
      if (!isInside(m[1])) {
        return block(
          "Shell command references absolute Windows path outside workspace",
          m[1]
        );
      }
    }

    // 2) Targeted "write/move/delete to absolute path" patterns.
    //    Low false-positive set — only fires on real shell tokens that move
    //    bytes onto disk at an absolute path. Reads (cat, less, grep) are
    //    intentionally NOT blocked here to keep the hook focused.
    const writePatterns = [
      // redirection:  > /path,  >> /path,  > X:\path
      /(?:^|[\s;|&])>+\s*((?:\/[^\s"'`;|&()<>]+|[a-zA-Z]:[\\/][^\s"'`;|&()<>]+))/,
      // write commands targeting an absolute path as a positional arg
      /\b(?:mkdir|touch|tee|cp|mv|rsync|install|rm|rmdir|ln|chmod|chown)\b[^\n]*?(?:^|\s)((?:\/[^\s"'`;|&()<>]+|[a-zA-Z]:[\\/][^\s"'`;|&()<>]+))/i,
      // cd into an absolute path
      /\bcd\s+((?:\/[^\s"'`;|&()<>]+|[a-zA-Z]:[\\/][^\s"'`;|&()<>]+))/i,
    ];

    for (const re of writePatterns) {
      const found = cmd.match(re);
      if (found && found[1] && !isInside(found[1])) {
        return block(
          "Shell command would write/cd outside workspace",
          found[1]
        );
      }
    }
  }

  process.exit(0);
});
