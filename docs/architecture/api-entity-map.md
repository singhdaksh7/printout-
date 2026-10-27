# API ↔ database mapping

For each registered route: how the caller authenticates, which tables it **reads**, which it **writes**, and whether the Android app should use it. Table names are Prisma models (see [full-er-diagram.md](./full-er-diagram.md)). `AuditLog` rows are appended by nearly every mutation; they are listed where the code writes one.

Android usage: **Yes** = part of the owner app; **Customer** = only for an Android customer flow; **Device mode** = only for a paired `pbd_` device; **No** = web/admin/Windows only.


## 1. Authentication and onboarding

| Method | Endpoint | Authentication | Reads | Writes | Android usage |
|---|---|---|---|---|---|
| POST | `/api/v1/auth` | None | User, Shop, UserGoogleIdentity, UserPhoneIdentity, ShopSettings, Subscription, Plan, PricingRule, AuditLog | Session, RefreshToken, PhoneOnboardingGrant (new identity), FcmRegistration (optional), UserGoogleIdentity/UserPhoneIdentity (lastAuthTime), User.lastLoginAt, AuditLog | YES: the only Android sign-in endpoint. |
| POST | `/api/v1/auth/refresh` | None | RefreshToken, User, Shop, UserPhoneIdentity, UserGoogleIdentity | RefreshToken (rotatedAt / new row), Session (old invalidated, new created), AuditLog | YES |
| POST | `/api/v1/auth/logout` | Session, or refresh token in body | Session, RefreshToken, PhoneOnboardingGrant | Session.invalidatedAt, RefreshToken.revokedAt, FcmRegistration (revoked), PhoneOnboardingGrant (deleted), AuditLog | YES |
| POST | `/api/v1/auth/logout-all` | Any session | Session, RefreshToken | Session, RefreshToken, FcmRegistration, AuditLog | YES |
| GET | `/api/v1/auth/session` | Any session | Session, User, Shop | — | NO: use `GET /users/me` (richer, same auth). |
| POST | `/api/v1/auth/login` | None | User, Shop, AdminTwoFactor | Session, AdminLoginChallenge, User.lastLoginAt, AuditLog | NO: sets a cookie and returns a CSRF token. Use `POST /auth` with `loginMethod: "email"`. |
| POST | `/api/v1/auth/login/2fa` | Pending 2FA challenge cookie | AdminLoginChallenge, AdminTwoFactor, AdminRecoveryCode, User | AdminLoginChallenge, AdminTwoFactor.lastUsedStep, AdminRecoveryCode.usedAt, Session, AuditLog | NO (admin web only) |
| POST | `/api/v1/auth/login/2fa/cancel` | None | AdminLoginChallenge | AdminLoginChallenge.consumedAt | NO (admin web only) |
| POST | `/api/v1/auth/google/session` | None | UserGoogleIdentity, User, Shop | Session, PhoneOnboardingGrant, UserGoogleIdentity.lastAuthTime, AuditLog | NO: use `POST /auth` (`loginMethod: "google"`). |
| POST | `/api/v1/auth/phone/session` | None | UserPhoneIdentity, User, Shop | Session, UserPhoneIdentity.lastAuthTime, AuditLog | NO: use `POST /auth` (`loginMethod: "otp"`). |
| GET | `/api/v1/auth/phone/config` | None | — | — | Optional (feature detection) |
| POST | `/api/v1/auth/firebase/exchange` | None | UserPhoneIdentity, User, Shop | Session, RefreshToken, PhoneOnboardingGrant, AuditLog | NO: `POST /auth` is the documented mobile entry (same logic). |
| POST | `/api/v1/shops/onboarding` | Restricted onboarding grant | PhoneOnboardingGrant, UserGoogleIdentity, UserPhoneIdentity, User | Shop, ShopSettings, User, UserGoogleIdentity or UserPhoneIdentity, Session, RefreshToken, AuditLog | YES (first-time Google users) |
| GET | `/api/v1/users/me/identities` | Owner session | User, UserPhoneIdentity, UserGoogleIdentity | — | YES (Settings) |
| POST | `/api/v1/users/me/identities/google` | Owner session | User, UserGoogleIdentity, UserPhoneIdentity | UserGoogleIdentity, Session (others ended), RefreshToken (others revoked), AuditLog | YES (Settings) |
| POST | `/api/v1/users/me/identities/google/unlink` | Owner session | User, UserGoogleIdentity, UserPhoneIdentity | UserGoogleIdentity (deleted), Session, RefreshToken, AuditLog | YES (Settings) |
| GET | `/api/v1/shop/account/phone` | Owner session | UserPhoneIdentity | — | Optional |
| POST | `/api/v1/shop/account/phone` | Owner session | User, UserPhoneIdentity | UserPhoneIdentity, Session, RefreshToken, AuditLog | Optional |
| POST | `/api/v1/shop/account/phone/unlink` | Owner session | User, UserPhoneIdentity, UserGoogleIdentity | UserPhoneIdentity (deleted), Session, RefreshToken, AuditLog | Optional |

