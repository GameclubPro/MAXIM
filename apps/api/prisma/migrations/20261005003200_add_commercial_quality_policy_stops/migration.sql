-- FLAG: Independent false-deletion stops are durable and independent of sample retention and Redis.
CREATE TABLE "commercial_quality_policy_stops" (
  "detector_source_sha256" TEXT NOT NULL,
  "decision_version" TEXT NOT NULL,
  "stopped_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "commercial_quality_policy_stops_pkey" PRIMARY KEY ("detector_source_sha256", "decision_version"),
  CONSTRAINT "commercial_quality_policy_stops_source_check" CHECK ("detector_source_sha256" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "commercial_quality_policy_stops_version_check" CHECK (length("decision_version") BETWEEN 1 AND 120)
);
