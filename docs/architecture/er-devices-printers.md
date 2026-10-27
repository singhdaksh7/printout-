# ER: devices, printers and print jobs

Two parallel model families exist. **Only the first is live:**

| Family | Models | Status on `main` |
|---|---|---|
| **Device foundation + Windows agent** | `ShopDevice`, `DevicePairingCode`, `DevicePrinter`, `DevicePrintJob` | **In use** (pairing, heartbeat, printers, claim/progress, shop queue) |
| **Target architecture** | `PrintAgent`, `Printer`, `PrintJob` | **Schema only**: no route/worker touches them |

```mermaid
erDiagram
  Shop ||--o{ ShopDevice : "devices (cascade)"
  Shop ||--o{ DevicePairingCode : "pairing codes (cascade)"
  Shop ||--o{ DevicePrinter : "devicePrinters (cascade)"
  Shop ||--o{ DevicePrintJob : "devicePrintJobs (cascade)"
  ShopDevice ||--o{ DevicePrinter : "printers (cascade)"
  ShopDevice ||--o{ DevicePrintJob : "printJobs (cascade)"
  DevicePrinter ||--o{ DevicePrintJob : "jobs (cascade)"

  ShopDevice {
    string id PK
    string shopId FK
    string name
    DevicePlatform platform "ANDROID or WINDOWS"
    DeviceStatus status "ACTIVE or REVOKED"
    string credentialHash UK "sha256 of pbd_ credential; raw never stored"
    int credentialVersion "default 1"
    string previousCredentialHash "rotation grace, indexed"
    datetime previousCredentialValidUntil "nullable"
    string appVersion "nullable"
    string osVersion "nullable"
    string pushToken "ANDROID device FCM token, never returned"
    datetime lastSeenAt "nullable heartbeat"
    datetime revokedAt "nullable"
    string revokedByUserId "no FK"
  }
  DevicePairingCode {
    string id PK
    string shopId FK
    string codeHash UK "HMAC of the PB-XXXX-XXXX code"
    datetime expiresAt "10 min"
    datetime usedAt "nullable, single use"
    string usedByDeviceId "no FK"
    string createdByUserId "no FK"
  }
  DevicePrinter {
    string id PK
    string shopId FK
    string deviceId FK
    string name "unique per device"
    string driverName "nullable"
    PrinterConnectivity connectivity "ONLINE OFFLINE ERROR UNKNOWN"
    boolean supportsColour
    boolean supportsDuplex
    json paperSizes "nullable"
    boolean present "false when no longer reported"
    boolean authorized "owner decision, default false"
    boolean isDefault "owner decision, one per shop"
    datetime lastReportedAt
  }
  DevicePrintJob {
    string id PK
    string shopId FK
    string orderId "no FK"
    string documentId "no FK"
    string deviceId FK
    string printerId FK
    DevicePrintJobStatus status "default QUEUED"
    DevicePrintJobStatus statusBeforeCancel "nullable"
    int attempt
    string leaseId "nullable"
    datetime leaseExpiresAt "nullable, 120 s"
    string clientRequestId "unique per shop (idempotency)"
    json options "snapshot: copies colourMode sides paperSize pageSelection"
    datetime submittingAt "write-ahead intent, non-null means duplicate risk"
    int spoolerJobId "nullable"
    string spoolerState "nullable"
    datetime printInitiatedAt "nullable"
    string errorCode "nullable"
    string errorMessage "nullable"
    string resolution "nullable manual reconcile outcome"
  }
```

Schema-only target tables (not used):

```mermaid
erDiagram
  Shop ||--o{ PrintAgent : "printAgents (cascade)"
  Shop ||--o{ Printer : "printers (cascade)"
  Shop ||--o{ PrintJob : "printJobs (Restrict)"
  PrintAgent ||--o{ Printer : "printers (cascade)"
  Order |o--o| PrintJob : "orderId unique (SetNull)"
  PrintJob |o--o{ Document : "documents (SetNull)"

  PrintAgent {
    string id PK
    string shopId FK
    string name
    string credentialHash UK
    string agentVersion "nullable"
    datetime lastSeenAt "nullable"
    datetime revokedAt "nullable"
  }
  Printer {
    string id PK
    string shopId FK
    string agentId FK
    string name
    boolean colour
    boolean duplex
    boolean active
  }
  PrintJob {
    string id PK
    string shopId FK
    string orderId FK "nullable, UK"
    string code
    date serviceDay "UK with shopId+code"
    PrintJobStatus status "UPLOADING QUEUED PRINTING PRINTED FAILED CANCELLED EXPIRED"
    int attempt
    string leaseId "nullable"
    string leaseAgentId "nullable"
    datetime leaseExpiresAt "nullable"
    datetime expiresAt "nullable"
  }
```

