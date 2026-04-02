# Contributing Guide

## Contribution Principles
- Keep Vistral AI-native: conversation + attachment driven.
- Preserve two-role semantics (user / admin) plus ownership-based model permissions.
- Prefer shared, reusable patterns over page-specific divergence.
- Update contracts first (`docs/*`) when behavior/data/API changes.

## Standard Workflow
1. Write a brief plan.
2. Update relevant documentation contracts when needed.
3. Implement minimal coherent change.
4. Run minimal checks matching the change scope.
5. Provide risk notes and next-step recommendations.

## Required Checks (Minimum)
- Docs-only change:
  - verify touched links are valid
  - verify terminology consistency across touched docs
- Code change:
  - run project-appropriate lint/test/type checks
  - verify contract alignment with `docs/data-model.md` and `docs/api-contract.md`

## Pull Request Expectations
Each change should clearly state:
- What changed
- Why it changed
- What was validated
- Remaining risks / follow-ups
