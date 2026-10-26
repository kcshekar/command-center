# New Automation Proposals

> **Purpose:** Curated list of candidate automations for the Command Center platform.
> Each entry is rated on Daily Usage frequency and Implementation Complexity.
> **Status:** PROPOSAL — not yet filtered or approved for implementation.

---

## Rating System

- **Usage Score** (1-10): How often a developer/person would benefit daily
- **Complexity** (L/M/H): Low = few activities, Medium = multi-step LLM, High = new integrations needed
- **Fit Score** (1-10): How naturally it fits the existing Temporal + Ollama + CC architecture

---

## Tier 1 — High Daily Impact (Must Have)

### N1 — GitHub Activity Standup Bot
- **Usage:** 9/10 | **Complexity:** L | **Fit:** 10/10
- **What:** Every morning at 08:50 IST (before standup), query GitHub API for yesterday's activity (commits, PRs opened/merged, issues closed, reviews). LLM drafts 3-bullet standup summary → Slack.
- **Why now:** Developers waste 10–15 min daily digging through GitHub history. Zero new integrations — GitHub API is public, Ollama already in stack.
- **Workflow:** `githubStandupWorkflow`
- **Schedule:** Daily at 08:50 IST
- **New activities:** `fetchGitHubActivity(userLogin, lookbackHours)`, `draftStandupSummary(rawActivity)`
- **Integration:** GitHub REST API (public, no OAuth needed for public repos; PAT for private)
- **New CC scope needed:** None (posts to Slack via existing `slack:send`)

### N2 — PR Auto-Review Bot
- **Usage:** 8/10 | **Complexity:** M | **Fit:** 9/10
- **What:** When a PR is opened/updated in watched repos, fetch the diff, send to Ollama with a code review prompt, post findings as a Slack message (not GitHub comment — avoids noise). Flags: unhandled errors, missing tests, console.logs, security red flags.
- **Why now:** Catches shallow issues before human review. Ollama keeps it private.
- **Workflow:** `prReviewWorkflow` (triggered by GitHub webhook → CC → Temporal)
- **Trigger:** Webhook (not scheduled) — CC receives GitHub webhook, starts workflow
- **New activities:** `fetchPRDiff(repoOwner, repo, prNumber, token)`, `reviewCodeWithLLM(diff, rules)`
- **Integration:** GitHub REST API, GitHub Webhooks → CC

### N3 — Slack Brain-Dump → GitHub Issue Creator
- **Usage:** 8/10 | **Complexity:** M | **Fit:** 8/10
- **What:** User sends a messy natural-language message to a specific Slack channel (e.g., `#brain-dump`). Bot parses it via Ollama, extracts: title, description, acceptance criteria, labels, priority. Creates a structured GitHub Issue and replies with a link.
- **Why now:** Eliminates the "I'll file this later" problem. No new infra — uses existing Slack integration.
- **Workflow:** `slackIssueDumperWorkflow`
- **Trigger:** Slack event webhook → CC → Temporal
- **New activities:** `parseSlackMessageToIssue(text)`, `createGitHubIssue(params, token)`

### N4 — Focus Block Protector (Calendar → DND)
- **Usage:** 9/10 | **Complexity:** L | **Fit:** 7/10
- **What:** Hourly scan of Google Calendar. If a "Deep Work" / "Focus" / "DND" event starts in the next 15 min, automatically set Slack status to 🎯 and enable Do Not Disturb via Slack API. Clears DND when the event ends.
- **Why now:** Developers lose focus context from Slack pings during flow state. Google Calendar + Slack already integrated.
- **Workflow:** `focusBlockWorkflow`
- **Schedule:** Every 15 min (piggyback on `inbox-triage-every-15m` cadence)
- **New activities:** `checkUpcomingFocusEvents(userEmail)`, `setSlackDND(token, durationMinutes)`, `clearSlackStatus(token)`
- **New integration:** Slack User Token (for DND API)

### N5 — Daily Expense Auto-Categorization Report
- **Usage:** 8/10 | **Complexity:** L | **Fit:** 10/10
- **What:** Every evening at 21:00, pull all today's expenses from CC finance module, run LLM to suggest better categories for any uncategorized ones, and post a clean daily spend summary to Slack. Includes anomaly detection ("Spent 3x usual on food today").
- **Why now:** The expense ingestion (A5) already auto-creates expenses. This closes the loop with a daily review.
- **Workflow:** `dailyExpenseReportWorkflow`
- **Schedule:** Daily at 21:00 IST
- **New activities:** `fetchTodayExpenses(userId)`, `categorizePendingExpenses(expenses)`, `detectSpendingAnomalies(expenses, history)`
- **New CC scope:** `expenses:read`

