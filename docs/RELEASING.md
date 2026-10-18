# Releasing

## Before a release

1. `npm run verify` passes, and CI is green on all three platforms.
2. **Live read check** against a real account, through a real MCP client:
   `cronometer-mcp doctor`, then `get_diary` for today, `get_daily_summary`,
   `nutrient_radar`, `search_foods`, `get_repeated_items`, and one `export_raw`.
3. **Live write check** for any write whose code changed, on the throwaway date
   **1900-01-02** so a real diary is never touched: add, read back, edit, read back,
   delete, and confirm the date is empty again. Update the status column in
   [PROTOCOL.md](PROTOCOL.md), and set `verified: true` in `src/mcp/registry.ts` for
   each write that passed.
4. Move the `CHANGELOG.md` entry from "unreleased" to the version and date.

## Cutting it

Set the same version in `package.json`, `server.json` (both `version` fields) and
`packaging/mcpb/manifest.json`, commit, then:

```sh
git tag v1.2.3
git push origin main v1.2.3
```

The `release` workflow checks that the tag matches every version field, runs the tests,
publishes to npm with provenance, builds `cronometer-mcp.mcpb` onto a **draft** GitHub
release, and publishes `server.json` to the MCP Registry. Write the release notes on the
draft and publish it.

## One-time setup

- **npm:** the first version of a new package must be published by hand
  (`npm login`, then `npm publish --access public`), because trusted publishing can only
  be configured for a package that exists. Then, on npmjs.com, add this repository and
  `release.yml` as a trusted publisher, and create a `npm` environment in the GitHub
  repository settings.
- **MCP Registry:** nothing to configure; `mcp-publisher login github-oidc` proves the
  `io.github.ekelly95/` namespace from the workflow's own token.
