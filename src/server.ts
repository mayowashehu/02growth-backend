import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { createClient } from "@supabase/supabase-js";
import { ZodError } from "zod";
import { diagnosisSchema, type DiagnosisSubmission } from "./schema.js";

const port = Number(process.env.PORT ?? 4000);
const host = process.env.HOST ?? "127.0.0.1";
const corsOrigin = process.env.CORS_ORIGIN ?? "http://localhost:3000";
const rateLimitMax = Number(process.env.RATE_LIMIT_MAX ?? 10);
const rateLimitWindowMs = Number(process.env.RATE_LIMIT_WINDOW_MS ?? 15 * 60 * 1000);

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be an integer between 1 and 65535");
}

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !supabaseServiceRoleKey) {
  throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
}

const supabase = createClient(supabaseUrl, supabaseServiceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const app = Fastify({
  logger: true,
  bodyLimit: 32 * 1024,
});

const attempts = new Map<string, { count: number; resetAt: number }>();

function getClientKey(request: FastifyRequest): string {
  return request.ip || "unknown";
}

function allowRequest(request: FastifyRequest, reply: FastifyReply): boolean {
  const now = Date.now();
  const key = getClientKey(request);
  const current = attempts.get(key);
  const entry = !current || current.resetAt <= now
    ? { count: 0, resetAt: now + rateLimitWindowMs }
    : current;

  entry.count += 1;
  attempts.set(key, entry);
  if (entry.count <= rateLimitMax) return true;

  reply.header("Retry-After", Math.ceil((entry.resetAt - now) / 1000));
  reply.code(429).send({ error: { code: "RATE_LIMITED", message: "Too many submissions. Please try again later." } });
  return false;
}

app.addHook("onRequest", async (request, reply) => {
  reply.header("Access-Control-Allow-Origin", corsOrigin);
  reply.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  reply.header("Access-Control-Allow-Headers", "content-type");
  reply.header("Vary", "Origin");

  if (request.method === "OPTIONS") {
    reply.code(204).send();
  }
});

app.get("/health", async () => ({ ok: true }));

app.post<{ Body: unknown }>("/api/diagnosis", async (request, reply) => {
  if (!allowRequest(request, reply)) return;

  const parsed = diagnosisSchema.safeParse(request.body);
  if (!parsed.success) {
    const fields = Object.fromEntries(
      parsed.error.issues.map((issue) => [issue.path.join(".") || "form", issue.message]),
    );
    return reply.code(400).send({
      error: { code: "VALIDATION_ERROR", message: "Please check the submitted fields.", fields },
    });
  }

  const submission: DiagnosisSubmission = parsed.data;
  const { error } = await supabase.from("diagnosis_inquiries").insert({
    ...submission,
    status: "new",
  });

  if (error) {
    request.log.error({ err: error }, "diagnosis inquiry insert failed");
    return reply.code(502).send({
      error: { code: "SUBMISSION_FAILED", message: "We could not submit this diagnosis request. Please try again." },
    });
  }

  return reply.code(201).send({ ok: true });
});

app.setErrorHandler((error, request, reply) => {
  request.log.error({ err: error }, "unhandled request error");
  return reply.code(500).send({
    error: { code: "INTERNAL_ERROR", message: "Something went wrong. Please try again." },
  });
});

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "shutting down");
  await app.close();
  process.exit(0);
};

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await app.listen({ port, host });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
