# Sequence diagrams

All flows are transcribed from the route code on `origin/main`. `API` = Fastify (`/api/v1`), `DB` = PostgreSQL, `FB` = Firebase Auth, `Store` = private object storage. Android examples use the **mobile bearer contract**: no cookies, no CSRF header.

## A. New Google user → create shop → dashboard

First-time user: Google proves the identity, but no account exists, so the API issues a **restricted** token pair that can only create the shop.

```mermaid
sequenceDiagram
  autonumber
  participant App as Android app
  participant FB as Firebase Auth
  participant API
  participant DB
  App->>FB: Continue with Google (Firebase SDK)
  FB-->>App: Firebase ID token
  App->>API: POST /auth {loginMethod google, firebaseIdToken, installationId, platform, fcmToken?}
  API->>FB: verify token (project, expiry, revoked, provider google.com, email verified)
  API->>DB: find UserGoogleIdentity by firebaseUid
  DB-->>API: none
  API->>DB: revoke older onboarding families of this uid+installation, insert PhoneOnboardingGrant + RefreshToken(kind=onboarding)
  API-->>App: 200 {accessToken (restricted), refreshToken, nextStep create_shop, user.id null, user.email, onboardingAvailable}
  Note over App,API: Restricted token works only for POST /shops/onboarding, GET /users/me, POST /auth/logout
  App->>API: POST /shops/onboarding {ownerName, shopName, address, pincode, client mobile, deviceId = installationId} Bearer restricted
  API->>DB: ONE transaction: Shop (ACTIVE) + ShopSettings + User (passwordSet=false) + UserGoogleIdentity + AuditLog
  API->>DB: revoke onboarding refresh token (reason onboarded), create Session + RefreshToken(kind=user)
  API-->>App: 201 {accessToken, refreshToken, nextStep dashboard or generate_qr or complete_profile, shop, ...}
  App->>App: replace stored tokens with the NEW pair
  App->>API: PUT /users/me/fcm-token {installationId, token, platform android} Bearer
  API-->>App: 200 {registered true}
  App->>API: GET /users/me Bearer
  API-->>App: 200 profile + nextStep
  Note over App: nextStep dashboard: show dashboard. The new shop has NO pricing rules yet: guide the owner to add them (POST /shop/pricing-rules).
```

Failure branches: `403 SELF_ONBOARDING_DISABLED` (feature flag off; the app should show "registration not open"), `409 ALREADY_ONBOARDED`, `409 EMAIL_UNAVAILABLE` (the Google email already belongs to another account: sign in with the existing method and *link* Google from Settings), `429`. A retry of the same onboarding within 2 minutes returns the same shop with `200`.

## B. Existing Google user → authenticate → dashboard

```mermaid
sequenceDiagram
  autonumber
  participant App as Android app
  participant FB as Firebase Auth
  participant API
  participant DB
  App->>FB: Continue with Google
  FB-->>App: Firebase ID token
  App->>API: POST /auth {loginMethod google, firebaseIdToken, installationId, platform, fcmToken?}
  API->>FB: verify token
  API->>DB: UserGoogleIdentity by firebaseUid, join User + Shop
  alt identity found and shop ACTIVE
    API->>DB: updateMany lastAuthTime where older (replay guard)
    API->>DB: revoke earlier families of this installation, create Session (15 min) + RefreshToken (30 d)
    API->>DB: register fcmToken (best effort, after auth)
    API-->>App: 200 {accessToken, refreshToken, expiresIn, refreshTokenExpiresIn, user, shops, shop, nextStep dashboard}
  else shop SUSPENDED
    API-->>App: 403 ACCOUNT_BLOCKED {details.nextStep account_blocked}
  else same ID token used twice
    API-->>App: 401 GOOGLE_TOKEN_INVALID
  end
  App->>App: store tokens (Keystore-encrypted), keep expiresAt = now + expiresIn
  App->>API: GET /shop/orders?active=1 Bearer accessToken
  API-->>App: 200 {items, nextCursor?}
```

An existing owner whose Google account has **never been linked** gets the restricted pair (as in flow A), *not* a session, even if the Google email equals their account email. They must sign in with their existing method (`loginMethod: "email"` or `"otp"`) and then link Google (`POST /users/me/identities/google`).

## C. Access token expires → refresh → retry safely

Refresh tokens are **single-use** and rotate; two concurrent refreshes would revoke the family if mishandled, so refresh is **single-flight**.

