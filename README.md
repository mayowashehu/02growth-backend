# 02Growth Diagnosis API

Backend service for the diagnostic intake form.

## Setup

```powershell
cd backend
npm install
Copy-Item .env.example .env
```

Set `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and `RESEND_API_KEY` in `.env`. The service uses the service-role key and Resend key only on the server, so they must never be exposed to the frontend.

Also set `ADMIN_API_TOKEN` — a long random secret (`openssl rand -hex 32`) that gates the internal case-file-sending tool below. Treat it like a password.

## Run

```powershell
npm run dev
```

The API listens on `http://127.0.0.1:4000` by default.

- `GET /health` returns `{ "ok": true }`.
- `POST /api/diagnosis` validates and stores a diagnosis inquiry.
- `POST /api/case-file-access` — a visitor requesting access to a proof card; notifies `ADMIN_EMAILS`.
- `POST /api/admin/send-case-file` — requires header `x-admin-token: <ADMIN_API_TOKEN>`. Emails one of the three case-file PDFs to a chosen recipient.
- `GET /admin/send-case-file?key=<ADMIN_API_TOKEN>` — a small self-contained form for the endpoint above. Wrong/missing `key` gets a flat 401. Bookmark the URL with your token included.

### Case file PDFs

Put the three approved PDFs in `private/case-files/` as `ats-funded.pdf`, `traderlab.pdf`, and `unified-proof.pdf` (see the README in that folder). Nothing in that directory is served statically — it's only ever read from disk by `/api/admin/send-case-file`. Override the location with `CASE_FILE_DIR` if you deploy the files elsewhere (e.g. a persistent volume).

Configure the frontend server with `DIAGNOSTIC_API_URL=http://127.0.0.1:4000`. The frontend keeps its direct Supabase implementation as a fallback when this variable is absent.

The API applies a per-IP in-memory rate limit. For multi-instance production deployments, put a shared rate limiter or gateway in front of the service.
