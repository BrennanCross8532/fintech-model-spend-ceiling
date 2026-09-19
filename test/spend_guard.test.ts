import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import {
  decideRiskAction,
  paymentEventSchema,
  verifyAuditNotification,
} from "../src/spend_guard.ts";

test("high-risk payments go to review before a model call", () => {
  const event = paymentEventSchema.parse({
    payment_id: "pay_2048",
    amount_usd: 420,
    risk_score: 0.87,
    merchant_category: "digital_goods",
    narrative: "New device and changed billing country",
  });

  assert.deepEqual(decideRiskAction(event), {
    payment_id: "pay_2048",
    action: "manual_review",
    reason: "elevated risk score",
  });
});

test("an authentic notification becomes a typed audit event", () => {
  const timestamp = "1789257600";
  const secret = "test-notification-secret";
  const body = Buffer.from(JSON.stringify({
    event_id: "evt_budget_17",
    event_type: "account.budget.threshold_reached",
    occurred_at: "2026-09-13T00:00:00.000Z",
    payment_id: "pay_2048",
    action: "manual_review",
  }));
  const signature = createHmac("sha256", secret)
    .update(`${timestamp}.${body.toString("utf8")}`)
    .digest("hex");

  const verified = verifyAuditNotification(body, timestamp, signature, secret);
  assert.equal(verified.event_id, "evt_budget_17");
  assert.equal(verified.action, "manual_review");
});
