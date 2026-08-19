#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$script_dir"

npm ci
node scripts/fetch-fonts.js
npm link
node bin/browser-agent.js doctor
node bin/browser-agent.js validate

echo "browser-agent setup completed"
