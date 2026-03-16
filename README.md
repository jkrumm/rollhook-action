# RollHook Deploy Action

Trigger a zero-downtime rolling deployment via [RollHook](https://github.com/jkrumm/rollhook).

- **No deploy secrets** — uses GitHub Actions OIDC, not stored tokens
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

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Build & push image to RollHook registry
        run: |
          echo "${{ secrets.ROLLHOOK_SECRET }}" | docker login ${{ vars.ROLLHOOK_URL }} -u rollhook --password-stdin
          docker build -t ${{ vars.ROLLHOOK_URL }}/myapp:${{ github.sha }} .
          docker push ${{ vars.ROLLHOOK_URL }}/myapp:${{ github.sha }}

      - uses: jkrumm/rollhook-action@v1
        with:
          url: ${{ vars.ROLLHOOK_URL }}
          image_tag: ${{ vars.ROLLHOOK_URL }}/myapp:${{ github.sha }}
```

**What you need:**

| Where | What |
|-|-|
| GitHub → Settings → Variables | `ROLLHOOK_URL` = `https://rollhook.example.com` |
| GitHub → Settings → Secrets | `ROLLHOOK_SECRET` (for registry push only) |
| Server | `ROLLHOOK_URL` env var set on the RollHook container |

That's it. No registry service to run, no GHCR permissions, no deploy token to rotate.

## How it works

1. Requests a short-lived OIDC token from GitHub Actions (audience = RollHook URL)
2. POSTs to `/deploy` with the image tag — RollHook discovers which compose service to update from the running container's labels
3. Streams real-time deploy logs via SSE back to CI
4. Polls until `success` or `failed`, then fails the step accordingly

## Server-side: authorize your repo

Add one label to your app's compose service so RollHook knows which repos may deploy it:

```yaml
services:
  myapp:
    image: ${IMAGE_TAG:-your-rollhook-url/myapp:latest}
    labels:
      - rollhook.allowed_repos=myorg/myapp
      # Optional: restrict to specific refs (default: refs/heads/main, refs/heads/master)
      # - rollhook.allowed_refs=refs/heads/main
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
