import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliError, errMessage, note, ok, step } from "../log.ts";
import { manifestRef } from "../manifest.ts";
import { computedSecrets, runtimeSecretNames, secretsForService } from "../secrets.ts";
import {
  brokerWiring,
  isServiceName,
  orgEnv,
  ordered,
  runnableServices,
  virtualServiceEnv,
  type ServiceName,
} from "../services.ts";
import {
  capture,
  deploymentSecretValue,
  isInvalidSecret,
  promptHidden,
  readEnvFile,
  resolveBuildRepoRoot,
  runInherit,
} from "../util.ts";
import { doctorCommon } from "./doctor.ts";
import { httpDeploymentLayerTransport, type DeploymentLayerTransport } from "../deployment-layer.ts";
import { securityScreenEnv, type GcpConfig, type DeskmateConfig } from "../config.ts";
import type { Backend } from "./types.ts";
import type { DeployContext } from "./registry.ts";

interface GcpOutputs {
  artifactRegistryUrl: string;
  bucketName: string;
  cloudSqlConnectionName: string;
  runtimeServiceAccountEmail: string;
  secretsPrefix: string;
  runtimeNetwork: string;
  runtimeSubnetwork: string;
}

export interface GcpManifest {
  id: string;
  imageLabel: string;
  createdAt: string;
  images: Record<string, string>;
  revisions: Record<string, string>;
}

function requireGcp(config: DeskmateConfig): GcpConfig {
  if (!config.gcp) throw new CliError('target "gcp" requires a gcp block');
  return config.gcp;
}

function gcloud(config: DeskmateConfig, args: string[]): string {
  const gcp = requireGcp(config);
  return capture(process.env.GCLOUD_BIN ?? "gcloud", [...args, "--project", gcp.projectId]);
}

function terraformOutputs(configDir: string): GcpOutputs {
  const raw = capture(process.env.TERRAFORM_BIN ?? "terraform", ["output", "-json"], {
    cwd: join(configDir, "infra"),
  });
  const parsed = JSON.parse(raw) as Record<string, { value?: unknown }>;
  const value = (name: string): string => {
    const found = parsed[name]?.value;
    if (typeof found !== "string" || !found) throw new CliError(`terraform output ${name} is missing`);
    return found;
  };
  return {
    artifactRegistryUrl: value("artifact_registry_url"),
    bucketName: value("bucket_name"),
    cloudSqlConnectionName: value("cloud_sql_connection_name"),
    runtimeServiceAccountEmail: value("runtime_service_account_email"),
    secretsPrefix: value("secrets_prefix"),
    runtimeNetwork: value("runtime_network"),
    runtimeSubnetwork: value("runtime_subnetwork"),
  };
}

export function gcpServiceName(config: DeskmateConfig, service: string): string {
  const full = `${config.orgId}-deskmate-${service}`;
  if (full.length <= 49) return full;
  const suffix = createHash("sha256").update(full).digest("hex").slice(0, 8);
  const tail = `-${service}-${suffix}`;
  return `${config.orgId.slice(0, 49 - tail.length).replace(/-+$/, "")}${tail}`;
}

export function gcpSecretName(gcp: GcpConfig, name: string): string {
  return `${gcp.secretsPrefix}${name}`;
}

function delimitedFlag(name: string, values: Record<string, string>): string | undefined {
  const entries = Object.entries(values);
  if (!entries.length) return undefined;
  const delimiter = "~";
  for (const [key, value] of entries) {
    if (key.includes(delimiter) || value.includes(delimiter)) {
      throw new CliError(`${key} contains the reserved gcloud environment delimiter ${delimiter}`);
    }
  }
  return `--${name}=^${delimiter}^${entries.map(([key, value]) => `${key}=${value}`).join(delimiter)}`;
}

