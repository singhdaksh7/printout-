# 03 – Target ER diagram (proposed, additive over the current schema)

Entities marked NEW do not exist today. Existing models gain only nullable columns.

```mermaid
erDiagram
  User ||--o{ Membership : "owns or staffs"
  Shop ||--o{ Membership : has
  User ||--o{ UserRoleGrant : "NEW roles"
  User ||--o{ FcmRegistration : devices
  User ||--o{ Order : "customerUserId NEW nullable"
  Shop ||--o{ Order : receives
  Shop ||--|| ShopSettings : has
  Shop ||--o{ PricingRule : "per-sheet rates kept"
  Shop ||--o{ ShopPaperOption : "NEW"
  Shop ||--o{ ShopImage : "NEW"
  Shop ||--o{ Review : "NEW"
  Order ||--|| Document : file
  Order ||--o{ OrderStatusHistory : log
  Order ||--o| Review : "NEW 0..1"
  Order ||--o{ OrderPayment : "NEW"
  User ||--o{ UserNotification : "NEW customers"
  Shop ||--o{ ShopNotification : "kept owners"
  User ||--o{ AuditLog : actor

  OrderPayment {
    string id
    string orderId
    string method
    string status
    string upiTxnRef
    string verifiedBy
  }
  Review {
    string id
    string orderId UK
    int rating
    string comment
  }
  ShopPaperOption {
    string shopId
    string kind
    string value
  }
```

New nullable columns: `Shop` (phone, email, city, state, country, latitude, longitude, isVerified, verifiedAt, verifiedBy, upiId, acceptedPaymentMethods, ratingAvg, ratingCount); `Order` (customerUserId, paymentMethod, paymentStatus, note, paperType, acceptedAt, completedAt, isReviewed); `User` (name parts, address, latitude, longitude, isActive, email nullable).

Unchanged infrastructure (see `docs/architecture/full-er-diagram.md` on PR #44): Session, RefreshToken, AdminTwoFactor, AdminRecoveryCode, AdminLoginChallenge, UserGoogleIdentity, UserPhoneIdentity, PhoneOnboardingGrant, ShopDevice, DevicePairingCode, DevicePrinter, DevicePrintJob, PrintAgent, Printer, PrintJob, DeletionReceipt, CustomerSession, Plan, Subscription, Invoice, Payment.
