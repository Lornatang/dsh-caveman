# Changelog

## 0.1.2 - 2026-11-18

- Settle the block hook promise on timeout or abort, so a hung analyzer cannot stall tool execution.
- Count only successful edits against the Cavecrew builder budget and match file identities with platform-aware case folding.
- Bound retained compression originals to 64 entries and 8 MiB, and drop an entry once it has been restored.
- Report inherited-event statistics from the current session's own events instead of replaying the whole log.
- Require a configured analyzer binary to be executable, and require the native bridge socket to be a socket owned by the service user on POSIX.
- Open input-state files non-blocking so a FIFO cannot stall the pre-execution check.

## 0.1.1 - 2026-11-18

- Republish the DSH plugin with the verified analyzer binaries attached to the matching GitHub release.

## 0.1.0 - 2026-11-18

- Honor HTTP and HTTPS proxy settings when downloading verified analyzers.

- Keep native child-session observations available after transient hook failures.
- Read native responses promptly and allow bounded transport scheduling slack.
- Provide Caveman skills and session-specific response styles.
- Register Cavecrew investigator, builder, and reviewer presets and delegation tools.
- Support recoverable native tool-result compression and session usage reports.
- Analyze DSH session history and recover verified input from diagnostic locators.
- Merge child-agent observations into their parent session.
- Reduce repeated session scans and batch recoverable compression requests.
- Offer Blocks suggestions and Browse MCP tools.
- Provide an Auto model routing configuration and command-line entry.
