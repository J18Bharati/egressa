# Two providers in one file. The block name decides which vendor each region
# belongs to, so they cannot be crossed.
provider "aws" {
  region = "eu-west-2"
}

# Supplied at plan time. Must not resolve, and must not be guessed.
provider "gcp" {
  region = var.deployment_region
}
