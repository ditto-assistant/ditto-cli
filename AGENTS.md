# Agent Instructions

This repo publishes [`@heyditto/cli`](https://www.npmjs.com/package/@heyditto/cli) to npm via [semantic-release](https://github.com/semantic-release/semantic-release) on every push to `main`. The conventions below are non-negotiable — break them and the release silently won't fire.

## Conventional commits (required)

Every commit subject AND every PR title MUST match conventional commits:

| Prefix | Effect |
| --- | --- |
| `feat: <…>` | minor bump (1.x.0) |
| `fix: <…>` | patch bump (1.1.x) |
| `feat!: <…>` or body containing `BREAKING CHANGE:` | major bump (x.0.0) |
| `chore:`, `docs:`, `refactor:`, `test:`, `ci:`, `build:`, `style:`, `perf:` | no release |

Subject is lowercase, verb-first, no trailing period.

- Good: `feat: add --output flag`, `fix: handle missing api key`, `docs: clarify macOS collision`
- Bad: `Add output flag`, `Fixed CLI`, `Update README.`

If your work doesn't fit one of these prefixes, pick the closest one — never invent a new prefix or omit it. semantic-release ignores any commit it cannot parse.

## PR merge strategy: squash only

"Create a merge commit" is **disabled** at the repo level. The merge subject `Merge pull request #N from …` is non-conventional and semantic-release silently classifies it as no-release — the published 1.1.1 → 1.1.2 gap exists because of exactly this mistake.

USE: "Squash and merge" (the GitHub UI button or `gh pr merge --squash`). The PR title becomes the squash commit subject, which is why PR titles must also be conventional.

Rebase merging is allowed but only if every individual commit on the branch is conventional. When in doubt, squash.

## Versions are computed, never edited

- Do NOT edit `package.json` `version` manually. semantic-release computes the package version during release; source manifests stay on the last committed version so branch protection does not block publishing.
- Do NOT run `npm version` or manually create release tags.
- semantic-release computes the next version from git tags + commit messages, writes it into the release workspace, builds via `prepack: npm run build`, publishes to npm with provenance, creates a GitHub release, and tags the release.
- The runtime version is read from `package.json` at startup (see `createRequire` in `src/config.ts`), so the installed CLI always reports the correct published version.

## Local development

```bash
just install
just check       # tsc --noEmit
just build       # tsc to dist/
just verify      # check + build + pack --dry-run
```

Never commit `dist/` (it's in `.gitignore`; semantic-release rebuilds via `prepack`).

## Authentication for live testing

`DITTO_API_KEY` is required for any command that hits the MCP server. Get one at <https://app.heyditto.ai/mcp/newkey> or run `ditto login`. Never commit a key.
