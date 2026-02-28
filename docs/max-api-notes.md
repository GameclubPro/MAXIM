# MAX API Notes (2026)

- Production mode should use webhook delivery over HTTPS.
- Message deletion constrained by max 24h age.
- Use secret path and webhook header secret for endpoint hardening.
- Mini-app auth requires HMAC validation of init data.
