# Decisions & Architecture Reference
> **Purpose:** Answers to 10 architectural decisions. Machine-readable for Claude/Gemini agents.
> **Status:** RESEARCH COMPLETE — awaiting final user approval before implementation.
> **Last Updated:** 2026-10-26

---

## Request-1: Revised Tier Ordering

User-defined implementation order (overrides previous priority tables):

### Tier 1 (Build First)
`N5, N4, N8, N9, N15, R1, R2, R3, R10, R11, R13, R15, R9, R7, R6`
- **Note on R6 (Flight Price Watcher):** Start tracking ONLY when user explicitly requests a route. Do NOT poll on a fixed schedule. Use same on-demand trigger as A6 Price Watch (`priceWatchInitialFetchWorkflow` pattern).

### Tier 2 (Build Second)
`N14, N12, N13, R12, R14`

### Tier 3 (Build Later)
`N1, N2, N3, N10, N6, N7, N11, R5, R8, R4`

---

## Request-2: Finance Module Architecture Split

### Current CC Finance Structure
- Overview
- Bills & Expenses
- Payroll
- Projects (with bills)
- Tax & CA

### RECOMMENDED: Split into Two Finance Zones

#### Zone A — Personal Finance (Fixed Salary Employee)
- `Overview` — Net position, income vs. spend
- `Bills & Expenses` — Day-to-day spending, utility bills, subscriptions
- **Income type:** Fixed monthly salary (full-time employee). Auto-populate from payroll credit.
- **Key automations using this zone:** R1 (UPI logger), R10 (budget report), R12 (net worth), N5 (daily expense report), N9 (bill forecaster)

#### Zone B — Business/Professional Finance
- `Payroll` — Salary slips, TDS deductions (pure employment tracking)
- `Tax & CA` — ITR, advance tax, CA communication, deductible tracking
- `Projects` — Freelance or consulting invoices ONLY (if applicable)
- **Why separate:** Business/CA-level transactions have fundamentally different RLS policies, report formats, and should not mix with personal grocery spends
- **DB impact:** Add a `finance_zone` enum column (`personal | professional`) on the `transactions` table. RLS policies stay per-user but add a zone filter.

### Agent Implementation Note
When building automations, ALWAYS specify which zone you're querying:
```typescript
// Personal zone only
const expenses = await fetchExpenses(userId, { zone: 'personal' });
// Professional zone only  
const taxItems = await fetchExpenses(userId, { zone: 'professional' });
```

---

## Request-3: LLM Data Exposure Audit (STRICT PRIVACY POLICY)

### 🟢 STAYS LOCAL — Ollama Only (llama3.2:3b or similar)

These automations process sensitive personal data and MUST use local Ollama exclusively:

| Automation | Data Processed | Why Local Only |
|---|---|---|
| R1 — UPI SMS Logger | Bank amounts, merchant names, account numbers | Financial PII |
| R2 — Document Expiry | Passport, insurance, DL numbers | Identity documents |
| R3 — Birthday Bot | Contact names, relationships, personal notes | Personal contacts |
| N5 — Expense Report | Daily spending patterns, categories | Financial behavior |
| N9 — Bill Forecaster | Account balances, EMI amounts | Banking data |
| R10 — Budget Report | Category spend vs budget | Financial behavior |
| R12 — Net Worth | All account balances, loan amounts | Full financial picture |
| R11 — Habit Bot | Health habits, sleep patterns, daily routines | Personal health |
| R9 — Vehicle Tracker | Fuel, odometer, service history | Lifestyle data |
| R8 — Sleep Tracker | Sleep times, patterns | Health data |
| R5 — Medication | Medication names, dosage, family health | Medical data |
| N4 — Focus Block | Calendar events, meeting titles | Work schedule |
| N8 — Learning Check | Reading progress, learning goals | Personal development |
| R13 — Subscription | All subscription names, amounts, billing | Financial + usage |
| R7 — Grocery List | Household items, consumption patterns | Lifestyle data |
| N11 — Health Tracker | Steps, sleep, heart rate | Biometric data |
| Mail Reply drafts | Email content, sender relationships | Communications |
| Inbox Triage | Email subject, body, sender | Communications |

### 🟡 REQUIRES EXTERNAL LLM — Flag Before Use

These automations inherently need internet-sourced fresh data or significant reasoning:

