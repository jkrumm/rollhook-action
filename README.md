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

## Outputs

| Output | Description |
|-|-|
| `job_id` | RollHook job ID |
| `status` | Final deployment status (`success` or `failed`) |

## Bootstrapping

The OIDC flow authorizes by checking the running container's labels. The very first deployment has no running container yet, so it must be done manually once:

```bash
docker login rollhook.example.com -u rollhook --password-stdin <<< "$ROLLHOOK_SECRET"
docker build -t rollhook.example.com/myapp:initial .
docker push rollhook.example.com/myapp:initial
IMAGE_TAG=rollhook.example.com/myapp:initial docker compose up -d
```

After the first container is running with its labels, all subsequent deploys go through the action with zero secrets.
