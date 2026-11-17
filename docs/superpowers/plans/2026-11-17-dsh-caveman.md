# DSH Caveman Implementation Plan

> Implement and verify the adapter in this session, with tests against the actual DSH service boundaries.

**Goal:** Reproduce the upstream Caveman experience for DeepSeek Harness and publish it under `@lornatang/dsh-caveman`.

**Architecture:** Keep upstream source immutable under `upstream/`. The root contains a TypeScript Cordis bundle, its tests, and documentation. DSH services contribute skills and per-session instructions; upstream components provide the other capabilities where DSH has an appropriate extension seam.

**Tech Stack:** Node.js, TypeScript, Cordis, DSH, upstream Caveman.

**Spec:** `docs/superpowers/specs/2026-11-17-dsh-caveman-design.md`

## Global constraints

- Preserve upstream source and Apache-2.0/MIT and third-party notices.
- Name: `@lornatang/dsh-caveman`.
- Never claim parity for an unimplemented or unverified feature.
- Never claim measured savings without a matching benchmark.

## Review focus

- Two simultaneous sessions must not share mode changes.
- An explicit stop command must remove mode instructions without changing another session.
- Quoted or unrelated text must not activate a mode.
- The packed plugin must register on a real DSH host, not only a test double.
- Compression must preserve a working recovery path and pass through unsupported content.

## Tasks

- [x] Preserve and verify the upstream source snapshot and provenance.
- [x] Write failing tests and implement native DSH skill discovery, exact upstream resources, and per-session mode activation, stop, and status.
- [ ] Integrate each remaining upstream capability with DSH using its real runtime, with behavior and recovery tests.
- [ ] Produce bilingual installation and limitations documentation, package metadata, CI, and a verified installable tarball.
- [ ] Verify actual DSH integration and the full requirement matrix; publish npm only after parity succeeds.
- [ ] Submit the market catalog entry and report its age/review status accurately.