## Constraints

| Table | Unique | Foreign keys (onDelete) | Indexes |
|---|---|---|---|
| ShopDevice | `credentialHash` | `shopId → Shop` (Cascade) | `(shopId, status)`, `previousCredentialHash` |
| DevicePairingCode | `codeHash` | `shopId → Shop` (Cascade) | `(shopId, expiresAt)` |
| DevicePrinter | `(deviceId, name)` | `shopId → Shop`, `deviceId → ShopDevice` (Cascade) | `(shopId, isDefault)` |
| DevicePrintJob | `(shopId, clientRequestId)` | `shopId → Shop`, `deviceId → ShopDevice`, `printerId → DevicePrinter` (all Cascade) | `(shopId, orderId)`, `(deviceId, status)`, `(shopId, status, createdAt)` |
| PrintAgent / Printer / PrintJob | `credentialHash` / none / `orderId`, `(shopId, serviceDay, code)` | see diagram | |

## Print-job state machine (`DevicePrintJobStatus`)

There is **deliberately no "PRINTED" state**: neither the spooler nor the platform can confirm paper. `PRINT_INITIATED` means "the spooler accepted the job and began processing it". Any job that may have reached the spooler is never auto re-queued: ambiguity ends in `NEEDS_RECONCILIATION` and a human decides.

```mermaid
stateDiagram-v2
  [*] --> QUEUED : shop enqueues via POST print-jobs
  QUEUED --> CLAIMED : agent claim (lease 120 s)
  QUEUED --> CANCELED : shop cancel (never claimed)
  CLAIMED --> DOWNLOADING : agent progress
  CLAIMED --> FAILED : agent progress
  CLAIMED --> QUEUED : lease expired (safe, nothing submitted)
  DOWNLOADING --> SUBMITTING : write-ahead intent
  DOWNLOADING --> FAILED : agent progress
  DOWNLOADING --> QUEUED : lease expired
  SUBMITTING --> SUBMITTED_TO_SPOOLER : agent
  SUBMITTING --> PRINT_INITIATED : agent
  SUBMITTING --> FAILED : agent
  SUBMITTING --> NEEDS_RECONCILIATION : agent or lease expired
  SUBMITTED_TO_SPOOLER --> PRINT_INITIATED : agent
  SUBMITTED_TO_SPOOLER --> NEEDS_RECONCILIATION : agent or lease expired
  PRINT_INITIATED --> FAILED : agent
  PRINT_INITIATED --> NEEDS_RECONCILIATION : agent
  NEEDS_RECONCILIATION --> PRINT_INITIATED : shop reconcile PRINTED, or agent evidence
  NEEDS_RECONCILIATION --> FAILED : shop reconcile NOT_PRINTED_REQUEUE (then new job)
  NEEDS_RECONCILIATION --> CANCELED : shop reconcile NOT_PRINTED_GIVE_UP
  CLAIMED --> CANCEL_REQUESTED : shop cancel
  DOWNLOADING --> CANCEL_REQUESTED : shop cancel
  SUBMITTING --> CANCEL_REQUESTED : shop cancel
  SUBMITTED_TO_SPOOLER --> CANCEL_REQUESTED : shop cancel
  PRINT_INITIATED --> CANCEL_REQUESTED : shop cancel
  CANCEL_REQUESTED --> CANCELED : agent confirms (or lease expired before submit)
  CANCEL_REQUESTED --> PRINT_INITIATED : agent, submission had already started
  CANCEL_REQUESTED --> FAILED : agent
  CANCEL_REQUESTED --> NEEDS_RECONCILIATION : agent or lease expired after submit
  NEEDS_RECONCILIATION --> SUBMITTED_TO_SPOOLER : original agent finds job in spooler
  CLAIMED --> FAILED : lease expired on attempt 5 (TOO_MANY_ATTEMPTS)
```

Constants (from `domain/print-jobs.ts`): lease 120 s, max 5 attempts (then `FAILED TOO_MANY_ATTEMPTS`), document download URL ≤120 s, one in-flight job per device, blocking statuses (`QUEUED, CLAIMED, DOWNLOADING, SUBMITTING, SUBMITTED_TO_SPOOLER, CANCEL_REQUESTED, NEEDS_RECONCILIATION`) block another job for the same order (`409 ACTIVE_PRINT_JOB_EXISTS`).

## Android relevance

An **Android phone running the owner app** uses a *user* bearer token and never creates `ShopDevice` rows. `ShopDevice.platform = ANDROID` exists for a **paired companion device** (pairing code → `pbd_` credential → `/device/*`). The print queue (`DevicePrinter`/`DevicePrintJob`) is Windows-only: Android devices get `409 CONFLICT` on printer/print-job device routes.
