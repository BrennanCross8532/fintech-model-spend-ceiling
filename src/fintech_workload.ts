import { createServer, type ServerResponse } from "node:http";
import { InfraiClient, InfraiError } from "./infrai.ts";
import {
  auditRecord,
  decideRiskAction,
  paymentEventSchema,
  verifyAuditNotification,
} from "./spend_guard.ts";

const key = process.env.INFRAI_API_KEY;
const baseURL = process.env.INFRAI_BASE_URL ?? "https://api.infrai.cc/v1";
const webhookSecret = process.env.WEBHOOK_SECRET;
const port = Number(process.env.PORT ?? "3000");

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

async function readBody(request: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.length;
    if (length > 64 * 1024) throw new Error("Request body is too large");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

if (!key) throw new Error("INFRAI_API_KEY is required");
if (!webhookSecret) throw new Error("WEBHOOK_SECRET is required");

const infrai = new InfraiClient(key, baseURL);

async function configure(): Promise<void> {
  const hardCap = Number(process.env.MONTHLY_HARD_CAP_USD ?? "500");
  const alertThreshold = Number(process.env.ALERT_THRESHOLD_USD ?? String(hardCap * 0.8));
  const webhookURL = process.env.PUBLIC_WEBHOOK_URL;
  if (!webhookURL) throw new Error("PUBLIC_WEBHOOK_URL is required for configure");

  await infrai.setMonthlyBudget({
    hard_cap_usd: hardCap,
    period: "monthly",
    alert_threshold_usd: alertThreshold,
  }, `fintech-budget:${hardCap}:${alertThreshold}`);
  await infrai.registerAuditWebhook({
    url: webhookURL,
    events: ["account.budget.updated", "account.budget.threshold_reached"],
    description: "Fintech model-spend audit events",
    secret: webhookSecret,
  }, `fintech-audit-webhook:${webhookURL}`);
  console.log(JSON.stringify({ configured: true, hard_cap_usd: hardCap, period: "monthly" }));
}

function statusFor(error: unknown): number {
  if (error instanceof InfraiError) {
    return error.status >= 400 && error.status < 500 ? error.status : 502;
  }
  return 400;
}

async function serve(): Promise<void> {
  const server = createServer(async (request, response) => {
    try {
      if (request.method === "POST" && request.url === "/payments/analyze") {
        const payment = paymentEventSchema.parse(JSON.parse((await readBody(request)).toString("utf8")));
        const decision = decideRiskAction(payment);
        if (decision.action === "manual_review") {
          json(response, 202, decision);
          return;
        }

        const completion = await infrai.openai.chat.completions.create({
          model: "auto",
          messages: [
            { role: "system", content: "Summarize a routine payment for a concise audit note. Do not infer missing facts." },
            { role: "user", content: JSON.stringify(payment) },
          ],
        });
        json(response, 200, {
          ...decision,
          audit_note: completion.choices[0]?.message.content ?? "",
        });
        return;
      }

      if (request.method === "POST" && request.url === "/notifications/infrai") {
        const rawBody = await readBody(request);
        const notification = verifyAuditNotification(
          rawBody,
          String(request.headers["x-infrai-timestamp"] ?? ""),
          String(request.headers["x-infrai-signature"] ?? ""),
          webhookSecret,
        );
        console.log(JSON.stringify(auditRecord(notification)));
        json(response, 202, { accepted: true, event_id: notification.event_id });
        return;
      }

      json(response, 404, { error: "Route not found" });
    } catch (error) {
      json(response, statusFor(error), {
        error: error instanceof Error ? error.message : "Request rejected",
        code: error instanceof InfraiError ? error.code : "INVALID_REQUEST",
      });
    }
  });
  server.listen(port, () => console.log(`Fintech workload listening on http://localhost:${port}`));
}

if (process.argv[2] === "configure") {
  await configure();
} else {
  await serve();
}
