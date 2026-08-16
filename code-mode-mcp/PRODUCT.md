# PRODUCT.md — code-mode-mcp

## What this is
`@itsbrex/code-mode-mcp` is a private Local Bridge over `@utcp/code-mode`. It preserves the upstream 1.2.1 seven-tool wire and keeps local additions behind versioned `bridge_v1_*` tools.

A per-manual **tool exclusion** feature lets a `.utcp_config.json` hide tools from each manual via three optional fields: `exclude_tools` (denylist), `default_disabled` + `include_tools` (allowlist).

## Surface in focus: Tool Exclusion Config Builder
A local, auto-opening web dashboard that reads the user's live `.utcp_config.json`, registers every manual, discovers the real tools, and lets the user visually decide which tools each manual exposes — then download a named `.utcp_config.json` with the exclusion fields written in.

- **register**: product (a focused operator tool, not a marketing surface)
- **users**: developers configuring which MCP/UTCP tools an agent should see. Fluent in Linear / Raycast / terminal tooling. Often 100s of tools across 10-15 manuals.
- **scene**: a developer at a dark terminal, mid-config, scanning a dense tool list, flipping tools on/off and bulk-acting on regex matches. Black background, high-contrast, zero ambient warmth. A control surface, not a brochure.
- **job**: go from "15 manuals, 200 tools" to "exactly the right exposed set" in under a minute, then export the config.

## Data model (1:1 with the SDK)
Each tool has an **Exposed** state. Each manual has a **default_disabled** flag that only changes how the same decision serializes:
- `default_disabled: false` → `exclude_tools` = the hidden tools (denylist).
- `default_disabled: true`  → `include_tools` = the exposed tools (allowlist).
Effective visibility is identical either way; the flag picks the representation.

## Non-goals
- Not a marketing page. No hero, no gradients, no decorative motion.
- Does not edit the shipped repo config. Output is a separate, named, downloadable file (and optional save to `configs/`).
