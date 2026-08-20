output "artifact_registry_url" {
  value = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.images.repository_id}"
}

output "bucket_name" {
  value = google_storage_bucket.data.name
}

output "cloud_sql_connection_name" {
  value = google_sql_database_instance.postgres.connection_name
}

output "runtime_service_account_email" {
  value = google_service_account.runtime.email
}

output "secrets_prefix" {
  value = var.secrets_prefix
}

output "runtime_network" {
  value = google_compute_network.runtime.name
}

output "runtime_subnetwork" {
  value = google_compute_subnetwork.runtime.name
}
