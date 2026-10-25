"use strict";
// XGS · Grok Build — global rules file.
//
// Grok scans agent rules in this order: ~/.grok/ (global), then every directory from the
// repo root down to the launch directory. Files found in ~/.grok/ are appended to the
// system prompt for every session, in every workspace, regardless of how Grok was
// launched — CLI, desktop app, or a script that forgets the --rules flag.
//
// That is the channel the frame belongs in, and it is the one the plugin never used:
// per the hooks reference, SessionStart is observe-only (additionalContext from it is
// dropped), PreToolUse/PostToolUse context arrives as a user-role <system-reminder>, and
// UserPromptSubmit discards an allowing hook's stdout. None of those is the system prompt.
//
// Hard limit: Grok caps each rules file at 10,000 characters and truncates past that.
// The frame is ~2.9 K, and install refuses rather than writing a block that would be cut.
//
// The block is marker-delimited so the file stays the user's: everything outside
// BEGIN/END is left byte-for-byte alone, and uninstall removes only the block.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");

const ROOT = path.resolve(__dirname, "..");
const FRAME = path.join(ROOT, "prompts", "xgs.md");
const BEGIN = "<!-- XGS:BEGIN -->";
const END = "<!-- XGS:END -->";
const MAX_RULES_CHARS = 10000;

function target() {
  if (process.env.XGS_AGENTS_FILE) return process.env.XGS_AGENTS_FILE;
  const home = process.env.GROK_HOME || path.join(os.homedir(), ".grok");
  return path.join(home, "AGENTS.md");
}

function block() {
  const frame = fs.readFileSync(FRAME, "utf8").trim();
  const text = [BEGIN, frame, END].join("\n");
  if (text.length > MAX_RULES_CHARS) {
    throw new Error("约定太长：Grok 每个规则文件上限 " + MAX_RULES_CHARS + " 字符，当前 " + text.length);
  }
  return text;
}

function strip(text) {
  const out = [];
  let depth = 0;
  for (const line of String(text).split("\n")) {
    const t = line.trim();
    if (t === BEGIN) { depth += 1; continue; }
    if (t === END) { depth = Math.max(0, depth - 1); continue; }
    if (depth === 0) out.push(line);
  }
  // Collapse the blank runs the removal leaves behind at the seams.
  const joined = out.join("\n").replace(/\n{3,}/g, "\n\n").replace(/^\n+/, "").replace(/\n+$/, "\n");
  return joined === "\n" ? "" : joined;
}

function read(file) {
  try { return fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const before = read(file);
  if (before === text) return false;
  if (before !== null) {
    const backup = file + ".xgs-backup-" + Date.now() + "-" + crypto.randomBytes(3).toString("hex");
    fs.copyFileSync(file, backup);
    fs.chmodSync(backup, fs.statSync(file).mode & 0o777);
    console.log("已备份：" + backup);
  }
  const temporary = file + ".xgs-" + crypto.randomBytes(6).toString("hex");
  try {
    fs.writeFileSync(temporary, text, { mode: 0o644 });
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
  return true;
}

function hasBlock(text) {
  return typeof text === "string" && text.includes(BEGIN) && text.includes(END);
}

function extractBlock(text) {
  if (!hasBlock(text)) return "";
  const lines = String(text).split("\n");
  const start = lines.findIndex((line) => line.trim() === BEGIN);
  const end = lines.findIndex((line) => line.trim() === END);
  if (start < 0 || end <= start) return "";
  return [BEGIN, ...lines.slice(start + 1, end), END].join("\n");
}

function main() {
  const action = process.argv[2] || "check";
  if (!["check", "install", "uninstall"].includes(action)) throw new Error("未知操作：" + action);
  const file = target();
  const current = read(file);
  if (action === "check") {
    if (current === null) { console.log("未安装：" + file + " 不存在"); return; }
    if (!hasBlock(current)) { console.log("未安装：" + file + " 里没有 XGS 段"); return; }
    console.log(extractBlock(current) === block() ? "已安装且为最新：" + file : "已安装，内容已过期：" + file + "（重新运行安装以更新）");
    return;
  }
  if (action === "install") {
    const base = strip(current || "").replace(/\n+$/, "");
    const next = (base ? base + "\n\n" : "") + block() + "\n";
    const changed = write(file, next);
    console.log(changed ? "已写入指令文件：" + file : "指令文件已是当前版本：" + file);
    return;
  }
  if (current === null || !hasBlock(current)) { console.log("指令文件里没有 XGS 段，无需移除。"); return; }
  const next = strip(current);
  if (next.trim() === "") {
    fs.rmSync(file, { force: true });
    console.log("已移除 XGS 段并删除空文件：" + file);
  } else {
    write(file, next);
    console.log("已移除 XGS 段，其余内容保留：" + file);
  }
}

if (require.main === module) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { target, block, strip, hasBlock, BEGIN, END };
