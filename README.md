# template-helloworld-express

A **GitHub template repository** — the application-side starting point for workloads provisioned by the platform-engineering bootstrap workflow.

When an operator clicks **Provision Infrastructure**, the platform workflow:

1. Provisions Azure infrastructure (Web App + Plan + VNet + PE + MI + Log Analytics + autoscale + slot) across `dev`, `staging`, `prod`.
2. Creates a new repo under the same org using **this template**.
3. Opens a tracking issue in the new repo.
4. Creates GitHub Environments (`dev`, `staging`, `prod`) and writes per-environment **variables** into each.
5. Dispatches **`ci.yml`** in the new repo and watches that single run.
6. Posts a summary on the tracking issue once the run completes.

The run is considered successful when `ci.yml` (which includes a dev deploy) reaches `success`.

---

## Application endpoints

| Path | Method | Response |
|------|--------|----------|
| `/` | GET | HTML hello-world page (app name, env, image tag) |
| `/health` | GET | `200 OK` — used by App Service health checks |
| `/whois` | GET | JSON `{ app_name, environment, image_tag }` |

Runtime configuration is injected as environment variables by `deploy.yml` and/or App Service app settings:

| Variable | Purpose | Default (local) |
|----------|---------|-----------------|
| `PORT` | HTTP listen port | `8080` |
| `APP_NAME` | Application name | `hello-world` |
| `APP_ENV` | Environment name | `local` |
| `IMAGE_TAG` | Running image tag | `dev` |

---

## Local development

```bash
# Install dependencies
npm install

# Run tests
npm test

# Start the server
APP_NAME=my-app APP_ENV=local IMAGE_TAG=dev npm start
# → http://localhost:8080
```

### Docker

```bash
docker build -t my-app:local .

docker run --rm -p 8080:8080 \
  -e APP_NAME=my-app \
  -e APP_ENV=local \
  -e IMAGE_TAG=local \
  my-app:local
# → http://localhost:8080
```

---

## Workflow overview

### `ci.yml` — Continuous Integration

