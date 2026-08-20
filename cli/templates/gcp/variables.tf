variable "project_id" {
  type = string
}

variable "region" {
  type = string
}

variable "org_id" {
  type = string
}

variable "artifact_registry" {
  type = string
}

variable "secrets_prefix" {
  type = string
}

variable "database_tier" {
  type    = string
  default = "db-f1-micro"
}

variable "database_version" {
  type    = string
  default = "POSTGRES_16"
}

variable "bucket_force_destroy" {
  type    = bool
  default = false
}