## 2. User profile

| Method | Endpoint | Authentication | Reads | Writes | Android usage |
|---|---|---|---|---|---|
| GET | `/api/v1/users/me` | Session or restricted grant | User, UserPhoneIdentity, UserGoogleIdentity, Shop, ShopSettings, Subscription, Plan, PricingRule, AuditLog, PhoneOnboardingGrant | — | YES: call at app start / after refresh to drive navigation by `nextStep`. |
| PATCH | `/api/v1/users/me` | Any session | User | User, Session (others ended on email change), RefreshToken, AuditLog | YES |
| GET | `/api/v1/shops/me` | Owner session | User, Shop, ShopSettings, Subscription, Plan, PricingRule, AuditLog | — | YES (includes `rateInfo` = active pricing rules) |
| PATCH | `/api/v1/shops/me` | Owner session | Shop | Shop, AuditLog | YES |
| GET | `/api/v1/shops/me/qr` | Owner session | Shop | — | YES (render QR in-app) |

## 3. Shop settings

| Method | Endpoint | Authentication | Reads | Writes | Android usage |
|---|---|---|---|---|---|
| GET | `/api/v1/shop/settings` | Owner session | Shop, ShopSettings | — | YES |
| PUT | `/api/v1/shop/settings` | Owner session | Shop, ShopSettings | Shop, ShopSettings, AuditLog | YES |
| GET | `/api/v1/shop/hours` | Owner session | ShopSettings | — | YES |
| PUT | `/api/v1/shop/hours` | Owner session | ShopSettings | Shop.updatedAt (row lock), ShopSettings, AuditLog | YES |
| PUT | `/api/v1/shop/hours/temporary-closure` | Owner session | ShopSettings | ShopSettings, AuditLog | YES |
| DELETE | `/api/v1/shop/hours/temporary-closure` | Owner session | ShopSettings | ShopSettings, AuditLog | YES |
| POST | `/api/v1/shop/hours/reopen` | Owner session | ShopSettings | ShopSettings.reopenUntil, AuditLog | YES |
| DELETE | `/api/v1/shop/hours/reopen` | Owner session | ShopSettings | ShopSettings, AuditLog | YES |
| GET | `/api/v1/shop/qr` | Owner session | Shop | — | Prefer `GET /shops/me/qr` (readiness-aware). |
| GET | `/api/v1/shop/devices` | Owner session | ShopDevice, DevicePrinter | — | YES (read-only management view) |

## 4. Shop pricing and quotes

| Method | Endpoint | Authentication | Reads | Writes | Android usage |
|---|---|---|---|---|---|
| GET | `/api/v1/shop/pricing-rules` | Owner session | PricingRule | — | YES |
| POST | `/api/v1/shop/pricing-rules` | Owner session | PricingRule | PricingRule, AuditLog | YES |
| PUT | `/api/v1/shop/pricing-rules/:id` | Owner session | PricingRule | PricingRule, AuditLog | YES |
| DELETE | `/api/v1/shop/pricing-rules/:id` | Owner session | PricingRule | PricingRule (deleted), AuditLog | YES |
| POST | `/api/v1/public/shops/:slug/quotes` | None | Shop, ShopSettings, Subscription, Document, PricingRule | — | Customer flow only (not needed by the owner app) |

