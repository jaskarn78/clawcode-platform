#!/bin/sh
# One-time setup: point git at the version-controlled hooks dir.
# Idempotent — safe to re-run.
set -e
cd "$(git rev-parse --show-toplevel)"
git config core.hooksPath scripts/git-hooks
chmod +x scripts/git-hooks/pre-commit
echo "git-hooks installed: core.hooksPath = scripts/git-hooks"
echo "Active hooks: pre-commit (supply-chain age guard)"
