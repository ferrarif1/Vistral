#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

TARGETS=(
  "src/pages"
  "src/components"
  "src/hooks"
  "src/services"
)

echo "[smoke-i18n-key-hygiene] scanning i18n keys in UI source"

single_quote_hits="$(rg -n "t\\(\\s*'[^']*[一-龥][^']*'" "${TARGETS[@]}" || true)"
double_quote_hits="$(rg -n "t\\(\\s*\\\"[^\\\"]*[一-龥][^\\\"]*\\\"" "${TARGETS[@]}" || true)"

if [[ -n "$single_quote_hits" || -n "$double_quote_hits" ]]; then
  echo "[smoke-i18n-key-hygiene] found non-portable i18n keys (Chinese literal used as key)"
  if [[ -n "$single_quote_hits" ]]; then
    echo "$single_quote_hits"
  fi
  if [[ -n "$double_quote_hits" ]]; then
    echo "$double_quote_hits"
  fi
  echo "[smoke-i18n-key-hygiene] use stable English keys in t('...') and keep localized text in I18nProvider"
  exit 1
fi

echo "[smoke-i18n-key-hygiene] PASS"
