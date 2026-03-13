# RollHook Deploy Action

Trigger a zero-downtime rolling deployment via [RollHook](https://github.com/jkrumm/rollhook) with real-time log streaming back to CI.

Uses GitHub Actions OIDC — no secrets to store or rotate.

## Usage

```yaml
permissions:
  id-token: write   # required for OIDC token

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: jkrumm/rollhook-action@v1
        with:
          url: ${{ vars.ROLLHOOK_URL }}
          image_tag: registry.example.com/my-app:${{ github.sha }}
```

## Inputs

| Input | Required | Default | Description |
|-|-|-|-|
| `url` | yes | — | RollHook server base URL |
| `image_tag` | yes | — | Docker image tag to deploy |
| `timeout` | no | `600` | Max seconds to wait for completion |

## Outputs

| Output | Description |
|-|-|
| `job_id` | RollHook job ID |
| `status` | Final deployment status (`success` or `failed`) |

## How it works

1. Requests a short-lived OIDC token from GitHub (audience = RollHook URL)
2. POSTs to `/deploy` — receives a `job_id` immediately
3. Streams real-time logs via SSE (`/jobs/:id/logs`)
4. Polls `/jobs/:id` until terminal state (`success` or `failed`)
5. Fails the step if deployment fails or timeout is exceeded

## Server-side setup

Add `rollhook.allowed_repos` to your app service in compose.yml on the server:

```yaml
services:
  app:
    labels:
      - rollhook.allowed_repos=myorg/myapp
      # Optional: restrict to specific refs (default: refs/heads/main and refs/heads/master)
      # - rollhook.allowed_refs=refs/heads/main,refs/heads/prod
```

Set `ROLLHOOK_URL` on the RollHook container to enable audience verification:

```yaml
services:
  rollhook:
    environment:
      ROLLHOOK_URL: https://rollhook.example.com
```