---

## Tier 2 — High Value, Weekly/Moderate Frequency

### N6 — Changelog & Release Notes Generator
- **Usage:** 7/10 | **Complexity:** M | **Fit:** 8/10
- **What:** When a PR is merged to `main`, aggregate all merged PRs since the last git tag. LLM sorts into user-facing features, bug fixes, and internal refactors. Posts clean markdown changelog draft to Slack and opens a PR to update `CHANGELOG.md`.
- **Why now:** Writing changelogs is universally avoided. Already have GitHub integration pattern from N2.
- **Workflow:** `changelogGeneratorWorkflow`
- **Trigger:** GitHub merge webhook
- **New activities:** `fetchMergedPRsSinceTag(repo, tag)`, `generateChangelog(prs)`, `openChangelogPR(content, repo)`

### N7 — Sentry / Error Digest
- **Usage:** 7/10 | **Complexity:** M | **Fit:** 7/10
- **What:** Hourly, fetch recent Sentry errors, cluster similar ones, identify who recently touched the file (via Git blame + GitHub API), format a smart Slack card: "3 new NullRefs in auth.ts → suspected: your PR #412". Button to create hotfix branch.
- **Why now:** Raw Sentry noise is unactionable. Clustering + blame attribution turns alerts into work items.
- **Workflow:** `errorDigestWorkflow`
- **Schedule:** Every hour
- **New activities:** `fetchSentryErrors(token, project)`, `clusterErrors(errors)`, `attributeToAuthor(file, repo)`
- **New integration:** Sentry API (new BYOK credential)

### N8 — Weekly Learning Goal Progress Check
- **Usage:** 7/10 | **Complexity:** L | **Fit:** 10/10
- **What:** Every Friday evening, compare the week's ingested learning items (A8) against the user's stated learning goals. LLM drafts a "what you learned this week" recap and a "what's missing" nudge. Posts to Slack.
- **Why now:** A8 already ingests content but never closes the feedback loop. This is a cheap add-on.
- **Workflow:** `weeklyLearningCheckWorkflow`
- **Schedule:** Every Friday at 19:00 IST
- **New activities:** `fetchWeekLearningItems(userId, daysBack: 7)`, `draftProgressReport(items, goals)`
- **New CC scope:** `learning:read` (already in ALL_SCOPES)

### N9 — Smart Bill / EMI Due Forecaster
- **Usage:** 7/10 | **Complexity:** L | **Fit:** 10/10
- **What:** Every Sunday, fetch next 30 days of reminders (bills + EMIs), pull account balances from CC, compute if current balances cover upcoming obligations. If shortfall detected, Slack an alert.
- **Why now:** A5 auto-creates bill reminders but no proactive cash-flow check exists.
- **Workflow:** `billForecastWorkflow`
- **Schedule:** Every Sunday at 10:00 IST
- **New activities:** `fetchUpcomingBills(userId, daysAhead: 30)`, `fetchAccountBalances(userId)`, `computeCashflowRisk(bills, balances)`
- **New CC scope:** `finance:read`

### N10 — GitHub PR Review Nudger
- **Usage:** 6/10 | **Complexity:** L | **Fit:** 9/10
- **What:** Daily check: fetch all open PRs across watched repos where you are a requested reviewer but haven't reviewed. Slack a reminder with PR titles, age, and author. Escalates if PR is >24h old.
- **Why now:** PRs stall because reviewers forget. Simple GitHub API poll.
- **Workflow:** `prReviewNudgeWorkflow`
- **Schedule:** Daily at 10:00 IST
- **New activities:** `fetchPendingReviews(userLogin, token)`, `formatPRNudge(prs)`

---

## Tier 3 — Specialist / Personal Use Case

### N11 — Health & Habit Tracker (Google Fit / Apple Health export)
- **Usage:** 8/10 | **Complexity:** H | **Fit:** 5/10
- **What:** Daily: pull step count, sleep hours, and active minutes from Google Fit API. Compare against goals. Post to Slack morning brief as a health section. Warn if sleep < 6h.
- **Why now:** Developers often track health separately from their daily brief. Merging reduces context switching.
- **Complexity note:** Google Fit API is deprecated → alternative is Apple Health export or Garmin Connect API.
- **New integration:** Google Fit (deprecated) or Garmin Connect API

