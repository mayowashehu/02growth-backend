# 02Growth Diagnosis API

Backend service for the diagnostic intake form.

## Setup

```powershell
cd backend
npm install
Copy-Item .env.example .env
```

Set `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and `RESEND_API_KEY` in `.env`. The service uses the service-role key and Resend key only on the server, so they must never be exposed to the frontend.

## Run

```powershell
npm run dev
```

The API listens on `http://127.0.0.1:4000` by default.

- `GET /health` returns `{ "ok": true }`.
- `POST /api/diagnosis` validates and stores a diagnosis inquiry.

Configure the frontend server with `DIAGNOSTIC_API_URL=http://127.0.0.1:4000`. The frontend keeps its direct Supabase implementation as a fallback when this variable is absent.

The API applies a per-IP in-memory rate limit. For multi-instance production deployments, put a shared rate limiter or gateway in front of the service.