```mermaid
sequenceDiagram
  autonumber
  participant UI as App code (many callers)
  participant Auth as Token manager (single-flight, Mutex)
  participant API
  participant DB
  UI->>API: GET /shop/orders Bearer A1
  API->>DB: Session by sha256(A1), not invalidated, not expired
  DB-->>API: none
  API-->>UI: 401 UNAUTHORIZED
  UI->>Auth: refresh needed (token used was A1)
  Auth->>Auth: lock - if stored token is already newer than A1, skip refresh
  Auth->>API: POST /auth/refresh {refreshToken R1, deviceId = installationId}
  API->>DB: atomic UPDATE RefreshToken SET rotatedAt WHERE id AND rotatedAt IS NULL
  API->>DB: end old Session, create Session A2 + RefreshToken R2 (same family)
  API-->>Auth: 200 {accessToken A2, refreshToken R2, expiresIn, ...}
  Auth->>Auth: persist A2 and R2 atomically, unlock
  Auth-->>UI: new token
  UI->>API: retry GET /shop/orders Bearer A2 (reads and idempotent writes only)
  API-->>UI: 200
  Note over Auth,API: Refresh outcomes: 401 REFRESH_TOKEN_EXPIRED/INVALID then sign in again. 409 REFRESH_CONFLICT then wait about 1 s and re-read the stored tokens (another refresh already won). 403 ACCOUNT_BLOCKED then show the blocked screen. 429 then back off. Connection failure BEFORE the request was sent: retry with the same R1.
```

**Lost refresh response (known sharp edge).** The server rotates R1 *before* the response reaches the app. If the response is lost (timeout after the request was sent), the app still holds R1, which is now spent: re-presenting it within `REFRESH_REUSE_GRACE_SECONDS` (5 s) returns `409 REFRESH_CONFLICT`, and later returns `401 REFRESH_TOKEN_INVALID` **and revokes the whole token family**. There is no way to recover the new pair, so the only safe outcome is to sign in again. Keep the refresh call's timeout generous (about 30 s) and treat an unrecoverable refresh as "signed out", not as a crash.

Retry rule for **mutating** calls after a 401: only retry when the request carries an idempotency key (`clientRequestId`) or is naturally idempotent (PUT/DELETE of a known id). `POST /shop/orders/:id/print-now`, `transitions`, `print-jobs` all take a UUID `clientRequestId`: reuse the **same** UUID on retry.

## D. Customer uploads PDF → gets quote → creates order

Customers are anonymous; there is no login. (This is the web flow; an Android customer client would follow the same sequence.)

```mermaid
sequenceDiagram
  autonumber
  participant C as Customer (browser)
  participant API
  participant Store as Object storage
  participant DB
  C->>API: GET /public/shops/:slug
  API->>DB: Shop + ShopSettings + Subscription
  API-->>C: shop, availability, acceptsOrders, printCapabilities, retentionMinutes
  C->>API: POST /public/shops/:slug/uploads/initiate {fileName, byteSize, declaredMimeType}
  API->>DB: INSERT Document (UPLOADING, id random 24 char, expiresAt now+60 min)
  API-->>C: {uploadId, uploadUrl (token, 15 min, single use), requiredHeaders, limits}
  C->>API: PUT uploadUrl (raw bytes, Content-Type = declared)
  API->>Store: stream put (size cap enforced while streaming, sha256 in-stream)
  API->>DB: Document.checksum, byteSize
  API-->>C: 200 {uploadId, byteSize}
  C->>API: POST /public/shops/:slug/uploads/:uploadId/complete
  API->>Store: read, magic-byte check, PDF parse, page count (limits: 50 MiB, 200 pages)
  API->>DB: Document AVAILABLE, pageCount, expiresAt = now + 24 h
  API-->>C: {documentId, pageCount, expiresAt, ...}
  C->>API: POST /public/shops/:slug/quotes {documentId, printOptions}
  API->>DB: active PricingRule for (colourMode, sides)
  API-->>C: {quoteId (signed, 10 min), totalPaise, selectedPageCount, sheets, unitPricePaise, expiresAt}
  C->>API: POST /public/shops/:slug/orders {quoteId, clientRequestId UUID, customerDisplayNameOrReference?}
  API->>DB: TX: claim Document, shop.orderCounter++, recheck hours, recompute price, INSERT Order(NEW)+history+ShopNotification
  API-->>C: {orderNumber, trackingToken, status NEW, totalPaise}
  API--)API: after commit: SSE fan-out, FCM to shop owners, device notifier (best effort)
```

Repeat the final POST with the same `clientRequestId` and the original order is returned (idempotent).

## E. Shop receives order → prints → customer tracking updates

