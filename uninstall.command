#!/bin/bash
# Uninstall the local XGS Grok plugin; keep source files and runtime data.
# --check only verifies the target and performs no uninstall.
set -euo pipefail
finish() {
  local status=$?
  if [ "$status" -ne 0 ]; then
    printf '\n卸载失败（退出码 %s），请查看上面的错误信息。\n' "$status" >&2
    if [ -t 0 ]; then read -r -p '按回车键关闭…' _ || true; fi
  fi
}
trap finish EXIT
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
export PATH="${GROK_HOME:-$HOME/.grok}/bin:$HOME/.grok/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
GROK="$(command -v "${GROK_EXE:-grok}")" || {
  printf '没有找到 Grok，可用 GROK_EXE 指定可执行文件路径。\n' >&2
  exit 1
}
NODE=""
if [ -n "${NODE_EXE:-}" ]; then
  NODE="$(command -v "$NODE_EXE")" || exit 1
elif command -v node >/dev/null 2>&1; then
  NODE="$(command -v node)"
else
  for candidate in "${NVM_DIR:-$HOME/.nvm}"/versions/node/*/bin/node "$HOME/.volta/bin/node"; do
    if [ -x "$candidate" ] && { [ -z "$NODE" ] || [ "$candidate" -nt "$NODE" ]; }; then NODE="$candidate"; fi
  done
fi
if [ -z "$NODE" ]; then
  printf '没有找到 Node.js，请用 NODE_EXE 指定其路径。\n' >&2
  exit 1
fi
if [ "$#" -gt 1 ] || { [ "$#" -eq 1 ] && [ "$1" != '--check' ]; }; then
  printf '用法：uninstall.command [--check]\n' >&2
  exit 1
fi
"$NODE" - "$ROOT" "$GROK" "${1:-}" <<'JS'
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");
const [root, grok, mode] = process.argv.slice(2);
function canonical(value) { try { return fs.realpathSync(value); } catch { return path.resolve(value); } }
function run(args) {
  const result = spawnSync(grok, args, { encoding: "utf8", env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || "Grok 命令未正常完成");
  return result.stdout;
}
try {
  const plugins = JSON.parse(run(["plugin", "list", "--json"]));
  if (!Array.isArray(plugins)) throw new Error("插件列表格式不受支持");
  const matches = plugins.filter(plugin => plugin.name === "xgs");
  if (!matches.length) {
    console.log("当前未安装 XGS 插件，无需卸载。");
    process.exit(0);
  }
  if (matches.length !== 1 || typeof matches[0].source !== "string" || canonical(matches[0].source) !== canonical(root)) {
    throw new Error("已安装的 xgs 来自其他目录，未执行卸载。请先用 grok plugin list 检查来源。");
  }
  if (mode === "--check") {
    console.log("检查通过：将卸载此目录安装的 XGS 插件，保留源码和运行数据；本次未执行卸载。");
    process.exit(0);
  }
  const output = run(["plugin", "uninstall", "xgs", "--confirm", "--keep-data"]);
  if (output.trim()) console.log(output.trim());
  console.log("卸载完成，源码和运行数据已保留。请完全退出并重开 Grok；已有会话请关闭。");
  const config = path.join(process.env.GROK_HOME || path.join(os.homedir(), ".grok"), "config.toml");
  if (fs.existsSync(config) && fs.readFileSync(config, "utf8").includes(path.join(root, "rules"))) {
    console.log("检测到手动添加的规则路径，请从 config.toml 的 extra_rule_dirs 中移除此项目的 rules 目录。");
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
JS

# Remove the frame from Grok's global rules file. Everything outside the XGS markers is
# left exactly as it was; the file is deleted only when the block was all it held.
"$NODE" "$ROOT/scripts/agents.cjs" uninstall
