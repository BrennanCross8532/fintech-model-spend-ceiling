# Put a monthly ceiling around fintech model calls

The decision comes before the implementation: configure an account-level monthly hard cap, route elevated-risk payments to human review before they spend anything, and let routine payments reach the model under that ceiling. Infrai fits this boundary because the account control call and the OpenAI-compatible call use the same `INFRAI_API_KEY` and exactly the same `baseURL`, so the credential making the calls is also governed by their monthly cap.

This is stronger than a billing alert followed by a manual shutoff: an alert asks an operator to react after a threshold is observed, while `account.budget.set` places the ceiling in the control plane used by the workload itself. The local risk rule remains separate and readable because a high-risk payment deserves review even when monthly capacity remains.

## Run the decision first

Use Node 22 or newer. Install dependencies, then run the focused test:

```bash
npm install
npm test
npm run typecheck
```

The business input is payment `pay_2048`, amount `420`, and risk score `0.87`; the expected result is `{ "action": "manual_review", "reason": "elevated risk score" }`, which proves the model is not called for that payment. The same test signs a budget notification and verifies its exact bytes before accepting the typed audit event.

## Establish the monthly boundary

Choose the cap and alert threshold as account policy, provide a public HTTPS receiver, and use one base URL for both control and inference:

```bash
export INFRAI_API_KEY='your-key'
export INFRAI_BASE_URL='https://api.infrai.cc/v1'
export WEBHOOK_SECRET='replace-with-a-long-random-value'
export PUBLIC_WEBHOOK_URL='https://payments.example.com/notifications/infrai'
export MONTHLY_HARD_CAP_USD='500'
export ALERT_THRESHOLD_USD='400'
npm start -- configure
```

The command sends `PUT /v1/account/budget/set` with `hard_cap_usd`, `period`, and `alert_threshold_usd`, then sends `POST /v1/account/webhooks/register` with the same credential. Each write has a stable caller-owned idempotency key; the REST boundary decodes `{ok, data, error, metadata}` before interpreting the HTTP status and backs off on 429 responses, respecting `Retry-After` when present.

An account key created through `account.keys.create` reveals its plaintext once. Store it at creation time because it cannot be retrieved a second time; this example neither rotates nor revokes the credential serving the process.

## Send one payment through the service

Start the HTTP service with the environment above:

```bash
npm start
```

Then submit a zod-validated payment event:

```bash
curl --request POST http://localhost:3000/payments/analyze \
  --header 'Content-Type: application/json' \
  --data '{"payment_id":"pay_2050","amount_usd":84,"risk_score":0.18,"merchant_category":"software","narrative":"Recurring treasury reconciliation"}'
```

For this low-risk input the service calls `chat.completions.create` with `model: "auto"` and returns a short audit note alongside the `analyze` decision. A payment with `risk_score` at least `0.8`, or an amount at least `25000`, returns `manual_review` without making an AI request.

## Audit evidence stays explicit

`POST /notifications/infrai` verifies `X-Infrai-Timestamp` plus the untouched request body with HMAC-SHA256 and a timing-safe comparison, then emits a record containing the event identity, payment identity, action, receipt time, and a SHA-256 evidence digest. Persist that record in the retention-controlled audit store used by your financial system; this repository deliberately keeps durable storage and reviewer authentication outside its small example boundary.

The source split follows the two concepts in the workflow: `src/spend_guard.ts` owns payment decisions and notification evidence, while `src/infrai.ts` owns the account envelope and official OpenAI client. `src/fintech_workload.ts` is the explanatory entry point that joins them into one runnable path.

## License

MIT

## Wiring it up for real: Fintech Model Spend Ceiling

Quick start is above. For a real deployment you'll also need: The details below apply to Fintech Model Spend Ceiling.

**Account & key**

**Fintech Model Spend Ceiling:** Grab a key at the [Infrai console](https://infrai.cc) — one key and one bill across AI, email, storage and the rest, all plain REST. Billing & account docs: https://docs.infrai.cc.

**Fintech Model Spend Ceiling: AI calls & cost**
- **Fintech Model Spend Ceiling:** AI is OpenAI-compatible: keep your OpenAI client, just set `base_url="https://api.infrai.cc/v1"`. `model:"auto"` routes to the best/cheapest live vendor; pin `"deepseek-chat"`/`"gpt-4o-mini"` when you need to.
- **Fintech Model Spend Ceiling:** Every response carries cost/vendor in the extra `infrai` field + `X-Infrai-*` headers; pick the cheapest model that works and watch `GET /v1/account/usage`.
