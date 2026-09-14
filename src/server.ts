import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { Resend } from "resend";
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

const resendApiKey = process.env.RESEND_API_KEY;
if (!resendApiKey) {
  throw new Error("RESEND_API_KEY is required");
}

const supabase = createClient(supabaseUrl, supabaseServiceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const resend = new Resend(resendApiKey);
const emailFrom = "02Growth <hello@02growth.online>";
const adminRecipients = ["teslimshehu17@gmail.com", "teslimnysc17@gmail.com"];

const app = Fastify({
  logger: true,
  bodyLimit: 32 * 1024,
});

const attempts = new Map<string, { count: number; resetAt: number }>();

function getClientKey(request: FastifyRequest): string {
  return request.ip || "unknown";
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character] ?? character);
}

function field(label: string, value: string): string {
  return `<div class="field"><div class="label">${escapeHtml(label)}</div><div class="value">${escapeHtml(value) || "-"}</div></div>`;
}

function buildAdminEmail(submission: DiagnosisSubmission): string {
  return `<!doctype html>
<html><body style="margin:0;background:#f4f5f6;color:#34383d;font-family:Arial,sans-serif;line-height:1.55">
  <div style="max-width:680px;margin:32px auto;background:#fff;border:1px solid #e1e4e7">
    <div style="padding:32px;border-bottom:3px solid #24282d">
      <div style="font-size:12px;letter-spacing:2px;color:#737a82;text-transform:uppercase">02Growth</div>
      <h1 style="margin:12px 0 0;font-size:25px;font-weight:600;color:#24282d">New Project Diagnosis Submission</h1>
    </div>
    <div style="padding:28px 32px">
      <h2 style="margin:0 0 14px;font-size:16px;color:#24282d">Project Context</h2>
      <div class="grid">${field("Stage", submission.project_stage)}${field("Observed Problems", submission.observed_problem)}${field("Concerning Behaviour", submission.concerning_behaviour)}</div>
      <hr style="border:0;border-top:1px solid #e1e4e7;margin:26px 0">
      <h2 style="margin:0 0 14px;font-size:16px;color:#24282d">Diagnostic Surface Details</h2>
      <div class="grid">${field("Surface Type", submission.inspection_surfaces.join(", "))}${field("Links / Surfaces", submission.inspection_surfaces.join(", "))}${field("Details", submission.inspection_details)}</div>
      <hr style="border:0;border-top:1px solid #e1e4e7;margin:26px 0">
      <h2 style="margin:0 0 14px;font-size:16px;color:#24282d">Strategic Constraints</h2>
      <div class="grid">${field("90-Day Consequence", submission.ninety_day_consequence)}${field("Current Feelings", submission.current_feeling)}</div>
      <hr style="border:0;border-top:1px solid #e1e4e7;margin:26px 0">
      <h2 style="margin:0 0 14px;font-size:16px;color:#24282d">Contact Profiling</h2>
      <div class="grid">${field("Name", submission.contact_name)}${field("Role", submission.contact_role)}${field("Method Chosen", submission.contact_method)}</div>
    </div>
  </div>
  <style>.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}.field{padding:12px 0;border-bottom:1px solid #eef0f2}.label{font-size:11px;letter-spacing:1px;color:#737a82;text-transform:uppercase}.value{margin-top:4px;white-space:pre-wrap;overflow-wrap:anywhere}@media(max-width:600px){.grid{grid-template-columns:1fr}}</style>
</body></html>`;
}

function buildClientEmail(): string {
  return `<!doctype html>
<html><body style="margin:0;background:#f6f7f8;color:#30343a;font-family:Arial,sans-serif;line-height:1.7">
  <div style="max-width:560px;margin:40px auto;padding:40px 36px;background:#fff;border:1px solid #e3e5e7">
    <div style="font-size:12px;letter-spacing:2px;color:#6d737a;text-transform:uppercase">02Growth</div>
    <div style="height:1px;background:#dfe2e5;margin:24px 0 30px"></div>
    <p style="margin:0 0 18px">Received,</p>
    <p style="margin:0 0 18px">We have successfully received your diagnostic intake data for your project. Someone on the team reads it withn 24 hours. If it is a fit, you get a time for the 7 - day diagnosis. If it is not, we say so and we do not keep you in a drip. Do not send extra files unless we ask.</p>
    <p style="margin:0">Best regards,<br><strong>02Growth</strong></p>
  </div>
</body></html>`;
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

  const clientEmail = submission.contact_method.match(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+/i)?.[0];
  const emailSends = [
    resend.emails.send({
      from: emailFrom,
      to: adminRecipients,
      subject: "🚨 ALERT: New Project Diagnosis Submission",
      html: buildAdminEmail(submission),
    }),
  ];

  if (clientEmail) {
    emailSends.push(resend.emails.send({
      from: emailFrom,
      to: clientEmail,
      subject: "We have the intake - 02Growth",
      html: buildClientEmail(),
    }));
  }

  const emailResults = await Promise.allSettled(emailSends);
  for (const result of emailResults) {
    if (result.status === "rejected") {
      request.log.error({ err: result.reason }, "diagnosis email delivery failed");
    }
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
