import Fastify, {
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import { Resend } from "resend";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { readFile } from "node:fs/promises";
import { timingSafeEqual } from "node:crypto";
import path from "node:path";
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

const adminApiToken: string = (() => {
  const value = process.env.ADMIN_API_TOKEN;

  if (!value || value.length < 16) {
    throw new Error(
      "ADMIN_API_TOKEN is required and must be at least 16 characters. Generate one with `openssl rand -hex 32`.",
    );
  }

  return value;
})();

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

// Matches the site's font-mono uppercase micro-labels (record tags, field
// labels, "VERIFIED"). Falls back gracefully where IBM Plex Mono isn't
// available to the mail client.
const MONO_STACK =
  "'IBM Plex Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,monospace";

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

// Absolute origin this server is reachable at, used to build the "Reply"
// link embedded in the diagnosis notification email. Falls back to the
// local dev address; set PUBLIC_BASE_URL in production (e.g. the Render
// URL — the same one the frontend's DIAGNOSTIC_API_URL points at).
const PUBLIC_BASE_URL = (
  process.env.PUBLIC_BASE_URL ?? `http://${host}:${port}`
).replace(/\/$/, "");

// The two personal sender identities available in the reply-to-diagnosis
// tool. Each must be a sender address already verified on the 02growth.online
// domain in Resend — double-check these two match your actual Resend
// senders and edit them here if not.
const REPLY_SENDER_IDENTITIES: Record<
  string,
  { label: string; from: string }
> = {
  mayowa: {
    label: "Mayowa",
    from: "Mayowa · 02Growth <mayowa@02growth.online>",
  },
  pleasure: {
    label: "Pleasure",
    from: "Pleasure · 02Growth <pleasure@02growth.online>",
  },
};

const CASE_FILE_ALLOWLIST: Record<string, string> = {
  "ats-funded": "ATS Funded × 02Growth Lab",
  traderlab: "TraderLab × 02Growth Lab",
  "unified-proof": "02Growth Lab — Track Record",
};

function resolveCaseName(caseId: string): string | null {
  return CASE_FILE_ALLOWLIST[caseId] ?? null;
}

// The PDFs are never served statically and never sit inside the frontend
// bundle or a "public" directory — this path is only ever read from disk,
// server-side, by the /api/admin/send-case-file handler below.
const CASE_FILE_DIR =
  process.env.CASE_FILE_DIR ??
  path.join(process.cwd(), "private", "case-files");

const CASE_FILE_PDFS: Record<string, string> = {
  "ats-funded": "02GrowthLab_ATS-FUNDED.pdf",
  traderlab: "02GrowthLab_TraderLab.pdf",
  "unified-proof": "02GrowthLab_Track-Record.pdf",
};

function resolveCaseFilePath(caseId: string): string | null {
  const filename = CASE_FILE_PDFS[caseId];
  return filename ? path.join(CASE_FILE_DIR, filename) : null;
}

function isValidAdminToken(candidate: unknown): boolean {
  if (typeof candidate !== "string" || candidate.length === 0) {
    return false;
  }

  const expected = Buffer.from(adminApiToken);
  const actual = Buffer.from(candidate);

  // Buffers must be equal length for timingSafeEqual; a length mismatch is
  // simply "not valid" rather than an error.
  if (expected.length !== actual.length) {
    return false;
  }

  return timingSafeEqual(expected, actual);
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
    content="dark"
  >
  <meta
    name="supported-color-schemes"
    content="dark"
  >
  <title>02Growth</title>
</head>

<body
  style="
    margin:0;
    padding:0;
    background:#0A0A0A;
    color:#F3EEE3;
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
    style="width:100%;background:#0A0A0A;"
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
            background:#121212;
            border:1px solid rgba(255,255,255,0.10);
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
                color:#9A9A9A;
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
            color:#9A9A9A;
            font-size:10px;
            line-height:1.4;
            font-weight:700;
            letter-spacing:1.4px;
            text-transform:uppercase;
            font-family:${MONO_STACK};
          "
        >
          ${escapeHtml(eyebrow)}
        </div>

        <div
          style="
            color:#F3EEE3;
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
          border-top:1px solid rgba(255,255,255,0.10);
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
                color:#9A9A9A;
                font-size:10px;
                line-height:1.5;
                font-weight:700;
                letter-spacing:1px;
                text-transform:uppercase;
                font-family:${MONO_STACK};
              "
            >
              ${escapeHtml(label)}
            </td>

            <td
              valign="top"
              style="
                color:#D8D2C4;
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
  submissionId: string,
): string {
  const replyUrl =
    `${PUBLIC_BASE_URL}/admin/reply-diagnosis` +
    `?key=${encodeURIComponent(adminApiToken)}` +
    `&id=${encodeURIComponent(submissionId)}`;

  const contactAction = `
    <a
      href="${replyUrl}"
      style="
        display:inline-block;
        padding:11px 16px;
        background:#268C28;
        color:#0A0A0A;
        text-decoration:none;
        font-size:13px;
        font-weight:700;
      "
    >
      Reply via 02Growth →
    </a>
  `;

  return emailShell(`
    <tr>
      <td
        style="
          padding:30px 32px 26px;
          background:#0A0A0A;
          border-bottom:3px solid #268C28;
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
                  color:#268C28;
                  font-size:10px;
                  line-height:1.5;
                  font-weight:700;
                  letter-spacing:1.8px;
                  text-transform:uppercase;
                  font-family:${MONO_STACK};
                "
              >
                02Growth · Diagnostic Intake
              </div>

              <div
                style="
                  margin-top:10px;
                  color:#F3EEE3;
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
                  color:#9A9A9A;
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
          background:#161616;
          border-bottom:1px solid rgba(255,255,255,0.10);
        "
      >
        <div
          style="
            margin-bottom:8px;
            color:#9A9A9A;
            font-size:10px;
            font-weight:700;
            letter-spacing:1.3px;
            text-transform:uppercase;
            font-family:${MONO_STACK};
          "
        >
          First read
        </div>

        <div
          style="
            color:#F3EEE3;
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
            color:#9A9A9A;
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
                  border-top:1px solid rgba(255,255,255,0.10);
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
          background:#0A0A0A;
          color:#9A9A9A;
          font-size:11px;
          line-height:1.6;
        "
      >
        <strong style="color:#F3EEE3;">
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
          background:#0A0A0A;
          border-bottom:3px solid #268C28;
        "
      >
        <div
          style="
            color:#268C28;
            font-size:10px;
            line-height:1.5;
            font-weight:700;
            letter-spacing:1.8px;
            text-transform:uppercase;
            font-family:${MONO_STACK};
          "
        >
          02Growth
        </div>

        <div
          style="
            margin-top:10px;
            color:#F3EEE3;
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
            color:#F3EEE3;
            font-size:15px;
            line-height:1.7;
          "
        >
          Hi ${escapeHtml(firstName)},
        </p>

        <p
          style="
            margin:0 0 18px;
            color:#D8D2C4;
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
            color:#D8D2C4;
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
            background:#161616;
            border:1px solid rgba(255,255,255,0.10);
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
                  color:#9A9A9A;
                  font-size:10px;
                  font-weight:700;
                  letter-spacing:1.2px;
                  text-transform:uppercase;
                  font-family:${MONO_STACK};
                "
              >
                What happens next
              </div>

              <div
                style="
                  margin-top:14px;
                  color:#D8D2C4;
                  font-size:14px;
                  line-height:1.75;
                "
              >
                <strong style="color:#F3EEE3;">
                  1.
                </strong>
                We review the project and the surfaces
                you submitted.
              </div>

              <div
                style="
                  margin-top:10px;
                  color:#D8D2C4;
                  font-size:14px;
                  line-height:1.75;
                "
              >
                <strong style="color:#F3EEE3;">
                  2.
                </strong>
                You will hear from us within 24 hours.
              </div>

              <div
                style="
                  margin-top:10px;
                  color:#D8D2C4;
                  font-size:14px;
                  line-height:1.75;
                "
              >
                <strong style="color:#F3EEE3;">
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
            color:#D8D2C4;
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
            border-top:1px solid rgba(255,255,255,0.10);
          "
        >
          <p
            style="
              margin:0;
              color:#F3EEE3;
              font-size:14px;
              line-height:1.65;
            "
          >
            02Growth<br>
            <span
              style="
                color:#9A9A9A;
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
/* Case file delivery (admin-triggered)                                      */
/* -------------------------------------------------------------------------- */

function buildCaseFileDeliveryEmail(
  caseName: string,
  recipientName: string,
): { html: string; text: string } {
  const firstName = recipientName.trim().split(/\s+/)[0] || "there";

  const html = emailShell(`
    <tr>
      <td
        style="
          padding:30px 32px 26px;
          background:#0A0A0A;
          border-bottom:3px solid #268C28;
        "
      >
        <div
          style="
            color:#268C28;
            font-size:10px;
            line-height:1.5;
            font-weight:700;
            letter-spacing:1.8px;
            text-transform:uppercase;
            font-family:${MONO_STACK};
          "
        >
          02Growth · Case file delivery
        </div>

        <div
          style="
            margin-top:10px;
            color:#F3EEE3;
            font-size:25px;
            line-height:1.25;
            font-weight:700;
          "
        >
          Your requested case file
        </div>
      </td>
    </tr>

    <tr>
      <td style="padding:32px;">
        <p style="margin:0 0 18px;color:#F3EEE3;font-size:15px;line-height:1.7;">
          Hi ${escapeHtml(firstName)},
        </p>

        <p style="margin:0 0 18px;color:#D8D2C4;font-size:15px;line-height:1.75;">
          Attached is the case file for <strong style="color:#F3EEE3;">${escapeHtml(caseName)}</strong>, shared privately following your access request.
        </p>

        <p style="margin:0 0 26px;color:#D8D2C4;font-size:15px;line-height:1.75;">
          This document contains client-sensitive material. Please treat it as confidential and avoid forwarding or posting it publicly.
        </p>

        <div style="padding-top:22px;border-top:1px solid rgba(255,255,255,0.10);">
          <p style="margin:0;color:#F3EEE3;font-size:14px;line-height:1.65;">
            02Growth<br>
            <span style="color:#9A9A9A;font-size:12px;">
              Diagnose before you prescribe.
            </span>
          </p>
        </div>
      </td>
    </tr>
  `);

  const text = `Hi ${firstName},

Attached is the case file for ${caseName}, shared privately following your access request.

This document contains client-sensitive material. Please treat it as confidential and avoid forwarding or posting it publicly.

02Growth
Diagnose before you prescribe.
02growth.online`;

  return { html, text };
}

/* -------------------------------------------------------------------------- */
/* Diagnosis reply (admin-triggered, personal sender identity)               */
/* -------------------------------------------------------------------------- */

function buildAdminReplyEmail(
  contactName: string,
  senderLabel: string,
  message: string,
): { html: string; text: string } {
  const firstName = contactName.trim().split(/\s+/)[0] || "there";

  const paragraphs = message
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);

  const htmlParagraphs = paragraphs
    .map(
      (paragraph) => `
        <p style="margin:0 0 18px;color:#D8D2C4;font-size:15px;line-height:1.75;">
          ${escapeHtml(paragraph).replace(/\n/g, "<br>")}
        </p>
      `,
    )
    .join("");

  const html = emailShell(`
    <tr>
      <td style="padding:30px 32px 26px;background:#0A0A0A;border-bottom:3px solid #268C28;">
        <div style="color:#268C28;font-size:10px;line-height:1.5;font-weight:700;letter-spacing:1.8px;text-transform:uppercase;font-family:${MONO_STACK};">
          02Growth
        </div>

        <div style="margin-top:10px;color:#F3EEE3;font-size:25px;line-height:1.25;font-weight:700;">
          Following up on your request
        </div>
      </td>
    </tr>

    <tr>
      <td style="padding:32px;">
        <p style="margin:0 0 18px;color:#F3EEE3;font-size:15px;line-height:1.7;">
          Hi ${escapeHtml(firstName)},
        </p>

        ${htmlParagraphs}

        <div style="padding-top:22px;border-top:1px solid rgba(255,255,255,0.10);">
          <p style="margin:0;color:#F3EEE3;font-size:14px;line-height:1.65;">
            ${escapeHtml(senderLabel)} · 02Growth<br>
            <span style="color:#9A9A9A;font-size:12px;">
              Diagnose before you prescribe.
            </span>
          </p>
        </div>
      </td>
    </tr>
  `);

  const text = `Hi ${firstName},

${paragraphs.join("\n\n")}

${senderLabel} · 02Growth
Diagnose before you prescribe.
02growth.online`;

  return { html, text };
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

    const { data: inserted, error } = await supabase
      .from("diagnosis_inquiries")
      .insert({
        ...submission,
        status: "new",
      })
      .select("id")
      .single();

    if (error || !inserted) {
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

    const submissionId = inserted.id as string;

    const clientEmail = extractEmail(
      submission.contact_method,
    );

    const emailSends: Promise<unknown>[] =
      [
        resend.emails.send({
          from: emailFrom,
          to: NOTIFICATION_EMAILS,
          subject: `New diagnosis request — ${submission.project_stage} — ${submission.contact_name}`,
          html: buildAdminEmail(
            submission,
            submissionId,
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
            background:#0A0A0A;
            border-bottom:3px solid #268C28;
          "
        >
          <div
            style="
              color:#268C28;
              font-size:10px;
              line-height:1.5;
              font-weight:700;
              letter-spacing:1.8px;
              text-transform:uppercase;
              font-family:${MONO_STACK};
            "
          >
            02Growth · Case file access
          </div>

          <div
            style="
              margin-top:10px;
              color:#F3EEE3;
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

/* -------------------------------------------------------------------------- */
/* Admin: send an approved case file privately                               */
/* -------------------------------------------------------------------------- */

const sendCaseFileSchema = z.object({
  caseId: z.string().trim().min(2).max(80),
  recipientEmail: z.string().trim().email().max(255),
  recipientName: z.string().trim().min(1).max(120).default("there"),
});

function checkAdminToken(
  request: FastifyRequest,
  reply: FastifyReply,
  token: unknown,
): boolean {
  if (isValidAdminToken(token)) {
    return true;
  }

  reply.code(401).send({
    error: {
      code: "UNAUTHORIZED",
      message: "Invalid or missing admin token.",
    },
  });

  return false;
}

app.post<{ Body: unknown }>(
  "/api/admin/send-case-file",
  async (request, reply) => {
    if (
      !checkAdminToken(
        request,
        reply,
        request.headers["x-admin-token"],
      )
    ) {
      return;
    }

    if (!allowRequest(request, reply)) {
      return;
    }

    const parsed = sendCaseFileSchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.code(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message: "Please check the recipient email and case ID.",
        },
      });
    }

    const { caseId, recipientEmail, recipientName } = parsed.data;
    const caseName = resolveCaseName(caseId);
    const filePath = resolveCaseFilePath(caseId);
    console.log(`caseId:${caseId}, caseName:${caseName}, filePath:${filePath}`);    

    if (!caseName || !filePath) {
      return reply.code(400).send({
        error: {
          code: "INVALID_CASE_ID",
          message: "Unknown case ID.",
        },
      });
    }

    let fileBuffer: Buffer;

    try {
      fileBuffer = await readFile(filePath);
    } catch (error) {
      request.log.error(
        { err: error, filePath },
        "case file PDF missing on disk",
      );

      return reply.code(500).send({
        error: {
          code: "FILE_NOT_FOUND",
          message: `PDF not found for "${caseName}". Expected it at ${filePath}.`,
        },
      });
    }

    const { html, text } = buildCaseFileDeliveryEmail(
      caseName,
      recipientName,
    );

    try {
      await resend.emails.send({
        from: emailFrom,
        to: recipientEmail,
        subject: `02Growth — Your case file: ${caseName}`,
        html,
        text,
        attachments: [
          {
            filename: path.basename(filePath),
            content: fileBuffer.toString("base64"),
          },
        ],
      });

      request.log.info(
        { caseId, recipientEmail },
        "case file delivered",
      );

      return reply.code(200).send({ ok: true });
    } catch (error) {
      request.log.error(
        { err: error },
        "case file delivery email failed",
      );

      return reply.code(502).send({
        error: {
          code: "EMAIL_FAILED",
          message: "The email failed to send. Please try again.",
        },
      });
    }
  },
);

// A single token-gated static form — not a dashboard, no accounts, no
// database. Anyone without the correct ?key= gets a flat 401. The token is
// echoed into the page only after it has already been validated below, so
// it never appears anywhere unless the visitor already had it.
app.get<{ Querystring: { key?: string } }>(
  "/admin/send-case-file",
  async (request, reply) => {
    if (!allowRequest(request, reply)) {
      return;
    }

    if (!isValidAdminToken(request.query.key)) {
      reply.code(401);
      reply.type("text/plain");
      return "Not authorized.";
    }

    const token = request.query.key ?? "";
    const options = Object.entries(CASE_FILE_ALLOWLIST)
      .map(
        ([id, name]) =>
          `<option value="${escapeHtml(id)}">${escapeHtml(name)}</option>`,
      )
      .join("");

    reply.type("text/html");

    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Send case file · 02Growth</title>
  <style>
    :root {
      --background:#0A0A0A;
      --card:#121212;
      --foreground:#F3EEE3;
      --muted:#9A9A9A;
      --primary:#268C28;
      --primary-foreground:#0A0A0A;
      --border:rgba(255,255,255,0.10);
    }
    * { box-sizing:border-box; }
    body {
      margin:0;
      min-height:100vh;
      display:flex;
      align-items:center;
      justify-content:center;
      background:var(--background);
      color:var(--foreground);
      font-family:-apple-system,BlinkMacSystemFont,'Inter','Segoe UI',Helvetica,Arial,sans-serif;
      padding:24px;
    }
    .card {
      width:100%;
      max-width:440px;
      background:var(--card);
      border:1px solid var(--border);
      padding:32px;
    }
    .eyebrow {
      font-family:'IBM Plex Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
      font-size:10px;
      font-weight:700;
      letter-spacing:1.4px;
      text-transform:uppercase;
      color:var(--muted);
      margin:0 0 8px;
    }
    h1 {
      font-size:20px;
      font-weight:700;
      margin:0 0 24px;
      line-height:1.3;
    }
    label {
      display:block;
      font-family:'IBM Plex Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
      font-size:10px;
      font-weight:700;
      letter-spacing:1px;
      text-transform:uppercase;
      color:var(--muted);
      margin:18px 0 6px;
    }
    select, input {
      width:100%;
      background:var(--background);
      border:1px solid var(--border);
      color:var(--foreground);
      padding:10px 12px;
      font-size:14px;
      font-family:inherit;
    }
    select:focus, input:focus { outline:1px solid var(--primary); }
    button {
      margin-top:24px;
      width:100%;
      background:var(--primary);
      color:var(--primary-foreground);
      border:1px solid var(--primary);
      padding:11px 16px;
      font-size:12px;
      font-weight:700;
      letter-spacing:0.8px;
      text-transform:uppercase;
      cursor:pointer;
    }
    button:disabled { opacity:0.6; cursor:default; }
    #status {
      margin-top:16px;
      padding:12px 14px;
      font-size:13px;
      font-weight:700;
      line-height:1.5;
      border:1px solid transparent;
      display:none;
    }
    #status.ok {
      display:block;
      color:var(--primary);
      background:rgba(38,140,40,0.12);
      border-color:var(--primary);
    }
    #status.err {
      display:block;
      color:#e06060;
      background:rgba(224,96,96,0.12);
      border-color:#e06060;
    }
  </style>
</head>
<body>
  <div class="card">
    <p class="eyebrow">02Growth · Internal</p>
    <h1>Send a case file</h1>

    <form id="f">
      <label for="caseId">Case</label>
      <select id="caseId" required>${options}</select>

      <label for="recipientName">Recipient name</label>
      <input id="recipientName" type="text" placeholder="Harrison" required>

      <label for="recipientEmail">Recipient email</label>
      <input id="recipientEmail" type="email" placeholder="name@company.com" required>

      <button type="submit" id="submitBtn">Send case file</button>
      <div id="status"></div>
    </form>
  </div>

  <script>
    var form = document.getElementById("f");
    var btn = document.getElementById("submitBtn");
    var status = document.getElementById("status");
    var token = ${JSON.stringify(token)};

    form.addEventListener("submit", function (event) {
      event.preventDefault();

      var caseSelect = document.getElementById("caseId");
      var caseLabel = caseSelect.options[caseSelect.selectedIndex].text;
      var recipientEmail = document.getElementById("recipientEmail").value;

      btn.disabled = true;
      btn.textContent = "Sending…";
      status.className = "";
      status.textContent = "";

      fetch("/api/admin/send-case-file", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-admin-token": token,
        },
        body: JSON.stringify({
          caseId: caseSelect.value,
          recipientName: document.getElementById("recipientName").value,
          recipientEmail: recipientEmail,
        }),
      })
        .then(function (res) {
          return res.json().then(function (data) {
            return { ok: res.ok, data: data };
          });
        })
        .then(function (result) {
          if (result.ok) {
            status.className = "ok";
            status.textContent =
              "✓ Sent — " + caseLabel + " delivered to " + recipientEmail + ".";
            form.reset();
          } else {
            status.className = "err";
            status.textContent =
              "✗ Not sent — " +
              ((result.data && result.data.error && result.data.error.message) ||
                "something went wrong.");
          }
        })
        .catch(function () {
          status.className = "err";
          status.textContent = "✗ Not sent — network error. Please try again.";
        })
        .finally(function () {
          btn.disabled = false;
          btn.textContent = "Send case file";
        });
    });
  </script>
</body>
</html>`;
  },
);

/* -------------------------------------------------------------------------- */
/* Admin: reply to a diagnosis submission under a personal sender identity   */
/* -------------------------------------------------------------------------- */

const replyDiagnosisBodySchema = z.object({
  id: z.string().trim().uuid(),
  sender: z.enum(["mayowa", "pleasure"]),
  message: z.string().trim().min(1).max(5000),
});

app.post<{ Body: unknown }>(
  "/api/admin/reply-diagnosis",
  async (request, reply) => {
    if (
      !checkAdminToken(
        request,
        reply,
        request.headers["x-admin-token"],
      )
    ) {
      return;
    }

    if (!allowRequest(request, reply)) {
      return;
    }

    const parsed = replyDiagnosisBodySchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.code(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message: "Please check the sender and message fields.",
        },
      });
    }

    const { id, sender, message } = parsed.data;
    const identity = REPLY_SENDER_IDENTITIES[sender];

    const { data: submission, error } = await supabase
      .from("diagnosis_inquiries")
      .select("contact_name, contact_method")
      .eq("id", id)
      .maybeSingle();

    if (error || !submission) {
      return reply.code(404).send({
        error: {
          code: "NOT_FOUND",
          message: "That submission could not be found.",
        },
      });
    }

    const clientEmail = extractEmail(submission.contact_method);

    if (!clientEmail) {
      return reply.code(400).send({
        error: {
          code: "NO_EMAIL",
          message: `No email address found in "${submission.contact_method}". Reply to them directly using that contact method instead.`,
        },
      });
    }

    const { html, text } = buildAdminReplyEmail(
      submission.contact_name,
      identity.label,
      message,
    );

    try {
      await resend.emails.send({
        from: identity.from,
        to: clientEmail,
        subject: "Re: Your 02Growth diagnostic request",
        html,
        text,
      });

      request.log.info(
        { id, sender },
        "diagnosis reply sent",
      );

      return reply.code(200).send({ ok: true });
    } catch (err) {
      request.log.error(
        { err },
        "diagnosis reply email failed",
      );

      return reply.code(502).send({
        error: {
          code: "EMAIL_FAILED",
          message: "The reply failed to send. Please try again.",
        },
      });
    }
  },
);