| Automation | External LLM Needed | What's Sent (NO PII) | Approved LLM |
|---|---|---|---|
| A1 — Tech News | Yes | HN post titles + story text (public) | Gemini Flash or OpenAI |
| A2 — Job Feed | Yes | Job description text (public listings) | Gemini Flash |
| N1 — GitHub Standup | Partial | GitHub activity (commit messages, PR titles) | Gemini Flash for summary |
| N2 — PR Review | Yes | Code diff (no credentials, no env vars) | Gemini Flash or Claude |
| N14 — Security Alerts | No | CVE data (public) | Ollama sufficient |
| **R6 — Flight Watcher** | Yes | Route + dates ONLY (no payment info) | SerpAPI (no LLM needed) |
| **Interview Prep** | Yes | Job description + role (public info) | Gemini/Claude for research |
| **Resume Tailoring** | Partial | JD text ONLY | Local Ollama for tailoring |
| **Company Research** | Yes | Company name + role (public) | Gemini for web research |
| **Tech News Content** | Yes | GitHub commits, blog URLs (public) | Gemini Flash |
| **Reddit/LinkedIn Post** | Yes | Drafted content for review | Gemini Flash (draft only) |
| **Auto-Learner (N7 rework)** | Yes | Automation names + public docs | Gemini for research |
| **Mock Interview** | Yes | Role/tech stack info (no personal salary) | Claude or Gemini |

### 🔴 NEVER SEND EXTERNALLY
- Bank account numbers, IFSC codes, UPI IDs
- Aadhaar / PAN numbers
- Passport / DL numbers
- Insurance policy numbers
- Salary amounts, salary slips
- Personal contact phone numbers / emails
- Medical records / medication names
- Home address, travel itinerary (hotel booking refs, PNR)

### Implementation Rule for Agents
```typescript
// Before calling any external LLM, validate no PII in payload:
const EXTERNAL_LLM_SAFE_CHECK = [
  'no_account_numbers', 'no_aadhaar_pan', 'no_medical_data',
  'no_contact_pii', 'no_home_address', 'no_financial_amounts'
];
// Use Ollama for all personal/sensitive data processing
// Use Gemini/Claude API only for public-data research tasks
```

---

## Request-4: Multi-Gmail Account Architecture

### Account Routing Map (User Defined)

| Gmail Account | Purpose | Automations That Use It |
|---|---|---|
| Personal Gmail (Account A) | Personal expenses, insurance, bills, general mail | A5 (Inbox Triage), R1 (UPI SMS), R2 (doc expiry), R14 (travel bookings) |
| Job Hunt Gmail (Account B) | Job listings, recruiter emails, interview scheduling | A2 (Job Feed), A3 (Interview Prep), A4 (Calendar Sync), N2 (PR Review — job email) |
| Work/Company Gmail (Account C) | Company meetings, GitHub notifications, work calendar | N4 (Focus Block), A0 (Morning Brief calendar), N1 (GitHub Standup) |
| (Future) Finance Gmail | Bank alerts, credit card statements (if separate) | R1 (UPI SMS ingestion extension) |

### Implementation Architecture

```typescript
// In CC credentials store — each Gmail integration needs a label/type
type GmailIntegration = {
  id: string;
  email: string;
  purpose: 'personal' | 'job_hunt' | 'work' | 'finance';
  scopes: string[];
  historyId: string; // for incremental sync
};

// Each workflow MUST specify which account purpose to use
// DO NOT mix account types in a single workflow
const emailsToTriage = await fetchGmailMessages(
  integrations.filter(i => i.purpose === 'personal')
);
```

### DB Change Required
- Add `purpose` column to `gmail_integrations` (or equivalent integration table)
- Each automation's schedule config stores `gmail_purpose: string`
- Inbox triage workflow must fan out per account — separate runs, separate histories

---

## Request-5: Notification Channel Decision

### FINAL DECISION (User Q2 answer)
- **Slack stays as primary** for ALL automations, all tiers.
- Telegram / Discord / Mobile App NOT implemented now.
- **Architecture mandate:** Build a `NotificationChannel` abstraction layer so adding Telegram/Discord/mobile later requires zero workflow changes.

### NotificationChannel Abstraction

All workflows call a single `sendNotification()` activity, NEVER Slack SDK directly.

```typescript
// services/automations-worker/src/activities/notify.ts
export type NotificationChannel = 'slack' | 'telegram' | 'discord' | 'push';

export interface NotificationPayload {
  text: string;
  blocks?: SlackBlock[];        // Slack-specific (ignored by other channels)
  buttons?: ActionButton[];     // Rendered as inline keyboard on Telegram, buttons on Slack
  metadata?: Record<string, unknown>;
}

export async function sendNotification(
  userId: string,
  payload: NotificationPayload,
  channel: NotificationChannel = 'slack'  // default for now; config-driven later
): Promise<void> {
  switch (channel) {
    case 'slack':    return sendSlackNotification(userId, payload);
    case 'telegram': return sendTelegramNotification(userId, payload); // add later
    case 'discord':  return sendDiscordNotification(userId, payload);  // add later
    case 'push':     return sendPushNotification(userId, payload);     // add later
  }
}
```

