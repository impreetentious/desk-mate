# Sandbox base image

The Debian (glibc) + Node image the container-based agent computers are built from. CI
publishes it as the `sandbox-base` image and `cli/manifest.json` pins it by digest, so a
rebuild cannot silently change what agents run inside.

Two things consume it:

- **`local/Dockerfile`** stacks the microVM agent on top to produce
  `deskmate-sandbox-local:latest`, the image the `local` sandbox backend runs.
- **`deskmate sandbox build` / `deskmate sandbox publish`** use the pinned digest as the
  `FROM` base for a deployment's own sandbox layer (`<deploy dir>/sandbox/`), unless that
  directory supplies its own `Dockerfile`.

The `sprites` backend does **not** use this image — Fly Sprites boots its own managed
Ubuntu image, so tools a Sprites deployment needs are installed on the resident disk
rather than baked here.

glibc (rather than musl) means vendor install scripts and prebuilt binaries work as they
do on a typical laptop, without compatibility shims. Baked in: the coding-agent CLIs,
`git`, `curl`, `jq`, `gh`, AWS CLI v2, and a Python venv at `/opt/agent-venv` (on `PATH`).
The agentic browser engine is build-gated behind `INSTALL_BROWSER_ENGINE=1`.

Deployment-specific tools are **not** baked here — a deployment stacks them on top via its
sandbox layer. Anything else the agent needs it installs itself, the way a colleague would.

## Build and publish the base image

```bash
brew install flyctl
fly auth login
export FLY_SANDBOX_APP_NAME=<operator-owned-sandbox-app>
fly apps create "$FLY_SANDBOX_APP_NAME" --org <fly-org>
npm run deploy:fly-image
```

Sandbox images run `linux/amd64` only. `npm run deploy:fly-image` builds on Fly's remote
amd64 builder, so it works unchanged from arm64 (Apple Silicon) hosts, where a local
`docker build` produces an arm64 image and `--platform linux/amd64` under qemu emulation is
slow and unreliable. Use it rather than a bare `fly deploy`: this app only stores the
image, and a bare deploy creates launch machines nothing uses.

`scripts/local-sandbox-build.sh` (`npm run sandbox:local:build`) follows the same rule when
building the local sandbox image: it uses the remote builder when `FLY_SANDBOX_APP_NAME` is
set, and otherwise builds locally with `--platform linux/amd64`.

## Sandbox backends

`SANDBOX_BACKEND` selects one of three, and `SANDBOX_SECONDARY_BACKEND` may name a
different one for scopes routed away from the default:

- **`local`** — a Docker container on the host, from the image above. Fast, **not
  isolated**, and needs a running Docker daemon. Dev and tests only; it is the default
  when `SANDBOX_BACKEND` is unset, and production refuses to boot without an explicit
  choice.
- **`sprites`** — a Fly Sprites microVM per scope. The production Fly option.
- **`aws`** — an AWS microVM, built separately from `aws/microvm-agent/` and selected by
  `AWS_SANDBOX_IMAGE`.

## The Sprites backend

`createSpritesSandbox` (`../src/sandbox/sprites-sandbox.ts`) drives one Sprite per scope
over the Sprites API. The whole disk persists and the machine auto-sleeps when idle, so
installed packages, virtualenvs, and build state stay warm between turns — a private
"laptop" per scope, rooted at `/home/sprite` with the workspace at
`/home/sprite/workspace`.

Read-only mount layers (org/team/granted scopes) are materialized into the VM from their
owners' stores each turn. The writable layer lives on the Sprite's own disk, which is the
source of truth for this backend; core reads files back out of it — the workspace tree, and
resident credential paths — through the backend's agent-computer backup capability, batched
as one tar stream per area rather than one exec per file.

That read excludes `.aws` (so a stale credential cache cannot shadow the platform role),
reproducible or noisy caches (`__pycache__`, `.cache`, a home-level `venv`), and the
ephemeral credential paths core materializes for a single turn.

Its Agent Computer profile is `backend=sprites`, `writablePersistence=resident_disk`,
process sessions supported, and `egressEnforcement=domain` when an egress proxy is
configured (otherwise `none`).

### Configure it

```bash
SPRITES_TOKEN=<sprites-api-token> \
SANDBOX_BACKEND=sprites \
SPRITES_EGRESS_PROXY_URL=https://<egress-proxy> \
npm start
```

`SPRITES_TOKEN` is required. Other knobs: `SPRITES_BASE_URL` (defaults to the public
Sprites API), `SPRITES_NAME_PREFIX` (`deskmate` — Sprites are named per scope from it), and
`SANDBOX_TIMEOUT_SEC` (600 — the bare per-command backstop, reached only on a
standalone/misconfigured path, since the orchestrator always passes an explicit
per-command timeout).

Core warns at boot when `SANDBOX_BACKEND=sprites` is set without
`SPRITES_EGRESS_PROXY_URL`: sandboxes then run with **no egress enforcement** (fail-open).

**Per-command execute timeout.** Each `execute` command has a wall-clock cap (exit 124 on
kill). The agent sets it per command via the tool's `timeout_seconds` param; if it doesn't,
the command falls to the configured default. Knobs: `EXEC_TIMEOUT_DEFAULT_SEC` (120 —
covers an unanticipated moderately-long command: npm install / tsc / a test run) and
`EXEC_TIMEOUT_MAX_SEC` (300 — the hard ceiling `timeout_seconds` is clamped to, so one
session can't starve others; work beyond it should run in the background or be broken into
shorter steps). Resolution order: agent param > default > sandbox backstop.

## Git CLI smoke test

For GitHub/GitLab resident CLI readiness against a real Sprite:

```bash
SPRITES_TOKEN=... SANDBOX_BACKEND=sprites npm run smoke:git-cli
```

This fails unless `git` and `gh` are on `PATH` in a resident computer, and reports whether
`glab` is available. On Sprites neither `gh` nor `glab` is baked in — both are advertised to
the agent as not-installed and are installed residently the first time they are needed — so
run this against a computer that has already been set up, not a fresh one. It also runs
`gh auth status` and reports a sanitized status (`ok`,
`auth_missing`, `host_unreachable`, or `auth_error`) without printing command output. If
`glab` is available or required, it does the same for `glab auth status`; otherwise GitLab
auth is reported as `skipped`. Add `GIT_CLI_SMOKE_REQUIRE_GLAB=1` when GitLab is meant to
be supported by the current image, `GIT_CLI_SMOKE_REQUIRE_GH_AUTH=1` after running
`gh auth login` on the resident computer, or `GIT_CLI_SMOKE_REQUIRE_GLAB_AUTH=1` after
`glab auth login`. A synthetic actor's Sprite is deleted afterwards by default; set
`GIT_CLI_SMOKE_ACTOR_ID=<real actor>` when testing an existing resident computer.