// A single token-gated static form, same pattern as /admin/send-case-file
// above: no accounts, no dashboard, a flat 401 without the correct ?key=.
app.get<{ Querystring: { key?: string; id?: string } }>(
  "/admin/reply-diagnosis",
  async (request, reply) => {
    if (!allowRequest(request, reply)) {
      return;
    }

    if (!isValidAdminToken(request.query.key)) {
      reply.code(401);
      reply.type("text/plain");
      return "Not authorized.";
    }

    const token = request.query.key ?? "";
    const submissionId = request.query.id ?? "";

    if (!/^[0-9a-f-]{36}$/i.test(submissionId)) {
      reply.code(400);
      reply.type("text/plain");
      return "Missing or invalid submission id.";
    }

    const { data: submission, error } = await supabase
      .from("diagnosis_inquiries")
      .select("contact_name, contact_role, project_stage, contact_method")
      .eq("id", submissionId)
      .maybeSingle();

    if (error || !submission) {
      reply.code(404);
      reply.type("text/plain");
      return "Submission not found.";
    }

    const clientEmail = extractEmail(submission.contact_method);

    const senderOptions = Object.entries(REPLY_SENDER_IDENTITIES)
      .map(
        ([key, identity]) =>
          `<option value="${escapeHtml(key)}">${escapeHtml(identity.label)}</option>`,
      )
      .join("");

    reply.type("text/html");

    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Reply to diagnosis · 02Growth</title>
  <style>
    :root {
      --background:#0A0A0A;
      --card:#121212;
      --foreground:#F3EEE3;
      --muted:#9A9A9A;
      --primary:#268C28;
      --primary-foreground:#0A0A0A;
      --border:rgba(255,255,255,0.10);
    }
    * { box-sizing:border-box; }
    body {
      margin:0;
      min-height:100vh;
      display:flex;
      align-items:center;
      justify-content:center;
      background:var(--background);
      color:var(--foreground);
      font-family:-apple-system,BlinkMacSystemFont,'Inter','Segoe UI',Helvetica,Arial,sans-serif;
      padding:24px;
    }
    .card {
      width:100%;
      max-width:480px;
      background:var(--card);
      border:1px solid var(--border);
      padding:32px;
    }
    .eyebrow {
      font-family:'IBM Plex Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
      font-size:10px;
      font-weight:700;
      letter-spacing:1.4px;
      text-transform:uppercase;
      color:var(--muted);
      margin:0 0 8px;
    }
    h1 {
      font-size:20px;
      font-weight:700;
      margin:0 0 8px;
      line-height:1.3;
    }
    .replying-to {
      margin:0 0 24px;
      font-size:13px;
      color:var(--muted);
      line-height:1.6;
    }
    .replying-to strong { color:var(--foreground); }
    label {
      display:block;
      font-family:'IBM Plex Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
      font-size:10px;
      font-weight:700;
      letter-spacing:1px;
      text-transform:uppercase;
      color:var(--muted);
      margin:18px 0 6px;
    }
    select, textarea {
      width:100%;
      background:var(--background);
      border:1px solid var(--border);
      color:var(--foreground);
      padding:10px 12px;
      font-size:14px;
      font-family:inherit;
      resize:vertical;
    }
    select:focus, textarea:focus { outline:1px solid var(--primary); }
    button {
      margin-top:24px;
      width:100%;
      background:var(--primary);
      color:var(--primary-foreground);
      border:1px solid var(--primary);
      padding:11px 16px;
      font-size:12px;
      font-weight:700;
      letter-spacing:0.8px;
      text-transform:uppercase;
      cursor:pointer;
    }
    button:disabled { opacity:0.6; cursor:default; }
    #status {
      margin-top:16px;
      padding:12px 14px;
      font-size:13px;
      font-weight:700;
      line-height:1.5;
      border:1px solid transparent;
      display:none;
    }
    #status.ok {
      display:block;
      color:var(--primary);
      background:rgba(38,140,40,0.12);
      border-color:var(--primary);
    }
    #status.err {
      display:block;
      color:#e06060;
      background:rgba(224,96,96,0.12);
      border-color:#e06060;
    }
    .no-email {
      margin-top:20px;
      padding:14px;
      font-size:13px;
      line-height:1.6;
      color:#e06060;
      background:rgba(224,96,96,0.12);
      border:1px solid #e06060;
    }
  </style>