**Workflow usage:**
```typescript
// Workflows never import Slack SDK directly
await activities.sendNotification(userId, {
  text: 'Your morning brief is ready.',
  blocks: morningBriefBlocks,
}, 'slack');
```

**Config-driven channel selection (future):**
- Add `notification_channel` column to user settings table
- `sendNotification()` reads this and routes accordingly
- No workflow code changes needed when adding a new channel

### Comparison Summary (for reference)

| Channel | Cost | Setup | Mobile UX | Bi-directional | History |
|---|---|---|---|---|---|
| **Slack** | Free (90d limit) | High | Good | Excellent (Block Kit) | 90 days |
| **Discord** | Free forever | Medium | Good | Good | Unlimited |
| **Telegram** | Free forever | 30 seconds | Excellent | Excellent (inline keyboard) | Unlimited |
| **Custom App** | High (infra + store) | Massive | Perfect | Unlimited | Unlimited |
| **ntfy.sh (self-hosted)** | Free | Low | Good | One-way only | Self-managed |

### RECOMMENDED ARCHITECTURE: Dual Channel

#### Primary: Keep Slack (for now)
- All existing automations (A0–A10) use Slack Block Kit
- Human-in-loop approvals (trash proposal, mail reply review) use Temporal Slack Updates
- Switching to another channel now = high migration cost with no immediate value

#### Future Phase: Add Telegram as Second Channel
- Telegram Bot API: Create once via @BotFather, use for bidirectional quick inputs
- Use cases: R7 (grocery list), R8 (sleep log), R9 (vehicle log), R11 (habit check-in)
- Reason: These need quick mobile inputs (1–2 message interactions), not rich cards
- Pattern: Temporal Update waits for Telegram reply (same as Slack approval pattern)
- **Config flag per automation:** `channel: 'slack' | 'telegram' | 'both'`

#### Long-Term: Custom Mobile App (Phase 3+)
- Worth building after 20+ automations are stable and the UX patterns are proven
- Stack recommendation: React Native (shares code with web app) + Expo
- Key feature: Critical alert bypass (Medication, insurance expiry, bill overdraft)
- Use **ntfy.sh** (self-hosted) as a bridge until the app is built — it gives push notifications without building a full app

### Decision for Now
1. **Keep Slack** as primary for all existing + new Tier 1/2 automations
2. **Add Telegram Bot** for Tier 1 input-heavy automations (R7, R8, R9, R11)
3. **Plan Mobile App** as a Phase 3 goal, after web UI redesign is done

---

## Request-6: UI/UX Redesign Plan

### Recommended Design Direction
Based on the app's nature (personal command center, data-heavy, automation management), the best approach is a **hybrid** of:

**Primary: Bento Grid + Glassmorphism** (most suitable for data dashboards)
**Secondary: Spatial UI depth** (for overlays, modals, and panel navigation)
**Accent: Selective Neumorphism** (for interactive toggles, status indicators)

Avoid: Full Skeuomorphism (too heavy), Brutalism (wrong tone), Maximalism (too cluttered for a control panel)

### Page-by-Page Redesign Plan

#### Phase 1 — Core Navigation & Overview (Bento + Glass)
- **Dashboard (Home):** Bento grid — large morning brief card, smaller automation status tiles, finance snapshot, upcoming calendar mini-widget
- **Automations Page:** Card list with status badge, schedule indicator, last-run time, and a toggle switch (Neumorphic style)
- **Finance Overview:** Split Zone A / Zone B toggle at top. Bar/sparkline charts in glass cards.

#### Phase 2 — Specialized Pages (Spatial + Bento)
- **Inbox Triage Review:** Spatial layering — pending approvals float as panels over the background
- **Job Hunt Dashboard:** Pipeline view (Kanban-style) — Applications, Interviews, Offers
- **Calendar View:** Full weekly/monthly view with focus blocks highlighted
- **Habits & Health:** Streak rings, sleep charts, habit heatmap (GitHub-style)

#### Phase 3 — Advanced Features (Full Spatial)
- **Automation Builder:** Visual workflow editor (nodes/edges) — Spatial depth, draggable
- **Personal Brand Studio:** LinkedIn + Reddit post queue, content calendar
- **Mobile App** (Phase 3+)

### Design Tokens to Establish First
```css
/* Before any page implementation, lock these */
--bg-base: #090d14;
--surface: #111827;
--glass-bg: rgba(255,255,255,0.04);
--glass-border: rgba(255,255,255,0.08);
--glass-blur: blur(12px);
--bento-gap: 16px;
--radius-card: 18px;
--accent-primary: #6366f1;
--accent-success: #10b981;
--accent-warn: #f59e0b;
--accent-danger: #ef4444;
```

---

## Request-7: Auto-Learner Automation (Reworked A8)

### New Concept: "Automater" — Self-Improving Automation Agent

