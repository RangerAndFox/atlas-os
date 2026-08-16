# Atlas OS

The canonical specification for Atlas OS, a microkernel operating system for coherent software evolution.

## Purpose

This repository contains the **normative specification and reference enforcement
implementation** for Atlas OS. It is the canonical source of truth for the Atlas
architecture, governance contracts, guard, reviewer skills, and project templates.

## Repository Structure

| Path              | Contents                                                                 |
| ----------------- | ------------------------------------------------------------------------ |
| `spec/`           | Normative specification documents.                                       |
| `adr/`            | Architecture Decision Records — the "why" behind accepted decisions.     |
| `docs/`           | Non-normative supporting documentation, guides, and background.          |
| `diagrams/`       | Source and rendered diagrams referenced by the specification.            |
| `release-notes/`  | Per-release notes describing changes to the specification.               |
| `plugin/atlas/`   | Active guard, reviewer skills, design gate, templates, and tests.          |
| `reference/`      | Deprecated reference orchestrator retained for compatibility evidence.    |
| `CONSTITUTION.md` | The external Engineering Constitution — engineering principles governing how Atlas OS is designed and maintained; external to the normative specification. |
| `CHANGELOG.md`    | A chronological record of notable changes to this repository.            |
| `LICENSE`         | The license governing use of this specification.                         |

Specification governance — versioning, acceptance, amendment, and supersession
of the normative specification — is owned by
[`spec/00-specification-governance.md`](spec/00-specification-governance.md), not
by the Engineering Constitution.

## Status

The Atlas guard and review/design enforcement surfaces are implemented and tested.
Some numbered normative specification chapters remain placeholders; treat those
chapters as unratified until their content is authored and accepted under
`spec/00-specification-governance.md`.