export function gcpDeployArgs(input: {
  projectId: string;
  region: string;
  serviceName: string;
  image: string;
  serviceAccount: string;
  env: Record<string, string>;
  secrets: Record<string, string>;
  core: boolean;
  cloudSqlConnectionName?: string;
  public: boolean;
  network: string;
  subnet: string;
}): string[] {
  const args = [
    "run",
    "deploy",
    input.serviceName,
    "--image",
    input.image,
    "--region",
    input.region,
    "--platform",
    "managed",
    "--service-account",
    input.serviceAccount,
    "--port",
    "8080",
    "--min-instances",
    input.core ? "1" : "0",
    "--max-instances",
    "1",
    "--memory",
    input.core ? "1Gi" : "512Mi",
    "--cpu",
    "1",
    "--allow-unauthenticated",
    "--ingress",
    input.public ? "all" : "internal",
    "--network",
    input.network,
    "--subnet",
    input.subnet,
    "--vpc-egress",
    "all-traffic",
    "--quiet",
  ];
  if (input.core) args.push("--no-cpu-throttling");
  if (input.cloudSqlConnectionName) args.push("--add-cloudsql-instances", input.cloudSqlConnectionName);
  const env = delimitedFlag("set-env-vars", input.env);
  const secrets = delimitedFlag("set-secrets", input.secrets);
  if (env) args.push(env);
  if (secrets) args.push(secrets);
  args.push("--project", input.projectId);
  return args;
}

function serviceUrl(config: DeskmateConfig, service: ServiceName): string {
  const gcp = requireGcp(config);
  return gcloud(config, [
    "run",
    "services",
    "describe",
    gcpServiceName(config, service),
    "--region",
    gcp.region,
    "--format=value(status.url)",
  ]).trim();
}

