import { test } from "node:test";
import assert from "node:assert/strict";
import {
  gcpDeployArgs,
  gcpLogArgs,
  gcpSecretName,
  gcpServiceName,
  gcpServiceSecrets,
  type GcpManifest,
} from "../src/backends/gcp.ts";
import { computedSecrets } from "../src/secrets.ts";
import type { DeskmateConfig } from "../src/config.ts";

const config: DeskmateConfig = {
  contract: 1,
  orgId: "acme",
  publicUrl: "https://deskmate.example.com",
  target: "gcp",
  services: ["core"],
  plugins: [],
  skills: [],
  env: {},
  imageOverrides: {},
  sandbox: { app: "acme-sandboxes" },
  gcp: {
    projectId: "acme-project",
    region: "us-central1",
    artifactRegistry: "acme-deskmate",
    secretsPrefix: "acme-deskmate-",
    imageLabel: "release",
  },
};

test("Cloud Run deploy arguments bind immutable images, env, secrets, SQL, and core scaling", () => {
  const args = gcpDeployArgs({
    projectId: "acme-project",
    region: "us-central1",
    serviceName: "acme-deskmate-core",
    image: `us-central1-docker.pkg.dev/acme-project/acme-deskmate/core@sha256:${"a".repeat(64)}`,
    serviceAccount: "runtime@acme-project.iam.gserviceaccount.com",
    env: { ORG_ID: "acme", VALUE: "a,b" },
    secrets: { DATABASE_URL: "acme-deskmate-DATABASE_URL:latest" },
    core: true,
    public: true,
    network: "acme-deskmate-runtime",
    subnet: "acme-deskmate-runtime",
    cloudSqlConnectionName: "acme-project:us-central1:acme-deskmate-postgres",
  });
  assert.deepEqual(args.slice(0, 4), ["run", "deploy", "acme-deskmate-core", "--image"]);
  assert.ok(args.includes("--no-cpu-throttling"));
  assert.ok(args.includes("--add-cloudsql-instances"));
  assert.equal(args[args.indexOf("--ingress") + 1], "all");
  assert.ok(args.includes("--set-env-vars=^~^ORG_ID=acme~VALUE=a,b"));
  assert.ok(args.includes("--set-secrets=^~^DATABASE_URL=acme-deskmate-DATABASE_URL:latest"));
  assert.deepEqual(args.slice(-2), ["--project", "acme-project"]);
});

test("non-core Cloud Run services scale to zero and do not receive core-only flags", () => {
  const args = gcpDeployArgs({
    projectId: "acme-project",
    region: "us-central1",
    serviceName: "acme-deskmate-web-ui",
    image: `image@sha256:${"b".repeat(64)}`,
    serviceAccount: "runtime@acme-project.iam.gserviceaccount.com",
    env: {},
    secrets: {},
    core: false,
    public: false,
    network: "acme-deskmate-runtime",
    subnet: "acme-deskmate-runtime",
  });
  assert.equal(args[args.indexOf("--min-instances") + 1], "0");
  assert.ok(!args.includes("--no-cpu-throttling"));
  assert.ok(!args.includes("--add-cloudsql-instances"));
  assert.equal(args[args.indexOf("--ingress") + 1], "internal");
});

test("GCP log arguments use GA reads and alpha streaming without shell interpolation", () => {
  assert.deepEqual(
    gcpLogArgs({
      projectId: "acme-project",
      region: "us-central1",
      serviceName: "acme-deskmate-core",
      tail: 25,
    }),
    [
      "run",
      "services",
      "logs",
      "read",
      "acme-deskmate-core",
      "--region",
      "us-central1",
      "--limit",
      "25",
      "--project",
      "acme-project",
    ],
  );
  assert.deepEqual(
    gcpLogArgs({
      projectId: "acme-project",
      region: "us-central1",
      serviceName: "acme-deskmate-core",
      follow: true,
    }).slice(0, 5),
    ["alpha", "run", "services", "logs", "tail"],
  );
});

test("GCP resource names derive deterministically from config", () => {
  assert.equal(gcpServiceName(config, "core"), "acme-deskmate-core");
  assert.equal(gcpSecretName(config.gcp!, "CORE_SIGNING_SECRET"), "acme-deskmate-CORE_SIGNING_SECRET");
  assert.equal(gcpServiceName({ ...config, orgId: "a".repeat(63) }, "portal").length, 49);
  assert.notEqual(
    gcpServiceName({ ...config, orgId: "a".repeat(63) }, "portal"),
    gcpServiceName({ ...config, orgId: "a".repeat(63) }, "core"),
  );
});

test("the GCP deployment manifest records immutable images and deployed revisions", () => {
  const manifest: GcpManifest = {
    id: "deployment-id",
    imageLabel: "release",
    createdAt: "2026-07-31T00:00:00.000Z",
    images: { core: `registry/core@sha256:${"c".repeat(64)}` },
    revisions: { core: "acme-deskmate-core-00001-abc" },
  };
  assert.match(manifest.images.core!, /@sha256:[a-f0-9]{64}$/);
  assert.equal(manifest.revisions.core, "acme-deskmate-core-00001-abc");
});

test("Cloud Run binds required stored secrets and skips absent optional secrets", () => {
  const required = computedSecrets(config)
    .filter((secret) => secret.required)
    .map((secret) => gcpSecretName(config.gcp!, secret.name));
  const available = new Set([
    ...required,
    gcpSecretName(config.gcp!, "DATABASE_URL"),
    gcpSecretName(config.gcp!, "S3_ACCESS_KEY_ID"),
    gcpSecretName(config.gcp!, "S3_SECRET_ACCESS_KEY"),
  ]);
  const secrets = gcpServiceSecrets(config, "core", available);
  assert.equal(secrets.CORE_SIGNING_SECRET, "acme-deskmate-CORE_SIGNING_SECRET:latest");
  assert.equal(secrets.ANTHROPIC_API_KEY, undefined);
  assert.throws(
    () => gcpServiceSecrets(config, "core", new Set()),
    /required Secret Manager secret acme-deskmate-[A-Z_]+ is missing/,
  );
});