## 5. Shop orders and live queue

| Method | Endpoint | Authentication | Reads | Writes | Android usage |
|---|---|---|---|---|---|
| GET | `/api/v1/shop/orders` | Owner session | Order, Document, DevicePrintJob (print=attention) | — | YES (primary list; combine with SSE / push / polling) |
| GET | `/api/v1/shop/orders/counts` | Owner session | Order, Document, DevicePrintJob | — | YES (badge / polling fallback) |
| GET | `/api/v1/shop/orders/history` | Owner session | Order, Document, OrderStatusHistory, User, ShopDevice | — | YES |
| GET | `/api/v1/shop/orders/history/summary` | Owner session | Order, Document | — | YES |
| GET | `/api/v1/shop/orders/history/export.csv` | Owner session | Order, Document | AuditLog | Optional (share/download) |
| GET | `/api/v1/shop/orders/:id` | Owner session | Order, Document, OrderStatusHistory | — | YES |
| POST | `/api/v1/shop/orders/:id/transitions` | Owner session | Order, Document | Order.status, OrderStatusHistory, AuditLog | YES |
| POST | `/api/v1/shop/orders/:id/print-now` | Owner session | Order, Document | Document (status → PRINTED_RETENTION, printInitiatedAt, deleteAfter), Order.status, OrderStatusHistory, AuditLog | YES (open the URL in a PDF viewer / print service) |
| POST | `/api/v1/shop/orders/:id/print-confirmation` | Owner session | — | — | NO: do not call. |
| POST | `/api/v1/shop/orders/:id/document-access` | Owner session | Order, Document | AuditLog | YES |
| POST | `/api/v1/shop/orders/:id/document-download` | Owner session | Order, Document | AuditLog | YES |

## 6. Printing and devices

| Method | Endpoint | Authentication | Reads | Writes | Android usage |
|---|---|---|---|---|---|
| POST | `/api/v1/shop/devices/pairing-codes` | Owner session | DevicePairingCode | DevicePairingCode, AuditLog | Optional (owner shows code to a Windows agent) |
| PATCH | `/api/v1/shop/devices/:id` | Owner session | ShopDevice | ShopDevice, AuditLog | Optional |
| POST | `/api/v1/shop/devices/:id/revoke` | Owner session | ShopDevice | ShopDevice (status REVOKED, pushToken cleared), AuditLog | Optional |
| PATCH | `/api/v1/shop/devices/:id/printers/:printerId` | Owner session | DevicePrinter, ShopDevice | DevicePrinter, AuditLog | Optional |
| POST | `/api/v1/shop/orders/:id/print-jobs` | Owner session | Order, Document, DevicePrinter, ShopDevice, DevicePrintJob | Document, Order.status, OrderStatusHistory, DevicePrintJob, AuditLog | Optional (requires a Windows agent) |
| GET | `/api/v1/shop/print-jobs` | Owner session | DevicePrintJob, DevicePrinter | DevicePrintJob (lease recovery), AuditLog | Optional |
| POST | `/api/v1/shop/print-jobs/:id/cancel` | Owner session | DevicePrintJob | DevicePrintJob, AuditLog | Optional |
| POST | `/api/v1/shop/print-jobs/:id/retry` | Owner session | DevicePrintJob, DevicePrinter | DevicePrintJob, AuditLog | Optional |
| POST | `/api/v1/shop/print-jobs/:id/reconcile` | Owner session | DevicePrintJob | DevicePrintJob, AuditLog | Optional |
| POST | `/api/v1/device/pair` | None | DevicePairingCode, Shop, Subscription | DevicePairingCode.usedAt, ShopDevice, AuditLog | Only for a dedicated Android print device (see guide §13) |
| POST | `/api/v1/device/heartbeat` | Device credential | ShopDevice | ShopDevice | Device mode only |
| PUT | `/api/v1/device/push-token` | Device credential | ShopDevice | ShopDevice.pushToken, AuditLog | Device mode only |
| GET | `/api/v1/device/me` | Device credential | ShopDevice, Shop | — | Device mode only |
| GET | `/api/v1/device/orders` | Device credential | Order, Document | — | Device mode only |
| GET | `/api/v1/device/orders/:id` | Device credential | Order, Document, OrderStatusHistory | — | Device mode only |
| POST | `/api/v1/device/orders/:id/print` | Device credential | Order, Document | Document, Order.status, OrderStatusHistory, AuditLog | Device mode only |
| POST | `/api/v1/device/orders/:id/reprint` | Device credential | Order, Document | AuditLog | Device mode only |
| POST | `/api/v1/device/orders/:id/download` | Device credential | Order, Document | AuditLog | Device mode only |
| PUT | `/api/v1/device/printers` | Device credential | DevicePrinter | DevicePrinter | NO (Windows agent) |
| POST | `/api/v1/device/print-jobs/claim` | Device credential | DevicePrintJob, DevicePrinter | DevicePrintJob, AuditLog | NO (Windows agent) |
| GET | `/api/v1/device/print-jobs/active` | Device credential | DevicePrintJob | DevicePrintJob (lease recovery) | NO (Windows agent) |
| POST | `/api/v1/device/print-jobs/:id/download` | Device credential | DevicePrintJob, Order, Document | AuditLog | NO (Windows agent) |
| POST | `/api/v1/device/print-jobs/:id/progress` | Device credential | DevicePrintJob | DevicePrintJob, AuditLog | NO (Windows agent) |
| POST | `/api/v1/device/credential/rotate` | Device credential | ShopDevice | ShopDevice, AuditLog | Device mode only |

