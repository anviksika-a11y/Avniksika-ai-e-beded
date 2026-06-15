// /api/diagnose.js  — Vercel Node.js serverless function
//
// Free, instant AI growth diagnosis for anviksika.in.
// Fetches a homepage, extracts readable content, sends it to Claude
// for a structured diagnosis, emails a copy, and returns it on-page.
//
// Setup notes:
//   npm install cheerio @upstash/redis
//
// Required environment variables (see bottom of file for full list):
//   ANTHROPIC_API_KEY
//   UPSTASH_REDIS_REST_URL
//   UPSTASH_REDIS_REST_TOKEN
//   RESEND_API_KEY        (optional — email is best-effort)
//   FROM_EMAIL            (optional — defaults below)

import * as cheerio from "cheerio";
import { Redis } from "@upstash/redis";

const redis = Redis.fromEnv(); // uses UPSTASH_REDIS_REST_URL / _TOKEN

const MODEL          = process.env.CLAUDE_MODEL || "claude-sonnet-4-6";
const RATE_LIMIT     = 3;            // diagnoses per IP
const RATE_WINDOW    = 60 * 60 * 24; // 24h in seconds
const CACHE_TTL      = 60 * 60;      // 1h cache for dup submissions
const FETCH_TIMEOUT  = 10_000;       // 10s
const MAX_STRUGGLE   = 800;          // chars sent to Claude
const MAX_SITE_TEXT  = 6000;         // chars of extracted site text
const MAX_TOKENS     = 1200;         // cap Claude output cost

const SYSTEM_PROMPT = `You are the lead growth analyst at Anviksika, a startup growth-strategy consultancy.
You diagnose a startup's homepage for positioning, messaging clarity, and conversion problems.
You are sharp, specific, and never generic. No fluff, no praise padding.

Analyze the provided homepage content (and the founder's stated struggle, if any).
Focus on: positioning clarity, message-to-market match, CTA presence/clarity, and the
single biggest thing blocking conversion.

Return ONLY valid JSON in exactly this shape, no markdown, no commentary:
{
  "working": ["2-4 short, specific bullets on what's genuinely strong"],
  "unclear": ["2-4 short, specific bullets on what's vague, missing, or confusing"],
  "fixes": [
    { "title": "Concrete prioritized fix", "rationale": "1-2 sentences on why it matters and the expected impact" }
  ]
}
Provide exactly 3 fixes, ordered by impact. Keep each bullet under 30 words.`;

function json(res, status, body) {
  res.status(status).setHeader("Content-Type", "application/json");
  res.send(JSON.stringify(body));
}

function getIp(req) {
  const xff = req.headers["x-forwarded-for"];
  return (Array.isArray(xff) ? xff[0] : (xff || "")).split(",")[0].trim()
    || req.socket?.remoteAddress || "unknown";
}

function normalizeUrl(raw) {
  try {
    const u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (!["http:", "https:"].includes(u.protocol)) return null;
    return u.toString();
  } catch { return null; }
}

async function fetchSite(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      redirect: "follow",
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; AnviksikaBot/1.0; +https://anviksika.in)",
        "Accept": "text/html,application/xhtml+xml",
      },
    });
    if (r.status === 403 || r.status === 401 || r.status === 429) return { blocked: true };
    if (!r.ok) return { error: `Site returned ${r.status}` };
    const ct = r.headers.get("content-type") || "";
    if (!ct.includes("html")) return { error: "URL is not an HTML page" };
    return { html: await r.text() };
  } catch (e) {
    if (e.name === "AbortError") return { error: "timeout" };
    return { error: "unreachable" };
  } finally {
    clearTimeout(t);
  }
}

function extractText(html) {
  const $ = cheerio.load(html);
  $("script, style, noscript, svg, iframe").remove();

  const meta = $('meta[name="description"]').attr("content")
    || $('meta[property="og:description"]').attr("content") || "";
  const title = $("title").first().text().trim();
  const headings = $("h1, h2, h3").map((_, el) => $(el).text().trim()).get();
  const ctas = $("a, button").map((_, el) => $(el).text().trim()).get()
    .filter(t => t && t.length < 40);
  const body = $("body").text().replace(/\s+/g, " ").trim();

  const parts = [
    title && `TITLE: ${title}`,
    meta && `META DESCRIPTION: ${meta}`,
    headings.length && `HEADINGS:\n- ${headings.slice(0, 30).join("\n- ")}`,
    ctas.length && `BUTTONS / LINKS:\n- ${[...new Set(ctas)].slice(0, 25).join("\n- ")}`,
    `BODY COPY:\n${body}`,
  ].filter(Boolean).join("\n\n");

  return parts.slice(0, MAX_SITE_TEXT);
}

