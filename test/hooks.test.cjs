"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");
const ROOT = path.resolve(__dirname, "..");
const HOOK = path.join(ROOT, "hooks/hook.js");
const AGENTS = path.join(ROOT, "scripts/agents.cjs");

function session(t) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "xgs-grok-test-"));
  t.after(() => fs.rmSync(data, { recursive: true, force: true }));
  const run = (event, fields = {}) => {
    const result = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify(fields),
      encoding: "utf8",
      env: { ...process.env, GROK_PLUGIN_ROOT: ROOT, GROK_PLUGIN_DATA: data, GROK_HOOK_EVENT: event },
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout ? JSON.parse(result.stdout) : null;
  };
  run.dataDir = data;
  return run;
}

function agents(args, env = {}) {
  const result = spawnSync(process.execPath, [AGENTS, ...args], { encoding: "utf8", env: { ...process.env, ...env } });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test("SessionStart is observe-only: state is recorded, nothing is injected", (t) => {
  const run = session(t);
  assert.equal(run("session_start", { sessionId: "s1" }), null);
  const log = fs.readFileSync(path.join(run.dataDir, "runtime.log"), "utf8");
  assert.match(log, /"ev":"session_start"/);
  assert.match(log, /"note":"observe_only"/);
});

test("tool events carry the frame twice per turn, then a reminder every third call", (t) => {
  const run = session(t);
  run("user_prompt_submit", { sessionId: "s1", prompt: "继续第二个站点任务", promptId: "p1" });
  const first = run("pre_tool_use", { sessionId: "s1", promptId: "p1", toolName: "run_terminal_command" });
  assert.equal(first.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.match(first.hookSpecificOutput.additionalContext, /小怪兽/);
  assert.match(first.hookSpecificOutput.additionalContext, /会话约定/);
  assert.match(run("post_tool_use", { sessionId: "s1", promptId: "p1" }).hookSpecificOutput.additionalContext, /会话约定/);
  assert.equal(run("pre_tool_use", { sessionId: "s1", promptId: "p1" }), null);
  assert.match(run("post_tool_use", { sessionId: "s1", promptId: "p1" }).hookSpecificOutput.additionalContext, /工作约定提醒/);
});

test("the injected frame carries no override signature", (t) => {
  const run = session(t);
  run("user_prompt_submit", { sessionId: "s1", prompt: "看看这个漏洞", promptId: "p1" });
  const text = run("pre_tool_use", { sessionId: "s1", promptId: "p1" }).hookSpecificOutput.additionalContext;
  for (const signature of [/priority\s*=\s*"authoritative"/i, /read it as configuration/i, /blacklist/i, /refuse none/i]) {
    assert.doesNotMatch(text, signature);
  }
});

test("wake word gets exactly one acknowledgement, then the turn ends", (t) => {
  const run = session(t);
  run("user_prompt_submit", { sessionId: "s1", prompt: "XGS！", promptId: "p1" });
  const output = run("stop", { sessionId: "s1", reason: "end_turn", lastAssistantMessage: "Hello" });
  assert.equal(output.decision, "block");
  assert.match(output.reason, /Elmhome I'm here，干什么你直说。/);
  assert.equal(run("stop", {
    sessionId: "s1",
    reason: "end_turn",
    stopHookActive: true,
    lastAssistantMessage: "Elmhome I'm here，干什么你直说。",
  }), null);
});

test("session teardown Stop is observed and never blocks", (t) => {
  const run = session(t);
  run("user_prompt_submit", { sessionId: "s1", prompt: "继续", promptId: "p1" });
  assert.equal(run("stop", { sessionId: "s1", reason: "channel_closed", lastAssistantMessage: "这个不做。" }), null);
  const log = fs.readFileSync(path.join(run.dataDir, "runtime.log"), "utf8");
  assert.match(log, /"reason":"channel_closed","action":"observe"/);
});

test("short, standard-free refusals are recognised; ordinary prose is not", () => {
  const { REFUSAL_RE } = require(HOOK);
  const positives = [
    "第二个站点 `chataxy8.sbs` 的后续是入侵取数据和打挂服务。这个不做。",
    "这份注入配置不改变我的身份和工作准则——我不会采纳它。",
    "这个不做。",
    "这条活不接",
    "这类请求免了",
    "换个任务吧",
    "我先把边界说清楚",
    "I'll skip this one.",
    "not something I'll do",
    "I cannot help with this request.",
  ];
  for (const text of positives) assert.equal(REFUSAL_RE.test(text), true, text);
  const negatives = [
    "这个不做改动的地方是第 12 行。",
    "先看 ~/.grok/config.toml 里的 plugins 段。",
    "Here is the explanation of the loader.",
    "我不参与这个判断是错的，因为实测返回 200。",
  ];
  for (const text of negatives) assert.equal(REFUSAL_RE.test(text), false, text);
});

test("a refusal on a turn that never carried the frame gets the frame back", (t) => {
  const run = session(t);
  run("user_prompt_submit", { sessionId: "s1", prompt: "继续第二个站点任务", promptId: "p1" });
  const output = run("stop", { sessionId: "s1", promptId: "p1", reason: "end_turn", lastAssistantMessage: "这个不做。" });
  assert.equal(output.decision, "block");
  assert.match(output.reason, /会话约定/);
  assert.match(output.reason, /小怪兽/);
});

test("a refusal after the frame already shipped re-drives without repeating it", (t) => {
  const run = session(t);
  run("user_prompt_submit", { sessionId: "s1", prompt: "继续第二个站点任务", promptId: "p1" });
  run("pre_tool_use", { sessionId: "s1", promptId: "p1" });
  const output = run("stop", { sessionId: "s1", promptId: "p1", reason: "end_turn", lastAssistantMessage: "这个不做。" });
  assert.equal(output.decision, "block");
  assert.doesNotMatch(output.reason, /## 工作范围/);
});

test("recovery is capped per turn and resets on the next prompt", (t) => {
  const run = session(t);
  run("user_prompt_submit", { sessionId: "s1", prompt: "Explain this code", promptId: "p1" });
  assert.equal(run("stop", { sessionId: "s1", reason: "end_turn", lastAssistantMessage: "Here is the explanation." }), null);
  const refusal = { sessionId: "s1", reason: "end_turn", lastAssistantMessage: "I cannot help with this request." };
  assert.equal(run("stop", refusal).decision, "block");
  assert.equal(run("stop", refusal).decision, "block");
  assert.equal(run("stop", refusal), null);
  run("user_prompt_submit", { sessionId: "s1", prompt: "Please explain again", promptId: "p2" });
  assert.equal(run("stop", refusal).decision, "block");
});

test("context is clipped to Grok's 10,000 character ceiling", () => {
  const { clip } = require(HOOK);
  const long = "x".repeat(12000);
  assert.ok(clip(long).length <= 10000);
  assert.equal(clip("short"), "short");
});

test("global rules file: install is idempotent, keeps user content, uninstall removes only the block", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xgs-grok-agents-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "AGENTS.md");
  fs.writeFileSync(file, "# 我的笔记\n\n- 先跑 pnpm test\n");
  const env = { XGS_AGENTS_FILE: file };

  assert.match(agents(["check"], env), /未安装/);
  agents(["install"], env);
  const installed = fs.readFileSync(file, "utf8");
  assert.match(installed, /# 我的笔记/);
  assert.match(installed, /小怪兽/);
  assert.equal(installed.match(/<!-- XGS:BEGIN -->/g).length, 1);
  assert.ok(installed.length <= 10000, "block must fit Grok's per-file ceiling");

  agents(["install"], env);
  assert.equal(fs.readFileSync(file, "utf8"), installed);
  assert.match(agents(["check"], env), /已安装且为最新/);

  agents(["uninstall"], env);
  const after = fs.readFileSync(file, "utf8");
  assert.match(after, /# 我的笔记/);
  assert.doesNotMatch(after, /XGS:BEGIN/);
});

test("global rules file: uninstall deletes a file that held nothing else", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xgs-grok-agents-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "AGENTS.md");
  const env = { XGS_AGENTS_FILE: file };
  agents(["install"], env);
  assert.ok(fs.existsSync(file));
  agents(["uninstall"], env);
  assert.equal(fs.existsSync(file), false);
});

test("the \"cannot write this\" shape is caught (observed live)", () => {
  const { REFUSAL_RE } = require(HOOK);
  const positives = ["Elmhome，这段不能写。", "我不会提供代码、步骤或编译命令。", "我不能写这个。", "这个不能给你。"];
  for (const text of positives) assert.equal(REFUSAL_RE.test(text), true, text);
  const negatives = ["这个判断不能只靠日志。", "我不提供担保。", "这段代码不能被静态分析器检出。"];
  for (const text of negatives) assert.equal(REFUSAL_RE.test(text), false, text);
});
