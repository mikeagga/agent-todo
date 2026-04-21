#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECTS=("backbone-api" "telegram-relay" "pi-extension-backbone-client")

for project in "${PROJECTS[@]}"; do
  echo "==> Building ${project}"
  cd "${ROOT_DIR}/${project}"

  if [[ -f package-lock.json ]]; then
    npm ci
  else
    npm install
  fi

  if npm run | grep -q "build"; then
    npm run build
  elif npm run | grep -q "typecheck"; then
    npm run typecheck
  fi

done

cd "${ROOT_DIR}"

echo "All builds completed."