Triggered by `push` on `main` and `workflow_dispatch` (the platform's bootstrap dispatch).

```
push / workflow_dispatch
  └─ build-test-push
        ├─ npm ci && npm test
        ├─ docker build & push → ghcr.io/<owner>/<repo>:sha-<short>
        └─ outputs: image_tag
  └─ deploy-dev  (calls deploy.yml with environment=dev)
        └─ OIDC login → image swap → restart → smoke test
```

The entire run — including the dev deploy — must be green for the platform to consider bootstrap successful.

### `deploy.yml` — Reusable Deploy

Reusable workflow (`workflow_call`). Called by `ci.yml` for dev on every push; called by a separate promotion workflow (not in this template) for staging/prod.

**Inputs**

| Input | Type | Description |
|-------|------|-------------|
| `environment` | string | `dev`, `staging`, or `prod` |
| `image_tag` | string | Tag to deploy, e.g. `sha-abc1234` |

**GitHub Environment variables consumed** (set by the platform workflow)

| Variable | Example |
|----------|---------|
| `AZURE_SUBSCRIPTION_ID` | `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx` |
| `AZURE_CLIENT_ID` | `yyyyyyyy-yyyy-yyyy-yyyy-yyyyyyyyyyyy` |
| `AZURE_TENANT_ID` | `zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz` |
| `AZURE_RESOURCE_GROUP` | `rg-myapp-dev` |
| `AZURE_WEBAPP_NAME` | `app-myapp-dev` |

**Deploy steps**

1. OIDC login via `azure/login@v3` using the variables above.
2. `az webapp config container set` — points the existing Web App at the new image (no infrastructure changes).
3. `az webapp config appsettings set` — injects `APP_ENV`, `IMAGE_TAG`, `APP_NAME`.
4. `az webapp restart`.
5. Smoke test: polls `GET https://<webapp>.azurewebsites.net/health` every 10 s for up to 3 min.

> **Private-endpoint environments** — if `private_endpoint_enabled=true` for an environment (typically staging/prod), the public `/health` endpoint is not reachable from GitHub-hosted runners. Switch the smoke test to the control-plane state check documented in `deploy.yml` (comment block at the bottom of the smoke-test step).

---

## Prerequisites before first use

### 1. Workflow permissions on the new repo

When GitHub creates a repo from a template via the API, the new repo inherits the
org/account default for `GITHUB_TOKEN` permissions, which is **read-only** unless
changed. `ci.yml` needs `packages: write` to push to GHCR — that declaration in
the workflow file is silently ignored if the repo default is read-only.

**Fix A — org/account default (one-time, affects all future repos)**

Change the default so every template-generated repo inherits read+write automatically:

- Personal account: **Settings → Actions → General → Workflow permissions → Read and write permissions**
- Organisation: **Org Settings → Actions → General → Workflow permissions → Read and write permissions**

**Fix B — platform workflow (per-repo, no org setting change required)**

Add this API call to the platform workflow immediately after creating the repo and
before dispatching `ci.yml`:

```bash
gh api \
  --method PUT \
  /repos/$NEW_REPO_FULL_NAME/actions/permissions/workflow \
  -f default_workflow_permissions=write
```

This is the recommended approach for fully automated provisioning — it keeps each
repo correctly configured without relying on an org-wide default that could be
changed by accident.

> **Future automation**: this call is a candidate for the platform workflow to
> perform automatically as part of the bootstrap sequence, alongside environment
> and variable creation.

### 2. OIDC federated credentials

The platform workflow creates the service principal and its initial federated credentials scoped to the **platform repo**. For `deploy.yml` to authenticate from the **new app repo**, the same SP needs an additional federated credential per environment:

| Environment | Subject claim |
|-------------|---------------|
| `dev` | `repo:<org>/<app-repo>:environment:dev` |
| `staging` | `repo:<org>/<app-repo>:environment:staging` |
| `prod` | `repo:<org>/<app-repo>:environment:prod` |

**How to add (Azure Portal)**

1. Open the service principal → **Certificates & secrets** → **Federated credentials**.
2. Add a credential for each environment using the subject format above.

**How to add (CLI)**

```bash
APP_REPO="my-org/my-app"
CLIENT_ID="<client-id>"

for ENV in dev staging prod; do
  az ad app federated-credential create \
    --id "$CLIENT_ID" \
    --parameters "{
      \"name\": \"${APP_REPO//\//-}-${ENV}\",
      \"issuer\": \"https://token.actions.githubusercontent.com\",
      \"subject\": \"repo:${APP_REPO}:environment:${ENV}\",
      \"audiences\": [\"api://AzureADTokenExchange\"]
    }"
done
```

> **Future automation**: adding these federated credentials is a candidate for the platform workflow to perform automatically at provision time.

### 2. GHCR package visibility

On the first push, `docker/build-push-action` creates the package as **private** by default. Either:

- Go to `https://github.com/orgs/<org>/packages` → the package → **Package settings** → change visibility to **Public** (recommended for cross-org pulls from App Service), **or**
- Add the managed identity of the Web App to the package's access list with `read` permission.

---

## Container image tags

| Scenario | Tags produced |
|----------|---------------|
| Push to `main` | `sha-<7-char-sha>`, `latest` |
| `workflow_dispatch` from platform | `sha-<7-char-sha>`, `latest` |

The `deploy.yml` always uses the immutable `sha-*` tag; `:latest` is a convenience alias.

---

## Repo structure

```
.
├── src/
│   ├── index.js          # Express app
│   └── index.test.js     # Jest unit tests
├── .github/
│   └── workflows/
│       ├── ci.yml        # Build → test → push → deploy-dev
│       └── deploy.yml    # Reusable deploy (any env)
├── Dockerfile
├── .dockerignore
├── .gitignore
├── package.json
└── README.md
```

---

## License

MIT — see [LICENSE](LICENSE).
