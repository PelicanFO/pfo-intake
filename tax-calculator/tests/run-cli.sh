#!/bin/sh
# Run the test suite from the command line using macOS's built-in JavaScriptCore.
# Usage: sh tests/run-cli.sh        (from the tax-calculator folder)
# Node users can instead run: node --experimental-default-type=module tests/run-node.mjs
JSC=/System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc
cd "$(dirname "$0")" && exec "$JSC" -m run-cli.js
