# Changelog

## Unreleased

- Preserve the upstream Caveman source snapshot and expose its voice skills to DSH.
- Expose every original skill for explicit invocation, keeping unported skills out of automatic model discovery.
- Track voice-mode changes independently per session using the upstream parser.
- Add an opt-in native-tool compression adapter using the upstream middleware, with original-result recovery and restoration.
- Add an opt-in Blocks shell hook using the upstream generic protocol.
- Register the original Browse MCP server when its binary is configured.
- Document and test an opt-in DSH provider route through upstream Auto.
- Report recorded current-session usage through `/caveman-stats` without estimating savings.
- Forward the `dsh-caveman` command to the published upstream CLI.

Full DSH feature parity and release verification are still in progress.
