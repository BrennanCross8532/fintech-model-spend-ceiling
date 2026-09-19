import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

export const paymentEventSchema = z.object({
  payment_id: z.string().min(1).max(80),
  amount_usd: z.number().positive().max(1_000_000),
  risk_score: z.number().min(0).max(1),
  merchant_category: z.string().min(2).max(80),
  narrative: z.string().min(1).max(2_000),
});

export type PaymentEvent = z.infer<typeof paymentEventSchema>;
export type RiskAction = "analyze" | "manual_review";

export type PaymentDecision = {
  payment_id: string;
  action: RiskAction;
  reason: string;
};

export function decideRiskAction(event: PaymentEvent): PaymentDecision {
  if (event.risk_score >= 0.8 || event.amount_usd >= 25_000) {
    return {
      payment_id: event.payment_id,
      action: "manual_review",
      reason: event.risk_score >= 0.8 ? "elevated risk score" : "large payment",
    };
  }
  return {
    payment_id: event.payment_id,
    action: "analyze",
    reason: "routine payment analysis",
  };
}

export type AuditNotification = {
  event_id: string;
  event_type: string;
  occurred_at: string;
  payment_id: string;
  action: RiskAction;
};

export function verifyAuditNotification(
  rawBody: Buffer,
  timestamp: string,
  signature: string,
  secret: string,
): AuditNotification {
  if (!/^\d+$/.test(timestamp)) throw new Error("Invalid notification timestamp");
  const expected = createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody.toString("utf8")}`)
    .digest("hex");
  const supplied = Buffer.from(signature, "hex");
  const calculated = Buffer.from(expected, "hex");
  if (supplied.length !== calculated.length || !timingSafeEqual(supplied, calculated)) {
    throw new Error("Invalid notification signature");
  }

  return z.object({
    event_id: z.string().min(1),
    event_type: z.string().min(1),
    occurred_at: z.string().datetime(),
    payment_id: z.string().min(1),
    action: z.enum(["analyze", "manual_review"]),
  }).parse(JSON.parse(rawBody.toString("utf8")));
}

export function auditRecord(notification: AuditNotification): object {
  const evidence = JSON.stringify(notification);
  return {
    ...notification,
    evidence_sha256: createHash("sha256").update(evidence).digest("hex"),
    recorded_at: new Date().toISOString(),
  };
}
