# GCP deployment

Use this after the choices and billing confirmation in `deployment.md`.

## Architecture

| Need                      | GCP service                                                                       |
| ------------------------- | --------------------------------------------------------------------------------- |
| Runtime (one per service) | Cloud Run services (core: min-instances=1, CPU always allocated, max-instances=1) |
| Postgres                  | Cloud SQL                                                                         |
| Object storage            | GCS via S3-interoperability HMAC keys (native store later)                        |
| Secrets                   | Secret Manager references                                                         |
| Rollback                  | Cloud Run revisions                                                               |
| Images                    | Artifact Registry                                                                 |
| Agent sandboxes           | Fly Sprites (interim); GCE-backed substrate planned                               |

## Bootstrap

```bash
gcloud auth list
gcloud projects describe <project-id>
npm exec deskmate -- infra render
terraform -chdir=infra init
terraform -chdir=infra apply
```

Terraform enables the required APIs and creates Artifact Registry, Cloud SQL,
the runtime service account, the GCS bucket and HMAC credentials, and managed
secrets. Set `publicUrl` to the custom domain that fronts core, then run:

```bash
npm exec deskmate -- setup
npm exec deskmate -- secrets push
npm exec deskmate -- sandbox publish
npm exec deskmate -- doctor
npm exec deskmate -- up
npm exec deskmate -- check --live
```

`deskmate status` shows Cloud Run readiness and revisions, `deskmate logs` reads Cloud
Logging, `deskmate rollback --to <revision>` moves traffic to a prior revision, and
`deskmate down` removes the Cloud Run services while leaving Terraform infrastructure.