```mermaid
sequenceDiagram
  autonumber
  participant Cust as Customer
  participant API
  participant DB
  participant Owner as Shop owner app (Android / web)
  participant FCM as Firebase Cloud Messaging
  participant Win as Windows Print Agent
  participant Store as Object storage
  Cust->>API: POST /public/shops/:slug/orders
  API->>DB: Order NEW + ShopNotification (same TX)
  API-->>Cust: trackingToken
  API--)Owner: SSE order.created / notification.created (if a stream is open)
  API--)FCM: data {type order.new, orderId}
  FCM--)Owner: push
  Owner->>API: GET /shop/notifications?after=lastSeq and GET /shop/orders?active=1&print=pending
  API-->>Owner: new order(s)
  alt print from the owner's own screen or any viewer
    Owner->>API: POST /shop/orders/:id/print-now {clientRequestId}
    API->>DB: TX: Document AVAILABLE -> PRINTED_RETENTION (printInitiatedAt, deleteAfter now+30 min), Order NEW->ACCEPTED->PRINTING, history
    API-->>Owner: {order, firstPrint true, access {url, expiresAt, inline}}
    Owner->>Store: open signed URL in a PDF viewer, user prints
  else print through a Windows printer
    Owner->>API: POST /shop/orders/:id/print-jobs {clientRequestId, printerId?}
    API->>DB: initiate print (as above) then INSERT DevicePrintJob QUEUED
    API-->>Owner: 201 {job, created true}
    Win->>API: POST /device/print-jobs/claim
    API-->>Win: {job {leaseId, options, printer}}
    Win->>API: POST /device/print-jobs/:id/download {leaseId}
    API-->>Win: {url <=120 s, sha256, byteSize}
    Win->>Store: GET url
    Win->>API: progress DOWNLOADING, SUBMITTING (write-ahead), SUBMITTED_TO_SPOOLER, PRINT_INITIATED
    API--)Owner: SSE printJob.updated
  end
  loop customer polls every few seconds while the page is open
    Cust->>API: GET /public/orders/:trackingToken
    API-->>Cust: status PRINTING, printIssue false, document.deleteAfter, timeline
  end
  Note over Cust,API: There is no PRINTED/READY/COLLECTED in the new flow. After Print the customer sees PRINTING and the file deletion countdown.
```

## F. Document retention expiry → worker deletes file

```mermaid
sequenceDiagram
  autonumber
  participant W as Worker (separate process)
  participant DB
  participant Store as Object storage
  loop every minute
    W->>DB: select due Documents (PRINTED_RETENTION and deleteAfter<=now, AVAILABLE and expiresAt<=now, stale UPLOADING/FAILED), batch 100
    DB-->>W: rows
    W->>DB: any live lease on the document's print job? (CLAIMED..SUBMITTED_TO_SPOOLER)
    alt live lease and within 5 min grace
      W->>W: defer (counted as deferred)
    else
      W->>Store: delete object (idempotent)
      W->>Store: exists? must be false
      alt verified gone
        W->>DB: TX: UPDATE Document SET DELETED WHERE status unchanged
        W->>DB: AuditLog document.deleted (reason)
        opt reason is not print_retention and order is NEW/ACCEPTED/PRINTING
          W->>DB: Order -> EXPIRED + OrderStatusHistory(reason document_expired) + AuditLog order.expired
        end
      else storage error
        W->>DB: deletionError (safe code), deletionAttempts+1 - retried next tick
      end
    end
  end
  Note over W,DB: Hourly: pairing-code sweep, notification retention (14 d), expired refresh tokens and onboarding grants, stale FCM registrations.
```

Orders and metadata are never deleted. API clients see the effect as `document.status = DELETED`, `fileName = null` on the tracking page, and `410 DOCUMENT_UNAVAILABLE` from document-access. The worker cannot push SSE (different process): clients refetch.

## G. Android fetches and edits shop pricing rules

```mermaid
sequenceDiagram
  autonumber
  participant App as Android app
  participant API
  participant DB
  App->>API: GET /shop/pricing-rules Bearer
  API->>DB: PricingRule WHERE shopId = session shop
  API-->>App: 200 {data: [{id, paperSize A4, colourMode, sides, pricePerSheetPaise, active, ...}]}
  Note over App: Show up to 4 rows (bw/colour x single/duplex). Money is integer paise - format in the UI.
  alt edit an existing rule
    App->>API: PUT /shop/pricing-rules/:id {pricePerSheetPaise, active}
    API->>DB: UPDATE ... WHERE id AND shopId (tenant guard) + AuditLog
    API-->>App: 200 {data: rule}
  else create a missing combination
    App->>API: POST /shop/pricing-rules {colourMode, sides, pricePerSheetPaise}
    API->>DB: INSERT (unique shop+paper+colour+sides) + AuditLog
    API-->>App: 201 {data: rule}
    Note over App,API: 409 DUPLICATE_PRICING_RULE means it already exists: re-GET and PUT instead
  else remove
    App->>API: DELETE /shop/pricing-rules/:id
    API-->>App: 204
  end
  Note over App,API: Last write wins (no version / ETag). Changes affect NEW quotes and orders immediately - existing orders keep their price snapshot. 401 then refresh flow C.
  App->>API: GET /shops/me (optional)
  API-->>App: shop.rateInfo = active rules only, and showQr / nextStep
```