Replace the current A8 (Learning Digest) logic with a smarter agent:

#### What Automater Does
1. **Weekly scan** of all active automations in the system
2. For each automation, pulls from:
   - GitHub repos of relevant libraries (Temporal.io, Ollama, Bun)
   - Reddit r/selfhosted, r/homeautomation, r/MachineLearning, r/programming
   - Official changelogs and release notes
   - Hacker News (top story filtering)
3. **Analyzes** whether any improvement applies to the existing automation implementation
4. **Drafts an improvement proposal** — not auto-applies — with:
   - What changed (library version, better API, new model)
   - Impact: performance, cost, accuracy
   - Risk: breaking change? schema migration needed?
5. Sends a Slack card for human review + approval

#### Privacy Rule
- Automater only reads **automation definitions** (workflow names, activity names, library versions)
- Does NOT read user data, emails, expenses
- External LLM used: Gemini Flash (for research synthesis, public info only)
- Local Ollama for drafting the improvement proposal text

#### Workflow ID: `automaterWorkflow`
- **Schedule:** Every Sunday at 10:00 IST (or triggered manually)
- **New activities:** `scanInstalledLibraryVersions()`, `researchImprovements(automation, version)`, `draftImprovementProposal(automation, findings)`, `postImprovementToSlack(proposals)`

---

## Request-8: Job Hunt & Interview Pipeline (Complete Redesign)

### Full Pipeline (in order)

#### Stage 1: Job Discovery
- **Sources:** Naukri, Indeed, LinkedIn, Glassdoor, AngelList/Wellfound, company career pages
- **Method:** `JobSpy` (open-source Python library) wrapped as a local microservice
  - JobSpy handles LinkedIn, Indeed, Glassdoor, Naukri scraping in one unified API
  - Self-hosted: runs as a local FastAPI service called by the Temporal activity
  - No official API needed — scraper handles anti-bot rotation
- **Alternative for blocked sites:** SerpAPI (Google Jobs) — sends only search query, no PII
- **Deduplication:** Track by job URL hash in `job_listings` table
- **External LLM:** Gemini Flash — scores job fit against master profile (JD keywords vs skills)

#### Stage 2: Resume Tailoring + ATS Check
- **Tool:** `Resume-Matcher` or `JobGlove` (open-source, self-hosted via Docker)
- **Input:** Master resume (stored in CC as Markdown/JSON) + Job Description
- **ATS Check:** Local PDF parser checks keyword density, section headers, formatting
- **Tailoring:** Local Ollama rewrites specific sections to match JD keywords
- **Output:** Tailored PDF + ATS score + gap report
- **Privacy:** Resume and JD processed locally. NEVER sent to external LLM.

#### Stage 3: Company Research
- **Input:** Company name + job title (PUBLIC info only)
- **External LLM:** Gemini with web search enabled — researches:
  - Company size, funding, tech stack, Glassdoor rating
  - Recent news, product launches, engineering blog posts
  - Interview culture from Reddit/Glassdoor (aggregated public reviews)
- **Output:** Company research card stored in CC `job_research` table

#### Stage 4: Mock Interview Preparation
- **Basis:** Previous interview data from A3 + A4 (rounds, tech stack used)
- **Input to external LLM:** Role name, tech stack, company type (no salary, no PII)
- **External LLM:** Claude Sonnet or Gemini — generates mock Q&A specific to role+stack
- **Delivery:** Slack with interview question set (10–15 questions)
- **Mock Interview Mode:** Interactive Slack thread — user answers, LLM scores each response

#### Stage 5: Scoring & Decision Gate
- After mock interview, calculate overall readiness score (0–100)
- **Score < 60:** Auto-suggest prep resources, re-schedule mock in 3 days
- **Score 60–80:** Human review card — "Proceed to apply?" with Yes/Later buttons
- **Score > 80:** Auto-suggest applying. Prepare application tracking entry.

#### New Automation: `jobHuntPipelineWorkflow`
- Replaces the scattered A2/A3 automations with a unified pipeline
- All 5 stages run as sequential Temporal activities with human checkpoints

---

## Request-9: WhatsApp Access — Decision

### Hard Limitation (Cannot Change)
Meta does **not** provide any official API to read personal WhatsApp chat history.
Using unofficial wrappers (Baileys, Puppeteer-based) risks **permanent WhatsApp account ban**.
This is a hard technical constraint, not just a policy preference.

### Best Alternatives (Ranked)

#### Option A: Android Notification Listener (RECOMMENDED for Phase 1)
- **How:** Android Tasker app + AutoNotification plugin reads incoming WA notification text
- **What's captured:** Message preview text only (first ~200 chars as it appears in notification)
- **Privacy:** Stays 100% local on device. Nothing leaves your phone.
- **Limitation:** Cannot access chat history, only real-time incoming messages
- **What you get:** "Summary of unread messages received today" — good enough for 80% of use cases
- **Action:** Tasker sends summary to your Telegram bot → CC receives it as a daily Slack post

