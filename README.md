# template-helloworld-express

A **GitHub template repository** — the application-side starting point for workloads provisioned by the platform-engineering bootstrap workflow.

When an operator clicks **Provision Infrastructure**, the platform workflow:

1. Provisions the cloud infrastructure for the application (Azure, AWS, or GCP, per the platform's infrastructure templates) across `dev`, `staging`, `prod`.
2. Creates a new repo under the same org using **this template**.
3. Opens a tracking issue in the new repo.
4. Creates GitHub Environments (`dev`, `staging`, `prod`) and writes per-environment **variables** into each — including `DEPLOY_TARGET_CLOUD`, which tells the deploy router where that environment lives (see [Cloud resolution](#cloud-resolution)).
5. Watches the **`ci.yml`** run that GitHub auto-triggers from the initial
   `push` to `main` after template generation (the platform doesn't dispatch
   it — it observes the auto-trigger).
6. Posts a summary on the tracking issue once the run completes.

The run is considered successful when `ci.yml` (which includes a dev deploy) reaches `success`.

---

## Application endpoints

| Path | Method | Response |
|------|--------|----------|
| `/` | GET | HTML hello-world page (app name, env, image tag) |
| `/health` | GET | `200 OK` — used by platform health checks and deploy smoke tests |
| `/whois` | GET | JSON `{ app_name, environment, image_tag }` |

Runtime configuration is injected as environment variables by the deploy workflows (and/or the cloud runtime's own settings):

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

The CI/CD pipeline is **cloud-agnostic**: build and release logic never mention a cloud provider. All deployments funnel through the `deploy.yml` router, which resolves the target cloud per environment and delegates to a cloud-specific reusable workflow:

``` text
ci.yml ──────────────┐
release.yml ─────────┤                      ┌─ deploy-azure.yml  (e.g. App Service)
                     ├─▶ deploy.yml ────────┼─ deploy-aws.yml    (e.g. ECS Fargate)
manual dispatch ─────┘    (cloud router)    └─ deploy-gcp.yml    (comming soon)
```

### `ci.yml` — Continuous Integration

Triggered by `push` on `main` (auto-fired by the initial commit GitHub
creates when template-generating this repo, which is what the platform's
`observe-ci` job watches), and by `workflow_dispatch` for ad-hoc re-runs.

``` text
push / workflow_dispatch
  └─ build-test-push
        ├─ npm ci && npm test
        ├─ docker build & push → ghcr.io/<owner>/<repo>:sha-<short>
        └─ outputs: image_tag
  └─ deploy-dev  (calls deploy.yml with environment=dev)
        └─ resolve cloud → provider deploy → post-deploy validation
```

`ci.yml` contains no cloud-specific logic and no cloud parameter — the dev environment's own configuration decides where it deploys. The entire run — including the dev deploy — must be green for the platform to consider bootstrap successful.

### `release.yml` — Release & Promotion

Triggered when a **GitHub Release is created**. Also has a `workflow_dispatch` trigger for testing without creating a real release.

``` text
release created / workflow_dispatch
  └─ validate
        └─ pre-release flag declares intent → tag format must agree → target environment
  └─ identify-image  (environment: dev for RC, staging for GA)
        └─ resolve source env cloud → read the sha-* tag currently running there
  └─ retag-image
        └─ docker pull sha-tag → docker tag release-tag → docker push
  └─ deploy  (calls deploy.yml with target environment + release tag)
```

The `identify-image` job is cloud-aware: it resolves the **source** environment's cloud from `DEPLOY_TARGET_CLOUD` (same rule as the router) and runs the matching read-only query — Azure Web App `linuxFxVersion`, or the ECS service's current task definition image. Source and target environments may live on different clouds.

#### Release routing rules

On release events, the release's **pre-release flag declares the intent**, and the tag format must agree with it — the workflow never routes on the tag alone:

| Release type | Required tag format | Example | Target |
|--------------|--------------------|---------|--------|
| Pre-release ✔ | `X.Y.Z-RC` | `1.4.0-RC` | `staging` |
| Full release | `X.Y.Z` (no suffix) | `1.4.0` | `prod` |
| — | `v` prefix accepted | `v1.4.0-RC` | same as above |

A flag/format mismatch (e.g. a pre-release tagged `1.4.0`, or a full release tagged `1.4.0-RC`) or any other tag format fails the workflow immediately, before any image or deployment action. Manual `workflow_dispatch` runs have no pre-release flag, so the target is derived from the tag format alone (testing path).

#### Image tagging strategy

The workflow does not build a new image. It reads the `sha-*` tag currently deployed to the development `dev` environment, adds the release version as a second tag to the same image digest in GHCR, and deploys that tag to the target environment. At any point in time the same image may carry multiple tags:

| Tag | Meaning |
|-----|---------|
| `sha-abc1234` | built from commit `abc1234`, deployed to `dev` |
| `1.4.0-RC` | promoted to `staging` as release candidate |
| `1.4.0` | promoted to `prod` as GA release |

### `deploy.yml` — Cloud-agnostic deploy router

Reusable workflow (`workflow_call`), also manually runnable (`workflow_dispatch`). Called by `ci.yml` for dev on every push and by `release.yml` for staging/prod promotions. It contains **no cloud-provider deployment commands**: it resolves the target cloud, opens the deployment report, routes to the matching cloud workflow, and reports the result. In the future, provenance & attestation will be crafted into this workflow.

#### Inputs

| Input | Type | Description |
|-------|------|-------------|
| `environment` | string | `dev`, `staging`, or `prod` |
| `image_tag` | string | Tag to deploy, e.g. `sha-abc1234` or `1.4.0-RC` |

There is deliberately **no `cloud` input** — callers never carry cloud knowledge.

#### Cloud resolution

The target cloud comes from the **`DEPLOY_TARGET_CLOUD`** variable, read in the scope of the target GitHub Environment:

- Allowed values: `azure`, `aws`, `gcp`.
- An **environment-level** value overrides a **repository-level** one, so each environment can target a different cloud (e.g. dev on `azure`, staging on `aws`, prod on `gcp`), while a repository-level value acts as the default for environments that don't override it.
- The variable is configured by the platform workflow alongside the other per-environment cloud parameters. An unset or invalid value **fails fast** with an error naming the variable and the environment.

Examples — single-cloud setup (repository-level default):

```bash
gh variable set DEPLOY_TARGET_CLOUD --repo <org>/<app-repo> --body aws
```

Per-environment override (heterogeneous setup):

```bash
gh variable set DEPLOY_TARGET_CLOUD --repo <org>/<app-repo> --env dev --body azure
gh variable set DEPLOY_TARGET_CLOUD --repo <org>/<app-repo> --env staging --body aws
gh variable set DEPLOY_TARGET_CLOUD --repo <org>/<app-repo> --env prod --body aws
```

#### Deployment reports

Every deployment leaves an audit record so the history of changes (who did what, how and when) can be reconstructed from either entry point — the workflow run or the project issue history. Both mechanisms are built from the same record, so they always carry the same tables and facts:

| | Run summary | Report issue |
|---|---|---|
| `dev` | started + finished segments | — (fail-early CI loop, no issue noise) |
| `staging` / `prod` | started + finished segments | opens at start, result posted as a comment |

The start record carries environment, target cloud, image tag, trigger, initiating actor, commit, start timestamp and the run link; the result record carries the outcome, per-cloud job results, finish timestamp and the evidence link. Report issues are **never closed by automation**: they stay open, whatever the outcome, until a project member reviews the results and the linked evidence and closes the issue to acknowledge the deployment.

#### Manual deployment

Any environment can be deployed ad hoc from the Actions tab (**Deploy → Run workflow**) or with the CLI — the cloud is still resolved from the environment's configuration:

```bash
gh workflow run deploy.yml --repo <org>/<app-repo> \
  -f environment=staging \
  -f image_tag=sha-abc1234
```

### `deploy-azure.yml` — Azure implementation (App Service)

Invoked only by the router. Steps, in order:

1. **Preflight** — validates all required variables, failing fast **before any login or mutation** and naming every missing item.
2. OIDC login via `azure/login@v3` (no long-lived credentials).
3. `az webapp config appsettings set` — injects `APP_NAME`, `APP_ENV`, `IMAGE_TAG` **before** the container update so the new container starts with the right env vars already in place.
4. `az webapp config container set` — points the Web App at the new image; the image change triggers an App Service restart automatically.
5. **Readiness wait** — polls the per-instance state via the ARM REST API until every instance reports `READY`.
6. Post-deploy validation (see [Post-deploy validation](#post-deploy-validation)).

GitHub Environment variables consumed (set by the platform workflow):

| Variable | Example |
|----------|---------|
| `AZURE_SUBSCRIPTION_ID` | `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx` |
| `AZURE_CLIENT_ID` | `yyyyyyyy-yyyy-yyyy-yyyy-yyyyyyyyyyyy` |
| `AZURE_TENANT_ID` | `zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz` |
| `AZURE_RESOURCE_GROUP` | `rg-myapp-dev` |
| `AZURE_WEBAPP_NAME` | `app-myapp-dev` |

### `deploy-aws.yml` — AWS implementation (ECS Fargate)

Invoked only by the router. Steps, in order:

1. **Preflight** — validates all required variables, failing fast **before any login or mutation** and naming every missing item.
2. OIDC authentication via `aws-actions/configure-aws-credentials@v4` (IAM role assumption, no long-lived keys).
3. **Deployment controller detection** — the infrastructure provisions services with different ECS controllers, and the workflow branches on the service's `deploymentController.type`.
4. Registers a new task definition revision carrying the image **and** the `APP_NAME` / `APP_ENV` / `IMAGE_TAG` env vars atomically (the ECS equivalent of Azure's settings-before-image ordering).
5. Ships the revision per controller:
   - **`ECS` (rolling)** — `aws ecs update-service`, then `aws ecs wait services-stable`.
   - **`CODE_DEPLOY` (blue/green)** — creates an AWS CodeDeploy deployment whose AppSpec carries the new task definition and the container name/port read from it, then polls until the deployment succeeds, logging per interval the status, the lifecycle stage in progress, and the **live ALB traffic split** between the blue/green target groups. Failed or stopped deployments fail within one poll interval, surfacing CodeDeploy's error information.
6. Post-deploy validation (see [Post-deploy validation](#post-deploy-validation)).

> **Watching a blue/green deployment**: the job log is the reference progress view. The ECS console's task-set traffic column lags until the task-set swap completes, and the two target groups alternate blue/green roles between deployments — the actual traffic split lives in the ALB listener weights, which the job log reports.

GitHub Environment variables consumed (set by the platform workflow):

| Variable | Example | Notes |
|----------|---------|-------|
| `AWS_ROLE_ARN` | `arn:aws:iam::<account>:role/<role>` | IAM role assumed via OIDC |
| `AWS_REGION` | `eu-west-1` | |
| `AWS_ECS_CLUSTER` | `myapp-dev` | |
| `AWS_ECS_SERVICE` | `myapp-dev` | |
| `AWS_APP_URL` | `https://myapp.dev.example.com` | required for `dev` only (HTTP smoke test) |

The CodeDeploy resource names are **derived by naming convention** rather than configured — application `cd-<service>`, deployment group `<service>-dg` — so blue/green environments need no extra variables. A missing derived resource fails fast naming the expected values. Reading the live traffic weights needs `elasticloadbalancing:DescribeListeners` on the deploy role; without it the progress log degrades to status/stage reporting.

### `deploy-gcp.yml` — GCP implementation

Not implemented yet: the file exposes the shared `environment`/`image_tag` contract so the router can reference it, and fails fast with an actionable error if selected. The implementation (Cloud Run, OIDC via Workload Identity Federation, on par with the Azure and AWS workflows) is tracked in the issue backlog.

### Post-deploy validation

All three environments run **control-plane assertions** in every deployment; `dev` additionally gets an HTTP smoke test against the public endpoint. Control-plane assertions catch failures the readiness wait alone can miss — e.g. a rolled-back deployment that settles on the previous revision would still serve `/health` from the old version, but the image-tag assertion fails it.

| Check | Azure | AWS |
|-------|-------|-----|
| Runtime state | App Service state == `Running` | Service `ACTIVE`; rolling: primary deployment rollout `COMPLETED`; blue/green: primary task set `STEADY_STATE` with running == desired |
| Deployed image | `linuxFxVersion` contains the expected tag | The (task set's) task definition image contains the expected tag |
| HTTP smoke test (`dev` only) | `GET /health` on `<webapp>.azurewebsites.net`, up to 3 min | `GET /health` on `AWS_APP_URL`, up to 3 min |

The public hostname for staging/prod is unreachable from GitHub-hosted runners (private-only ingress), so the smoke test is dev-only; the control-plane assertions provide equivalent confidence without network access to the app. To use HTTP validation against staging/prod, provision self-hosted runners inside the private network and remove the environment condition on the smoke-test step.

On AWS, a failed rollout additionally triggers a **diagnostics step** that dumps the service deployments, recent service events, stopped-task stop codes and container exit codes — and, for blue/green, the recent CodeDeploy deployments with their error information — so a failed deployment is diagnosable from the job log alone.

**What the underlying infrastructure must provide:** each environment must expose the app's contract — the container listens on `PORT` (image default `8080`) as a **non-root** user, and serves `/health`. On Azure that means a Linux container Web App with `health_check_path = "/health"` and dev reachable publicly; on AWS an ECS Fargate service whose task definition, target groups and security groups speak port `8080`, with the CodeDeploy application/deployment group following the naming convention above for blue/green environments. Any infrastructure deviating from this needs matching changes to the deploy workflows.

---

## Prerequisites before first use

### 1. Workflow permissions on the new repo — handled automatically

When GitHub creates a repo from a template via the API, the new repo inherits the
org/account default for `GITHUB_TOKEN` permissions, which is **read-only** unless
changed. `ci.yml` needs `packages: write` to push to GHCR and `issues: write`
for the deployment reports — those declarations in the workflow file are
silently ignored if the repo default is read-only.

**The platform workflow handles this for you.** Immediately after creating the
repo from the template, the platform's `create-app-repo` job calls:

```bash
gh api \
  --method PUT \
  /repos/$NEW_REPO_FULL_NAME/actions/permissions/workflow \
  -f default_workflow_permissions=write
```

so the very first `ci.yml` run already has the permissions it needs. No operator
action required.

If you'd rather rely on an org-wide default instead (so every new repo inherits
the right permission without per-repo API calls), set:

- Personal account: **Settings → Actions → General → Workflow permissions → Read and write permissions**
- Organisation: **Org Settings → Actions → General → Workflow permissions → Read and write permissions**

The per-repo PUT is the recommended path for fully automated provisioning because
it doesn't rely on an org-wide default that could be changed by accident — but
both work.

### 2. Cloud OIDC trust — handled automatically

The deploy workflows authenticate with **OIDC only** — no long-lived cloud
credentials are stored anywhere. Each cloud must trust this repo's workflow
identities, per environment; the platform workflow registers the trust for you
when provisioning, so no operator action is required on the happy path.

**Azure** — the service principal needs a federated credential per environment:

| Environment | Subject claim |
|-------------|---------------|
| `dev` | `repo:<org>/<app-repo>:environment:dev` |
| `staging` | `repo:<org>/<app-repo>:environment:staging` |
| `prod` | `repo:<org>/<app-repo>:environment:prod` |

If you ever need to add them by hand — for example to authorise an
out-of-band branch or fork that the platform didn't provision:

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

> **Prerequisite for the automated path** (one-time setup, owned by the
> platform side — but listed here for completeness):
>
> 1. The platform service principal must be added as an **owner** of its
>    own App Registration:
>
>    ```bash
>    APP_OBJECT_ID=$(az ad app show --id "$CLIENT_ID" --query id -o tsv)
>    SP_OBJECT_ID=$(az ad sp show --id "$CLIENT_ID" --query id -o tsv)
>    az ad app owner add --id "$APP_OBJECT_ID" --owner-object-id "$SP_OBJECT_ID"
>    ```
>
>    Ownership alone covers user-delegated flows, but not the
>    application-only flow a workflow's OIDC token runs under.
>
> 2. The SP must hold the Microsoft Graph **application permission**
>    `Application.ReadWrite.OwnedBy` with admin consent. Grant via Entra
>    Portal (*App registrations → API permissions → Add → Microsoft Graph
>    → Application permissions → `Application.ReadWrite.OwnedBy` → Grant
>    admin consent*) or with `az rest` POST against
>    `/v1.0/servicePrincipals/<sp-id>/appRoleAssignments`.
>
> Without (2), the automated fed-cred call returns
> `Insufficient privileges to complete the operation` even with full
> ownership. `Application.ReadWrite.OwnedBy` (not `…OwnedBy.All` or
> `…All`) keeps the SP's blast radius to App Registrations it owns —
> which, after step 1, is exactly one: itself.

**AWS** — the IAM role in `AWS_ROLE_ARN` needs a trust policy on the GitHub
OIDC provider (`token.actions.githubusercontent.com`) accepting the same
per-environment subject claims (`repo:<org>/<app-repo>:environment:<env>`).
The platform's `oidc-trust` job registers these when provisioning.

### 3. GHCR package must not already exist under a different repo

GHCR ties each package permanently to the repository that first created it. If a
package named `ghcr.io/<owner>/<app>` already exists — for example from an earlier
test run of a repo with the same name — `GITHUB_TOKEN` from the new repo will be
denied with `permission_denied: write_package` on every push, regardless of token
permissions or repo settings.

**If you are re-provisioning a repo with the same name**, delete the old package
first:

- Organisation: `https://github.com/orgs/<org>/packages/container/<app>`
- Personal account: `https://github.com/users/<user>/packages/container/<app>`

Go to **Package settings → Delete this package** before triggering `ci.yml`.

### 4. GHCR package visibility and runtime pull access

The cloud runtimes pull the image **without registry credentials** by default. If
the container image is private the runtime will fail to start it (e.g. Azure App
Service reports `ImagePullUnauthorizedFailure`; ECS tasks stop with a pull error).
There are three strategies; choose the one that matches your context.

---

#### Strategy 1 — Public package (this template's default; suitable for workshops)

For a workshop using a public repository, making the container image public is the
right trade-off: the source code is already open, so the built artefact being
publicly pullable adds no meaningful exposure.

**GHCR package visibility is automatically inherited from the repository.** When
`ci.yml` pushes an image to GHCR using `GITHUB_TOKEN`, GitHub links the package to
the repository and applies the same visibility:

- **Public repository** → package is **public** — the runtimes can pull without
  credentials. No extra steps, no secrets required.
- **Private repository** → package is **private** — use Strategy 2 or 3 below.

---

#### Strategy 2 — Private GHCR package with stored credentials (Azure example)

App Service can pull a private GHCR image if registry credentials are passed when
the container is configured. In `deploy-azure.yml`, add three flags to the
`az webapp config container set` call:

```bash
az webapp config container set \
  --container-registry-url      "https://ghcr.io" \
  --container-registry-user     "<github-username>" \
  --container-registry-password "<classic-pat-read-packages>"
```

The password must be a **classic PAT** with the `read:packages` scope (fine-grained
PATs do not support GHCR). App Service persists the credentials and uses them for
every subsequent pull — restarts, scale-out, slot swaps. (The AWS equivalent is an
ECS `repositoryCredentials` secret in Secrets Manager referenced from the task
definition.)

**Downsides to be aware of:**

- Classic PATs are long-lived and do not rotate automatically; a rotation process
  must be put in place.
- The credential is stored in plain text in the App Service configuration unless
  you use an [Azure Key Vault reference](https://learn.microsoft.com/azure/app-service/app-service-key-vault-references)
  (`@Microsoft.KeyVault(...)` syntax in the app setting value).
- If the PAT expires or is revoked all environments using it break simultaneously.

Suitable for private repositories where the image must stay private, and where the
operational cost of PAT rotation is acceptable.

---

#### Strategy 3 — Cloud-native registry + workload identity (recommended for production)

The cleanest production approach avoids credentials entirely by replacing GHCR with
the cloud's own registry and its identity-based pull authorization — **Azure
Container Registry** pulled via the Web App's managed identity (`AcrPull` role), or
**Amazon ECR** pulled via the ECS task execution role.

The workflow change is small: replace the `docker login ghcr.io` / `docker push`
steps with the registry's OIDC-authenticated login and push to the registry's
address instead; the deploy workflows then reference that address.

``` text
ci.yml: build → registry login (OIDC) → docker push <registry>/<app>:<tag>
deploy-*.yml: point the runtime at <registry>/<app>:<tag>  (no credentials needed)
```

**What changes on the platform side:**

- Terraform provisions the registry and the role assignment linking the runtime's
  identity to it (e.g. `AcrPull` for the Web App's managed identity, or the ECR
  pull permissions on the ECS task execution role).
- The registry address is added as a per-environment GitHub variable alongside
  the existing ones.

**Benefits over strategies 1 and 2:**

- Zero credentials in the pipeline or in the runtime configuration.
- The identity tokens are managed by the cloud and never expire.
- Works equally well for dev, staging, and prod with no changes to the workflow.
- Integrates with the cloud's image-scanning and policy tooling if needed.

This is the recommended path for any workload moving beyond the workshop stage.

---

#### Summary

| | Public GHCR | Private GHCR + credentials | Cloud registry + identity |
|---|---|---|---|
| Image visibility | Public | Private | Private |
| Credentials required | None | Classic PAT (`read:packages`) | None (workload identity) |
| Rotation required | — | Yes (manual) | No |
| Platform changes needed | None | Workflow only | Terraform + workflow |
| Recommended for | Workshops / OSS | Private repos (short-term) | Production |

---

## Container image tags

| Scenario | Tags produced |
|----------|---------------|
| Push to `main` (incl. the template-generation initial commit) | `sha-<7-char-sha>`, `latest` |
| Release candidate (`X.Y.Z-RC`) | `sha-<7-char-sha>` *(existing)* + `X.Y.Z-RC` |
| GA release (`X.Y.Z`) | `sha-<7-char-sha>` *(existing)* + `X.Y.Z` |

The `sha-*` tag is the immutable build identity. Release tags are added to the same
digest by `release.yml` without rebuilding. `:latest` always points to the most
recent `main` push.

---

## Repo structure

``` text
.
├── src/
│   ├── index.js            # Express app
│   └── index.test.js       # Jest unit tests
├── .github/
│   └── workflows/
│       ├── ci.yml          # Build → test → push → deploy-dev
│       ├── release.yml     # Intent-checked release → retag → promote to staging/prod
│       ├── deploy.yml      # Cloud-agnostic router + deployment reports
│       ├── deploy-azure.yml# Azure implementation (App Service)
│       ├── deploy-aws.yml  # AWS implementation (ECS Fargate, rolling + blue/green)
│       └── deploy-gcp.yml  # GCP placeholder (fails fast until implemented)
├── Dockerfile
├── .dockerignore
├── .gitignore
├── LICENSE
├── package.json            # Runtime deps + npm scripts (start, test)
├── package-lock.json       # Locked dep tree (committed; npm ci uses it)
└── README.md
```

---

## License

MIT — see [LICENSE](LICENSE).
