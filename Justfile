set dotenv-load

api := env_var_or_default("DITTO_API_BASE", "https://api.heyditto.ai")
npm_cache := env_var_or_default("NPM_CONFIG_CACHE", "/tmp/heyditto-npm-cache")

default:
  @just --list

install:
  npm install

check:
  npm run check

build:
  npm run build

test:
  npm test

pack: build
  NPM_CONFIG_CACHE="{{npm_cache}}" npm pack --dry-run

# Smoke commands. Each runs the compiled CLI against $DITTO_API_BASE
# (override per-invocation, e.g. `just status http://localhost:3400`).
status api=api: build
  DITTO_API_BASE="{{api}}" node dist/cli.js status

config api=api: build
  DITTO_API_BASE="{{api}}" node dist/cli.js config

search api=api +query: build
  DITTO_API_BASE="{{api}}" node dist/cli.js search {{query}}

subjects api=api +query: build
  DITTO_API_BASE="{{api}}" node dist/cli.js subjects {{query}}

endpoints api=api: build
  DITTO_API_BASE="{{api}}" node dist/cli.js endpoints

# Dry-run the coding-agent launchers (no key is minted).
claude-plan api=api *args: build
  DITTO_API_BASE="{{api}}" node dist/cli.js claude --dry-run {{args}}

codex-plan api=api *args: build
  DITTO_API_BASE="{{api}}" node dist/cli.js codex --dry-run {{args}}

# Local-API shortcuts.
local-status:
  just status http://localhost:3400

local-search +query:
  just search http://localhost:3400 {{query}}

verify: check build test pack
