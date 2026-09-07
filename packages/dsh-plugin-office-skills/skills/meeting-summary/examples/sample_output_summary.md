# Meeting Summary: Enterprise Event Streaming Migration Architecture Review

**Date:** 2026-08-14  
**Participants:** Sarah Lin (Principal Architect), Marcus Vance (Lead Data Engineer), Elena Rostova (Director of Infrastructure), David Chen (Product Security Lead)

---

## 1. Executive Summary

- **Meeting Objective:** Finalize the architectural, financial, security, and scheduling plans for migrating the enterprise event streaming infrastructure from self-hosted Apache Kafka on EC2 to Google Cloud Pub/Sub.
- **Key Decisions Made:**
  - Approved full platform migration from self-hosted Kafka to Google Cloud Pub/Sub.
  - Standardized on Protocol Buffers version 3 (Protobuf) for message serialization and schema enforcement, deprecating unvalidated JSON payloads and rejecting Apache Avro.
  - Mandated Google Cloud Pub/Sub Schema Registry enforcement at the topic boundary with strict backward compatibility rules.
  - Enforced Customer-Managed Encryption Keys (CMEK), VPC Service Controls (VPC-SC), and Workload Identity Federation IAM policies across all production messaging resources.
  - Approved target timeline: Dual-publishing in staging by September 5, 2026; InfoSec audit complete by September 12, 2026; production cutover scheduled for October 3, 2026.
- **Strategic Outcomes & Impact:**
  - Reduces net messaging infrastructure and operational costs by 28%, eliminating approximately 22 hours per month of manual Kafka broker maintenance and partition rebalancing management.
  - Resolves consumer rebalance lag spikes (previously exceeding 4 minutes during peak traffic), achieving sub-26 millisecond p99 publish latency at 65,000 QPS.
  - Eliminates silent schema drift across polyglot microservices via centralized schema validation and automated CI tooling.
- **Critical Risks & Blockers:**
  - InfoSec compliance approval is a hard gate prior to staging sign-off, requiring complete VPC-SC perimeter validation by September 12, 2026.
  - Memory footprint impact on legacy Python consumer workers using streaming pull clients remains unbenchmarked and unassigned.

---

## 2. Detailed Discussion Record and Action Items

### Topic 1: Messaging Platform Migration Evaluation

- **Context and Background:** The organization currently operates an 18-node `r5.2xlarge` Apache Kafka cluster across three Availability Zones with a 5-node ZooKeeper quorum. The platform team incurs 22 hours per month managing partition rebalancing storms, disk saturation, and rolling patching. Under peak marketing load, consumer group rebalance lag exceeds 4 minutes, violating the 30-second downstream inventory update SLA.
- **Detailed Explanation:** The data engineering team evaluated two primary options:
  1. *Kafka 3.8 Upgrade with KRaft:* Removes ZooKeeper dependency but retains manual partition rebalancing, broker sizing overhead, and cross-AZ data egress expenses.
  2. *Google Cloud Pub/Sub:* Fully managed autoscaling messaging service. Pilot benchmarking demonstrated sustained throughput of 65,000 events per second, average publish latency of 14 milliseconds, and p99 latency of 26 milliseconds on multi-region topics.
  3. *Financial Comparison:* Kafka self-hosting costs $14,200 per month in compute/storage plus $8,500 in engineering overhead ($22,700 total). Google Cloud Pub/Sub is projected at $11,800 per month for 4.2 billion monthly messages (2 KB average payload), representing a 28% net financial savings.
- **Discussion and Rationale (The "Why"):** Upgrading Kafka to KRaft was rejected because it failed to resolve the core operational pain points around partition scaling and manual node maintenance. Google Cloud Pub/Sub was selected because it eliminates cluster operational overhead entirely while satisfying all latency and throughput requirements within budget.
- **Key Conclusions:** The team unanimously approved transitioning the entire messaging tier to Google Cloud Pub/Sub.

### Topic 2: Schema Evolution and Serialization Standard

- **Context and Background:** Existing downstream services consume unstructured JSON payloads. This lack of contract enforcement causes schema drift and unhandled parser exceptions in production.
- **Detailed Explanation:** The team evaluated Apache Avro versus Protocol Buffers version 3 (Protobuf):
  1. *Apache Avro:* Leveraged by historical analytics pipelines in Snowflake and Spark, but requires complex schema registry coordination across microservices.
  2. *Protobuf v3:* Provides strongly typed code generation across Go, Java, and TypeScript microservices. Payloads are 42% smaller than JSON and 15% smaller than Avro with schema headers, minimizing network overhead.