## 7. Notifications / FCM

| Method | Endpoint | Authentication | Reads | Writes | Android usage |
|---|---|---|---|---|---|
| PUT | `/api/v1/users/me/fcm-token` | Owner session | FcmRegistration | FcmRegistration, AuditLog | YES (call on every `onNewToken` and after login) |
| DELETE | `/api/v1/users/me/fcm-token` | Owner session | FcmRegistration | FcmRegistration (revoked), AuditLog | YES (on sign-out / push opt-out) |
| GET | `/api/v1/shop/notifications` | Owner session | ShopNotification | — | YES |
| POST | `/api/v1/shop/notifications/read-all` | Owner session | ShopNotification | ShopNotification.readAt | YES |
| POST | `/api/v1/shop/notifications/:id/read` | Owner session | ShopNotification | ShopNotification.readAt | YES |
| GET | `/api/v1/shop/events` | Owner session | Session, ShopNotification | — | Optional (foreground only; OkHttp SSE with Bearer header). Push (FCM) is the background path. |

## 8. Analytics

| Method | Endpoint | Authentication | Reads | Writes | Android usage |
|---|---|---|---|---|---|
| GET | `/api/v1/shop/analytics` | Owner session | Order, OrderStatusHistory, Document | — | YES |
| GET | `/api/v1/shop/analytics/revenue` | Owner session | Order (raw grouped SQL), Document | — | Optional |
| GET | `/api/v1/shop/analytics/revenue/export.csv` | Owner session | Order, Document | AuditLog | Optional |

## 9. Customer public APIs

| Method | Endpoint | Authentication | Reads | Writes | Android usage |
|---|---|---|---|---|---|
| GET | `/api/v1/public/shops/:slug` | None | Shop, ShopSettings, Subscription | — | Customer flow / deep link only |
| POST | `/api/v1/public/shops/:slug/uploads/initiate` | None | Shop, ShopSettings, Subscription | Document | Customer flow only |
| PUT | `/api/v1/public/uploads/:uploadId/content` | Upload token | Document | Object storage (private bucket), Document.checksum / byteSize | Customer flow only |
| POST | `/api/v1/public/shops/:slug/uploads/:uploadId/complete` | None | Document, Shop, Object storage | Document | Customer flow only |
| POST | `/api/v1/public/shops/:slug/orders` | None | Shop, ShopSettings, Subscription, Document, PricingRule, Order | Shop.orderCounter, Order, OrderStatusHistory, ShopNotification, FCM push (best effort) | Customer flow only |
| GET | `/api/v1/public/orders/:token` | Tracking token (path) | Order, Shop, ShopSettings, Document, OrderStatusHistory, DevicePrintJob | — | YES for the customer flow |

