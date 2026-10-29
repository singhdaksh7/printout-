# 13 – Final ER and sequence diagrams (as implemented)

Source of truth: `apps/api/prisma/schema.prisma` and the migrations `20261028100000` to `20261028140000`. Status per `IMPLEMENTATION_PROGRESS.md`.

## Entity relationships added by Schema V2

```mermaid
erDiagram
  User ||--o{ UserRoleGrant : "roles"
  User ||--o{ Membership : "owns or staffs"
  Shop ||--o{ Membership : has
  User ||--o{ Order : "customerUserId (null for guest QR)"
  User ||--o{ Document : "uploaderUserId (null for guest QR)"
  Shop ||--o{ Order : receives
  Shop ||--o{ ShopPaperOption : advertises
  Shop ||--o{ ShopImage : "private photos"
  Shop ||--o{ PricingRule : "per-sheet prices (kept)"
  Order ||--|| Document : file
  Order ||--o{ OrderStatusHistory : "append-only"
  Order ||--o{ OrderPaymentEvent : "append-only, DB trigger"
  Order ||--o| Review : "0..1, unique orderId"
  Shop ||--o{ Review : rated
  User ||--o{ Review : writes
  User ||--o{ UserNotification : "customer inbox"
  User ||--o{ FcmRegistration : devices

  User {
    string id PK
    string email "nullable only for CUSTOMER (CHECK)"
    Role role "SHOP_OWNER, PLATFORM_ADMIN, CUSTOMER"
    bool isActive
    float latitude
    float longitude
  }
  Shop {
    string id PK
    ShopStatus status
    bool isVerified "discovery gate, admin only"
    float latitude
    float longitude
    string upiId
    PaymentMethod_array acceptedPaymentMethods
    int ratingSum
    int ratingCount
    float ratingAvg
  }
  Order {
    string id PK
    OrderStatus status "adds REJECTED (flag)"
    PaymentMethod paymentMethod "null for guest/historical"
    PaymentStatus paymentStatus
    string upiTxnRef "unique per shop"
    string note
    bool isReviewed
  }
  OrderPaymentEvent {
    string event "UPI_SUBMITTED, UPI_VERIFIED, UPI_REJECTED, CASH_RECEIVED, REFUND_RECORDED"
    string actorRole
    int amountPaise
  }
  Review {
    string orderId UK
    int rating "1..5 CHECK"
    string comment
  }
```

## Customer order, payment and review

```mermaid
sequenceDiagram
  autonumber
  participant C as Customer app/web
  participant API as API
  participant S as Private storage
  participant O as Shop owner
  participant DB as PostgreSQL
  C->>API: POST /auth (audience customer) or /auth/customer/google/session
  API-->>C: session (restricted if new) -> POST /customers/onboarding
  C->>API: GET /customer/shops/nearby
  API->>DB: verified + ACTIVE shops, distance order
  C->>API: POST /customer/uploads
  API-->>C: uploadUrl (token, 15 min)
  C->>S: PUT file (via API stream)
  C->>API: POST completePath
  API->>S: magic-byte check, page count
  C->>API: POST /customer/quotes (per-sheet, server price)
  C->>API: POST /customer/orders (Idempotency-Key, paymentMethod)
  API->>DB: tx: lock shop, recalc price, create order + history + outbox
  API-->>O: push + SSE after commit
  O->>API: Print (existing) -> status PRINTING
  API->>DB: tx: history + customer inbox row
  API-->>C: push after commit
  C->>API: POST /customer/orders/{id}/payment (UTR claim)
  O->>API: PATCH /shops/{shopId}/orders/{id}/payment paid
  API->>DB: tx: row lock, event, inbox row
  C->>API: POST /customer/reviews
  API->>DB: tx: review + order.isReviewed + shop rating aggregate
```

## Order status and payment status (independent)

```mermaid
stateDiagram-v2
  [*] --> NEW
  NEW --> ACCEPTED : Print
  NEW --> CANCELLED : customer or shop
  NEW --> REJECTED : shop (flag, reason)
  NEW --> EXPIRED : worker
  ACCEPTED --> PRINTING : Print
  ACCEPTED --> CANCELLED
  PRINTING --> PRINTED : device confirmation
  PRINTED --> READY
  READY --> COLLECTED
```

```mermaid
stateDiagram-v2
  [*] --> unpaid
  unpaid --> paid : shop confirms cash
  unpaid --> pendingVerification : customer submits UPI ref
  pendingVerification --> paid : shop verifies
  pendingVerification --> unpaid : shop rejects ref
  paid --> refunded : platform admin records refund
```

## System overview

```mermaid
flowchart LR
  subgraph Clients
    A[Customer web /app, flag]
    B[Customer Android - contract only]
    C[Owner web and Android]
    D[Windows Print Agent]
    E[Admin console]
  end
  A & B & C & E --> T[Traefik TLS]
  D --> T
  T --> API[Fastify API]
  T --> W[nginx SPA]
  API --> PG[(PostgreSQL)]
  API --> R2[(Private object storage)]
  WK[Retention worker] --> PG
  WK --> R2
  API -. best effort .-> FCM[Firebase Cloud Messaging]
```