### N12 — Automated Tax Document Organizer
- **Usage:** 5/10 | **Complexity:** M | **Fit:** 8/10
- **What:** Monthly (on the 5th), fetch all finance records from CC, categorize by tax type (business vs personal), compute running totals for deductible expenses. Email a structured summary for CA/accountant.
- **Why now:** Finance module already tracks expenses. Building on CC's CA invoice/email infrastructure.
- **Workflow:** `taxDocumentWorkflow`
- **Schedule:** 5th of each month at 09:00 IST
- **New activities:** `fetchTaxPeriodExpenses(userId, month)`, `categorizeTaxItems(expenses)`, `draftTaxSummaryEmail(summary)`

### N13 — Meeting Preparation Agent
- **Usage:** 6/10 | **Complexity:** M | **Fit:** 7/10
- **What:** 30 minutes before each calendar meeting, fetch event details + attendees, research their GitHub/LinkedIn, pull any relevant notes from CC Knowledge Base, draft a "pre-meeting brief" in Slack.
- **Why now:** Morning brief already fetches calendar. Adding prep research is a natural extension.
- **Workflow:** `meetingPrepWorkflow` (triggered by calendar sync activity)
- **Trigger:** Scheduled check every 30 min
- **New activities:** `researchAttendees(attendees)`, `fetchRelevantKBNotes(topic)`, `draftMeetingBrief(...)`

### N14 — Dependency Security Alert Watcher
- **Usage:** 7/10 | **Complexity:** L | **Fit:** 8/10
- **What:** Daily: query GitHub's Dependabot alerts API for critical/high vulnerabilities in watched repos. Slack a prioritized list with CVE scores and suggested fix versions.
- **Why now:** A11 scans for upgrades monthly but misses security urgency. Dependabot data is free via GitHub API.
- **Workflow:** `securityAlertWorkflow`
- **Schedule:** Daily at 09:30 IST
- **New activities:** `fetchDependabotAlerts(repos, token)`, `prioritizeAlerts(alerts)`

### N15 — Daily Weather & Commute Brief Add-on
- **Usage:** 7/10 (for non-remote workers) | **Complexity:** L | **Fit:** 6/10
- **What:** Inject weather + AQI data into the morning brief (A0). If rain or bad AQI, add a 🌧️ warning. If work-from-office day detected on calendar, add commute traffic estimate.
- **Why now:** Easy add-on to existing morning brief workflow. OpenWeatherMap API is free.
- **New activities:** `fetchWeatherAQI(lat, lon)`, `checkCommuteTraffic(origin, dest)`
- **New integration:** OpenWeatherMap API (free tier), Google Maps Distance Matrix API

---

## Tier 4 — Regular User Automations (Non-Developer)

> These automations serve **anyone** — not just developers. They focus on everyday life: personal finance, family coordination, health, shopping, documents, and lifestyle. All fit the same Temporal + Ollama + CC architecture and send notifications via Slack or (with extension) a Telegram/WhatsApp bot.

### R1 — UPI / Bank SMS Expense Auto-Logger
- **Usage:** 10/10 | **Complexity:** L | **Fit:** 10/10
- **Audience:** Everyone who uses UPI (GPay, PhonePe, Paytm)
- **What:** Parse incoming bank/UPI SMS notifications (forwarded via Gmail or a Telegram bot). Extract: amount, merchant, category, account. Auto-create CC expense record. Zero manual entry.
- **Why it matters:** Indians make 10–30 UPI transactions/day. Manual logging is abandoned within a week. This closes that loop.
- **Workflow:** `upiSmsIngestionWorkflow`
- **Trigger:** Gmail poll (every 15 min) for SMS-forwarded bank alerts, or Telegram photo/message webhook
- **LLM use:** Ollama extracts amount + merchant from unstructured SMS text (e.g., "Paid Rs.450 to Swiggy via HDFC Bank UPI")
- **New activities:** `parseUpiSms(text)`, `detectBankSender(from)`
- **New CC scope:** `expenses:write` (already exists in A5)