function serviceEnvironment(
  config: DeskmateConfig,
  service: ServiceName,
  outputs: GcpOutputs,
  urls: Partial<Record<ServiceName, string>>,
): Record<string, string> {
  const coreUrl = urls.core ?? config.publicUrl;
  const authUrl = urls.auth ?? `${config.publicUrl}/idp`;
  const env = {
    ...orgEnv(service, config.orgId, config.publicUrl, config.services.includes("portal")),
    ...(service === "core" ? {} : { CORE_API_URL: coreUrl }),
    ...(config.services.includes("auth")
      ? brokerWiring(service, {
          publicUrl: config.publicUrl,
          authBaseUrl: authUrl,
          ...(config.env.auth?.AUTH_ALLOWED_EMAIL_DOMAIN
            ? { allowedEmailDomain: config.env.auth.AUTH_ALLOWED_EMAIL_DOMAIN }
            : {}),
        })
      : {}),
    ...(service === "core"
      ? {
          DEPLOY_PROVIDER: "gcp",
          SESSION_STORE: "postgres",
          RUN_STORE: "postgres",
          SNAPSHOT_STORE: "s3",
          TRANSFER_STORE: "s3",
          S3_BUCKET: outputs.bucketName,
          S3_REGION: "auto",
          SANDBOX_BACKEND: config.sandbox?.backend ?? "sprites",
          ...(config.sandbox?.app ? { FLY_SANDBOX_APP: config.sandbox.app } : {}),
          ...(config.model ? { AGENT_MODEL: config.model } : {}),
          ...(config.modelProvider ? { MODEL_PROVIDER: config.modelProvider } : {}),
          ...virtualServiceEnv(config.services, config.env),
          ...securityScreenEnv(config),
        }
      : {}),
    ...(service === "portal"
      ? {
          ...(urls["web-ui"] ? { WEB_UI_UPSTREAM: urls["web-ui"] } : {}),
          ...(urls.admin ? { ADMIN_UPSTREAM: urls.admin } : {}),
        }
      : {}),
    ...config.env[service],
  };
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

export function gcpServiceSecrets(
  config: DeskmateConfig,
  service: ServiceName,
  available: ReadonlySet<string>,
): Record<string, string> {
  const gcp = requireGcp(config);
  const result: Record<string, string> = {};
  for (const secret of secretsForService(config, service)) {
    const storedName = gcpSecretName(gcp, secret.name);
    if (!available.has(storedName)) {
      if (secret.required) throw new CliError(`required Secret Manager secret ${storedName} is missing`);
      continue;
    }
    const names = runtimeSecretNames(service, secret);
    for (const name of names.length ? names : [secret.name]) {
      result[name] = `${storedName}:latest`;
    }
  }
  if (service === "core") {
    for (const name of ["DATABASE_URL", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"]) {
      const storedName = gcpSecretName(gcp, name);
      if (!available.has(storedName))
        throw new CliError(`Terraform-managed Secret Manager secret ${storedName} is missing`);
      result[name] = `${storedName}:latest`;
    }
  }
  return result;
}

function availableSecrets(config: DeskmateConfig): Set<string> {
  const output = gcloud(config, ["secrets", "list", "--format=value(name)"]);
  return new Set(
    output
      .split("\n")
      .map((name) => name.trim().split("/").at(-1) ?? "")
      .filter(Boolean),
  );
}

function publishImage(
  config: DeskmateConfig,
  service: ServiceName,
  registry: string,
  label: string,
  opts: { buildFrom?: boolean; buildFromPath?: string },
): string {
  const tagged = `${registry}/${service}:${label}`;
  if (opts.buildFrom) {
    const root = resolveBuildRepoRoot(opts.buildFromPath, [service]);
    runInherit("docker", [
      "buildx",
      "build",
      "--platform",
      "linux/amd64",
      "--provenance=false",
      "--push",
      "-f",
      join(root, "deploy", service, "Dockerfile"),
      "-t",
      tagged,
      root,
    ]);
  } else {
    runInherit("docker", [
      "buildx",
      "imagetools",
      "create",
      "--prefer-index=false",
      "--tag",
      tagged,
      config.imageOverrides[service] ?? manifestRef(service),
    ]);
  }
  const inspected = capture("docker", ["buildx", "imagetools", "inspect", tagged]);
  const digest = inspected.match(/^Digest:\s*(sha256:[0-9a-f]{64})\s*$/m)?.[1];
  if (!digest) throw new CliError(`Artifact Registry did not return an immutable digest for ${service}`);
  return `${registry}/${service}@${digest}`;
}

function writeManifest(config: DeskmateConfig, outputs: GcpOutputs, manifest: GcpManifest): void {
  const dir = mkdtempSync(join(tmpdir(), "deskmate-gcp-manifest-"));
  const file = join(dir, "manifest.json");
  try {
    writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
    runInherit(process.env.GCLOUD_BIN ?? "gcloud", [
      "storage",
      "cp",
      file,
      `gs://${outputs.bucketName}/deployments/${manifest.imageLabel}.json`,
      "--project",
      requireGcp(config).projectId,
      "--quiet",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function up(
  ctx: DeployContext,
  opts: { dryRun: boolean; buildFrom?: boolean; buildFromPath?: string; imageLabel?: string },
): Promise<void> {
  const { config } = ctx;
  const gcp = requireGcp(config);
  const outputs = terraformOutputs(ctx.configDir);
  const services = runnableServices(config.services);
  const label = opts.imageLabel ?? gcp.imageLabel;
  if (opts.dryRun) {
    for (const service of services)
      step(`${service}: would publish ${outputs.artifactRegistryUrl}/${service}:${label}`);
    return;
  }
  runInherit(process.env.GCLOUD_BIN ?? "gcloud", [
    "auth",
    "configure-docker",
    `${gcp.region}-docker.pkg.dev`,
    "--quiet",
  ]);
  const images: Record<string, string> = {};
  for (const service of services)
    images[service] = publishImage(config, service, outputs.artifactRegistryUrl, label, opts);
  const urls: Partial<Record<ServiceName, string>> = {};
  const revisions: Record<string, string> = {};
  const secrets = availableSecrets(config);
  for (const def of ordered(services)) {
    const args = gcpDeployArgs({
      projectId: gcp.projectId,
      region: gcp.region,
      serviceName: gcpServiceName(config, def.name),
      image: images[def.name]!,
      serviceAccount: outputs.runtimeServiceAccountEmail,
      env: serviceEnvironment(config, def.name, outputs, urls),
      secrets: gcpServiceSecrets(config, def.name, secrets),
      core: def.name === "core",
      public: config.services.includes("portal") ? def.name === "portal" : def.name === "core",
      network: outputs.runtimeNetwork,
      subnet: outputs.runtimeSubnetwork,
      ...(def.name === "core" ? { cloudSqlConnectionName: outputs.cloudSqlConnectionName } : {}),
    });
    runInherit(process.env.GCLOUD_BIN ?? "gcloud", args);
    urls[def.name] = serviceUrl(config, def.name);
    revisions[def.name] = gcloud(config, [
      "run",
      "services",
      "describe",
      gcpServiceName(config, def.name),
      "--region",
      gcp.region,
      "--format=value(status.latestReadyRevisionName)",
    ]).trim();
    ok(`${def.name}: ${urls[def.name]}`);
  }
  writeManifest(config, outputs, {
    id: randomUUID(),
    imageLabel: label,
    createdAt: new Date().toISOString(),
    images,
    revisions,
  });
}

function status(ctx: DeployContext): void {
  const gcp = requireGcp(ctx.config);
  const output = gcloud(ctx.config, ["run", "services", "list", "--region", gcp.region, "--format=json"]);
  const services = JSON.parse(output) as Array<{
    metadata?: { name?: string };
    status?: { conditions?: Array<{ type?: string; status?: string }>; latestReadyRevisionName?: string; url?: string };
  }>;
  note("SERVICE\tREADY\tREVISION\tURL");
  const configured = new Set(runnableServices(ctx.config.services).map((name) => gcpServiceName(ctx.config, name)));
  for (const service of services.filter((item) => item.metadata?.name && configured.has(item.metadata.name))) {
    const ready = service.status?.conditions?.find((condition) => condition.type === "Ready")?.status ?? "Unknown";
    note(
      [
        service.metadata?.name ?? "unknown",
        ready,
        service.status?.latestReadyRevisionName ?? "-",
        service.status?.url ?? "-",
      ].join("\t"),
    );
  }
}

export function gcpLogArgs(input: {
  projectId: string;
  region: string;
  serviceName: string;
  follow?: boolean;
  tail?: number;
}): string[] {
  return [
    ...(input.follow ? ["alpha"] : []),
    "run",
    "services",
    "logs",
    input.follow ? "tail" : "read",
    input.serviceName,
    "--region",
    input.region,
    ...(!input.follow ? ["--limit", String(input.tail ?? 100)] : []),
    "--project",
    input.projectId,
  ];
}

function logs(ctx: DeployContext, service: string | undefined, opts: { follow?: boolean; tail?: number }): void {
  const gcp = requireGcp(ctx.config);
  const services = service ? [service] : runnableServices(ctx.config.services);
  for (const name of services) {
    if (!isServiceName(name)) throw new CliError(`unknown GCP service ${name}`);
    const args = gcpLogArgs({
      projectId: gcp.projectId,
      region: gcp.region,
      serviceName: gcpServiceName(ctx.config, name),
      ...opts,
    });
    runInherit(process.env.GCLOUD_BIN ?? "gcloud", args);
  }
}

function down(ctx: DeployContext): void {
  const gcp = requireGcp(ctx.config);
  for (const service of runnableServices(ctx.config.services).reverse()) {
    runInherit(process.env.GCLOUD_BIN ?? "gcloud", [
      "run",
      "services",
      "delete",
      gcpServiceName(ctx.config, service),
      "--region",
      gcp.region,
      "--project",
      gcp.projectId,
      "--quiet",
    ]);
  }
}

function rollback(ctx: DeployContext, to?: string): void {
  if (!to) throw new CliError("GCP rollback requires --to <revision>");
  const service = runnableServices(ctx.config.services).find((name) =>
    to.startsWith(`${gcpServiceName(ctx.config, name)}-`),
  );
  if (!service) throw new CliError(`revision ${to} does not belong to a configured GCP service`);
  const gcp = requireGcp(ctx.config);
  runInherit(process.env.GCLOUD_BIN ?? "gcloud", [
    "run",
    "services",
    "update-traffic",
    gcpServiceName(ctx.config, service),
    "--region",
    gcp.region,
    `--to-revisions=${to}=100`,
    "--project",
    gcp.projectId,
    "--quiet",
  ]);
}

function storedSecrets(config: DeskmateConfig): Map<string, string> {
  const values = new Map<string, string>();
  for (const secret of computedSecrets(config)) {
    try {
      values.set(
        secret.name,
        gcloud(config, [
          "secrets",
          "versions",
          "access",
          "latest",
          "--secret",
          gcpSecretName(requireGcp(config), secret.name),
        ]).trim(),
      );
    } catch {
      continue;
    }
  }
  return values;
}

async function doctor(ctx: DeployContext): Promise<void> {
  const gcp = requireGcp(ctx.config);
  gcloud(ctx.config, ["auth", "list", "--filter=status:ACTIVE", "--format=value(account)"]);
  gcloud(ctx.config, ["projects", "describe", gcp.projectId, "--format=value(projectId)"]);
  const enabled = new Set(
    gcloud(ctx.config, ["services", "list", "--enabled", "--format=value(config.name)"]).trim().split("\n"),
  );
  const missing = [
    "run.googleapis.com",
    "sqladmin.googleapis.com",
    "secretmanager.googleapis.com",
    "artifactregistry.googleapis.com",
    "compute.googleapis.com",
  ].filter((api) => !enabled.has(api));
  if (missing.length) throw new CliError(`required GCP APIs are not enabled: ${missing.join(", ")}`);
  const outputs = terraformOutputs(ctx.configDir);
  gcloud(ctx.config, [
    "artifacts",
    "repositories",
    "describe",
    gcp.artifactRegistry,
    "--location",
    gcp.region,
    "--format=value(name)",
  ]);
  await doctorCommon(ctx.config, storedSecrets(ctx.config), { configDir: ctx.configDir, requiredSecretValues: true });
  ok(`GCP deployment prerequisites are ready (${outputs.runtimeServiceAccountEmail})`);
}

async function secretsPush(ctx: DeployContext, envFile?: string): Promise<void> {
  const path = envFile ? join(ctx.configDir, envFile) : join(ctx.configDir, ".env");
  if (envFile && !existsSync(path)) throw new CliError(`${path} does not exist`);
  const values = readEnvFile(path);
  const gcp = requireGcp(ctx.config);
  for (const secret of computedSecrets(ctx.config).filter((item) => item.managedBy === "operator")) {
    const supplied = deploymentSecretValue(secret.name, values.get(secret.name));
    if (!secret.required && !supplied) {
      step(`${secret.name}: optional, not supplied`);
      continue;
    }
    const value = supplied ?? (await promptHidden(secret.name));
    if (isInvalidSecret(secret.name, value)) {
      throw new CliError(
        `${secret.name} must have a non-empty, non-placeholder value; signing keys must be at least 32 characters`,
      );
    }
    const name = gcpSecretName(gcp, secret.name);
    try {
      gcloud(ctx.config, ["secrets", "describe", name, "--format=value(name)"]);
    } catch (error) {
      if (!/NOT_FOUND|not found|does not exist/i.test(errMessage(error))) throw error;
      gcloud(ctx.config, ["secrets", "create", name, "--replication-policy=automatic"]);
    }
    const dir = mkdtempSync(join(tmpdir(), "deskmate-gcp-secret-"));
    const file = join(dir, "value");
    try {
      writeFileSync(file, value, { mode: 0o600 });
      gcloud(ctx.config, ["secrets", "versions", "add", name, `--data-file=${file}`]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    step(`${secret.name}: uploaded`);
  }
}

export const gcpDeploymentLayerTransport: DeploymentLayerTransport = httpDeploymentLayerTransport({
  secretFallback: (config) =>
    gcloud(config, [
      "secrets",
      "versions",
      "access",
      "latest",
      "--secret",
      gcpSecretName(requireGcp(config), "CORE_SIGNING_SECRET"),
    ]).trim(),
  timeoutMs: 60_000,
});

export const createGcpBackend = (ctx: DeployContext): Backend => ({
  up: (opts) => up(ctx, opts),
  status: () => status(ctx),
  logs: (service, opts) => logs(ctx, service, opts),
  down: () => down(ctx),
  rollback: (to) => rollback(ctx, to),
  doctor: () => doctor(ctx),
  secretsPush: (envFile) => secretsPush(ctx, envFile),
  pinSandbox: () => note("GCP uses the sandbox image recorded by the deployment layer"),
});
