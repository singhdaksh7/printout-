# Printout Buddy

- For UI, branch/CI workflow and as-built status, use the `printout-buddy` skill.
- For schema-v2 work (customer accounts, multi-shop, nearby search, customer orders, REJECTED status, cash/UPI tracking, reviews, retention) or anything reconciling the 23-page schema PDF with production, consult the `printout-buddy-architecture` skill first. Treat only CURRENT_PRODUCTION as existing; PROPOSED and BLOCKED items are not APIs and need owner confirmation.
- Never run production migrations, deploy, or push to `main`/`development` without explicit approval.
