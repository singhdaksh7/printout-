# Android integration guide (Kotlin)

Audience: the Android developer integrating the **shop-owner app** with the existing Printout Buddy backend. Every endpoint, field and error code below is verified against the route code on `origin/main` (`080c6bd`); details per endpoint are in [api-inventory.md](./api-inventory.md) and the machine-readable [OpenAPI spec](../openapi/api-v1.yaml). Flows are in [sequence-diagrams.md](./sequence-diagrams.md).

**Ground rules (read first)**

1. **Mobile uses its own token contract, not cookies.** Send `Authorization: Bearer <accessToken>` on every owner call. There is **no CSRF header** and no cookie handling for Bearer requests.
2. **The Firebase ID token is used exactly once**, at `POST /auth`, to prove identity. It is **never** accepted by `/shop/*`, `/users/*` or `/shops/*`.
3. **Two secrets, rotating:** a short-lived opaque *access token* and a single-use *refresh token*. Refresh is single-flight; if a refresh result is lost the user must sign in again (see [§6](#6-refresh-token-rotation-logout-and-session-expiry)).
4. **Request bodies are strict.** Unknown keys → `400 VALIDATION_ERROR`. Omit optional fields instead of sending `null` (configure `explicitNulls = false`).
5. **Money is integer paise.** Dates are ISO-8601 UTC. Business time is `Asia/Kolkata`.
6. **Admin accounts cannot sign in on mobile** (`403 FORBIDDEN`). The app is for shop owners.
7. **Feature flags are server-side and default OFF in code:** `GOOGLE_LOGIN_ENABLED`, `SHOP_SELF_ONBOARDING_ENABLED`, `FCM_PUSH_ENABLED`. Their production values are **Requires confirmation** (production env is not in the repository). The app must tolerate `503 GOOGLE_LOGIN_UNAVAILABLE`, `403 SELF_ONBOARDING_DISABLED`, and missing push.

## 1. Production base URL

```kotlin
object Api {
    const val BASE_URL = "https://printoutbuddy.tech/api/v1/"   // trailing slash for Retrofit; paths below are relative
    const val ROOT = "https://printoutbuddy.tech"                // /health lives here, not under /api/v1
}
```

Responses are `{ "data": ... }` on success and `{ "error": { code, message, requestId, details? } }` on failure. `204` has no body.

### Common models and JSON config

```kotlin
val json = Json {
    ignoreUnknownKeys = true   // the server adds fields over time (additive compatibility)
    explicitNulls = false      // omit nulls: request bodies are strict
    encodeDefaults = false
}

@Serializable data class Envelope<T>(val data: T)

@Serializable data class ApiErrorBody(val error: ApiErrorDto)
@Serializable data class ApiErrorDto(
    val code: String, val message: String, val requestId: String? = null, val details: JsonElement? = null
)

class ApiException(
    val status: Int, val code: String, override val message: String,
    val requestId: String?, val details: JsonElement?, val retryAfterSeconds: Long? = null
) : Exception(message)

@Serializable data class UserProfile(
    val id: String?, val role: String?, val name: String?, val email: String?, val phoneNumber: String?,
    val loginMethods: List<String>, val emailVerified: Boolean, val phoneVerified: Boolean,
    val createdAt: String?, val updatedAt: String?, val lastLoginAt: String?
)
@Serializable data class RateInfo(val paperSize: String, val colourMode: String, val sides: String, val pricePerSheetPaise: Int)
@Serializable data class ShopProfile(
    val id: String, val shopName: String, val slug: String, val address: String?, val pincode: String?,
    val phoneNumber: String?, val shopStatus: String, val isActive: Boolean, val acceptsOrders: Boolean,
    val showQr: Boolean, val qrCodeUrl: String?, val rateInfo: List<RateInfo>, val onboardingStatus: String
)
@Serializable data class MobileAuth(
    val accessToken: String, val refreshToken: String, val tokenType: String,
    val expiresIn: Long, val refreshTokenExpiresIn: Long,
    val user: UserProfile, val shops: List<ShopProfile>, val shop: ShopProfile?,
    val nextStep: String, val isShopRegisteredAtLeastOne: Boolean, val showQr: Boolean, val onboardingAvailable: Boolean
)
```

### HTTP client skeleton (OkHttp + Retrofit)

```kotlin
// build.gradle: okhttp, okhttp-sse, retrofit, retrofit2-kotlinx-serialization-converter, kotlinx-serialization-json
class AuthHeaderInterceptor(private val tokens: TokenStore) : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val req = chain.request()
        val t = runBlocking { tokens.read() }?.access
        return chain.proceed(if (t != null && req.header("Authorization") == null)
            req.newBuilder().header("Authorization", "Bearer $t").build() else req)
    }
}

fun okHttp(tokens: TokenStore, installationId: String): OkHttpClient {
    val refreshClient = OkHttpClient.Builder().callTimeout(30, TimeUnit.SECONDS).build()   // no authenticator on this one
    return OkHttpClient.Builder()
        .addInterceptor(AuthHeaderInterceptor(tokens))
        .authenticator(TokenAuthenticator(tokens, installationId, refreshClient))
        .connectTimeout(10, TimeUnit.SECONDS).readTimeout(30, TimeUnit.SECONDS)
        .build()                                                  // add a logging interceptor ONLY in debug and redact Authorization
}

val retrofit: Retrofit = Retrofit.Builder().baseUrl(Api.BASE_URL).client(okHttp(tokens, installation.id()))
    .addConverterFactory(json.asConverterFactory("application/json".toMediaType())).build()

/** Maps any non-2xx into ApiException so callers branch on `code`, never on message text. */
suspend fun <T> safe(block: suspend () -> T): T = try { block() } catch (e: HttpException) {
    val body = e.response()?.errorBody()?.string()
    val err = runCatching { json.decodeFromString<ApiErrorBody>(body!!).error }.getOrNull()
    throw ApiException(e.code(), err?.code ?: "HTTP_${e.code()}", err?.message ?: e.message(), err?.requestId, err?.details,
                       e.response()?.headers()?.get("Retry-After")?.toLongOrNull())
}

interface AuthApi {
    @POST("auth")             suspend fun signIn(@Body b: AuthRequest): Envelope<MobileAuth>
    @POST("auth/refresh")     suspend fun refresh(@Body b: RefreshRequest): Envelope<MobileAuth>
    @POST("auth/logout")      suspend fun logout(@Body b: LogoutRequest): Response<Unit>        // 204
    @POST("auth/logout-all")  suspend fun logoutAll(@Body b: LogoutAllRequest): Response<Unit>  // 204
    @POST("shops/onboarding") suspend fun onboard(@Body b: OnboardingRequest): Envelope<MobileAuth>
    @PUT("users/me/fcm-token") suspend fun putFcm(@Body b: FcmReg): Envelope<JsonElement>
    @POST("users/me/identities/google") suspend fun linkGoogle(@Body b: LinkGoogle): Envelope<JsonElement>
}
```

## 2. Firebase Google sign-in → token exchange

**The token must be fresh.** The server rejects a Firebase ID token whose `auth_time` (the instant the user *actually signed in with Google*) is older than `FIREBASE_AUTH_MAX_AGE_SECONDS` (300 s), and each token can be exchanged **once** (a later `auth_time` is required every time). `getIdToken(true)` refreshes the token but does **not** change `auth_time`. So: **do a real Google sign-in immediately before every `POST /auth`**, send the token right away, then discard the Firebase session.

```kotlin
// Credential Manager + Firebase Auth. webClientId = the OAuth "Web client" id of the Firebase project.
suspend fun googleIdToken(activity: Activity, webClientId: String): String {
    val request = GetCredentialRequest.Builder()
        .addCredentialOption(GetGoogleIdOption.Builder()
            .setServerClientId(webClientId)
            .setFilterByAuthorizedAccounts(false)
            .build())
        .build()
    val cred = CredentialManager.create(activity).getCredential(activity, request).credential
    val googleToken = GoogleIdTokenCredential.createFrom(cred.data).idToken
    val auth = FirebaseAuth.getInstance()
    val user = auth.signInWithCredential(GoogleAuthProvider.getCredential(googleToken, null)).await().user!!
    return user.getIdToken(false).await().token!!      // fresh: auth_time == now
}
```

```kotlin
@Serializable data class AuthRequest(
    val loginMethod: String,                 // "google" | "otp" | "email"
    val firebaseIdToken: String? = null,     // required for google / otp
    val email: String? = null, val password: String? = null,   // loginMethod = "email" only
    val fcmToken: String? = null,            // optional; registered only after auth succeeds
    val installationId: String,              // 16-64 chars [A-Za-z0-9_-], random, stable per install
    val platform: String = "android"
)

suspend fun signInWithGoogle(activity: Activity): MobileAuth {
    val idToken = googleIdToken(activity, BuildConfig.GOOGLE_WEB_CLIENT_ID)
    val fcm = runCatching { FirebaseMessaging.getInstance().token.await() }.getOrNull()
    val result = safe {
        authApi.signIn(AuthRequest("google", firebaseIdToken = idToken, fcmToken = fcm, installationId = installation.id()))
    }.data
    FirebaseAuth.getInstance().signOut()          // the Firebase session is not needed afterwards
    tokens.save(result)                           // §5
    return result
}
```

**Installation id:** generate once (`SecureRandom`, 24 bytes → Base64 URL-safe, no padding → 32 chars), persist, and reuse for sign-in, refresh (`deviceId`), onboarding (`deviceId`) and FCM (`installationId`). It binds the refresh token to this install: a refresh from another id is treated as theft.

`loginMethod` alternatives (same endpoint, same response): `"otp"` (Firebase phone ID token + optional `phoneNumber` that must equal the verified number) and `"email"` (`email` + `password`). Email sign-in works only for shop owners.

### Handling the response: `nextStep`

`MobileAuth.nextStep` (also returned by `GET /users/me`) drives navigation:

| `nextStep` | Meaning | App action |
|---|---|---|
| `create_shop` | verified identity, no account (restricted token, `user.id == null`) | onboarding screen → `POST /shops/onboarding` |
| `complete_profile` | shop exists but owner name or address is empty | profile form → `PATCH /users/me`, `PATCH /shops/me` |
| `generate_qr` | shop exists but is not live (`shopStatus != ACTIVE`, or bad slug) | QR screen using `GET /shops/me/qr` (shows `reason`) |
| `dashboard` | ready | main app |
| `account_blocked` | shop `SUSPENDED` | blocked screen. Sign-in itself returns `403 ACCOUNT_BLOCKED` with `details.nextStep = "account_blocked"` and **no tokens**. |

## 3. First-time Google user onboarding

An unlinked Google identity receives the **restricted pair**: `accessToken` (scoped grant) + `refreshToken` (kind `onboarding`), `user.id = null`, `user.email` = the Google-verified email, `nextStep = "create_shop"`. It is valid only for `POST /shops/onboarding`, `GET /users/me` and `POST /auth/logout`, and only for the access-token lifetime (refresh it like a normal token).

```kotlin
@Serializable data class OnboardingRequest(
    val ownerName: String,            // 1-100
    val shopName: String,             // 2-100
    val address: String,              // 5-300
    val pincode: String,              // ^[1-9][0-9]{5}$
    val client: String = "mobile",
    val deviceId: String,             // = installationId
    val email: String? = null         // Google: omit (or equal to the verified email). Phone principals: required.
)

suspend fun createShop(req: OnboardingRequest): MobileAuth {
    val auth = safe { authApi.onboard(req) }.data                     // Bearer = restricted token (sent by the interceptor)
    tokens.save(auth)            // REPLACE the stored pair with the account's own pair
    return auth                  // 201 created, or 200 when the identical request is repeated
}
```

Errors: `403 SELF_ONBOARDING_DISABLED` (registration not open: show "contact support"), `409 ALREADY_ONBOARDED` (go to sign-in), `409 EMAIL_UNAVAILABLE` (that Google email already belongs to an account: sign in with the existing method, then link Google in Settings), `400 VALIDATION_ERROR` (show `details.fieldErrors`), `401` (grant expired: sign in with Google again).

Result: user + shop + Google identity exist; the shop is created **`ACTIVE`, `acceptsOrders = true`** (code since PR #40; some older docs still say `PILOT`, which is stale). The new owner has **no password** and **no pricing rules**: next screen should prompt them to set prices (§8), otherwise customers get `422 NO_PRICING_RULE`.

## 4. Existing shop-owner sign-in

Same endpoint, `loginMethod: "google"`. If the Google identity is **already linked** to an owner account the response is the full pair with `nextStep = "dashboard"` (or `generate_qr` / `complete_profile`).

Matching is **only** by the Firebase uid of a *linked* identity. An owner who has never linked Google, even with the same email, gets the restricted pair, not a session. They sign in with their existing method (`"email"`/`"otp"`) and then link Google:

```kotlin
@Serializable data class Reauth(val currentPassword: String? = null, val firebaseIdToken: String? = null)
@Serializable data class LinkGoogle(val firebaseIdToken: String, val reauth: Reauth)

// freshGoogleToken = googleIdToken(...) obtained NOW; reauth = exactly ONE of password or another linked identity's fresh token
suspend fun linkGoogle(freshGoogleToken: String, password: String) =
    safe { authApi.linkGoogle(LinkGoogle(freshGoogleToken, Reauth(currentPassword = password))) }
```

Linking ends **all other sessions and refresh families** of the user (the current one stays). `GET /users/me/identities` returns masked link state; `POST /users/me/identities/google/unlink` refuses the last sign-in method (`409 LAST_SIGNIN_METHOD`).

## 5. Secure credential storage

Store: `accessToken`, `refreshToken`, absolute `accessExpiresAt` (= `now + expiresIn`), `refreshExpiresAt`, `installationId`. Never log them; never put them in `SharedPreferences` plain text, intents, crash reports or backups.

```kotlin
class TokenStore(context: Context) {
    private val aead: Aead = AndroidKeysetManager.Builder()
        .withSharedPref(context, "pb_keyset", "pb_keyset_prefs")
        .withKeyTemplate(KeyTemplates.get("AES256_GCM"))
        .withMasterKeyUri("android-keystore://pb_master_key")   // key material never leaves the Keystore
        .build().keysetHandle.getPrimitive(Aead::class.java)
    private val ds = context.createDataStore("pb_tokens")       // or any file you encrypt with `aead`

    data class Tokens(val access: String, val refresh: String, val accessExpiresAtMs: Long, val refreshExpiresAtMs: Long)
    suspend fun save(a: MobileAuth) = write(Tokens(
        a.accessToken, a.refreshToken,
        System.currentTimeMillis() + a.expiresIn * 1000, System.currentTimeMillis() + a.refreshTokenExpiresIn * 1000))
    suspend fun read(): Tokens? = /* decrypt with aead, associated data = "pb_tokens" */ TODO()
    suspend fun clear() { /* delete file */ }
    // write()/read(): aead.encrypt(plain, "pb_tokens".toByteArray()) / decrypt(...)
}
```

Add `android:allowBackup="false"` (or exclude the token file in `dataExtractionRules`/`fullBackupContent`). Treat decrypt failure (e.g. restored-from-backup device) as "signed out".

## 6. Refresh-token rotation, logout and session expiry

Defaults (read the real values from `expiresIn` / `refreshTokenExpiresIn`): access **15 min**, refresh **30 days**, both opaque random strings (not JWTs: do not parse them).

```kotlin
@Serializable data class RefreshRequest(val refreshToken: String, val deviceId: String)

class TokenAuthenticator(
    private val tokens: TokenStore, private val installationId: String, private val refreshClient: OkHttpClient
) : Authenticator {
    private val lock = Any()
    override fun authenticate(route: Route?, response: Response): Request? {
        val path = response.request.url.encodedPath
        // never "refresh" a failed sign-in / refresh / logout call, and never loop
        if (path.endsWith("/auth") || path.endsWith("/auth/refresh") || path.endsWith("/auth/logout") || response.request.header("X-Retry") != null) return null
        val sent = response.request.header("Authorization")?.removePrefix("Bearer ")
        synchronized(lock) {                                      // SINGLE-FLIGHT: one refresh at a time
            val current = runBlocking { tokens.read() } ?: return null
            if (current.access != sent) return retry(response, current.access)   // someone already refreshed
            val body = json.encodeToString(RefreshRequest(current.refresh, installationId))
            val r = refreshClient.newCall(Request.Builder().url(Api.BASE_URL + "auth/refresh")
                .post(body.toRequestBody("application/json".toMediaType())).build()).execute()
            r.use {
                when {
                    it.isSuccessful -> {
                        val auth = json.decodeFromString<Envelope<MobileAuth>>(it.body!!.string()).data
                        runBlocking { tokens.save(auth) }         // persist BEFORE retrying
                        return retry(response, auth.accessToken)
                    }
                    it.code == 409 -> {                           // REFRESH_CONFLICT: another refresh just won
                        Thread.sleep(800)
                        val latest = runBlocking { tokens.read() }
                        return if (latest != null && latest.access != sent) retry(response, latest.access) else null
                    }
                    it.code == 401 || it.code == 403 -> { runBlocking { tokens.clear() }; SessionEvents.signedOut(); return null }
                    else -> return null                           // 429 / 5xx: keep tokens, surface the error
                }
            }
        }
    }
    private fun retry(r: Response, access: String) =
        r.request.newBuilder().header("Authorization", "Bearer $access").header("X-Retry", "1").build()
}
```

Rules:

- **Refresh before expiry is optional**; refreshing on `401` via the `Authenticator` is enough. If you refresh proactively, do it through the same single-flight path.
- **Never run two refreshes concurrently and never reuse an old refresh token.** A presented token that was already rotated (after a 5 s grace) revokes the whole family.
- **Lost response:** if the app sent `POST /auth/refresh` but never received the reply, the server may have rotated the token and the app cannot learn the new pair. A later retry with the old token fails and revokes the family → the only recovery is a fresh sign-in. Use a generous timeout (≈30 s) and handle "unrecoverable refresh" as signed-out.
- Outcomes: `401 REFRESH_TOKEN_INVALID|EXPIRED` → sign in again; `403 ACCOUNT_BLOCKED` → blocked screen; `409 REFRESH_CONFLICT` → re-read storage and retry once; `429` → back off.

**Logout** (idempotent, works even if the access token has expired):

```kotlin
@Serializable data class LogoutRequest(val refreshToken: String? = null)
@Serializable data class LogoutAllRequest(val keepPush: Boolean = false)

suspend fun logout() {
    val t = tokens.read()
    runCatching {   // best effort: always clear local state
        safe { authApi.logout(LogoutRequest(t?.refresh)) }          // Bearer is added when a token is stored
    }
    tokens.clear()
    FirebaseAuth.getInstance().signOut()
    // push registration of this installation is revoked server-side by /auth/logout
}
```

`POST /auth/logout-all` (body `{ "keepPush": false }`) signs out **every** device. After a password/identity change on another device, your tokens may be revoked: the next call returns `401` then refresh fails → signed out.

**Session expiry / blocked:** a suspended shop loses all sessions immediately (`401`, then refresh → `403 ACCOUNT_BLOCKED`). Show a blocked screen from `nextStep = "account_blocked"`; do not loop.

## 7. Loading shop data

Call `GET /users/me` after sign-in/refresh/app start, then `GET /shops/me`:

```kotlin
interface PrintoutApi {
    @GET("users/me")  suspend fun me(): Envelope<ProfileView>
    @GET("shops/me")  suspend fun shop(): Envelope<ShopsView>
    @GET("shops/me/qr") suspend fun qr(): Envelope<QrInfo>
}
@Serializable data class ProfileView(val user: UserProfile, val shops: List<ShopProfile>, val shop: ShopProfile?, val nextStep: String, val showQr: Boolean)
@Serializable data class ShopsView(val shops: List<ShopProfile>, val shop: ShopProfile?, val nextStep: String, val showQr: Boolean)
@Serializable data class QrInfo(val ready: Boolean, val publicUrl: String?, val qrCodeUrl: String?, val reason: String?)
```

`shops` has **zero or one** element (single-shop model; `shop == shops[0]`). Render the QR in-app from `qrCodeUrl` (`https://printoutbuddy.tech/p/<slug>`); only show it when `ready`.

Other settings: `GET/PUT /shop/settings` (name, address, public contact, brand colour, `acceptsOrders` toggle), `GET/PUT /shop/hours` plus temporary closure and emergency reopen endpoints (`weeklyHours` is `{ mon..sun: [{start:"HH:MM", end:"HH:MM|24:00"}] }`, `PUT` is partial).

## 8. Pricing rules: fetch and edit

Up to four rules exist per shop (A4 only): colour mode `bw|colour` × sides `single|duplex`. `pricePerSheetPaise` is an integer 1…1,000,000.

```kotlin
@Serializable data class PricingRule(
    val id: String, val paperSize: String, val colourMode: String, val sides: String,
    val pricePerSheetPaise: Int, val active: Boolean, val createdAt: String, val updatedAt: String
)
@Serializable data class CreateRule(val colourMode: String, val sides: String, val pricePerSheetPaise: Int, val active: Boolean = true)
@Serializable data class UpdateRule(val pricePerSheetPaise: Int? = null, val active: Boolean? = null,
                                    val colourMode: String? = null, val sides: String? = null)

interface PricingApi {
    @GET("shop/pricing-rules")           suspend fun list(): Envelope<List<PricingRule>>
    @POST("shop/pricing-rules")          suspend fun create(@Body b: CreateRule): Envelope<PricingRule>      // 201
    @PUT("shop/pricing-rules/{id}")      suspend fun update(@Path("id") id: String, @Body b: UpdateRule): Envelope<PricingRule>
    @DELETE("shop/pricing-rules/{id}")   suspend fun delete(@Path("id") id: String): Response<Unit>            // 204
}

suspend fun savePrice(existing: PricingRule?, colour: String, sides: String, paise: Int): PricingRule =
    if (existing != null) pricing.update(existing.id, UpdateRule(pricePerSheetPaise = paise)).data
    else try { pricing.create(CreateRule(colour, sides, paise)).data }
         catch (e: ApiException) {
             if (e.code != "DUPLICATE_PRICING_RULE") throw e
             val dup = pricing.list().data.first { it.colourMode == colour && it.sides == sides }   // someone created it meanwhile
             pricing.update(dup.id, UpdateRule(pricePerSheetPaise = paise)).data
         }
```

- No version/ETag: **last write wins**. Refetch the list after each change.
- Existing orders keep their price snapshot; **new** quotes/orders use the current active rules immediately.
- Quote price = `sheets × pricePerSheetPaise`, `sheets = (sides == duplex ? ceil(pages/2) : pages) × copies`. The app should preview with that formula but never treat it as authoritative.

## 9. Orders and the live queue

```kotlin
@Serializable data class OrderItem(
    val id: String, val orderNumber: String, val status: String, val totalPaise: Int, val currency: String,
    val createdAt: String, val updatedAt: String, val customerDisplayNameOrReference: String?,
    val originalFilename: String, val pageCount: Int?, val selectedPageCount: Int?, val colourMode: String?,
    val sides: String?, val copies: Int?, val documentStatus: String, val deleteAfter: String?, val printInitiatedAt: String?
)
@Serializable data class OrderPage(val items: List<OrderItem>, val nextCursor: String? = null)
@Serializable data class Counts(val pending: Int, val attention: Int)

interface OrdersApi {
    @GET("shop/orders") suspend fun list(
        @Query("active") active: String? = "1",   // hides COLLECTED / CANCELLED / EXPIRED
        @Query("print") print: String? = null,    // pending | initiated | attention
        @Query("sort") sort: String = "newest",
        @Query("cursor") cursor: String? = null, @Query("limit") limit: Int = 50): Envelope<OrderPage>
    @GET("shop/orders/counts") suspend fun counts(): Envelope<Counts>
    @GET("shop/orders/{id}")   suspend fun detail(@Path("id") id: String): Envelope<JsonElement>
}
```

- **Pagination:** pass back `nextCursor` verbatim (opaque). Absent `nextCursor` = last page. Do not mix cursors across different `sort`/filters.
- **Live queue strategy:** (1) on foreground: `GET /shop/orders?active=1` + `GET /shop/orders/counts`; (2) foreground real-time: SSE (§11); (3) background: FCM → on push, refetch; (4) reconnect/recovery: `GET /shop/notifications?after=<lastSeq>`. Poll `counts` every 30–60 s only as a fallback (limit 600/min per session is generous).
- **Print (the one shop action):** `POST /shop/orders/{id}/print-now` with a fresh UUID `clientRequestId`. The first success starts a 30-minute deletion countdown (`document.deleteAfter`), moves the order `NEW→ACCEPTED→PRINTING` and returns `access.url` (≤5 min). Open it with a PDF viewer / `PrintManager`. Repeats with the same or a new id are safe: they only re-issue access (`firstPrint: false`).
- **Reprint/view later:** `POST /shop/orders/{id}/document-access` (inline) or `.../document-download` (attachment). `410 DOCUMENT_UNAVAILABLE` means the file is gone (expired or past `deleteAfter`).
- **Cancel:** `POST /shop/orders/{id}/transitions` `{ "toStatus":"CANCELLED", "clientRequestId": "<uuid>", "reason"?: "..." }`. It is the **only** status a shop can request. Do not call the retired `print-confirmation` (always `410`).
- **Order status in the new flow** ends at `PRINTING` after Print; `PRINTED/READY/COLLECTED` appear only on legacy orders. "Print initiated" ≠ paper printed.

```kotlin
@Serializable data class ClientRequest(val clientRequestId: String)
@Serializable data class PrintAccess(val url: String, val expiresAt: String, val contentDisposition: String, val mimeType: String)
@Serializable data class PrintResult(val firstPrint: Boolean, val transitioned: Boolean, val access: PrintAccess)
// @POST("shop/orders/{id}/print-now") suspend fun printNow(@Path("id") id: String, @Body b: ClientRequest): Envelope<PrintResult>

suspend fun printNow(orderId: String, requestId: String = UUID.randomUUID().toString()): PrintResult =
    orders.printNow(orderId, ClientRequest(requestId)).data       // retry with the SAME requestId
```

## 10. Customer tracking (customer flow only)

No authentication; the tracking token in the URL is the capability. An Android customer client (or a deep link from the web QR) uses:

```kotlin
@GET("public/orders/{token}") suspend fun track(@Path("token") token: String): Envelope<Tracking>

@Serializable data class Tracking(
    val serverTime: String, val orderNumber: String, val shopName: String, val status: String, val totalPaise: Int,
    val printIssue: Boolean, val timeline: List<TimelineEntry>, val document: TrackedDoc
)
@Serializable data class TimelineEntry(val status: String, val at: String)
@Serializable data class TrackedDoc(val fileName: String?, val pageCount: Int?, val status: String, val deleteAfter: String?, val deletedAt: String?)
```

Poll every 5–15 s while the screen is visible and stop on terminal statuses; honour `429`. Treat `404 NOT_FOUND` as "unknown/expired link". Key fields: `status`, `timeline[]`, `printIssue` (true when the latest print job failed/needs attention), `document.deleteAfter/deletedAt`, `pickup`, `serverTime` (use it to compute the countdown, not the device clock). **Never log the token.** The upload flow is `GET /public/shops/{slug}` → `POST .../uploads/initiate` → `PUT uploadUrl` (resolve it against the base host if relative; raw bytes, header `Content-Type` must equal the declared MIME) → `POST .../uploads/{id}/complete` → `POST .../quotes` → `POST .../orders` ([sequence D](./sequence-diagrams.md#d-customer-uploads-pdf--gets-quote--creates-order)); use a fresh `clientRequestId` UUID per order and reuse it on retry.

## 11. Notifications: FCM, inbox and SSE

**FCM registration:** register after sign-in and **whenever the token changes**. The `installationId` must equal the one used at sign-in.

```kotlin
@Serializable data class FcmReg(val installationId: String, val token: String, val platform: String = "android")

class PbMessagingService : FirebaseMessagingService() {
    override fun onNewToken(token: String) {
        // Only if signed in; otherwise the token is sent with POST /auth next time (fcmToken)
        scope.launch { runCatching { safe { authApi.putFcm(FcmReg(installation.id(), token)) } } }
    }
    override fun onMessageReceived(m: RemoteMessage) {
        // data = { type: "order.new", orderId: "<id>" }; the notification title is generic ("New print order").
        // There is NO file name or customer data in the push: fetch details with your own token.
        if (m.data["type"] == "order.new") refreshQueueAndInbox()
    }
}
// On sign-out the server revokes this installation's registration. Explicit opt-out:
// DELETE users/me/fcm-token with body {"installationId": "<id>"}  (exactly one of installationId | token)
```

With Retrofit a DELETE with a body needs `@HTTP(method = "DELETE", path = "users/me/fcm-token", hasBody = true)`. Push is best effort and may be disabled server-side; the inbox below is the recovery path.

**Inbox (durable):**

```kotlin
@Serializable data class Notif(val id: String, val seq: String, val type: String, val createdAt: String, val readAt: String?, val data: NotifData)
@Serializable data class NotifData(val orderId: String, val orderNumber: String)
@Serializable data class NotifPage(val items: List<Notif>, val nextCursor: String?, val hasMore: Boolean, val latestCursor: String?, val unreadCount: Int)

// GET shop/notifications?after=<lastSeq>&limit=50   catch-up (newest first; seq is a decimal STRING, compare as Long/BigInteger)
// GET shop/notifications?cursor=<oldestSeq>         page backwards
// POST shop/notifications/{id}/read, POST shop/notifications/read-all
```

Persist `lastSeenSeq` locally; on launch, reconnect, and every push, call `?after=lastSeenSeq` and merge by `id`.

**SSE (optional, foreground only):** `GET /shop/events`, `Authorization: Bearer`, header `Last-Event-ID` for replay. Events: `order.created`, `order.statusChanged`, `order.updated`, `printJob.updated`, `document.deletionScheduled`, `notification.created`; comment `: ping` every ≤25 s. Limits: 10 streams per shop, 5 per session, 30 connects/min (`429` with `Retry-After`). The bus is in memory on one API process and the retention worker cannot publish to it, so **never rely on SSE alone**.

```kotlin
val es = EventSources.createFactory(sseClient /* readTimeout = 0 */).newEventSource(
    Request.Builder().url(Api.BASE_URL + "shop/events").header("Authorization", "Bearer $access")
        .header("Accept", "text/event-stream").build(),
    object : EventSourceListener() {
        override fun onEvent(es: EventSource, id: String?, type: String?, data: String) { /* type = event name, data = JSON */ }
        override fun onFailure(es: EventSource, t: Throwable?, r: Response?) { if (r?.code == 401) refreshThenReconnect() else reconnectWithBackoff() }
    })
```

Close the stream in `onStop`; an access-token refresh requires reconnecting with the new token (the server also re-validates the session every heartbeat and closes the stream when it ends).

## 12. Error handling and retries

```kotlin
suspend inline fun <reified T> Call.await(): T { /* execute; map non-2xx via ApiErrorBody -> ApiException(status, code, message, requestId, details, Retry-After) */ }
```

| Status / `code` | Meaning | App behaviour |
|---|---|---|
| 400 `VALIDATION_ERROR` | bad/unknown field; `details.fieldErrors` | show field errors; do not retry |
| 401 `UNAUTHORIZED` | token missing/expired/revoked | refresh once (§6), retry; on failure → sign-in |
| 401 `INVALID_CREDENTIALS`, `GOOGLE_TOKEN_INVALID`, `PHONE_TOKEN_INVALID` | sign-in failed | for Google: sign in with Google **again** (fresh token); do not auto-retry the same token |
| 401 `REFRESH_TOKEN_INVALID` / `REFRESH_TOKEN_EXPIRED` | refresh failed | clear tokens → sign-in screen |
| 403 `FORBIDDEN` | wrong role (e.g. admin on mobile) | show message |
| 403 `ACCOUNT_BLOCKED` / `SHOP_SUSPENDED` | suspended | blocked screen |
| 403 `SELF_ONBOARDING_DISABLED` | registration closed | "contact support" |
| 403 `CSRF_INVALID` | you sent cookies | you should never see it with Bearer |
| 404 `NOT_FOUND` / `ORDER_NOT_FOUND` / `PRINT_JOB_NOT_FOUND` | missing or another tenant's | remove from UI, refresh list |
| 409 `REFRESH_CONFLICT` | concurrent refresh | wait ~1 s, re-read tokens |
| 409 `DUPLICATE_PRICING_RULE` | rule exists | GET and PUT instead |
| 409 `INVALID_STATUS_TRANSITION` / `ACTIVE_PRINT_JOB_EXISTS` / `DOCUMENT_UNAVAILABLE` | state changed | refetch the order, show current state |
| 409 `EMAIL_UNAVAILABLE`, `ALREADY_ONBOARDED`, `IDEMPOTENCY_CONFLICT` | conflict | per §3 / use a new `clientRequestId` only for a *different* intent |
| 410 `DOCUMENT_UNAVAILABLE` / `ENDPOINT_RETIRED` | file deleted / retired API | show "file removed"; remove the call |
| 422 `NO_PRICING_RULE`, `INVALID_PAGE_RANGE`, `QUOTE_EXPIRED` … | business rule | show message |
| 429 `RATE_LIMITED` | throttled | honour `Retry-After`; exponential backoff with jitter |
| 5xx / `INTERNAL_ERROR` / 503 `*_UNAVAILABLE` | server/outage or feature off | backoff; keep UI usable |

**Retry policy:** retry **GET** and naturally idempotent writes (`PUT`, `DELETE`) on network errors, `502/503/504`, `429`: 3 attempts, 0.5 s → 1 s → 2 s with ±20% jitter, cap 10 s, respecting `Retry-After`. Retry **POST** only when it carries an idempotency key (`clientRequestId` on `print-now`, `transitions`, `print-jobs`, `retry`, `reconcile`, public `orders`) and reuse the **same** key. Do **not** blindly retry `POST /auth`, `POST /auth/refresh` (see §6), `POST /shop/devices/pairing-codes` or `POST /shop/hours/reopen` (not idempotent). Always include `error.requestId` in bug reports.

## 13. Devices and printers (where appropriate)

The Windows agent prints; the **owner app only manages**. Useful owner endpoints (Bearer): `GET /shop/devices` (list with `presence`, `printers`), `POST /shop/devices/pairing-codes` (code `PB-XXXX-XXXX`, 10 min, single use; the owner types it into the Windows agent), `PATCH /shop/devices/{id}` (rename), `POST /shop/devices/{id}/revoke`, `PATCH /shop/devices/{id}/printers/{printerId}` (`{ authorized, isDefault }`), `POST /shop/orders/{id}/print-jobs` (queue to a Windows printer), `GET /shop/print-jobs`, and `cancel` / `retry` / `reconcile`.

- A print job targets an **authorized, present** printer; if none is default pass `printerId`. Possible conflicts: `PRINTER_NOT_AUTHORIZED`, `PRINTER_UNAVAILABLE`, `PRINTER_UNSUPPORTED_OPTIONS`, `ACTIVE_PRINT_JOB_EXISTS`.
- **No "printed" state exists.** `PRINT_INITIATED` = the spooler accepted it. `NEEDS_RECONCILIATION` requires a human decision via `reconcile` (`PRINTED` / `NOT_PRINTED_REQUEUE` / `NOT_PRINTED_GIVE_UP`); `retry` after a possibly-submitted job needs `acknowledgeDuplicateRisk: true` (show a "check the printer first" confirmation).
- **Device mode (`/device/*`) is a different identity** (`pbd_…` credential from `POST /device/pair`, `platform: "ANDROID"`), intended for a dedicated companion device, not for the owner app. Android device accounts can use `/device/orders*`, `/device/heartbeat`, `/device/push-token`, `/device/credential/rotate`; the printer/print-job device routes are **Windows-only** (`409 CONFLICT`). Whether the Android app should act as a paired device at all is **Requires confirmation** (the owner-session model in this guide is the supported default).

## 14. Offline and reconnection behaviour

- **Cache read models** (orders page, pricing rules, profile) in Room for display; mark them stale. Never cache access/refresh tokens outside the encrypted store, and never cache signed document URLs (≤5 min lifetime).
- **Mutations while offline:** keep a small outbox of *idempotent* actions (`print-now`, cancel, pricing edit) with their `clientRequestId`; replay on reconnect with the same ids. Expect `409 INVALID_STATUS_TRANSITION` / `DOCUMENT_UNAVAILABLE` on replay because the 30-minute / 24-hour deadlines keep running: surface it, do not retry forever.
- **On reconnect (and on every foreground):** (1) ensure a valid token (refresh if `accessExpiresAt` is near), (2) `GET /shop/notifications?after=lastSeq`, (3) `GET /shop/orders?active=1` and `GET /shop/orders/counts`, (4) reopen SSE, (5) re-register FCM if the token changed.
- **Server time:** use `serverTime` from `/public/orders/:token`, `/shop/hours` (`availability.serverTime`) and `/device/heartbeat` for countdowns; do not trust the device clock for `deleteAfter`.
- Connectivity probe: `GET https://printoutbuddy.tech/health` (`{"data":{"status":"ok"}}`). Do not use `/ready` from the app.

## 15. Implementation checklist

- [ ] OkHttp + kotlinx.serialization (`ignoreUnknownKeys`, `explicitNulls=false`); TLS only; no cookie jar for owner calls.
- [ ] Installation id generated once; used for sign-in, refresh (`deviceId`), onboarding, FCM.
- [ ] Fresh Google sign-in before every `POST /auth`; discard the Firebase session after the exchange.
- [ ] Tokens in Keystore-backed AEAD storage; backups excluded; never logged.
- [ ] Single-flight `Authenticator`; refresh result persisted before retrying; lost-refresh → sign-in again.
- [ ] `nextStep`-driven navigation; blocked/closed-registration/feature-off screens.
- [ ] UUID `clientRequestId` for every print/cancel/order mutation, reused on retry.
- [ ] Cursor pagination with opaque cursors; inbox catch-up by `seq`.
- [ ] FCM `onNewToken` → `PUT /users/me/fcm-token`; push handler only triggers a refetch.
- [ ] No calls to retired/admin/Windows-only endpoints; no billing UI.
- [ ] Support: log `requestId` from error bodies (never tokens, tracking tokens, FCM tokens or signed URLs).

## 16. Example requests and responses

All values are **fake placeholders** (ids, tokens, numbers). Shapes are those produced by the code. `<ACCESS>` / `<REFRESH>` stand for opaque 43-character tokens; never log real ones. Success bodies are wrapped in `{ "data": ... }`.

### 16.1 `POST /auth` (Google): existing owner

```http
POST /api/v1/auth HTTP/1.1
Host: printoutbuddy.tech
Content-Type: application/json

{
  "loginMethod": "google",
  "firebaseIdToken": "<FIREBASE_ID_TOKEN>",
  "fcmToken": "<FCM_TOKEN>",
  "installationId": "Hq3mV9xT2bLwK8dN5rYzA1cE7uJ4oPfG",
  "platform": "android"
}
```

```json
{
  "data": {
    "accessToken": "<ACCESS>",
    "refreshToken": "<REFRESH>",
    "tokenType": "Bearer",
    "expiresIn": 900,
    "refreshTokenExpiresIn": 2592000,
    "isShopRegisteredAtLeastOne": true,
    "showQr": true,
    "nextStep": "dashboard",
    "user": {
      "id": "cmaexampleuser0001", "role": "shop", "name": "Anita Sharma", "email": "anita@example.com",
      "phoneNumber": null, "loginMethods": ["google"], "emailVerified": true, "phoneVerified": false,
      "createdAt": "2026-10-20T09:15:00.000Z", "updatedAt": "2026-10-20T09:15:00.000Z", "lastLoginAt": "2026-10-27T05:30:12.000Z"
    },
    "shops": [
      {
        "id": "cmaexampleshop0001", "ownerId": "cmaexampleuser0001", "shopName": "Anita Xerox & Print",
        "phoneNumber": null, "address": "12 MG Road, Pune", "pincode": "411001", "location": null,
        "status": "standard", "plan": null, "isVerified": null, "isActive": true, "showQr": true,
        "qrCodeUrl": "https://printoutbuddy.tech/p/anita-xerox-print-7k2a",
        "rateInfo": [ { "paperSize": "A4", "colourMode": "bw", "sides": "single", "pricePerSheetPaise": 200 } ],
        "services": { "colourModes": ["bw"], "sides": ["single"] }, "payment": null, "rating": null,
        "createdAt": "2026-10-20T09:15:00.000Z", "updatedAt": "2026-10-26T11:02:00.000Z",
        "slug": "anita-xerox-print-7k2a", "shopStatus": "ACTIVE", "acceptsOrders": true, "isDefault": true,
        "registeredBy": "self", "images": null, "referral": null, "onboardingStatus": "dashboard"
      }
    ],
    "shop": { "id": "cmaexampleshop0001", "note": "identical to shops[0]; abbreviated in this example only" },
    "onboardingAvailable": true
  }
}
```

(`shop` is the same object as `shops[0]`; the abbreviation above is only to keep the example short, the real response repeats the full object.)

### 16.2 `POST /auth` (Google): no account yet, restricted pair

```json
{
  "data": {
    "accessToken": "<RESTRICTED_ACCESS>", "refreshToken": "<RESTRICTED_REFRESH>", "tokenType": "Bearer",
    "expiresIn": 900, "refreshTokenExpiresIn": 2592000,
    "isShopRegisteredAtLeastOne": false, "showQr": false, "nextStep": "create_shop",
    "user": { "id": null, "role": null, "name": null, "email": "newowner@example.com", "phoneNumber": null,
              "loginMethods": ["google"], "emailVerified": true, "phoneVerified": false,
              "createdAt": null, "updatedAt": null, "lastLoginAt": null },
    "shops": [], "shop": null, "onboardingAvailable": true
  }
}
```

### 16.3 `POST /shops/onboarding`

```json
{
  "ownerName": "Ravi Kumar", "shopName": "Ravi Print Point", "address": "Shop 4, Station Road, Nashik",
  "pincode": "422001", "client": "mobile", "deviceId": "Hq3mV9xT2bLwK8dN5rYzA1cE7uJ4oPfG"
}
```

Response `201`: same body as 16.1 with the new owner (`loginMethods: ["google"]`, `registeredBy: "self"`, `rateInfo: []`, `shopStatus: "ACTIVE"`, `nextStep: "dashboard"`). Validation error example:

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "Request validation failed", "requestId": "0f1e2d3c-0000-4000-8000-000000000000",
  "details": { "formErrors": [], "fieldErrors": { "pincode": ["Enter a valid 6-digit PIN code"] } } } }
```

### 16.4 `POST /auth/refresh`

```json
{ "refreshToken": "<REFRESH>", "deviceId": "Hq3mV9xT2bLwK8dN5rYzA1cE7uJ4oPfG" }
```

Response `200`: same shape as 16.1 (a new `accessToken` **and** a new `refreshToken`; replace both). Failures:

```json
{ "error": { "code": "REFRESH_TOKEN_INVALID", "message": "Your sign-in could not be renewed. Sign in again.", "requestId": "..." } }
```

```json
{ "error": { "code": "ACCOUNT_BLOCKED", "message": "This account is blocked. Contact Printout Buddy support.", "requestId": "...", "details": { "nextStep": "account_blocked" } } }
```

### 16.5 Pricing rules

`GET /api/v1/shop/pricing-rules` returns `200`:

```json
{ "data": [
  { "id": "cmarule000000001", "paperSize": "A4", "colourMode": "bw", "sides": "single", "pricePerSheetPaise": 200, "active": true,
    "createdAt": "2026-10-20T09:20:00.000Z", "updatedAt": "2026-10-20T09:20:00.000Z" },
  { "id": "cmarule000000002", "paperSize": "A4", "colourMode": "colour", "sides": "duplex", "pricePerSheetPaise": 1000, "active": true,
    "createdAt": "2026-10-20T09:21:00.000Z", "updatedAt": "2026-10-22T08:00:00.000Z" }
] }
```

`POST /api/v1/shop/pricing-rules` with body `{ "colourMode": "bw", "sides": "duplex", "pricePerSheetPaise": 150 }` returns `201 { "data": { "id": "...", "paperSize": "A4", ... } }`; a repeat of an existing combination returns `409`:

```json
{ "error": { "code": "DUPLICATE_PRICING_RULE", "message": "A pricing rule for this colour mode and sides already exists", "requestId": "..." } }
```

`PUT /api/v1/shop/pricing-rules/cmarule000000001` with `{ "pricePerSheetPaise": 250 }` returns `200` with the updated rule. `DELETE` returns `204`.

### 16.6 Live queue

`GET /api/v1/shop/orders?active=1&print=pending&limit=20` returns `200`:

```json
{ "data": {
  "items": [
    { "id": "cmaorder00000001", "orderNumber": "ANITAX-0042", "status": "NEW", "totalPaise": 1200, "currency": "INR",
      "createdAt": "2026-10-27T05:41:10.000Z", "updatedAt": "2026-10-27T05:41:10.000Z",
      "customerDisplayNameOrReference": "Ravi", "originalFilename": "notes.pdf", "pageCount": 12, "selectedPageCount": 6,
      "colourMode": "bw", "sides": "duplex", "copies": 2, "documentStatus": "AVAILABLE", "deleteAfter": null,
      "printInitiatedAt": null, "paperSize": "A4", "pageSelection": { "mode": "ranges", "ranges": [ { "from": 1, "to": 6 } ] } }
  ],
  "nextCursor": "WyIyMDI2LTEwLTI3VDA1OjQxOjEwLjAwMFoiLCJjbWFvcmRlcjAwMDAwMDAxIl0"
} }
```

For the next page repeat the call with `&cursor=<nextCursor>`. `GET /api/v1/shop/orders/counts` returns `{ "data": { "pending": 3, "attention": 0 } }`.

### 16.7 Print and cancel

`POST /api/v1/shop/orders/cmaorder00000001/print-now`:

```json
{ "clientRequestId": "6f1c2a7e-3b64-4c0e-9a55-1d2f8e7b9c10" }
```

Response `200`:

```json
{ "data": {
  "order": { "id": "cmaorder00000001", "orderNumber": "ANITAX-0042", "status": "PRINTING" },
  "transitioned": true, "firstPrint": true,
  "document": { "status": "PRINTED_RETENTION", "printInitiatedAt": "2026-10-27T05:44:00.000Z", "deleteAfter": "2026-10-27T06:14:00.000Z" },
  "access": { "url": "https://<object-store-or-api-host>/<signed-path>?<signature>", "expiresAt": "2026-10-27T05:49:00.000Z",
              "contentDisposition": "inline", "mimeType": "application/pdf" }
} }
```

`POST /api/v1/shop/orders/cmaorder00000001/transitions` with `{ "toStatus": "CANCELLED", "reason": "Customer asked", "clientRequestId": "<uuid>" }` returns `200 { "data": { "order": { "id": "...", "orderNumber": "...", "status": "CANCELLED", "totalPaise": 1200, "currency": "INR", "createdAt": "...", "updatedAt": "..." } } }`. A conflict looks like:

```json
{ "error": { "code": "INVALID_STATUS_TRANSITION", "message": "Invalid order transition: PRINTING -> CANCELLED", "requestId": "...", "details": { "from": "PRINTING", "to": "CANCELLED" } } }
```

### 16.8 Notifications and push

`PUT /api/v1/users/me/fcm-token` with `{ "installationId": "Hq3mV9xT2bLwK8dN5rYzA1cE7uJ4oPfG", "token": "<FCM_TOKEN>", "platform": "android" }` returns `200 { "data": { "registered": true, "installationId": "Hq3m...", "platform": "android" } }`.

`GET /api/v1/shop/notifications?after=120&limit=50` returns `200`:

```json
{ "data": {
  "items": [ { "id": "cmanotif0000001", "seq": "123", "type": "order.created", "createdAt": "2026-10-27T05:41:10.000Z", "readAt": null,
               "data": { "orderId": "cmaorder00000001", "orderNumber": "ANITAX-0042" } } ],
  "nextCursor": null, "hasMore": false, "latestCursor": "123", "unreadCount": 1
} }
```

The FCM data message the app receives is `{ "type": "order.new", "orderId": "cmaorder00000001" }` with a generic notification title; nothing else is sent.

### 16.9 Errors you must handle everywhere

```json
{ "error": { "code": "UNAUTHORIZED", "message": "Authentication required", "requestId": "..." } }
```

```json
{ "error": { "code": "RATE_LIMITED", "message": "Too many requests. Please slow down and retry shortly.", "requestId": "..." } }
```

(`RATE_LIMITED` also carries a `Retry-After` header in seconds.)

```json
{ "error": { "code": "SHOP_SUSPENDED", "message": "This shop is suspended", "requestId": "..." } }
```

### 16.10 Customer flow

```http
POST /api/v1/public/shops/anita-xerox-print-7k2a/uploads/initiate
Content-Type: application/json

{ "fileName": "notes.pdf", "byteSize": 482113, "declaredMimeType": "application/pdf" }
```

```json
{ "data": { "uploadId": "dGhpc0lzQW5FeGFtcGxlSWQ", "uploadUrl": "https://printoutbuddy.tech/api/v1/public/uploads/dGhpc0lzQW5FeGFtcGxlSWQ/content?token=<UPLOAD_TOKEN>",
  "requiredHeaders": { "content-type": "application/pdf" }, "expiresAt": "2026-10-27T05:56:00.000Z",
  "limits": { "acceptedMimeTypes": ["application/pdf", "image/jpeg", "image/png"], "maxBytes": 52428800, "maxPdfPages": 200, "imagePageCount": 1 } } }
```

`uploadUrl` is absolute when the server has `PUBLIC_API_BASE` configured and a **relative path (`/api/v1/public/uploads/...`) when it does not**: always resolve it against `https://printoutbuddy.tech` before use (**Requires confirmation** which form production returns). `PUT <uploadUrl>` with the raw bytes and `Content-Type: application/pdf` returns `{ "data": { "uploadId": "...", "byteSize": 482113 } }`. Then `POST .../uploads/<uploadId>/complete` (no body) returns `{ "data": { "documentId": "...", "detectedMimeType": "application/pdf", "byteSize": 482113, "pageCount": 12, "documentStatus": "AVAILABLE", "uploadedAt": "...", "expiresAt": "..." } }`.

```http
POST /api/v1/public/shops/anita-xerox-print-7k2a/quotes
Content-Type: application/json

{ "documentId": "dGhpc0lzQW5FeGFtcGxlSWQ",
  "printOptions": { "paperSize": "A4", "colourMode": "bw", "sides": "duplex", "copies": 2, "pageSelection": { "mode": "ranges", "ranges": [ { "from": 1, "to": 6 } ] } } }
```

```json
{ "data": { "quoteId": "<SIGNED_QUOTE>",
  "printOptions": { "paperSize": "A4", "colourMode": "bw", "sides": "duplex", "copies": 2, "pageSelection": { "mode": "ranges", "ranges": [ { "from": 1, "to": 6 } ] } },
  "selectedPageCount": 6, "sheetsPerCopy": 3, "totalSheets": 6, "unitPricePaise": 200, "totalPaise": 1200, "currency": "INR", "expiresAt": "2026-10-27T05:55:00.000Z" } }
```

```http
POST /api/v1/public/shops/anita-xerox-print-7k2a/orders
Content-Type: application/json

{ "quoteId": "<SIGNED_QUOTE>", "customerDisplayNameOrReference": "Ravi", "clientRequestId": "0d9a6f52-7a0e-4f4f-8f8b-3c2d1e0b9a11" }
```

```json
{ "data": { "orderNumber": "ANITAX-0042", "trackingToken": "<TRACKING_TOKEN>", "status": "NEW", "totalPaise": 1200, "currency": "INR" } }
```

`GET /api/v1/public/orders/<TRACKING_TOKEN>` returns `200`:

```json
{ "data": {
  "serverTime": "2026-10-27T05:46:00.000Z", "retentionMinutes": 30, "shopSlug": "anita-xerox-print-7k2a",
  "orderNumber": "ANITAX-0042", "shopName": "Anita Xerox & Print",
  "pickup": { "address": "12 MG Road, Pune", "contact": null }, "printIssue": false,
  "status": "PRINTING", "totalPaise": 1200, "currency": "INR",
  "createdAt": "2026-10-27T05:41:10.000Z", "updatedAt": "2026-10-27T05:44:00.000Z",
  "printOptions": { "paperSize": "A4", "colourMode": "bw", "sides": "duplex", "copies": 2, "pageSelection": { "mode": "ranges", "ranges": [ { "from": 1, "to": 6 } ] } },
  "selectedPageCount": 6,
  "document": { "fileName": "notes.pdf", "pageCount": 12, "status": "PRINTED_RETENTION", "deleteAfter": "2026-10-27T06:14:00.000Z", "deletedAt": null },
  "documentDeleteAfter": "2026-10-27T06:14:00.000Z",
  "timeline": [ { "status": "NEW", "at": "2026-10-27T05:41:10.000Z" }, { "status": "ACCEPTED", "at": "2026-10-27T05:44:00.000Z" }, { "status": "PRINTING", "at": "2026-10-27T05:44:00.000Z" } ]
} }
```
