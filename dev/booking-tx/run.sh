#!/bin/sh
# 在本地把 createBooking / updateBooking / savePrices / clearAll 跑一遍。
# 和 test/run.sh 一样用 macOS 自带的 jsc。
#
# ⚠️ 成败是【印在输出里】的，不体现在退出码上 —— jsc 里未处理的 Promise 拒绝
#    是静默 exit 0，这里不做假绿。看最后那行「通过 N / 失败 M」。
set -e
JSC=/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc
DIR=$(cd "$(dirname "$0")" && pwd)

if [ ! -x "$JSC" ]; then
  echo "找不到 jsc"
  exit 1
fi

exec "$JSC" "$DIR/harness.js"