#### Option B: WhatsApp Business API (Self-hosted) — ONLY for sending yourself messages
- Create a second number on Meta Cloud API → use as a personal notification channel
- Can't read personal chats, but you can send yourself formatted notifications FROM your automations
- Useful for: critical alerts, reminders sent to your personal WA number
- Not useful for reading/summarizing existing chats

#### Option C: Signal or Telegram (Best Long-term Alternative)
- Ask family/important contacts to move to Telegram or Signal
- Both have full open APIs for reading + drafting messages
- Telegram MTProto API can read your own messages, create summaries, and auto-reply
- **Realistic?** Ask close family for critical threads. Others stay on WA.

### Final Decision
- **Now:** Accept WA limitation. Use notification listener for real-time capture.
- **Phase 2:** Implement Telegram bot as second notification channel — gradually migrate important group chats there.
- **Do NOT** use unofficial WA libraries. Risk of permanent account ban outweighs the benefit.

---

## Request-10: Reddit + LinkedIn Personal Brand Automation

### Architecture: Content Engine

#### Content Sources (Inputs)
1. GitHub commits and PR summaries (from N1 standup data)
2. Hacker News + tech blog RSS (from A1 news workflow)
3. Bugs/solutions from your own work (manual input via Slack command)
4. Automater improvement proposals (R&D content from Request-7)

#### Content Pipeline
1. **Ideation:** Ollama scans recent GitHub activity + news → identifies "interesting story"
2. **Drafting:** External LLM (Gemini Flash) drafts LinkedIn post + Reddit post (different tone)
   - LinkedIn: Professional, structured, career/architecture angle
   - Reddit: Technical depth, honest, community-focused, zero self-promotion
3. **Human Review (MANDATORY):** Both drafts sent to Slack for approval before any posting
4. **Scheduling:** Random interval posting (NOT fixed schedule)

#### Random Interval Strategy
```typescript
// LinkedIn: 2–5 posts per week, randomized within weekdays 9am–12pm IST
// Reddit: 1–3 posts per week, randomized across different subs + times
// NEVER post LinkedIn and Reddit on the same day (avoid pattern detection)

const linkedinInterval = randomBetween(2, 5) * DAYS; // days gap between posts
const redditInterval = randomBetween(3, 7) * DAYS;   // wider gap for Reddit
const postTime = randomBetween(9, 14) * HOURS;       // random time within window
```

#### LinkedIn Automation: `linkedinContentWorkflow`
- **Trigger:** Temporal cron with random jitter (not fixed schedule)
- **API:** LinkedIn Official API (requires LinkedIn Developer Application approval)
- **Approval:** ALWAYS human-in-loop before posting
- **Content types:** Text posts, article shares, code snippet carousels

#### Reddit Automation: `redditContentWorkflow`
- **Important:** Reddit has strict anti-spam policies. Key rules:
  - Never post the same content twice
  - Post in relevant subreddits only (r/selfhosted, r/programming, r/webdev, r/india)
  - Post ratio: 80% contributing (comments/discussions) to 20% own posts
  - Use `PRAW` (Python Reddit API Wrapper) — requires a registered Reddit App
  - **Approval:** ALWAYS human-in-loop before posting (never auto-post)
- **Wrapper:** PRAW as a local microservice (similar to JobSpy)

#### Target Subreddits for Technical Expert Positioning
| Subreddit | Content Type | Posting Frequency |
|---|---|---|
| r/selfhosted | Automation tutorials, self-hosted tools | 1-2x/month |
| r/webdev | Architecture posts, debugging stories | 1-2x/month |
| r/programming | Engineering insights, code analysis | 1x/month |
| r/india | Tech career insights, finance automations | 1x/month |
| r/devops | CI/CD, infrastructure posts | 1x/month |

---

## Summary: External Services Required (New Integrations)

| Service | Purpose | Data Sent | Privacy Risk |
|---|---|---|---|
| Gemini Flash API | Research, content drafting, job scoring | Public info ONLY | Low |
| Claude API (optional) | Mock interview, complex reasoning | Role/tech stack only | Low |
| JobSpy (local) | Job scraping | No data sent externally | Zero |
| SerpAPI | Google Flights / Google Jobs | Route/query only | Low |
| PRAW (local) | Reddit API wrapper | Post content (reviewed) | Low |
| Resume-Matcher (local) | ATS check | Local only | Zero |
| LinkedIn API | Post scheduling | Approved content only | Low |
| Telegram Bot API | Input channel | Message text | Low |

---

## Q1–Q7 Final Answers (CLOSED)

