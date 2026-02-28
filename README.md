# RollHook Deploy Action

Trigger a zero-downtime rolling deployment via [RollHook](https://github.com/jkrumm/rollhook) with real-time log streaming back to CI.

## Usage

```yaml
- uses: jkrumm/rollhook-action@v1
  with:
    url: ${{ secrets.ROLLHOOK_URL }}
    token: ${{ secrets.ROLLHOOK_WEBHOOK_TOKEN }}
    image_tag: registry.example.com/my-app:${{ github.sha }}
```

## Inputs

| Input | Required | Default | Description |
|-|-|-|-|
| `url` | yes | — | RollHook server base URL |
| `token` | yes | — | RollHook webhook token |
| `app` | no | repo name | App name in `rollhook.config.yaml` |
| `image_tag` | yes | — | Docker image tag to deploy |
| `timeout` | no | `600` | Max seconds to wait for completion |

## Outputs

| Output | Description |
|-|-|
| `job_id` | RollHook job ID |
| `status` | Final deployment status (`success` or `failed`) |

## How it works

1. POSTs to `/deploy/:app` — receives a `job_id` immediately
2. Streams real-time logs from the deployment via SSE (`/jobs/:id/logs`)
3. Polls `/jobs/:id` until terminal state (`success` or `failed`)
4. Fails the step if deployment fails or timeout is exceeded

## Full example

```yaml
deploy:
  runs-on: ubuntu-latest
  needs: [docker]
  steps:
    - uses: jkrumm/rollhook-action@v1
      with:
        url: ${{ secrets.ROLLHOOK_URL }}
        token: ${{ secrets.ROLLHOOK_WEBHOOK_TOKEN }}
        app: my-api
        image_tag: registry.example.com/my-api:${{ needs.docker.outputs.version }}
        timeout: '300'
```
