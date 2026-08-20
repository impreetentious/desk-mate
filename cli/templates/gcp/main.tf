locals {
  required_services = toset([
    "artifactregistry.googleapis.com",
    "compute.googleapis.com",
    "run.googleapis.com",
    "secretmanager.googleapis.com",
    "sqladmin.googleapis.com",
  ])
  runtime_account_id = trim(substr("${var.org_id}-deskmate-runtime", 0, 30), "-")
  runtime_network_name = length("${var.org_id}-deskmate-runtime") <= 63 ? "${var.org_id}-deskmate-runtime" : "${substr(var.org_id, 0, 51)}-${substr(sha256(var.org_id), 0, 8)}"
  bucket_name        = trim(substr("${var.project_id}-${var.org_id}-deskmate-data", 0, 63), "-")
}

resource "google_project_service" "required" {
  for_each           = local.required_services
  service            = each.value
  disable_on_destroy = false
}

resource "google_artifact_registry_repository" "images" {
  location      = var.region
  repository_id = var.artifact_registry
  format        = "DOCKER"
  depends_on    = [google_project_service.required]
}

resource "google_compute_network" "runtime" {
  name                    = local.runtime_network_name
  auto_create_subnetworks = false
  depends_on              = [google_project_service.required]
}

resource "google_compute_subnetwork" "runtime" {
  name          = local.runtime_network_name
  ip_cidr_range = "10.80.0.0/24"
  region        = var.region
  network       = google_compute_network.runtime.id
}

resource "google_compute_router" "runtime" {
  name    = local.runtime_network_name
  region  = var.region
  network = google_compute_network.runtime.id
}

resource "google_compute_router_nat" "runtime" {
  name                               = local.runtime_network_name
  router                             = google_compute_router.runtime.name
  region                             = var.region
  nat_ip_allocate_option             = "AUTO_ONLY"
  source_subnetwork_ip_ranges_to_nat = "ALL_SUBNETWORKS_ALL_IP_RANGES"
}

resource "random_password" "database" {
  length  = 32
  special = false
}

resource "google_sql_database_instance" "postgres" {
  name             = "${var.org_id}-deskmate-postgres"
  database_version = var.database_version
  region           = var.region
  settings {
    tier = var.database_tier
    ip_configuration {
      ipv4_enabled = true
    }
    backup_configuration {
      enabled = true
    }
  }
  deletion_protection = false
  depends_on          = [google_project_service.required]
}

resource "google_sql_database" "deskmate" {
  name     = "deskmate"
  instance = google_sql_database_instance.postgres.name
}

resource "google_sql_user" "deskmate" {
  name     = "deskmate"
  instance = google_sql_database_instance.postgres.name
  password = random_password.database.result
}

resource "google_secret_manager_secret" "database_url" {
  secret_id = "${var.secrets_prefix}DATABASE_URL"
  replication {
    auto {}
  }
  depends_on = [google_project_service.required]
}

resource "google_secret_manager_secret_version" "database_url" {
  secret      = google_secret_manager_secret.database_url.id
  secret_data = "postgresql://deskmate:${urlencode(random_password.database.result)}@localhost/deskmate?host=/cloudsql/${google_sql_database_instance.postgres.connection_name}"
}

resource "google_service_account" "runtime" {
  account_id   = local.runtime_account_id
  display_name = "Deskmate Cloud Run runtime"
}

resource "google_project_iam_member" "runtime_roles" {
  for_each = toset([
    "roles/cloudsql.client",
    "roles/secretmanager.secretAccessor",
  ])
  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.runtime.email}"
}

resource "google_storage_bucket" "data" {
  name                        = local.bucket_name
  location                    = var.region
  uniform_bucket_level_access = true
  force_destroy               = var.bucket_force_destroy
}

resource "google_storage_bucket_iam_member" "runtime" {
  bucket = google_storage_bucket.data.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.runtime.email}"
}

resource "google_storage_hmac_key" "runtime" {
  service_account_email = google_service_account.runtime.email
}

resource "google_secret_manager_secret" "s3_access_key_id" {
  secret_id = "${var.secrets_prefix}S3_ACCESS_KEY_ID"
  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_version" "s3_access_key_id" {
  secret      = google_secret_manager_secret.s3_access_key_id.id
  secret_data = google_storage_hmac_key.runtime.access_id
}

resource "google_secret_manager_secret" "s3_secret_access_key" {
  secret_id = "${var.secrets_prefix}S3_SECRET_ACCESS_KEY"
  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_version" "s3_secret_access_key" {
  secret      = google_secret_manager_secret.s3_secret_access_key.id
  secret_data = google_storage_hmac_key.runtime.secret
}
