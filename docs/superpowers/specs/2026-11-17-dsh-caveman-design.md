# DSH Caveman design

## Intent

Provide JuliusBrussee/caveman through DeepSeek Harness as `@lornatang/dsh-caveman`, preserving the upstream behavior and attribution. The initial reference is upstream commit `9b243662ff98d392bc0a95b865a554583d71be75`. This repository is an independent integration and is not the upstream project.

## Requirements and constraints

- Preserve the full upstream public source snapshot and its licenses under `upstream/`.
- Organize the DSH package, tests, build, English README, and Chinese README like `dsh-notion`.
- Preserve upstream skill content, resources, commands, parsing and session isolation. Use DSH's public skill and agent services instead of editing global user files.
- Integrate and test the upstream input compression, model routing, block, browser and metering capabilities against actual DSH surfaces. Record any capability that cannot be integrated rather than claiming parity.
- Preserve user input, security boundaries, cancellation, and retrieval of any compressed information.
- The upstream cloud service is a separate non-public product and cannot be copied from this snapshot.
- Publish to npm only after parity and end-to-end verification; request catalog inclusion after the package exists. The market catalog requires a one-day-old repository and maintainer review.

## Approach

Keep the original project byte-for-byte as an auditable source snapshot. Implement the host adapter as a separate TypeScript package at the root. Reuse upstream runtime components and existing DSH extension points; do not substitute homemade compression or invent savings claims. An upstream-only mirror would preserve the code but would not make DSH an upstream-supported host; a narrow skill-only adapter would leave important upstream capabilities unavailable in DSH, so neither alone satisfies the request.
