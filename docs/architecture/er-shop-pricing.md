# ER: shop and pricing

Models: `Shop`, `ShopSettings`, `PricingRule`, `Membership` (unused), `User` (for context). Subscription/plan tables are in [er-legacy-billing.md](./er-legacy-billing.md).

```mermaid
erDiagram
  Shop ||--o| ShopSettings : "settings (cascade)"
  Shop ||--o{ PricingRule : "pricingRules (cascade)"
  Shop |o--o{ User : "users (SetNull)"
  Shop ||--o{ Membership : "memberships (cascade) UNUSED"
  User ||--o{ Membership : "memberships (cascade) UNUSED"

  Shop {
    string id PK
    string slug UK "public URL segment /p/slug"
    string displayName
    string address "nullable"
    string pincode "nullable, 6-digit PIN"
    ShopStatus status "default ACTIVE"
    boolean acceptsOrders "default true"
    int orderCounter "row-locking counter for order numbers"
    string kmsKeyRef "nullable, unused"
    datetime createdAt
    datetime updatedAt
  }
  ShopSettings {
    string id PK
    string shopId FK "UK, one per shop"
    string publicContact "nullable"
    string brandColor "nullable, #RRGGBB"
    string timezone "default Asia/Kolkata"
    json operatingHours "nullable weekly schedule"
    json specialClosures "default empty list"
    json temporaryClosure "nullable"
    datetime reopenUntil "nullable emergency reopen"
    AfterHoursPolicy afterHoursPolicy "default ACCEPT"
  }
  PricingRule {
    string id PK
    string shopId FK
    string paperSize "default A4 (only value accepted by the API)"
    ColourMode colourMode "bw or colour"
    PrintSides sides "single or duplex"
    int pricePerSheetPaise "integer paise"
    boolean active "default true"
  }
  Membership {
    string id PK
    string shopId FK
    string userId FK
    MembershipRole role "OWNER or STAFF"
  }
```

## Constraints

| Table | Unique | Foreign keys | Notes |
|---|---|---|---|
| Shop | `slug` | none | Tenant root. `orderCounter` is incremented under the shop row lock when an order is created. |
| ShopSettings | `shopId` | `shopId → Shop` (Cascade) | Created lazily (`upsert`) and with onboarding. |
| PricingRule | `(shopId, paperSize, colourMode, sides)` | `shopId → Shop` (Cascade) | Max 4 effective rules (A4 only): bw/colour × single/duplex. |
| Membership | `(shopId, userId)` | `shopId → Shop`, `userId → User` (Cascade) | **Unused.** Do not treat as authorization. |

## Behaviour that matters to an integrator

- **Pricing rule semantics:** a quote needs an *active* rule matching `(colourMode, sides)`. Sheets = `duplex ? ceil(pages/2) : pages`, times `copies`; total = sheets × `pricePerSheetPaise`. Missing rule → `422 NO_PRICING_RULE`. The cap is 2,000,000,000 paise per order.
- **Rule edits never change existing orders:** `Order.priceSnapshot` / `printOptionsSnapshot` freeze the price at order time (see [er-orders-documents.md](./er-orders-documents.md)). The order endpoint also **recomputes** the price from the shop's *current* active rules; the quote total is not authoritative.
- **Operating hours** live in `ShopSettings` JSON columns (`operatingHours`, `specialClosures`, `temporaryClosure`) interpreted in `timezone`; `afterHoursPolicy = BLOCK` makes the public intake return `409 SHOP_CLOSED` when closed.
- **Open vs accepting:** the public site accepts orders only if `Shop.status = ACTIVE` AND `Shop.acceptsOrders` AND (no subscription OR subscription `ACTIVE`) AND hours allow it.
- **Self-onboarded shops** (since PR #40) are created `ACTIVE` with `acceptsOrders = true`, a `ShopSettings` row, **no** `Subscription`, and **no** pricing rules: the owner must add rules before customers can get a quote (`422 NO_PRICING_RULE`).
