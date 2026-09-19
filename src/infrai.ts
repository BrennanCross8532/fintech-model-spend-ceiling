import OpenAI from "openai";

type ErrorDetail = {
  code?: string;
  message?: string;
  hint?: string;
  [key: string]: unknown;
};

type Envelope<T> = {
  ok: boolean;
  data?: T;
  error?: ErrorDetail;
  metadata?: unknown;
};

export class InfraiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly detail: ErrorDetail;

  constructor(status: number, detail: ErrorDetail = {}) {
    super(detail.hint ?? detail.message ?? "Infrai request was rejected");
    this.name = "InfraiError";
    this.code = detail.code ?? "REQUEST_REJECTED";
    this.status = status;
    this.detail = detail;
  }
}

function retryDelay(response: Response, attempt: number): number {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
    const dateDelay = Date.parse(retryAfter) - Date.now();
    if (Number.isFinite(dateDelay)) return Math.max(0, dateDelay);
  }
  return 250 * 2 ** attempt;
}

const wait = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

export class InfraiClient {
  readonly openai: OpenAI;
  private readonly key: string;
  readonly baseURL: string;
  private readonly fetcher: typeof fetch;

  constructor(
    key: string,
    baseURL: string,
    fetcher: typeof fetch = fetch,
  ) {
    this.key = key;
    this.baseURL = baseURL;
    this.fetcher = fetcher;
    this.openai = new OpenAI({ apiKey: key, baseURL, maxRetries: 3 });
  }

  async setMonthlyBudget(input: {
    hard_cap_usd: number;
    period: string;
    alert_threshold_usd?: number;
  }, idempotencyKey: string): Promise<unknown> {
    // Canonical REST capability: infrai.account.budget.set
    return this.write("/account/budget/set", "PUT", input, idempotencyKey);
  }

  async registerAuditWebhook(input: {
    url: string;
    events: string[];
    description?: string;
    secret?: string;
  }, idempotencyKey: string): Promise<unknown> {
    // Canonical REST capability: infrai.account.webhooks.register
    return this.write("/account/webhooks/register", "POST", input, idempotencyKey);
  }

  private async write<T>(
    path: string,
    method: "POST" | "PUT",
    body: unknown,
    idempotencyKey: string,
  ): Promise<T> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const response = await this.fetcher(`${this.baseURL}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.key}`,
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify(body),
      });

      const envelope = await response.json() as Envelope<T>;
      if (envelope.ok) return envelope.data as T;
      if (response.status === 429 && attempt < 3) {
        await wait(retryDelay(response, attempt));
        continue;
      }
      throw new InfraiError(response.status, envelope.error);
    }
    throw new Error("Retry sequence ended without a response");
  }
}