### R2 — Document & Policy Expiry Tracker
- **Usage:** 9/10 | **Complexity:** L | **Fit:** 9/10
- **Audience:** Everyone with a vehicle, passport, insurance, or licenses
- **What:** User registers documents in CC with expiry dates (vehicle insurance, PUC certificate, driving license, passport, health insurance). System sends Slack reminders at 60d, 30d, 15d, 7d, and 1d before expiry. Critical docs (insurance lapse) get a daily nudge in final 3 days.
- **Why it matters:** Insurance lapses, passport renew delays, and PUC non-compliance are common pain points. Calendar-based tracking is error-prone.
- **Workflow:** `documentExpiryWorkflow`
- **Schedule:** Daily at 09:00 IST
- **New CC module:** `document_registry` table (id, name, type, expires_on, user_id) — or extend `reminders` with a `document` category
- **New activities:** `fetchExpiringDocuments(userId, withinDays: 60)`, `formatDocumentAlert(doc, daysLeft)`
- **Note:** Reminders module already exists in CC. This is a thin extension.

### R3 — Birthday & Anniversary Reminder with Gift Suggestions
- **Usage:** 9/10 | **Complexity:** L | **Fit:** 8/10
- **Audience:** Everyone
- **What:** Store contacts + their important dates (birthday, anniversary, work anniversary) in CC. 7 days before: Slack reminder with AI-generated gift ideas based on the person's age/relationship/notes. On the day: auto-draft a warm WhatsApp/SMS message for approval before sending.
- **Why it matters:** Missing birthdays damages relationships. Generic "Happy Birthday" feels lazy. AI-drafted message + gift nudge = thoughtful on autopilot.
- **Workflow:** `birthdayReminderWorkflow`
- **Schedule:** Daily at 08:00 IST
- **LLM use:** Ollama generates contextual gift ideas ("She's 30, loves reading, works in finance — suggest 3 gift ideas")
- **New CC module:** `contact_occasions` table (contact_name, relationship, occasion_type, date, notes)
- **New activities:** `fetchUpcomingOccasions(userId, daysAhead: 7)`, `generateGiftIdeas(person)`, `draftOccasionMessage(person, occasion)`

### R4 — Weekly Family Logistics Digest
- **Usage:** 8/10 | **Complexity:** L | **Fit:** 7/10
- **Audience:** Parents, families with school-going kids
- **What:** Every Sunday evening, compile the upcoming week's events across all family members' calendars (via multiple Google OAuth accounts). Deduplicate, sort by day. Send a single clean "Week Ahead" summary to a shared Slack channel or WhatsApp group.
- **Why it matters:** Family scheduling is fragmented across 3–4 calendars. Sunday chaos = missed events.
- **Workflow:** `familyDigestWorkflow`
- **Schedule:** Every Sunday at 19:00 IST
- **Multi-user:** Scans multiple Google Calendar accounts (multiple OAuth tokens)
- **New activities:** `fetchMultipleCalendars(userEmails[], daysAhead: 7)`, `deduplicateEvents(allEvents)`, `formatFamilyDigest(events)`

### R5 — Medication & Supplement Refill Alert
- **Usage:** 8/10 | **Complexity:** L | **Fit:** 9/10
- **Audience:** Anyone on regular medication, supplements, or prescriptions — especially for elderly family members
- **What:** User registers medication with daily dosage + initial pill count. System tracks estimated remaining supply (count - days * dose). When < 7-day supply remains, Slack alert with the drug name and suggested order. Also alerts if dosage hasn't been logged (habit-check).
- **Why it matters:** Medication gaps are a real health risk, especially for elders. Manual pill counting is forgotten.
- **Workflow:** `medicationRefillWorkflow`
- **Schedule:** Daily at 20:00 IST (post-dinner check)
- **New CC module:** `medication_tracking` table (name, daily_dose, current_count, last_logged_at, user_id)
- **New activities:** `checkMedicationLevels(userId)`, `calculateDaysRemaining(med)`, `alertLowStock(med, daysLeft)`