async function callClaude(siteText, struggling) {
  const userMsg = [
    `HOMEPAGE CONTENT:\n${siteText}`,
    struggling ? `\n\nFOUNDER'S STATED STRUGGLE:\n${struggling.slice(0, MAX_STRUGGLE)}` : "",
  ].join("");

  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userMsg }],
    }),
  });

  if (!r.ok) throw new Error(`Claude API ${r.status}: ${await r.text()}`);
  const data = await r.json();
  const text = (data.content || []).map(b => b.text || "").join("").trim();

  // Be defensive: strip code fences and parse the first JSON object.
  const cleaned = text.replace(/```json|```/g, "").trim();
  const start = cleaned.indexOf("{"), end = cleaned.lastIndexOf("}");
  return JSON.parse(cleaned.slice(start, end + 1));
}

function diagnosisToHtml(d) {
  const li = (a) => (a || []).map(i => `<li>${i}</li>`).join("");
  const fixes = (d.fixes || []).map((f, i) =>
    `<p><strong>${i + 1}. ${f.title}</strong><br>
     <span style="color:#888">${f.rationale}</span></p>`).join("");
  return `
    <h2 style="color:#0D1B2A">Your Anviksika Growth Diagnosis</h2>
    <h3>What's Working</h3><ul>${li(d.working)}</ul>
    <h3>What's Unclear</h3><ul>${li(d.unclear)}</ul>
    <h3>Top 3 Fixes</h3>${fixes}
    <hr>
    <p>Want a full 18–22 page diagnostic with competitor analysis?
    <a href="https://calendly.com/anviksika/30min">Book a call →</a></p>`;
}

async function sendEmail(to, d) {
  if (!process.env.RESEND_API_KEY) return; // email is best-effort
  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: process.env.FROM_EMAIL || "Anviksika <diagnosis@anviksika.in>",
      to: [to],
      subject: "Your free growth diagnosis — Anviksika",
      html: diagnosisToHtml(d),
    }),
  }).catch(() => {}); // don't fail the request if email bounces
}

export default async function handler(req, res) {
  if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });

  const { url, email, struggling = "", manualText = "", company_website = "" } = req.body || {};

  // 1. Honeypot — silently accept then drop
  if (company_website) return json(res, 200, { diagnosis: { working: [], unclear: [], fixes: [] } });

  // 2. Basic validation
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
    return json(res, 400, { error: "A valid email is required." });
  const normUrl = normalizeUrl(url);
  if (!normUrl && !manualText)
    return json(res, 400, { error: "A valid website URL is required." });

  const ip = getIp(req);

  // 3. Cache check (dedupe by url+email)
  const cacheKey = `diag:${normUrl || "manual"}:${email.toLowerCase()}`;
  try {
    const cached = await redis.get(cacheKey);
    if (cached) return json(res, 200, { diagnosis: cached, cached: true });
  } catch {}

  // 4. Rate limit by IP
  try {
    const rlKey = `rl:${ip}`;
    const count = await redis.incr(rlKey);
    if (count === 1) await redis.expire(rlKey, RATE_WINDOW);
    if (count > RATE_LIMIT)
      return json(res, 429, { error: "Free limit reached (3 per day). Book a call for a full diagnostic." });
  } catch {} // if Redis is down, don't block users

  // 5. Get the content to analyze
  let siteText = manualText.trim();
  if (!siteText) {
    const fetched = await fetchSite(normUrl);
    if (fetched.blocked)
      return json(res, 422, { code: "SCRAPE_BLOCKED", error: "Site blocked automated reading." });
    if (fetched.error || !fetched.html)
      return json(res, 422, { error: "We couldn't reach that site. Check the URL and try again." });
    siteText = extractText(fetched.html);
    if (siteText.length < 120)
      return json(res, 422, { error: "Not enough readable content on that page to diagnose." });
  } else {
    siteText = siteText.slice(0, MAX_SITE_TEXT);
  }

  // 6. Claude
  let diagnosis;
  try {
    diagnosis = await callClaude(siteText, struggling);
  } catch (e) {
    console.error("Claude error:", e);
    return json(res, 502, { error: "The diagnosis engine is busy. Please try again shortly." });
  }

  // 7. Cache + email (best-effort, non-blocking on failure)
  try { await redis.set(cacheKey, diagnosis, { ex: CACHE_TTL }); } catch {}
  await sendEmail(email, diagnosis);

  return json(res, 200, { diagnosis });
}
