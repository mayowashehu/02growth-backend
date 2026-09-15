# Case file PDFs (private, never served)

Drop the three approved PDFs here with these exact filenames:

- `ats-funded.pdf`
- `traderlab.pdf`
- `unified-proof.pdf`

Nothing in this directory is served statically — Fastify never registers a
static-file plugin over it. The only code path that touches these files is
`POST /api/admin/send-case-file`, which reads the file, attaches it to an
email via Resend, and sends it to whichever address you enter on the
`/admin/send-case-file?key=...` form. There is no public URL that serves
these PDFs directly.

If you deploy to Render (or similar) from this git repo, commit this
directory (with the real PDFs) so it's present at runtime — don't gitignore
it. If you'd rather not commit client PDFs to git at all, set `CASE_FILE_DIR`
to point at a persistent disk / private volume mounted at deploy time
instead, and leave this folder empty.