### R6 — Flight & Hotel Price Drop Watcher
- **Usage:** 8/10 | **Complexity:** M | **Fit:** 8/10
- **Audience:** Frequent travellers, vacation planners
- **What:** User adds a travel route + date range to CC. System polls Google Flights (via SerpAPI or Skyscanner API) daily. When price drops below user-set threshold or by more than 15% from first-seen price, Slack alert with "Book now" link.
- **Why it matters:** Flight prices fluctuate 3–5x per day. Manual checking leads to either panic-buying or missing deals. The A6 price-watch pattern is already built for Amazon — reuse it for flights.
- **Workflow:** `flightPriceWatchWorkflow`
- **Architecture:** Exactly like A6 (Price Watch). Reuse `priceWatchInitialFetchWorkflow` pattern with a new `fetchFlightPrice` activity.
- **New activities:** `fetchFlightPrice(origin, dest, date, apiKey)`, `comparePriceToBaseline(current, baseline, threshold)`
- **New CC module:** `travel_watches` table (origin, destination, travel_date, threshold_price, user_id)
- **New integration:** SerpAPI (Google Flights scraper) or Skyscanner BYOK API

### R7 — Smart Grocery & Shopping List Manager
- **Usage:** 8/10 | **Complexity:** M | **Fit:** 7/10
- **Audience:** Households, families
- **What:** User voice-notes or messages items to add ("we're out of daal and oil") to a Telegram/Slack bot. Ollama parses the message, adds to a running CC grocery list. Every Saturday morning, system compiles the full list, groups by category (vegetables, grains, dairy), and sends to Slack/WhatsApp. Optionally integrates with Blinkit/BigBasket URLs.
- **Why it matters:** Grocery lists are scattered across WhatsApp messages, sticky notes, and memory. A central smart list removes friction.
- **Workflow:** `groceryListWorkflow`
- **Trigger:** Slack/Telegram message webhook (add items) + Saturday 08:00 cron (send compiled list)
- **LLM use:** Ollama parses natural language ("we need two packets of Aashirvaad atta and Amul butter") into structured items
- **New CC module:** `grocery_list` table (item, quantity, category, added_at, purchased, user_id)

### R8 — Sleep & Wake Routine Tracker
- **Usage:** 8/10 | **Complexity:** L | **Fit:** 6/10
- **Audience:** Health-conscious users, anyone trying to fix their sleep
- **What:** User logs bedtime/wake time via a quick Slack message ("slept at 11:30, woke at 6:45"). System tracks running weekly average, detects drift, and sends a weekly sleep score report. If sleep < 6h is detected 3 days in a row → Slack health warning.
- **Why it matters:** Sleep is the foundation of productivity. Most people don't track it until there's a crisis.
- **Workflow:** `sleepTrackerWorkflow`
- **Trigger:** Slack message webhook (log sleep) + weekly Sunday morning report
- **LLM use:** Parse natural language time expressions ("around midnight", "slept at 12-ish")
- **New CC module:** `sleep_logs` table (bedtime, wake_time, duration_mins, quality_score, logged_at, user_id)

### R9 — Vehicle Service & Fuel Cost Tracker
- **Usage:** 8/10 | **Complexity:** L | **Fit:** 9/10
- **Audience:** Car/bike owners (very relevant in India)
- **What:** User logs fuel fill-ups ("filled 40L at Rs.106/L, odometer 45230") via Slack message. System tracks: fuel efficiency (km/L trend), service intervals (every 5000km or 6 months), and monthly fuel cost. Monthly Slack report. Alert when service is due.
- **Why it matters:** Most people don't track fuel efficiency or know when their service is due. Rs. 3000–5000/month in fuel is worth monitoring.
- **Workflow:** `vehicleTrackerWorkflow`
- **Trigger:** Slack message webhook (log fuel/service) + monthly report cron
- **LLM use:** Parse fuel log entries from natural language
- **New CC module:** `vehicle_logs` table (vehicle_id, type: fuel|service|tyre, odometer, amount, date, notes, user_id)
- **New activities:** `computeFuelEfficiency(vehicleId, lastNFills)`, `detectServiceDue(vehicle)`, `generateVehicleReport(vehicleLogs)`

### R10 — Weekly Spending vs Budget Report
- **Usage:** 9/10 | **Complexity:** L | **Fit:** 10/10
- **Audience:** Anyone trying to manage their money
- **What:** User sets monthly budgets by category (food: ₹8000, travel: ₹5000, shopping: ₹3000). Every Friday, system pulls all logged expenses (from A5/R1 ingestion), compares actuals to prorated weekly budget, and sends a Slack report: "Food: ₹3200 / ₹4000 budget (80%) — on track. Shopping: ₹2800 / ₹1500 (186%) — over budget ⚠️"
- **Why it matters:** People track expenses but never get a clear picture against budget. This is the missing visualization loop.
- **Workflow:** `weeklyBudgetReportWorkflow`
- **Schedule:** Every Friday at 20:00 IST
- **New CC module:** `budget_limits` table (category, monthly_amount, currency, user_id)
- **New activities:** `fetchExpensesByCategory(userId, from, to)`, `computeBudgetVariance(actuals, budgets)`, `formatBudgetReport(...)`

