import Fastify, {
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import { Resend } from "resend";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import {
  diagnosisSchema,
  type DiagnosisSubmission,
} from "./schema.js";

const port = Number(process.env.PORT ?? 4000);
const host = process.env.HOST ?? "127.0.0.1";
const corsOrigin =
  process.env.CORS_ORIGIN ?? "http://localhost:3000";

const rateLimitMax = Number(
  process.env.RATE_LIMIT_MAX ?? 10,
);

const rateLimitWindowMs = Number(
  process.env.RATE_LIMIT_WINDOW_MS ??
    15 * 60 * 1000,
);

if (
  !Number.isInteger(port) ||
  port < 1 ||
  port > 65535
) {
  throw new Error(
    "PORT must be an integer between 1 and 65535",
  );
}

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceRoleKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceRoleKey) {
  throw new Error(
    "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required",
  );
}

const resendApiKey = process.env.RESEND_API_KEY;

if (!resendApiKey) {
  throw new Error("RESEND_API_KEY is required");
}

const supabase = createClient(
  supabaseUrl,
  supabaseServiceRoleKey,
  {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  },
);

const resend = new Resend(resendApiKey);

const emailFrom =
  "02Growth <hello@02growth.online>";

const DEFAULT_ADMIN_EMAILS = [
  "teslimshehu17@gmail.com",
  "teslimnysc17@gmail.com",
];

const ADMIN_EMAILS = (process.env.ADMIN_EMAILS ?? DEFAULT_ADMIN_EMAILS.join(","))
  .split(",")
  .map((email) => email.trim())
  .filter(Boolean);

const NOTIFICATION_EMAILS = ADMIN_EMAILS.length
  ? ADMIN_EMAILS
  : DEFAULT_ADMIN_EMAILS;

const CASE_FILE_ALLOWLIST: Record<string, string> = {
  "ats-funded": "ATS Funded × 02Growth Lab",
  traderlab: "TraderLab × 02Growth Lab",
  "unified-proof": "02Growth Lab — Track Record",
};

function resolveCaseName(caseId: string): string | null {
  return CASE_FILE_ALLOWLIST[caseId] ?? null;
}

const app = Fastify({
  logger: true,
  bodyLimit: 32 * 1024,
});

const attempts = new Map<
  string,
  {
    count: number;
    resetAt: number;
  }
>();

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function getClientKey(
  request: FastifyRequest,
): string {
  return request.ip || "unknown";
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character] ?? character,
  );
}

function safe(value?: string | null): string {
  const trimmed = value?.trim();

  return trimmed
    ? escapeHtml(trimmed)
    : "Not provided";
}

function formatList(
  values?: string[] | null,
): string {
  if (!values?.length) {
    return "Not provided";
  }

  return values.map(escapeHtml).join(", ");
}

