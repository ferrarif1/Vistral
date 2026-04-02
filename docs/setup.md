# Setup Guide

This repository is currently maintained as a product-and-contract baseline.

## 1) Prerequisites
- Git
- A POSIX shell environment
- Your preferred editor/IDE

## 2) Clone
```bash
git clone <your-fork-or-origin-url>
cd Vistral
```

## 3) Read Before Coding
Follow this order before making changes:
1. `README.md`
2. `AGENTS.md`
3. `.codex/config.toml`
4. `docs/prd.md`
5. `docs/ia.md`
6. `docs/flows.md`
7. `docs/data-model.md`
8. `docs/api-contract.md`

## 4) Baseline Validation
For documentation-focused changes, run at least:
```bash
rg "docs/setup.md|docs/contributing.md" README.md
```

Then manually verify any links you touched are valid repository paths.

## 5) Scope Reminder
Do not start feature-page implementation unless the task explicitly requires it.
Prioritize collaboration infrastructure, contracts, and consistency checks.
