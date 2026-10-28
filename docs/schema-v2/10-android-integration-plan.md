# 10 – Android integration plan

Android must keep working with every live route. Nothing below changes a live contract; new routes are additive and labelled NEW_PROPOSED in 05.

| Area | Today (live) | Plan | Compatibility |
|---|---|---|---|
| Sign-in | `POST /auth`, refresh, logout | Same endpoints; customer principal is a new `nextStep`/role value that older apps ignore | additive field only |
| Profile | `GET/PATCH /users/me` | extra optional fields | additive |
| FCM | `PUT/DELETE /users/me/fcm-token` | same routes, customer allowed | unchanged |
| Owner shops | `GET /shops/me` | `GET /shops/mine` + shop selector; each call carries shop id in the path | old route stays |
| Orders (owner) | `/shop/orders*`, device order routes | adapter `GET /shops/{shopId}/orders` | old routes stay |
| Customer app | none | new `/customer/*` routes, same token mechanics | new app only |
| Status display | NEW..COLLECTED | clients keep internal values; PDF-style names are a presentation mapping (08) | no enum break |
| Payments/reviews | none | new fields optional | additive |

Rollout order: (1) docs and OpenAPI agreed with the Android developer, (2) additive backend release, (3) Android feature flags, (4) customer app. Android must tolerate unknown enum values and unknown fields (strict bodies apply to *requests* only).

Matrix and detailed samples for the live routes are in `docs/architecture/android-integration-guide.md` (PR #44). Request and response samples for NEW_PROPOSED routes are deliberately not published as contracts until the owner approves the decisions in 02.