| Q# | Answer |
|---|---|
| Q1 — Finance split timing | **Option A — Do it now.** Cleaner long-term, fewer migration headaches later. |
| Q2 — Telegram automations | **Hold. Slack for all automations.** But build NotificationChannel abstraction so adding channels later needs zero workflow changes. |
| Q3 — WhatsApp listener | **Not implementing.** No official API = no implementation. |
| Q4 — JobSpy vs SerpAPI | **Use `fast-flights` (open-source, free) for flights.** For jobs: `JobSpy` primary. SerpAPI as paid fallback if scraping breaks. |
| Q5 — Reddit approval flow | **Yes — always human-approval before posting. Never auto-post.** |
| Q6 — Mobile App timing | **After current automations are stable.** Do not parallelize web + mobile work. |
| Q7 — API keys | **BYOK — user provides own API keys.** Store in `user_credentials` (pgcrypto) same as existing OpenAI/SerpAPI pattern. |

---

## Additional Architecture Decisions (Round 2)

---

## KB-1: Knowledge Base Tab — Rename + What It Actually Is

### Current State (scanned from codebase)

There are **two separate knowledge systems** in the app — they serve very different purposes:

#### System 1: `kb_commands` (route: `/api/kb/commands`)
- **What it stores:** CLI commands, git commands, terminal snippets, multi-line scripts
- **UI tab label:** "Knowledge Base" at route `/knowledge`
- **DB table:** `kb_commands` (title, command_text, context, notes, comments, attachments)
- **Current use:** Manual copy-paste command reference. Like a personal TIL/cheatsheet.
- **Used by automations?** No. Zero automation reads `kb_commands`.

#### System 2: `knowledge_items` (route: `/api/knowledge-items`)
- **What it stores:** Typed knowledge entries — `note | journal | brief | news | profile | job | job_lead | prep | lesson | snippet`
- **DB table:** `knowledge_items` (title, body, tags, source, source_id, tsvector search, embedding vector, metadata)
- **Used by automations?** YES — extensively:
  - A6 (Learning) writes `lesson` and `brief` type items
  - A2 (Jobs) writes `brief` items
  - A7 (Profile) reads/writes `profile` items
  - Embedder fills `embedding` column for semantic search
  - Profile Drafts page reads `type=profile` items
  - Interviews page reads linked knowledge items

### Recommended Renames

