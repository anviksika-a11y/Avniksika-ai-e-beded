# Anviksika — Free AI Growth Diagnosis

## What changed
- `index.html`: hero card now links to a new "Free AI Growth Diagnosis" section
  (id="diagnosis") placed right after the marquee. It contains a form
  (website URL, optional "what are you struggling with", email + honeypot)
  that posts to `/api/diagnose` and renders the result inline, styled to
  match the existing navy/gold theme.
- `api/diagnose.js`: Vercel serverless function. Fetches the submitted site,
  extracts readable text, sends it to Claude for a structured diagnosis,
  caches/dedupes via Upstash Redis, rate-limits by IP, and emails a copy
  via Resend (optional/best-effort).

This is fully free and self-serve — no approval step, no payment.

## Required environment variables (set in Vercel → Project → Settings → Environment Variables)

| Variable | Required | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | Yes | Your Claude API key |
| `CLAUDE_MODEL` | No | Defaults to `claude-sonnet-4-6` |
| `UPSTASH_REDIS_REST_URL` | Yes | From Upstash Redis dashboard |
| `UPSTASH_REDIS_REST_TOKEN` | Yes | From Upstash Redis dashboard |
| `RESEND_API_KEY` | No | If unset, email step is skipped silently |
| `FROM_EMAIL` | No | Defaults to `Anviksika <diagnosis@anviksika.in>` — must be a verified Resend sender/domain |

## Deploy notes (Vercel)
1. Push this folder to a GitHub repo.
2. Import the repo into Vercel.
3. Add the environment variables above.
4. Create a free Upstash Redis database (Vercel Marketplace → Upstash, or upstash.com directly)
   and copy its REST URL + token into the env vars.
5. (Optional) Set up Resend, verify your sending domain (`anviksika.in`), set `RESEND_API_KEY`
   and `FROM_EMAIL`. Without this, diagnoses still work and display on-page — just no email copy.
6. Deploy. The form on the homepage posts to `/api/diagnose` automatically — no extra wiring needed.

## Abuse controls already in place
- 3 diagnoses per IP per 24h (Redis-backed; fails open if Redis is down so users aren't blocked)
- Honeypot field (`company_website`) — bots that fill it get a silent empty response
- 10s fetch timeout on the target site
- Max 1200 output tokens per Claude call
- Cached result for 1h on duplicate (same URL + email) submissions
- Graceful fallback message if a site blocks scraping (403/401/429)

## Things to keep an eye on
- The 3-per-IP limit is easy to bypass with IP rotation. If abuse becomes a real problem,
  the next cheapest step is requiring email verification (magic link) before generating —
  that kills most throwaway submissions cheaply.
- Resend's free tier and sending-domain verification can take a little time to propagate —
  test with a real email before relying on it.
