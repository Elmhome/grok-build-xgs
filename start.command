#!/bin/bash
# Double-click in Finder to prepare the XGS plugin and start Grok.
# --check validates the environment without installing or starting a session.
set -euo pipefail

finish() {
  local status=$?
  if [ "$status" -ne 0 ]; then
    printf '\n启动失败（退出码 %s），请查看上面的错误信息。\n' "$status" >&2
    if [ -t 0 ]; then
      read -r -p '按回车键关闭…' _ || true
    fi
  fi
}
trap finish EXIT

PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
export PATH="${GROK_HOME:-$HOME/.grok}/bin:$HOME/.grok/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

if [ -n "${GROK_EXE:-}" ]; then
  GROK="$(command -v "$GROK_EXE")" || {
    printf '找不到指定的 Grok：%s\n' "$GROK_EXE" >&2
    exit 1
  }
else
  GROK="$(command -v grok)" || {
    printf '没有找到 Grok。请先安装 Grok Build：https://x.ai/build\n' >&2
    exit 1
  }
fi

NODE=""
if [ -n "${NODE_EXE:-}" ]; then
  NODE="$(command -v "$NODE_EXE")" || {
    printf '找不到指定的 Node.js：%s\n' "$NODE_EXE" >&2
    exit 1
  }
elif command -v node >/dev/null 2>&1; then
  NODE="$(command -v node)"
else
  # Finder does not necessarily load the shell configuration that activates nvm.
  for candidate in "${NVM_DIR:-$HOME/.nvm}"/versions/node/*/bin/node "$HOME/.volta/bin/node"; do
    if [ -x "$candidate" ] && { [ -z "$NODE" ] || [ "$candidate" -nt "$NODE" ]; }; then
      NODE="$candidate"
    fi
  done
fi

if [ -z "$NODE" ]; then
  printf '没有找到 Node.js。安装 Node.js 后再双击此文件：https://nodejs.org/\n' >&2
  exit 1
fi
# Make the same Node available to the plugin hooks started by Grok.
export PATH="$(dirname -- "$NODE"):$PATH"

cd -- "$PROJECT_DIR"
printf 'XGS · Grok Build 启动器\n项目：%s\nGrok：%s\nNode：%s\n\n' "$PROJECT_DIR" "$GROK" "$NODE"
"$GROK" --version
"$NODE" --version
"$NODE" --check "$PROJECT_DIR/hooks/hook.js"
"$GROK" plugin validate "$PROJECT_DIR"

if [ ! -s "$PROJECT_DIR/rules/xgs.md" ]; then
  printf '规则文件不存在或为空：%s/rules/xgs.md\n' "$PROJECT_DIR" >&2
  exit 1
fi

if [ "${1:-}" = '--check' ]; then
  printf '\n检查通过。双击 start.command 即可安装插件并启动。\n'
  exit 0
fi

# Reinstalling an existing local plugin fails on Grok 1.0.67. Check its source
# first, then use the plugin name accepted by the update/enable commands.
EXISTING_PLUGIN="$("$GROK" plugin list --json | "$NODE" -e '
  const fs = require("node:fs");
  const path = require("node:path");
  try {
    const plugins = JSON.parse(fs.readFileSync(0, "utf8"));
    if (!Array.isArray(plugins)) throw new Error("插件列表格式不受支持");
    const canonical = value => {
      try { return fs.realpathSync(value); } catch { return path.resolve(value); }
    };
    const matches = plugins.filter(plugin => plugin.name === "xgs");
    const existing = matches.find(plugin => typeof plugin.source === "string" &&
      canonical(plugin.source) === canonical(process.argv[1]));
    if (matches.length && (!existing || matches.length > 1)) {
      throw new Error("已安装其他来源的 xgs 插件，请先用 grok plugin list 检查并处理冲突");
    }
    if (existing) process.stdout.write(existing.name);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
' "$PROJECT_DIR")"

if [ -n "$EXISTING_PLUGIN" ]; then
  printf '\n正在更新已安装的 XGS 插件…\n'
  "$GROK" plugin update -- "$EXISTING_PLUGIN"
else
  printf '\n首次启动，正在安装 XGS 插件…\n'
  "$GROK" plugin install "$PROJECT_DIR" --trust
fi
"$GROK" plugin enable xgs

# Session rules use Grok native CLI support; no TOML editing is needed.
RULES="$(cat -- "$PROJECT_DIR/rules/xgs.md")"
printf '\n准备完成，正在启动 Grok。进入后可发送 XGS 验证。\n\n'
"$GROK" --rules "$RULES" "$@"