| Current Name | Rename To | Reason |
|---|---|---|
| "Knowledge Base" tab (sidebar nav) | **"Command Vault"** or **"Dev Snippets"** | It stores commands and code snippets — not a knowledge base in the traditional sense |
| `kb_commands` table | Leave as-is (internal) | No migration needed |
| `knowledge_items` table | Leave as-is (it's already well-named) | |

**Nav file change needed:**
```typescript
// apps/web/lib/nav-items.ts
// Current:
{ href: "/knowledge", label: "Knowledge Base", icon: BookOpen }
// Change to:
{ href: "/knowledge", label: "Command Vault", icon: Terminal }
```

### The REAL Knowledge Base Architecture (what should exist)

The `knowledge_items` system is the real knowledge base. But it needs a user-facing home. Currently it's only accessed indirectly via Learning, Jobs, and Profile Drafts pages.

**Proposed:** Add a dedicated **"My Knowledge"** or **"Brain"** page at `/brain` that gives you a unified view into `knowledge_items` with:
- Full text search (tsvector already built)
- Filter by type (note, brief, profile, lesson, snippet, job)
- Semantic search (once embeddings fill up)
- Manual entry of personal facts automations can use (e.g., "My current tech stack: TypeScript, Bun, Temporal, Postgres")
- This is the source of truth automations query when they need personal context

### Knowledge Items That Automations Need (Context Store)

For new automations to work well without asking you the same questions repeatedly, we need to populate certain `knowledge_item` types:

```
type=profile   → Technical profile (skills, years of exp, preferred roles, salary range)
type=profile   → Personal profile (city, daily routine, family, lifestyle preferences)  
type=note      → Vehicle info (make, model, year, registration number) for R9
type=note      → Insurance policies (type, insurer, policy #, expiry) for R2
type=note      → Budget limits by category for R10
type=snippet   → Resume master copy (Markdown) for Job Hunt pipeline
```

All of these can be entered via the new "My Knowledge" / "Brain" page. Automations then query:
```typescript
// Example in any automation activity:
const profile = await cc.searchKnowledgeItems({ type: 'profile', query: 'technical skills' });
// Uses tsvector + embedding for best match — no LLM lookup needed
```

---

## KB-2: Parallel Processing in Temporal Workflows

### Current State

All existing automations (A0–A11) execute activities sequentially. Example from morning brief:
```
fetchCalendar() → fetchNews() → fetchExpenses() → buildBrief() → sendSlack()
```

### Can We Parallelize? YES — Temporal Supports This Natively

Two patterns available:

#### Pattern 1: `Promise.all` — Parallel Activities (Use for most cases)

```typescript
// workflows/morning-brief.ts — BEFORE (sequential, ~8–12 sec total)
const calendar  = await activities.fetchCalendar(userId);
const news      = await activities.fetchTopNews(userId);
const expenses  = await activities.fetchTodayExpenses(userId);
const weather   = await activities.fetchWeather(userId);
const brief     = await activities.buildBrief({ calendar, news, expenses, weather });

// AFTER (parallel, ~3–4 sec — all 4 fetch in parallel)
const [calendar, news, expenses, weather] = await Promise.all([
  activities.fetchCalendar(userId),
  activities.fetchTopNews(userId),
  activities.fetchTodayExpenses(userId),
  activities.fetchWeather(userId),
]);
const brief = await activities.buildBrief({ calendar, news, expenses, weather });
```

**Rules for safe parallelism:**
- Activities must be **independent** (no output of A needed as input to B)
- Each activity still gets its own Temporal event history
- Cap at 10–20 parallel activities max per batch (avoid history bloat)
- Catch errors inside the map, not outside, so one failure doesn't kill all

#### Pattern 2: Child Workflows — Fan-out for Large Scale

Used when you need isolated retry/history per item (e.g., process 50 job listings independently):

```typescript
// workflows/job-hunt-pipeline.ts
// Fan out: one child workflow per high-scored job
const highScoreJobs = jobs.filter(j => j.fitScore > 70);
await Promise.all(
  highScoreJobs.map(job =>
    wf.executeChild('jobApplicationWorkflow', {
      args: [{ userId, jobId: job.id }],
      workflowId: `job-app-${job.id}`,
    })
  )
);
```

### Which Automations to Parallelize (Priority List)

| Automation | Current | After Parallelization | Est. Speedup |
|---|---|---|---|
| **A0 Morning Brief** | Sequential fetch (8–12s) | `Promise.all` all 4 fetches | 3–4s (3x faster) |
| **Job Hunt — Stage 1** | Sequential portal scraping | `Promise.all` across Naukri/Indeed/LinkedIn | 4x faster |
| **Job Hunt — Stage 3** | One company research | Fan-out per shortlisted job | N jobs in 1 round |
| **Automater** | Sequential scan per automation | `Promise.all` research per automation | Linear to constant |
| **R2 Doc Expiry** | Sequential check per doc | `Promise.all` check all docs | Near-instant |
| **Inbox Triage (A5)** | Sequential per email | Batch of 5 emails in parallel | 5x faster |

### Rules to Follow (Temporal Safety)

```typescript
// SAFE: independent parallel activities
const [a, b, c] = await Promise.all([actA(), actB(), actC()]);

// SAFE: error isolation — one failure doesn't kill the batch
const results = await Promise.all(
  items.map(async (item) => {
    try { return await processItem(item); }
    catch (e) { return { id: item.id, error: String(e) }; }
  })
);

// UNSAFE: more than ~50 parallel activities in one workflow — hits history limits
// SOLUTION: chunk into batches of 10-20
for (let i = 0; i < items.length; i += 20) {
  await Promise.all(items.slice(i, i + 20).map(processItem));
}

// UNSAFE: passing large arrays as child workflow args
// SOLUTION: pass IDs/offsets only, child fetches its own data
await wf.executeChild('processChunk', { args: [{ offset: 100, limit: 50 }] });
```

**Existing code to update:** Open a separate task to migrate A0 (Morning Brief) to parallel fetch pattern as a quick win — it's the most-run automation.

---

## KB-3: Automations That Should NOT Use LLM (Write Custom Code Instead)

### Rationale
Ollama (llama3.2:3b) with CPU inference can use 2–4 CPU cores per call and take 3–8 seconds on Apple Silicon. For simple deterministic tasks, this is wasteful. Custom code is faster, cheaper (zero CPU spike), and more reliable (no hallucination risk).

### Audited List — LLM NOT Needed

| Automation | LLM Currently Planned | Replace With | Why |
|---|---|---|---|
| **R2 — Document Expiry Tracker** | ❌ None needed | Pure date math: `daysUntilExpiry = differenceInDays(expiryDate, today)` | Threshold comparison, no language understanding needed |
| **R10 — Weekly Budget Report** | ❌ None needed | SQL aggregation: `SUM(amount) GROUP BY category` + simple percentage calc | Pure arithmetic, no natural language |
| **R12 — Monthly Net Worth** | ❌ None needed | SQL: `SUM(assets) - SUM(liabilities)` | Pure arithmetic |
| **R13 — Subscription Tracker** | ❌ None needed | Date math: `renewalDate - today <= 3` | Simple threshold check |
| **R9 — Vehicle Fuel Tracker** | ⚠️ Partial | LLM only for parsing natural-language Slack input ("filled 40L at ₹106"). Calculations (km/L, service due) = pure math | Split: parse input with Ollama, compute with code |
| **R5 — Medication Refill** | ❌ None needed | `Math.floor(stockRemaining / dailyDose)` | Pure arithmetic |
| **R11 — Habit Check-In (tracking)** | ❌ None needed | DB writes: `INSERT INTO habit_logs`. Streak = `COUNT consecutive days`. | Pure logic — LLM only for the motivational message when streak breaks |
| **N9 — Bill Forecaster** | ⚠️ Partial | LLM only for natural-language summary of risk. Calculations (overdraft risk, next bill dates) = pure math | Split: calculate with code, summarize with Ollama |
| **N5 — Daily Expense Report** | ⚠️ Partial | SQL for totals/categories. LLM only for the 2-sentence narrative at the bottom of the Slack card | Minimal LLM call (50 tokens, not 500) |
| **R3 — Birthday Reminder** | ⚠️ Partial | Date check = pure code. LLM only for: gift suggestions + personalised message draft | Mandatory LLM for the creative output only |
| **R15 — Morning Affirmation** | ✅ LLM required | Single prompt call — but keep it 20-token output max | Creative task — needs LLM |
| **N14 — Security Alerts** | ❌ None needed | GitHub Dependabot API → filter severity >= HIGH → Slack message | API + filter, no language understanding |
| **N4 — Focus Block Protector** | ❌ None needed | Calendar event title matching: `isFocusBlock(title) → setSlackDND(duration)` | Pattern matching with a small string list, no LLM |
| **R8 — Sleep Tracker (logging)** | ⚠️ Partial | LLM for parsing "slept at 11:30, woke at 6:45" → structured `{bedtime, wakeTime}`. Stats (avg, drift) = pure math | Ollama for NLP parse only |

### Summary Table — LLM Decision Per Automation

| Automation | LLM Decision | What LLM Does (if used) | What Code Does |
|---|---|---|---|
| R2, R10, R12, R13, R5, N14, N4 | 🚫 No LLM | — | Pure date/math/SQL |
| R11 (tracking) | 🚫 No LLM | — | DB writes, streak count |
| R11 (streak break msg) | ✅ Minimal Ollama | 1 motivational sentence | — |
| N9, N5 | ⚠️ Minimal Ollama | 2–3 sentence narrative | All calculations in SQL/code |
| R3 | ⚠️ Moderate Ollama | Gift ideas + message draft | Date math for reminder timing |
| R9, R8 | ⚠️ Minimal Ollama | Natural-language parse only | All math in code |
| R15, R7, R1 (classify) | ✅ Ollama | Core of the feature | Supporting code |
| Job Pipeline, Automater, Social Content | ✅ Ollama + External | Core intelligence | Scaffolding + DB |

### Implementation Rule for Agents
> **Before adding any Ollama call, ask: "Could this be a SQL query, date math, or a string comparison?"**
> If yes → write custom code. Reserve LLM for: NLP parsing of free text, content generation, research, classification.

---

## KB-4: SerpAPI Alternative for Flight Price Watching (R6)

### Decision: Use `fast-flights` (Open Source, Free)

`fast-flights` is a Python library that reverse-engineers Google Flights' internal Protobuf API. Zero cost, no API key, self-hosted.

**Stack:**
- Library: `fast-flights` (Python, GitHub: search `Anmoldureha/flights-skill` / `fast-flights`)
- Wrapper: FastAPI microservice (same pattern as JobSpy for job scraping)
- Runs locally alongside the worker
- Called from a Temporal activity via HTTP

```python
# local-services/flights/main.py
from fastapi import FastAPI
from fast_flights import FlightData, Passengers, create_filter, get_flights

app = FastAPI()

@app.get("/flights")
def check_price(origin: str, dest: str, date: str):
    filter = create_filter(
        flight_data=[FlightData(date=date, from_airport=origin, to_airport=dest)],
        trip="one-way",
        seat="economy",
        passengers=Passengers(adults=1),
    )
    result = get_flights(filter)
    return {
        "price": result.current_price,
        "currency": result.currency,
        "flights": [{"airline": f.name, "price": f.price} for f in result.flights[:3]]
    }
```

```typescript
// Temporal activity — calls local FastAPI
async function checkFlightPrice(origin: string, dest: string, date: string) {
  const res = await fetch(`http://localhost:8001/flights?origin=${origin}&dest=${dest}&date=${date}`);
  return res.json();
}
```

**Fallback:** If `fast-flights` Protobuf endpoint breaks (Google updates), SerpAPI as paid fallback. SerpAPI key already in `user_credentials` pattern (BYOK).

---