### R11 — Habit Check-In Bot (Evening Reflection)
- **Usage:** 8/10 | **Complexity:** L | **Fit:** 7/10
- **Audience:** Anyone building habits (exercise, reading, no-sugar, etc.)
- **What:** Every evening at 21:00, Slack bot sends a quick check-in: "Did you: ✅ Exercise? ✅ Read 20 pages? ✅ No junk food?" User replies with ✅/❌ or a quick note. System tracks streaks, sends weekly streak summary on Sundays. Losing a streak = motivational Ollama-drafted nudge.
- **Why it matters:** Habit apps get abandoned. A Slack bot that's already open = zero friction logging.
- **Workflow:** `habitCheckinWorkflow`
- **Schedule:** Daily at 21:00 IST (check-in) + Sunday 09:00 IST (streak report)
- **New CC module:** `habits` table + `habit_logs` table (habit_id, logged_at, completed, note, user_id)
- **Human-in-loop:** Uses Temporal Update pattern (same as inbox triage) — wait for user Slack reply, then record

### R12 — Monthly Net Worth Snapshot
- **Usage:** 7/10 | **Complexity:** L | **Fit:** 10/10
- **Audience:** Anyone with savings, investments, loans
- **What:** On the 1st of each month, fetch all CC accounts (bank, credit card, loan, investment balances from finance module). Compute: total assets - total liabilities = net worth. Show month-over-month change. Post to Slack. Over time, builds a net worth trend.
- **Why it matters:** Most people have no idea what their net worth is. CC already has all the account data — this just surfaces it.
- **Workflow:** `netWorthSnapshotWorkflow`
- **Schedule:** 1st of month at 08:00 IST
- **New CC scope:** `finance:read` (accounts + balances)
- **New activities:** `fetchAllAccountBalances(userId)`, `computeNetWorth(assets, liabilities)`, `compareToLastMonth(current, lastSnapshot)`
- **New CC module:** `net_worth_history` table (snapshot_date, assets_cents, liabilities_cents, net_worth_cents, user_id)

### R13 — Subscription & SIP Tracker
- **Usage:** 8/10 | **Complexity:** L | **Fit:** 9/10
- **Audience:** Everyone (Indians increasingly spend on Netflix, Hotstar, Spotify, mutual fund SIPs)
- **What:** User registers recurring subscriptions and SIPs (name, amount, billing date, frequency). System tracks: total monthly outflow from subscriptions, upcoming renewal alerts (3 days before), and annual cost summary. Flags subscriptions not used in the last 30 days (based on bank SMS activity).
- **Why it matters:** Average Indian has 4–6 subscriptions they've forgotten about. "Subscription creep" is real.
- **Workflow:** `subscriptionTrackerWorkflow`
- **Schedule:** Daily renewal check + monthly summary on 25th of month
- **New CC module:** `subscriptions` table (name, amount_cents, billing_day, frequency, last_used, user_id)
- **New activities:** `fetchRenewingSubscriptions(userId, daysAhead: 3)`, `detectUnusedSubscriptions(userId, smsActivity)`

### R14 — Travel Itinerary Organizer (Gmail → CC)
- **Usage:** 7/10 | **Complexity:** M | **Fit:** 8/10
- **Audience:** Frequent travellers
- **What:** Extension of A5 inbox triage. Add a new email category `travel_booking` to Ollama classifier. When a flight/hotel/train booking confirmation email is detected, auto-parse booking reference, dates, travel details, and create a CC `travel_booking` record. Before the trip, send a Slack "trip pack" 24h before departure.
- **Why it matters:** Gmail is full of booking confirmations but they're hard to find when needed. This creates a travel record automatically.
- **Workflow:** Extend `inboxTriageWorkflow` with `travel_booking` category + new `travelPackWorkflow`
- **LLM use:** Ollama extracts: flight number, PNR, hotel name, check-in/out, booking ref from email body
- **New activities:** `parseBookingEmail(email)`, `createTravelRecord(params)`, `buildTripPack(bookings, datesAhead: 1)`
- **New CC module:** `travel_bookings` table

