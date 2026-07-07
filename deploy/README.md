# Lolly MCP server on Google Cloud Run (Tier-B / Chromium)

The Vercel function at `lolly.tools/api/mcp` is **Tier-A only** — a serverless
function can't run headless Chromium, so it renders SVG/data formats and
`resvg` PNG for SVG-native tools, but **not** jpeg/webp, HTML-layout PNG, pdf, or
video. This container is the **Tier-B** deploy: it ships Chromium + drives a web
shell, so it renders **every** format for **all** tools.

Everything here stays under `services/mcp/deploy/` — no Google config leaks into
the repo root — so it travels when `services/mcp` splits into its own repo.

| Format | Vercel (`/api/mcp`) | This container |
|---|:--:|:--:|
| svg, emf, eps, data/text | ✅ | ✅ |
| png (SVG-native tools, e.g. qr-code) | ✅ | ✅ |
| **jpeg / webp** | ❌ | ✅ |
| **png for HTML-layout tools** (color-block, quotes, …) | ❌ | ✅ |
| **pdf / pdf-cmyk / video** | ❌ | ✅ |

## What it deploys

- A Cloud Run service `lolly-mcp` running `node services/mcp/src/http.ts` (the
  same gateway as Vercel — OAuth discovery + `/mcp` JSON-RPC), with Chromium.
- Image built by **Cloud Build** (native amd64) and stored in Artifact Registry.
- `LOLLY_MCP_TOKEN` + `LOLLY_MCP_SIGNING_SECRET` from **Secret Manager**;
  `LOLLY_WEB_BASE=https://lolly.tools` as a plain env var.
- Public Cloud Run IAM (`--allow-unauthenticated`) **on purpose** — the MCP
  server's own bearer/OAuth is the gate, exactly like the Vercel endpoint.

## Prerequisites

- `gcloud` CLI, authenticated (`gcloud auth login`), with a **project that has
  billing enabled**. (No local Docker needed — Cloud Build does the build.)
- The two secret values (reuse the Vercel ones from `plans/secrets.md`).

## Deploy

```bash
cd services/mcp/deploy
cp deploy.env.example deploy.env     # fill PROJECT_ID + the two secrets
./deploy.sh
```

`deploy.sh` is idempotent — it enables the APIs, creates the Artifact Registry
repo + Secret Manager secrets, grants the runtime service account secret access,
builds, deploys, and smoke-tests (`401` unauthenticated, then a live
`color-block → jpeg` that Vercel can't do). It prints the service URL; the MCP
endpoint is `<url>/mcp`.

## Point a client at it

Same flow as Vercel, just a new host:

```bash
# Claude Code
claude mcp add --transport http lolly-full https://<cloud-run-url>/mcp \
  --header "Authorization: Bearer <LOLLY_MCP_TOKEN>"

# claude.ai / Desktop: Add custom connector → https://<cloud-run-url>/mcp
# (auto-discovers OAuth, paste the token on the consent page)
```

OAuth discovery self-describes from the request `Host`, so the raw `*.run.app`
URL works out of the box — no extra config to test.

### Optional: brand it as `mcp.lolly.tools`

```bash
gcloud beta run domain-mappings create \
  --service lolly-mcp --domain mcp.lolly.tools --region us-central1
```

Add the CNAME it prints to the `lolly.tools` DNS zone. Then use
`https://mcp.lolly.tools/mcp` — discovery URLs follow the host automatically.

## Notes & tuning

- **Web shell for Tier B:** the container drives the live `LOLLY_WEB_BASE`
  (`https://lolly.tools`) to capture exports — lightest image, but depends on the
  site being up. For a fully self-contained/air-gapped image, build
  `shells/web/dist`, `COPY` it in, and set `LOLLY_WEB_DIST` instead of
  `LOLLY_WEB_BASE` (see `webshell.ts`).
- **Cost / cold starts:** defaults scale to zero (`--min-instances 0`) — cheap,
  but the first request after idle pays a cold start (image pull + Chromium
  launch, a few seconds). For snappy demos set `--min-instances 1`.
- **Resources:** `--cpu 2 --memory 2Gi`, `--concurrency 4`, `--timeout 600`.
  Video is CPU/RAM heavy — bump memory (e.g. `4Gi`) and lower concurrency if you
  see OOM, or raise `--timeout` (Cloud Run allows up to 3600s).
- **Two endpoints, one credential:** keep the Vercel endpoint for light/vector
  work and add this for full raster/pdf/video, or make this the single canonical
  endpoint. The `LOLLY_MCP_TOKEN` is shared, so either works with the same token.
- **Redeploy:** just re-run `./deploy.sh` (new timestamped image tag each time).
