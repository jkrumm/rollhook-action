# RollHook Deploy Action

Build, push, and deploy in one step using GitHub OIDC — no secrets required.

- **Zero secrets** — uses GitHub Actions OIDC, no `ROLLHOOK_SECRET` in CI
- **Built-in registry** — push your image directly to RollHook, no GHCR or Docker Hub needed
- **Live logs** — SSE log stream flows back into CI in real time

## Minimal example

```yaml
name: Deploy

on:
  push:
    branches: [main]

permissions:
  id-token: write   # required for OIDC
  contents: read

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: jkrumm/rollhook-action@v1
        with:
          url: ${{ vars.ROLLHOOK_URL }}
          image_name: myapp
```

**What you need in GitHub:**

| Where | What |
|-|-|
| Settings → Variables | `ROLLHOOK_URL` = `https://rollhook.example.com` |

No secrets. The action handles everything.

## How it works

1. Requests a short-lived OIDC token from GitHub Actions (audience = RollHook URL)
2. Exchanges the OIDC token for a short-lived registry credential via `POST /auth/token`
3. Logs in to the built-in RollHook registry (`docker login`)
4. Builds the Docker image (`docker build`)
5. Pushes to the registry (`docker push`)
6. Triggers the rolling deployment via `POST /deploy`
7. Streams real-time deploy logs via SSE back to CI and polls until `success` or `failed`

Authorization happens entirely server-side: RollHook verifies the OIDC token and checks the `rollhook.allowed_repos` / `rollhook.allowed_refs` labels on the running container.

## Server-side: authorize your repo

Add one label to your app's compose service so RollHook knows which repos may deploy it:

```yaml
services:
  myapp:
    image: ${IMAGE_TAG:-rollhook.example.com/myapp:latest}
    labels:
      - rollhook.allowed_repos=myorg/myapp
      # Optional: restrict to specific refs (default: refs/heads/main, refs/heads/master)
      # - rollhook.allowed_refs=refs/heads/main
```

## Inputs

| Input | Required | Default | Description |
|-|-|-|-|
| `url` | yes | — | RollHook server base URL |
| `image_name` | yes | — | Image name (without registry prefix or tag), e.g. `myapp` |
| `dockerfile` | no | `Dockerfile` | Path to Dockerfile |
| `context` | no | `.` | Docker build context path |
| `timeout` | no | `600` | Max seconds to wait for deployment to complete |
| `cloudflare_purge_hosts` | no | — | Multi-line list of hostnames to purge from the Cloudflare edge cache after a successful deploy |
| `cloudflare_api_token` | no | — | Cloudflare API token with Zone:Read + Zone:Cache Purge permissions. Required when `cloudflare_purge_hosts` is set |

## Outputs

| Output | Description |
|-|-|
| `job_id` | RollHook job ID |
| `status` | Final deployment status (`success` or `failed`) |
| `purged_hosts` | Comma-separated list of hostnames whose Cloudflare edge cache was purged |

## Cloudflare cache purge

```yaml
      - uses: jkrumm/rollhook-action@v1
        with:
          url: https://rollhook.example.com
          image_name: my-site
          cloudflare_purge_hosts: |
            example.com
            www.example.com
          cloudflare_api_token: ${{ secrets.CLOUDFLARE_PURGE_TOKEN }}
```

**What happens.** Once RollHook reports the deploy as `success` (a failed deploy never touches the cache), the action resolves each host to its Cloudflare zone — walking `www.a.example.com` → `a.example.com` → `example.com` until one matches — groups hosts that share a zone into a single purge call, and purges by hostname rather than `purge_everything`. That's safe even on a zone that also serves other content (an image CDN, say) under a different hostname, and is available on every Cloudflare plan. A rate-limited request is retried automatically. The `purged_hosts` output lists everything that actually got purged.

**Host format.** One or more hostnames, newline- or comma-separated (or both). Blank lines and `#` comments are ignored. A scheme, path, port, or trailing dot is stripped automatically, so `https://example.com/` and `example.com` are equivalent. Wildcards, bare IPs, and anything without a dot are rejected — before the docker build even starts — with every bad entry listed at once.

**Token scope.** Scope `cloudflare_api_token` to `Zone:Read` + `Zone:Cache Purge` on just the zones you purge, keep it in repo secrets, and grant nothing broader. Required whenever `cloudflare_purge_hosts` is set; if it's set without any hosts, the action warns that the secret is unused rather than failing.

**One-time Cloudflare setup.** This pairs with an origin `Cloudflare-CDN-Cache-Control` header set to a long edge TTL, plus a Cache Rule making HTML eligible for edge caching (Cloudflare's HTML defaults to bypassing cache) — the purge step is what makes shipping that combination on every deploy safe. Set both once per zone in the Cloudflare dashboard for `example.com`; they're independent of anything this action does per deploy.

**Troubleshooting.** A purge failure never fails the deploy itself — it only fails this action run, since the deployment already succeeded and stale content may be live until the next purge:

| Verdict | Cause | Fix |
|-|-|-|
| Token lacks Zone:Read + Cache Purge on `<zone>` | The token doesn't have both permissions on the zone that owns the host | Re-scope `cloudflare_api_token` in the Cloudflare dashboard |
| Host isn't in any zone this token can see | Typo in the hostname, or the token is scoped to other zones | Check spelling; check the token's zone list |
| Rate limited, re-run later | Cloudflare rate-limited the request after 3 attempts with backoff | Re-run the job |

The job summary always includes a Host / Zone / Result table, plus the raw Cloudflare API errors underneath on failure.

## Bootstrapping

The OIDC flow authorizes by checking the running container's labels. The very first deployment has no running container yet, so it must be done manually once:

```bash
docker login rollhook.example.com -u rollhook --password-stdin <<< "$ROLLHOOK_SECRET"
docker build -t rollhook.example.com/myapp:initial .
docker push rollhook.example.com/myapp:initial
IMAGE_TAG=rollhook.example.com/myapp:initial docker compose up -d
```

After the first container is running with its labels, all subsequent deploys go through the action with zero secrets.