### R15 — Daily Positive Affirmation & Quote (Morning Add-on)
- **Usage:** 7/10 | **Complexity:** L | **Fit:** 6/10
- **Audience:** General users wanting a mindfulness nudge
- **What:** Add to the morning brief: an Ollama-generated personalised affirmation or motivational quote tailored to the day's context (if many meetings → "Deep focus beats busy work". If Monday → "Strong start to the week"). Keeps the morning brief feeling warm and human.
- **Why it matters:** Many users want a bit of positivity in their morning digest. Trivial to add but high perceived value.
- **Implementation:** Add as an optional section in `morningBriefWorkflow` — new `generateDailyAffirmation(dayContext)` activity
- **Cost:** Near-zero — one small Ollama prompt per day

---

## Implementation Priorities (Suggested Order)

### Developer Automations
| Priority | ID | Name | Justification |
|---|---|---|---|
| 1 | N1 | GitHub Standup Bot | Highest daily value, lowest complexity, zero new integrations |
| 2 | N5 | Daily Expense Report | Closes A5 feedback loop, all infrastructure exists |
| 3 | N8 | Learning Progress Check | Closes A8 feedback loop, minimal new code |
| 4 | N9 | Bill/EMI Forecaster | Closes A5 bill reminder loop with finance data |
| 5 | N4 | Focus Block Protector | High daily impact, only needs Slack User Token |
| 6 | N14 | Security Alert Watcher | Low complexity, high developer value |
| 7 | N10 | PR Review Nudger | Simple poll, immediate team benefit |
| 8 | N2 | PR Auto-Review Bot | Medium complexity, webhook trigger needed |
| 9 | N3 | Slack Brain-Dump → Issue | Medium complexity, webhook trigger needed |
| 10 | N6 | Changelog Generator | Medium complexity, great for active projects |

### Regular User Automations
| Priority | ID | Name | Justification |
|---|---|---|---|
| 1 | R1 | UPI/Bank SMS Logger | 10M+ UPI transactions daily in India — highest daily value |
| 2 | R2 | Document Expiry Tracker | Insurance/PUC lapses are painful — CC reminders module already exists |
| 3 | R10 | Weekly Budget Report | Expenses are already ingested — surfacing them vs budget is cheap |
| 4 | R12 | Monthly Net Worth Snapshot | All account data exists in CC finance module |
| 5 | R3 | Birthday/Anniversary Bot | High emotional value, low complexity |
| 6 | R5 | Medication Refill Alert | Critical for elder care, simple to build |
| 7 | R11 | Habit Check-In Bot | Slack-native, Temporal Update pattern already mastered |
| 8 | R13 | Subscription Tracker | "Subscription creep" is money being wasted silently |
| 9 | R9 | Vehicle Tracker | Very India-relevant — fuel + service tracking in one place |
| 10 | R8 | Sleep Tracker | Foundational health metric, natural-language log via Slack |
| 11 | R6 | Flight Price Watcher | Direct reuse of A6 price-watch architecture |
| 12 | R7 | Grocery List Manager | Family utility — Slack/Telegram webhook needed |
| 13 | R4 | Family Logistics Digest | Multi-account Google Calendar needed |
| 14 | R14 | Travel Itinerary Organizer | Extend A5 inbox triage |
| 15 | R15 | Morning Affirmation | Nice-to-have, trivial to add to morning brief |

---

## Decisions to Make Before Implementation

1. **GitHub PAT storage** — Store as BYOK in CC credentials (same as Adzuna/Keepa) or as a first-class integration?
2. **Webhook triggers vs polling** — N2, N3, N6 need inbound webhooks. Does CC have a webhook receiver module? If not, do we add one to `apps/api`?
3. **Slack User Token** — N4 needs DND API which requires a user-level token (not bot). Where does this live?
4. **Multi-user vs single-user** — Current automations are mostly single-owner. Do new automations need per-user config?
5. **New DB tables in automations DB** — N1 needs a `github_activity_cursors` table (same pattern as `gmail_history_cursors`).
6. **Regular user new tables** — R1–R15 need new CC module tables. Add as new migrations to `apps/api/migrations/` or keep in `services/automations-worker/migrations/`?
7. **Telegram/WhatsApp as second notification channel** — R7, R8, R11 benefit from a chat-bot interface. Should we extend CC to support Telegram bot as a second delivery channel alongside Slack?