## 10. Admin-only APIs

| Method | Endpoint | Authentication | Reads | Writes | Android usage |
|---|---|---|---|---|---|
| GET | `/api/v1/admin/dashboard` | Admin session | Shop, Subscription, Order, Document, Plan | — | NO (admin web only) |
| GET | `/api/v1/admin/orders` | Admin session | Order, Document, Shop | — | NO (admin web only) |
| GET | `/api/v1/admin/shops` | Admin session | Shop, Subscription, Plan, User, Order | — | NO (admin web only) |
| POST | `/api/v1/admin/shops` | Admin session | Plan | Shop, ShopSettings, User, Subscription, AuditLog | NO (admin web only) |
| GET | `/api/v1/admin/shops/:id` | Admin session | Shop, User, Subscription, Order, PricingRule | — | NO (admin web only) |
| PUT | `/api/v1/admin/shops/:id` | Admin session | Shop | Shop, Session, RefreshToken, AuditLog | NO (admin web only) |
| GET | `/api/v1/admin/plans` | Admin session | Plan | — | NO (admin web only) |
| POST | `/api/v1/admin/plans` | Admin session | — | Plan, AuditLog | NO (admin web only) |
| PUT | `/api/v1/admin/plans/:id` | Admin session | Plan | Plan, AuditLog | NO (admin web only) |
| GET | `/api/v1/admin/subscriptions` | Admin session | Subscription, Plan, Shop | — | NO (admin web only) |
| PUT | `/api/v1/admin/subscriptions/:id` | Admin session | Shop, Plan, Subscription | Subscription, AuditLog | NO (admin web only) |
| GET | `/api/v1/admin/audit-logs` | Admin session | AuditLog | — | NO (admin web only) |
| GET | `/api/v1/admin/account` | Admin session | User, Session | — | NO (admin web only) |
| POST | `/api/v1/admin/account/email` | Admin session | User | User, Session, RefreshToken, AdminLoginChallenge, AuditLog | NO (admin web only) |
| POST | `/api/v1/admin/account/password` | Admin session | User | User, Session, RefreshToken, AdminLoginChallenge, AuditLog | NO (admin web only) |
| GET | `/api/v1/admin/account/2fa` | Admin session | AdminTwoFactor, AdminRecoveryCode | — | NO (admin web only) |
| POST | `/api/v1/admin/account/2fa/enroll` | Admin session | User, AdminTwoFactor | AdminTwoFactor (pending), AuditLog | NO (admin web only) |
| POST | `/api/v1/admin/account/2fa/enroll/verify` | Admin session | AdminTwoFactor | AdminTwoFactor, AdminRecoveryCode, User.passwordHash (rollback guard), Session, AuditLog | NO (admin web only) |
| POST | `/api/v1/admin/account/2fa/recovery-codes/acknowledge` | Admin session | AdminTwoFactor | AdminTwoFactor.recoveryAckAt | NO (admin web only) |
| POST | `/api/v1/admin/account/2fa/recovery-codes` | Admin session | AdminTwoFactor, AdminRecoveryCode | AdminRecoveryCode, AuditLog | NO (admin web only) |
| POST | `/api/v1/admin/account/2fa/disable` | Admin session | AdminTwoFactor | AdminTwoFactor (deleted), AdminRecoveryCode (deleted), AdminLoginChallenge, Session, AuditLog | NO (admin web only) |

## 11. Operations (not part of the product API)

| Method | Endpoint | Authentication | Reads | Writes | Android usage |
|---|---|---|---|---|---|
| GET | `/health` | None | — | — | Optional (connectivity probe) |
| GET | `/ready` | None | PostgreSQL (SELECT 1) | — | NO |
| GET | `/api/v1/internal/documents/:key` | Signed URL | Document, Local object storage | — | Indirect (the app opens URLs returned by print-now/document-access) |
