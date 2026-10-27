# ER: orders and documents

Models: `Order`, `OrderStatusHistory`, `Document`, plus the schema-only `DeletionReceipt`, `CustomerSession`, `PrintJob` (shown dashed in prose, drawn normally below). Device print dispatch is in [er-devices-printers.md](./er-devices-printers.md).

```mermaid
erDiagram
  Shop ||--o{ Order : "orders (Restrict)"
  Shop ||--o{ Document : "documents (Restrict)"
  Document ||--o| Order : "one order per document"
  Order ||--o{ OrderStatusHistory : "histories (cascade)"
  PrintJob |o--o{ Document : "documents (SetNull) UNUSED"
  Document ||--o| DeletionReceipt : "receipt (Restrict) UNUSED"
  Shop ||--o{ CustomerSession : "cascade UNUSED"

  Document {
    string id PK "24-char random, unguessable (capability for quote/order/complete)"
    string shopId FK
    string printJobId FK "nullable, unused"
    string objectKey UK "private storage key, never exposed by any API"
    string originalFilename
    string detectedMimeType "nullable, server-verified"
    bigint byteSize "nullable"
    int pageCount "nullable"
    string checksum "nullable sha256"
    DocumentStatus status "UPLOADING AVAILABLE PRINTED_RETENTION DELETED FAILED"
    datetime uploadedAt "nullable"
    datetime expiresAt "unprinted deadline (upload + 24h); UPLOADING reclaim deadline"
    datetime printedAt "legacy print confirmation"
    datetime printInitiatedAt "first Print, starts retention"
    datetime deleteAfter "printInitiatedAt + 30 min, never extended"
    datetime deletedAt "nullable"
    string deletionError "nullable"
    int deletionAttempts
    datetime lastDeletionAttemptAt "nullable"
  }
  Order {
    string id PK
    string shopId FK
    string documentId FK "UK"
    string orderNumber "per shop, e.g. CENTRA-0001"
    string clientRequestId "nullable, idempotency key"
    string trackingToken UK "customer capability token"
    string customerDisplayNameOrReference "nullable, max 100"
    OrderStatus status "default NEW"
    int totalPaise
    string currency "default INR"
    json priceSnapshot "immutable quote result"
    json printOptionsSnapshot "immutable PrintOptions"
    datetime createdAt
    datetime updatedAt
  }
  OrderStatusHistory {
    string id PK
    string orderId FK
    OrderStatus fromStatus "nullable on creation"
    OrderStatus toStatus
    string reason "nullable, e.g. Print"
    string actorUserId "no FK"
    string actorDeviceId "no FK"
    datetime createdAt
  }
  PrintJob {
    string id PK
    string shopId FK
    string orderId FK "nullable, UK"
    string code
    date serviceDay
    PrintJobStatus status
  }
  DeletionReceipt {
    string id PK
    string receiptId UK
    string documentId FK "UK"
    string sha256
    json wipeFlags
  }
  CustomerSession {
    string id PK
    string shopId FK
    string tokenHash UK
    datetime expiresAt
  }
```

## Constraints

| Table | Unique | Foreign keys (onDelete) | Indexes |
|---|---|---|---|
| Document | `objectKey` | `shopId → Shop` (Restrict), `printJobId → PrintJob` (SetNull) | `(shopId, status)`, `(status, deleteAfter)`, `(status, expiresAt)`, `(status, createdAt)`, `printJobId` |
| Order | `documentId`, `trackingToken`, `(shopId, orderNumber)`, `(shopId, clientRequestId)` | `shopId → Shop` (Restrict), `documentId → Document` (no action) | `(shopId, status, createdAt)`, `(shopId, createdAt)` |
| OrderStatusHistory | none | `orderId → Order` (Cascade) | `(orderId, createdAt)` |

`(shopId, clientRequestId)` is the order-creation idempotency key (a NULL `clientRequestId` never collides). `documentId` unique enforces **one order per document**.

## Lifecycles

**Order status** (`OrderStatus`): `NEW → ACCEPTED → PRINTING` is driven only by Print (`print-now` / `POST /device/orders/:id/print` / print-job enqueue). Owners may only **cancel** (`NEW|ACCEPTED → CANCELLED`). `PRINTING → EXPIRED` is system-only (retention worker). `PRINTED`, `READY`, `COLLECTED` are **legacy**: no endpoint creates them any more, old rows remain readable. Terminal: `COLLECTED`, `CANCELLED`, `EXPIRED`.

```mermaid
stateDiagram-v2
  [*] --> NEW : customer creates order
  NEW --> ACCEPTED : Print (internal step)
  ACCEPTED --> PRINTING : Print (internal step)
  NEW --> CANCELLED : owner cancel
  ACCEPTED --> CANCELLED : owner cancel
  NEW --> EXPIRED : worker, unprinted document expired
  ACCEPTED --> EXPIRED : worker
  PRINTING --> EXPIRED : worker (system only)
  PRINTING --> PRINTED : legacy only, no endpoint
  PRINTED --> READY : legacy only
  READY --> COLLECTED : legacy only
```

**Document status:** `UPLOADING` (initiate) → `AVAILABLE` (complete, `expiresAt = +24 h`) → `PRINTED_RETENTION` (first Print: `printInitiatedAt = now`, `deleteAfter = now + 30 min`) → `DELETED` (worker, only after the object is verified gone). `FAILED` = rejected/abandoned upload. Unprinted documents are deleted at `expiresAt` and their order becomes `EXPIRED`.

```mermaid
stateDiagram-v2
  [*] --> UPLOADING : uploads/initiate
  UPLOADING --> AVAILABLE : uploads/complete (validated)
  UPLOADING --> FAILED : invalid / oversize / abandoned
  AVAILABLE --> PRINTED_RETENTION : first Print
  AVAILABLE --> DELETED : worker at expiresAt (order EXPIRED)
  PRINTED_RETENTION --> DELETED : worker at deleteAfter
  FAILED --> DELETED : worker sweep
  UPLOADING --> DELETED : worker stale sweep
```

## JSON column shapes

`Order.printOptionsSnapshot` = `{ paperSize: "A4", colourMode: "bw"|"colour", sides: "single"|"duplex", copies: 1..1000, pageSelection: {mode:"all"} | {mode:"ranges", ranges:[{from,to}]} }` (ranges are normalised: sorted, merged, in bounds).

`Order.priceSnapshot` = `{ printOptions, selectedPageCount, sheetsPerCopy, totalSheets, unitPricePaise, totalPaise, currency: "INR" }`.

## Privacy-relevant facts

- `objectKey`, bucket names and storage URLs are **never** in any API response; the only document access is a short-lived signed URL (≤300 s and never later than `deleteAfter`/`expiresAt`).
- Orders and their metadata are **never deleted** by retention: only the file is. After deletion `document.fileName` is hidden from the customer tracking response.
- `DeletionReceipt`, `CustomerSession`, `PrintJob` are not used by any code path today.