function extractEmail(
  value: string,
): string | null {
  const match = value.match(
    /[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+/i,
  );

  return match?.[0] ?? null;
}

function emailShell(content: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta
    name="viewport"
    content="width=device-width, initial-scale=1"
  >
  <meta
    name="color-scheme"
    content="light"
  >
  <meta
    name="supported-color-schemes"
    content="light"
  >
  <title>02Growth</title>
</head>

<body
  style="
    margin:0;
    padding:0;
    background:#f3f4f4;
    color:#17191c;
    font-family:Arial,Helvetica,sans-serif;
    -webkit-font-smoothing:antialiased;
  "
>
  <table
    role="presentation"
    width="100%"
    cellpadding="0"
    cellspacing="0"
    border="0"
    style="width:100%;background:#f3f4f4;"
  >
    <tr>
      <td
        align="center"
        style="padding:32px 16px;"
      >
        <table
          role="presentation"
          width="100%"
          cellpadding="0"
          cellspacing="0"
          border="0"
          style="
            width:100%;
            max-width:680px;
            background:#ffffff;
            border:1px solid #e2e4e5;
          "
        >
          ${content}
        </table>

        <table
          role="presentation"
          width="100%"
          cellpadding="0"
          cellspacing="0"
          border="0"
          style="width:100%;max-width:680px;"
        >
          <tr>
            <td
              style="
                padding:18px 6px 0;
                color:#8a8f94;
                font-size:11px;
                line-height:1.5;
                text-align:center;
              "
            >
              02Growth · Growth diagnostics for Web3 teams
              <br>
              02growth.online
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function sectionTitle(
  eyebrow: string,
  title: string,
): string {
  return `
    <tr>
      <td
        style="
          padding:0 0 14px;
        "
      >
        <div
          style="
            margin-bottom:6px;
            color:#8b9095;
            font-size:10px;
            line-height:1.4;
            font-weight:700;
            letter-spacing:1.4px;
            text-transform:uppercase;
          "
        >
          ${escapeHtml(eyebrow)}
        </div>

        <div
          style="
            color:#17191c;
            font-size:17px;
            line-height:1.4;
            font-weight:700;
          "
        >
          ${escapeHtml(title)}
        </div>
      </td>
    </tr>
  `;
}

function infoRow(
  label: string,
  value: string,
): string {
  return `
    <tr>
      <td
        style="
          padding:13px 0;
          border-top:1px solid #eceeef;
          vertical-align:top;
        "
      >
        <table
          role="presentation"
          width="100%"
          cellpadding="0"
          cellspacing="0"
          border="0"
        >
          <tr>
            <td
              width="34%"
              valign="top"
              style="
                width:34%;
                padding-right:18px;
                color:#84898f;
                font-size:10px;
                line-height:1.5;
                font-weight:700;
                letter-spacing:1px;
                text-transform:uppercase;
              "
            >
              ${escapeHtml(label)}
            </td>

            <td
              valign="top"
              style="
                color:#272b30;
                font-size:14px;
                line-height:1.65;
                overflow-wrap:anywhere;
                word-break:break-word;
              "
            >
              ${value}
            </td>
          </tr>
        </table>
      </td>
    </tr>
  `;
}

function buildAdminEmail(
  submission: DiagnosisSubmission,
): string {
  const contactEmail = extractEmail(
    submission.contact_method,
  );

  const contactAction = contactEmail
    ? `
      <a
        href="mailto:${escapeHtml(contactEmail)}"
        style="
          display:inline-block;
          padding:11px 16px;
          background:#d9ff45;
          color:#111315;
          text-decoration:none;
          font-size:13px;
          font-weight:700;
        "
      >
        Reply by email
      </a>
    `
    : "";

  return emailShell(`
    <tr>
      <td
        style="
          padding:30px 32px 26px;
          background:#0b0c0d;
          border-bottom:3px solid #d9ff45;
        "
      >
        <table
          role="presentation"
          width="100%"
          cellpadding="0"
          cellspacing="0"
          border="0"
        >
          <tr>
            <td>
              <div
                style="
                  color:#d9ff45;
                  font-size:10px;
                  line-height:1.5;
                  font-weight:700;
                  letter-spacing:1.8px;
                  text-transform:uppercase;
                "
              >
                02Growth · Diagnostic Intake
              </div>

              <div
                style="
                  margin-top:10px;
                  color:#ffffff;
                  font-size:26px;
                  line-height:1.25;
                  font-weight:700;
                "
              >
                New project submitted for review
              </div>

              <div
                style="
                  margin-top:10px;
                  color:#aeb3b8;
                  font-size:14px;
                  line-height:1.6;
                "
              >
                ${safe(submission.contact_name)}
                ·
                ${safe(submission.contact_role)}
                ·
                ${safe(submission.project_stage)}
              </div>
            </td>
          </tr>
        </table>
      </td>
    </tr>

    <tr>
      <td
        style="
          padding:26px 32px;
          background:#f8f9f9;
          border-bottom:1px solid #e5e7e8;
        "
      >
        <div
          style="
            margin-bottom:8px;
            color:#8b9095;
            font-size:10px;
            font-weight:700;
            letter-spacing:1.3px;
            text-transform:uppercase;
          "
        >
          First read
        </div>

        <div
          style="
            color:#17191c;
            font-size:18px;
            line-height:1.55;
            font-weight:700;
          "
        >
          ${safe(submission.concerning_behaviour)}
        </div>

        <div
          style="
            margin-top:8px;
            color:#62686e;
            font-size:13px;
            line-height:1.65;
          "
        >
          This is the behaviour the founder identified as
          most concerning. Review the evidence below before
          making any diagnostic assumption.
        </div>
      </td>
    </tr>

    <tr>
      <td
        style="
          padding:30px 32px 8px;
        "
      >
        <table
          role="presentation"
          width="100%"
          cellpadding="0"
          cellspacing="0"
          border="0"
        >
          ${sectionTitle(
            "01 · Project state",
            "What they are seeing",
          )}

          ${infoRow(
            "Project stage",
            safe(submission.project_stage),
          )}

          ${infoRow(
            "Observed problem",
            safe(submission.observed_problem),
          )}

          ${infoRow(
            "Primary concern",
            safe(submission.concerning_behaviour),
          )}
        </table>
      </td>
    </tr>

    <tr>
      <td
        style="
          padding:22px 32px 8px;
        "
      >
        <table
          role="presentation"
          width="100%"
          cellpadding="0"
          cellspacing="0"
          border="0"
        >
          ${sectionTitle(
            "02 · Inspection surface",
            "Where Strategy should look",
          )}

          ${infoRow(
            "Surfaces",
            formatList(
              submission.inspection_surfaces,
            ),
          )}

          ${infoRow(
            "Links / handles",
            safe(submission.inspection_details),
          )}
        </table>
      </td>
    </tr>

    <tr>
      <td
        style="
          padding:22px 32px 8px;
        "
      >
        <table
          role="presentation"
          width="100%"
          cellpadding="0"
          cellspacing="0"
          border="0"
        >
          ${sectionTitle(
            "03 · Pressure",
            "What is at stake",
          )}

          ${infoRow(
            "90-day consequence",
            safe(
              submission.ninety_day_consequence,
            ),
          )}

          ${infoRow(
            "Founder intuition",
            safe(submission.current_feeling),
          )}
        </table>
      </td>
    </tr>

    <tr>
      <td
        style="
          padding:22px 32px 30px;
        "
      >
        <table
          role="presentation"
          width="100%"
          cellpadding="0"
          cellspacing="0"
          border="0"
        >
          ${sectionTitle(
            "04 · Contact",
            "Who submitted it",
          )}

          ${infoRow(
            "Name",
            safe(submission.contact_name),
          )}

          ${infoRow(
            "Role",
            safe(submission.contact_role),
          )}

          ${infoRow(
            "Reply via",
            safe(submission.contact_method),
          )}
        </table>

        ${
          contactAction
            ? `
              <div
                style="
                  padding-top:22px;
                  border-top:1px solid #eceeef;
                "
              >
                ${contactAction}
              </div>
            `
            : ""
        }
      </td>
    </tr>

    <tr>
      <td
        style="
          padding:18px 32px;
          background:#0b0c0d;
          color:#9da3a8;
          font-size:11px;
          line-height:1.6;
        "
      >
        <strong style="color:#ffffff;">
          Internal rule:
        </strong>
        treat this submission as signal, not diagnosis.
        Verify the project before deciding whether the
        7-day diagnostic engagement is warranted.
      </td>
    </tr>
  `);
}

function buildClientEmail(
  submission: DiagnosisSubmission,
): string {
  const firstName =
    submission.contact_name
      .trim()
      .split(/\s+/)[0] || "there";

  return emailShell(`
    <tr>
      <td
        style="
          padding:30px 32px 26px;
          background:#0b0c0d;
          border-bottom:3px solid #d9ff45;
        "
      >
        <div
          style="
            color:#d9ff45;
            font-size:10px;
            line-height:1.5;
            font-weight:700;
            letter-spacing:1.8px;
            text-transform:uppercase;
          "
        >
          02Growth
        </div>

        <div
          style="
            margin-top:10px;
            color:#ffffff;
            font-size:25px;
            line-height:1.25;
            font-weight:700;
          "
        >
          Your diagnostic request is in.
        </div>
      </td>
    </tr>

    <tr>
      <td
        style="
          padding:32px;
        "
      >
        <p
          style="
            margin:0 0 18px;
            color:#202328;
            font-size:15px;
            line-height:1.7;
          "
        >
          Hi ${escapeHtml(firstName)},
        </p>

        <p
          style="
            margin:0 0 18px;
            color:#454a50;
            font-size:15px;
            line-height:1.75;
          "
        >
          We have received your 02Growth diagnostic
          intake.
        </p>

        <p
          style="
            margin:0 0 26px;
            color:#454a50;
            font-size:15px;
            line-height:1.75;
          "
        >
          We review every project before deciding
          whether there is enough evidence and a
          meaningful enough problem for a full
          7-day diagnosis.
        </p>

        <table
          role="presentation"
          width="100%"
          cellpadding="0"
          cellspacing="0"
          border="0"
          style="
            width:100%;
            margin:0 0 28px;
            background:#f7f8f8;
            border:1px solid #e5e7e8;
          "
        >
          <tr>
            <td
              style="
                padding:20px 22px;
              "
            >
              <div
                style="
                  color:#8b9095;
                  font-size:10px;
                  font-weight:700;
                  letter-spacing:1.2px;
                  text-transform:uppercase;
                "
              >
                What happens next
              </div>

              <div
                style="
                  margin-top:14px;
                  color:#2f3439;
                  font-size:14px;
                  line-height:1.75;
                "
              >
                <strong style="color:#17191c;">
                  1.
                </strong>
                We review the project and the surfaces
                you submitted.
              </div>

              <div
                style="
                  margin-top:10px;
                  color:#2f3439;
                  font-size:14px;
                  line-height:1.75;
                "
              >
                <strong style="color:#17191c;">
                  2.
                </strong>
                You will hear from us within 24 hours.
              </div>

              <div
                style="
                  margin-top:10px;
                  color:#2f3439;
                  font-size:14px;
                  line-height:1.75;
                "
              >
                <strong style="color:#17191c;">
                  3.
                </strong>
                If the project is a fit, we will explain
                the next step for the paid 7-day
                diagnostic engagement.
              </div>
            </td>
          </tr>
        </table>

        <p
          style="
            margin:0 0 26px;
            color:#454a50;
            font-size:14px;
            line-height:1.75;
          "
        >
          There is nothing else you need to send right
          now. If we need additional access, context or
          evidence, we will ask for it directly.
        </p>

        <div
          style="
            padding-top:22px;
            border-top:1px solid #eceeef;
          "
        >
          <p
            style="
              margin:0;
              color:#202328;
              font-size:14px;
              line-height:1.65;
            "
          >
            02Growth<br>
            <span
              style="
                color:#7b8187;
                font-size:12px;
              "
            >
              Diagnose before you prescribe.
            </span>
          </p>
        </div>
      </td>
    </tr>
  `);
}

function buildClientText(
  submission: DiagnosisSubmission,
): string {
  const firstName =
    submission.contact_name
      .trim()
      .split(/\s+/)[0] || "there";

  return `Hi ${firstName},

We have received your 02Growth diagnostic intake.

We review every project before deciding whether there is enough evidence and a meaningful enough problem for a full 7-day diagnosis.

What happens next:
1. We review the project and the surfaces you submitted.
2. You will hear from us within 24 hours.
3. If the project is a fit, we will explain the next step for the paid 7-day diagnostic engagement.

There is nothing else you need to send right now. If we need additional access, context or evidence, we will ask for it directly.

02Growth
Diagnose before you prescribe.
02growth.online`;
}

/* -------------------------------------------------------------------------- */
/* Rate limiting                                                              */
/* -------------------------------------------------------------------------- */

function allowRequest(
  request: FastifyRequest,
  reply: FastifyReply,
): boolean {
  const now = Date.now();
  const key = getClientKey(request);
  const current = attempts.get(key);

  const entry =
    !current || current.resetAt <= now
      ? {
          count: 0,
          resetAt:
            now + rateLimitWindowMs,
        }
      : current;

  entry.count += 1;
  attempts.set(key, entry);

  if (entry.count <= rateLimitMax) {
    return true;
  }

  reply.header(
    "Retry-After",
    Math.ceil(
      (entry.resetAt - now) / 1000,
    ),
  );

  reply.code(429).send({
    error: {
      code: "RATE_LIMITED",
      message:
        "Too many submissions. Please try again later.",
    },
  });

  return false;
}

/* -------------------------------------------------------------------------- */
/* Fastify                                                                    */
/* -------------------------------------------------------------------------- */

app.addHook(
  "onRequest",
  async (request, reply) => {
    reply.header(
      "Access-Control-Allow-Origin",
      corsOrigin,
    );

    reply.header(
      "Access-Control-Allow-Methods",
      "GET,POST,OPTIONS",
    );

    reply.header(
      "Access-Control-Allow-Headers",
      "content-type",
    );

    reply.header("Vary", "Origin");

    if (request.method === "OPTIONS") {
      return reply.code(204).send();
    }
  },
);

app.get(
  "/health",
  async () => ({
    ok: true,
  }),
);

app.post<{ Body: unknown }>(
  "/api/diagnosis",
  async (request, reply) => {
    if (!allowRequest(request, reply)) {
      return;
    }

    const parsed =
      diagnosisSchema.safeParse(
        request.body,
      );

    if (!parsed.success) {
      const fields = Object.fromEntries(
        parsed.error.issues.map(
          (issue) => [
            issue.path.join(".") ||
              "form",
            issue.message,
          ],
        ),
      );

      return reply.code(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message:
            "Please check the submitted fields.",
          fields,
        },
      });
    }

    const submission: DiagnosisSubmission =
      parsed.data;

    const { error } = await supabase
      .from("diagnosis_inquiries")
      .insert({
        ...submission,
        status: "new",
      });

    if (error) {
      request.log.error(
        { err: error },
        "diagnosis inquiry insert failed",
      );

      return reply.code(502).send({
        error: {
          code: "SUBMISSION_FAILED",
          message:
            "We could not submit this diagnosis request. Please try again.",
        },
      });
    }

    const clientEmail = extractEmail(
      submission.contact_method,
    );

    const emailSends: Promise<unknown>[] =
      [
        resend.emails.send({
          from: emailFrom,
          to: NOTIFICATION_EMAILS,
          replyTo:
            clientEmail ?? undefined,
          subject: `New diagnosis request — ${submission.project_stage} — ${submission.contact_name}`,
          html: buildAdminEmail(
            submission,
          ),
        }),
      ];

    if (clientEmail) {
      emailSends.push(
        resend.emails.send({
          from: emailFrom,
          to: clientEmail,
          subject:
            "Your 02Growth diagnostic request is in",
          html: buildClientEmail(
            submission,
          ),
          text: buildClientText(
            submission,
          ),
        }),
      );
    }

    const emailResults =
      await Promise.allSettled(
        emailSends,
      );

    for (const result of emailResults) {
      if (
        result.status === "rejected"
      ) {
        request.log.error(
          { err: result.reason },
          "diagnosis email delivery failed",
        );
      }
    }

    return reply.code(201).send({
      ok: true,
    });
  },
);