</head>
<body>
  <div class="card">
    <p class="eyebrow">02Growth · Internal</p>
    <h1>Reply to diagnosis submission</h1>
    <p class="replying-to">
      Replying to <strong>${safe(submission.contact_name)}</strong>
      (${safe(submission.contact_role)}, ${safe(submission.project_stage)})
      ${
        clientEmail
          ? `— <strong>${safe(clientEmail)}</strong>`
          : ""
      }
    </p>

    ${
      clientEmail
        ? `
    <form id="f">
      <label for="sender">Send as</label>
      <select id="sender" required>${senderOptions}</select>

      <label for="message">Your reply</label>
      <textarea id="message" rows="8" placeholder="Type your reply — it'll be wrapped in the usual 02Growth email format." required></textarea>

      <button type="submit" id="submitBtn">Send reply</button>
      <div id="status"></div>
    </form>
    `
        : `
    <div class="no-email">
      No email address was found in this submission's contact method
      (“${safe(submission.contact_method)}”). Reply to them directly
      using that contact method instead — this tool can only send
      through Resend to a real email address.
    </div>
    `
    }
  </div>

  ${
    clientEmail
      ? `
  <script>
    var form = document.getElementById("f");
    var btn = document.getElementById("submitBtn");
    var status = document.getElementById("status");
    var token = ${JSON.stringify(token)};
    var submissionId = ${JSON.stringify(submissionId)};

    form.addEventListener("submit", function (event) {
      event.preventDefault();

      var senderSelect = document.getElementById("sender");
      var senderLabel = senderSelect.options[senderSelect.selectedIndex].text;
      var messageBox = document.getElementById("message");

      btn.disabled = true;
      btn.textContent = "Sending…";
      status.className = "";
      status.textContent = "";

      fetch("/api/admin/reply-diagnosis", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-admin-token": token,
        },
        body: JSON.stringify({
          id: submissionId,
          sender: senderSelect.value,
          message: messageBox.value,
        }),
      })
        .then(function (res) {
          return res.json().then(function (data) {
            return { ok: res.ok, data: data };
          });
        })
        .then(function (result) {
          if (result.ok) {
            status.className = "ok";
            status.textContent = "✓ Sent — reply delivered as " + senderLabel + ".";
            messageBox.value = "";
          } else {
            status.className = "err";
            status.textContent =
              "✗ Not sent — " +
              ((result.data && result.data.error && result.data.error.message) ||
                "something went wrong.");
          }
        })
        .catch(function () {
          status.className = "err";
          status.textContent = "✗ Not sent — network error. Please try again.";
        })
        .finally(function () {
          btn.disabled = false;
          btn.textContent = "Send reply";
        });
    });
  </script>
  `
      : ""
  }
</body>
</html>`;
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