- **Discussion and Rationale (The "Why"):** Although Avro had historical precedent in data warehouse pipelines, Protobuf v3 was selected due to superior polyglot service compatibility, smaller serialization footprint, and direct integration with Google Cloud Pub/Sub Schema Registry. Schema validation will occur directly at the topic boundary to reject malformed messages before ingestion.
- **Key Conclusions:** Adopt Protobuf v3 across all event producers. Centralize schema definitions in a dedicated repository managed with the Buf linting tool and enforce backward compatibility at the Pub/Sub API boundary.

### Topic 3: Security, Governance, and Compliance Controls

- **Context and Background:** Migrating production event streams requires strict alignment with enterprise InfoSec compliance, data privacy, and identity governance policies.
- **Detailed Explanation:** David Chen established three mandatory security requirements:
  1. *Encryption:* Customer-Managed Encryption Keys (CMEK) via Google Cloud KMS using the existing `us-central1` key ring for all production topics.
  2. *Network Isolation:* VPC Service Controls (VPC-SC) perimeters surrounding all Pub/Sub resources to block exfiltration paths.
  3. *Access Management:* Granular IAM roles (`roles/pubsub.publisher`, `roles/pubsub.subscriber`) bound to specific resource URIs via short-lived Workload Identity Federation tokens. Long-lived service account JSON keys are strictly prohibited.
- **Discussion and Rationale (The "Why"):** Security controls must be implemented upstream in infrastructure-as-code to prevent configuration drift and guarantee compliance before data ingestion begins.
- **Key Conclusions:** All infrastructure will be deployed via reusable Terraform modules incorporating CMEK and VPC-SC policies.

### Topic 4: Migration Timeline and Phasing

- **Context and Background:** Transitioning from Kafka to Pub/Sub requires zero data loss and uninterrupted operation of downstream business systems.
- **Detailed Explanation:** The migration proceeds in three distinct phases:
  1. *Dual-Publishing & Staging Validation:* An adapter in the event gateway will publish simultaneously to Kafka and Pub/Sub in staging starting September 5, 2026. Shadow traffic will run for two weeks to validate message ordering, delivery guarantees, and consumer offsets.
  2. *Security Audit:* Automated InfoSec scanning of VPC-SC perimeters will execute prior to September 12, 2026.
  3. *Production Cutover:* If staging shadow tests demonstrate zero data loss by September 19, 2026, production cutover will occur over the weekend of October 3, 2026.
- **Discussion and Rationale (The "Why"):** Dual-publishing provides a safe verification window to benchmark latency and verify consumer correctness under real traffic patterns without risking production data integrity.
- **Key Conclusions:** The team agreed to the October 3, 2026 production cutover target date contingent on staging validation and InfoSec sign-off.

### Action Items

| Action Item | Assigned To | Deadline | Acceptance Criteria / Target Deliverable |
| :--- | :--- | :--- | :--- |
| Develop reusable Terraform module for Google Cloud Pub/Sub with CMEK and IAM hardening | Tom Bradley | 2026-08-28 | Terraform module submitted and approved in repository |
| Implement dual-publishing adapter in core event gateway | Marcus Vance | 2026-09-05 | Gateway publishing simultaneously to Kafka and Pub/Sub in staging |
| Conduct automated security validation scan on VPC-SC perimeters | David Chen | 2026-09-12 | InfoSec compliance report signed and published |
| Verify shadow traffic zero data loss benchmark | Sarah Lin | 2026-09-19 | Sign-off report confirming SLA and zero loss over 14-day staging run |
| Benchmark memory footprint on legacy Python consumer workers with Pub/Sub streaming pull client | Unassigned | Not Specified | Resource utilization report comparing Kafka vs Pub/Sub client overhead |
| Execute production cutover to Google Cloud Pub/Sub | Marcus Vance | 2026-10-03 | Production traffic routed to Pub/Sub; Kafka decommission plan initiated |

---

## 3. Five-Sentence Summary

The enterprise architecture team finalized plans to decommission their self-hosted Apache Kafka cluster and migrate all event streaming workloads to Google Cloud Pub/Sub by October 3, 2026. This migration resolves chronic consumer rebalancing lag, improves p99 latency to under 26 milliseconds at 65,000 QPS, and yields a 28 percent net infrastructure cost reduction. The organization standardized on Protocol Buffers version 3 with Google Cloud Pub/Sub Schema Registry enforcement to eliminate downstream schema drift. Production rollout is gated on mandatory InfoSec controls, including Customer-Managed Encryption Keys, VPC Service Controls perimeters, and short-lived Workload Identity Federation tokens. Staging dual-publishing will launch on September 5, 2026, followed by an InfoSec compliance audit on September 12, 2026, prior to final production cutover.