const caseFileAccessSchema = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.string().trim().email().max(255),
  xHandle: z
    .string()
    .trim()
    .min(2)
    .max(120)
    .refine(
      (value) => value === "N/A" || /^@?[A-Za-z0-9_]{1,15}$/.test(value),
      "X handle must be a valid handle or N/A",
    ),
  projectCompany: z.string().trim().min(2).max(200),
  caseId: z.string().trim().min(2).max(80),
  caseName: z.string().trim().min(2).max(200).optional(),
  timestamp: z.string().trim().datetime().optional(),
});

app.post<{ Body: unknown }>(
  "/api/case-file-access",
  async (request, reply) => {
    if (!allowRequest(request, reply)) {
      return;
    }

    const parsed =
      caseFileAccessSchema.safeParse(
        request.body,
      );

    if (!parsed.success) {
      return reply.code(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message:
            "Something went wrong. Please reach out directly on X.",
        },
      });
    }

    const submission = parsed.data;
    const requestedAt = new Date().toISOString();
    const caseName = resolveCaseName(submission.caseId);

    if (!caseName) {
      return reply.code(400).send({
        error: {
          code: "INVALID_CASE_ID",
          message:
            "Something went wrong. Please reach out directly on X.",
        },
      });
    }

    const emailHtml = emailShell(`
      <tr>
        <td
          style="
            padding:30px 32px 26px;
            background:#0b0c0d;
            border-bottom:3px solid #d9ff45;
          "
        >
          <div
            style="
              color:#d9ff45;
              font-size:10px;
              line-height:1.5;
              font-weight:700;
              letter-spacing:1.8px;
              text-transform:uppercase;
            "
          >
            02Growth · Case file access
          </div>

          <div
            style="
              margin-top:10px;
              color:#ffffff;
              font-size:26px;
              line-height:1.25;
              font-weight:700;
            "
          >
            CASE FILE ACCESS REQUEST
          </div>
        </td>
      </tr>

      <tr>
        <td style="padding:28px 32px 10px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
            ${sectionTitle("Request details", "Who wants access")}
            ${infoRow("Requested case", safe(caseName))}
            ${infoRow("Name", safe(submission.name))}
            ${infoRow("Email", safe(submission.email))}
            ${infoRow("X", safe(submission.xHandle))}
            ${infoRow("Project / Company", safe(submission.projectCompany))}
            ${infoRow("Timestamp", safe(requestedAt))}
          </table>
        </td>
      </tr>
    `);

    try {
      await resend.emails.send({
        from: emailFrom,
        to: NOTIFICATION_EMAILS,
        subject: `02Growth — Case File Access Request: ${caseName}`,
        html: emailHtml,
      });

      return reply.code(201).send({
        ok: true,
        caseId: submission.caseId,
        caseName,
      });
    } catch (error) {
      request.log.error(
        { err: error },
        "case file access email delivery failed",
      );

      return reply.code(502).send({
        error: {
          code: "EMAIL_FAILED",
          message:
            "Something went wrong. Please reach out directly on X.",
        },
      });
    }
  },
);

app.setErrorHandler(
  (error, request, reply) => {
    request.log.error(
      { err: error },
      "unhandled request error",
    );

    return reply.code(500).send({
      error: {
        code: "INTERNAL_ERROR",
        message:
          "Something went wrong. Please try again.",
      },
    });
  },
);

const shutdown = async (
  signal: string,
) => {
  app.log.info(
    { signal },
    "shutting down",
  );

  await app.close();
  process.exit(0);
};

process.once(
  "SIGINT",
  () => void shutdown("SIGINT"),
);

process.once(
  "SIGTERM",
  () => void shutdown("SIGTERM"),
);

try {
  await app.listen({
    port,
    host,
  });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}