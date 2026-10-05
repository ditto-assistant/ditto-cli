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

- Do NOT edit `package.json` `version` manually. It is bumped automatically on each release by semantic-release and committed back to `main` via `@semantic-release/git` as `chore(release): X.Y.Z [skip ci]`. Any manual edit will be overwritten.
- Do NOT run `npm version` or manually create release tags.
- semantic-release computes the next version from git tags + commit messages, bumps `package.json` (and `package-lock.json`), builds via `prepack: npm run build`, publishes to npm with provenance, creates a GitHub release, and commits the bumped manifests back to `main`.
- The runtime version is read from `package.json` at startup (see `createRequire` in `src/config.ts`), so the installed CLI always reports the correct published version.

## Release authentication

The `Release` workflow uses the repository Actions secret `RELEASE_TOKEN` for both checkout and semantic-release, matching `ditto-subnet`. Use a token owned by an existing organization or repository admin authorized by the `main protection` bypass list. A fine-grained PAT needs access to this repository with Contents, Issues, and Pull requests read/write. Keep npm trusted publishing via OIDC enabled. Never store the token in source or logs.

An expired token publishes nothing, and the merged change sits unreleased. The `Release` workflow checks the token first and fails by name if it is rejected. The weekly `Release token expiry` workflow fails two weeks before the token expires. When either one fires, create a new token, store it with `gh secret set RELEASE_TOKEN -R ditto-assistant/ditto-cli`, then re-run the failed `Release` run (`gh run rerun <id>`). A later conventional commit on `main` also releases everything merged since the last tag.

The built-in `GITHUB_TOKEN` cannot push the generated version commit through the required-pull-request rule. Do not fall back to it or weaken branch protection. Release commits retain `[skip ci]` to prevent a token-authenticated push from starting another release.

## CI validation

`.depot/workflows/ci.yml` runs `npm run verify` (typecheck, build, tests, and pack dry-run) on pull requests and pushes to `main`. Before pushing affected changes, run `depot ci run --workflow .depot/workflows/ci.yml --job verify`. After pushing, inspect GitHub checks at the current PR head and use `depot ci diagnose` and `depot ci logs` for Depot failures.

The existing GitHub `CLI verification` workflow stays enabled during migration: Depot registers automatic triggers only after its workflow lands on the default branch. Retire `.github/workflows/ci.yml` in a follow-up after observing a successful automatic Depot run on the landed commit and confirming the required check contexts. Keep the `Release` workflow on GitHub-hosted runners for npm trusted publishing; do not duplicate publishing in Depot or copy `RELEASE_TOKEN` there.

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
