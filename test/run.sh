#!/bin/sh
# 跑小程序逻辑的冒烟测试。不需要 node —— 用 macOS 自带的 JavaScriptCore。
set -e
JSC=/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc
DIR=$(cd "$(dirname "$0")" && pwd)

if [ ! -x "$JSC" ]; then
  echo "找不到 jsc。装个 node 也行：node $DIR/smoke.js"
  exit 1
fi

exec "$JSC" "$DIR/smoke.js"
