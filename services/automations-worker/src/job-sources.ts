// A2 — job source adapters. One function per source, uniform JobCandidate.
//
// Adzuna + SerpAPI + JSearch — each adapter does its own BYOK and returns the
// uniform shape so the ingest activity can fan out across whichever ones have
// credentials.

export interface JobCandidate {
  source: string;         // 'adzuna'
  sourceId: string;       // adzuna's id as string
  title: string;
  company: string | null;
  location: string | null;
  url: string;
  salaryMin: number | null;
  salaryMax: number | null;
  currency: string | null;
  salaryPeriod: string | null;    // 'yearly' | NULL
  description: string | null;
  postedAt: string | null;         // ISO
  meta?: Record<string, unknown>;
}

const ADZUNA = "https://api.adzuna.com/v1/api/jobs";

export async function fetchAdzunaJobs(input: {
  appId: string;
  appKey: string;
  country?: string;              // 'in', 'us', 'gb', ...
  what: string;                   // keywords, space-separated
  where?: string;                 // city/region
  resultsPerPage?: number;
  salaryMin?: number;             // in local currency
}): Promise<JobCandidate[]> {
  const country = (input.country ?? "in").toLowerCase();
  const params = new URLSearchParams({
    app_id: input.appId,
    app_key: input.appKey,
    results_per_page: String(input.resultsPerPage ?? 25),
    what: input.what,
    "content-type": "application/json",
  });
  if (input.where) params.set("where", input.where);
  if (input.salaryMin && input.salaryMin > 0) params.set("salary_min", String(Math.round(input.salaryMin)));

  const url = `${ADZUNA}/${country}/search/1?${params.toString()}`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`adzuna ${res.status}: ${body.slice(0, 200)}`);
  }
  const body = (await res.json()) as {
    results?: Array<{
      id?: string | number; title?: string; redirect_url?: string;
      company?: { display_name?: string };
      location?: { display_name?: string; area?: string[] };
      salary_min?: number; salary_max?: number; salary_is_predicted?: string;
      description?: string; created?: string; category?: { label?: string };
      contract_type?: string; contract_time?: string;
    }>;
  };
  const out: JobCandidate[] = [];
  for (const r of body.results ?? []) {
    if (!r.id || !r.title || !r.redirect_url) continue;
    out.push({
      source: "adzuna",
      sourceId: String(r.id),
      title: r.title.trim(),
      company: r.company?.display_name ?? null,
      location: r.location?.display_name ?? null,
      url: r.redirect_url,
      salaryMin: typeof r.salary_min === "number" ? r.salary_min : null,
      salaryMax: typeof r.salary_max === "number" ? r.salary_max : null,
      currency: null,                    // Adzuna doesn't echo currency; infer from country caller-side
      salaryPeriod: "yearly",            // Adzuna returns annualized values
      description: r.description ? r.description.slice(0, 1200) : null,
      postedAt: r.created ?? null,
      meta: {
        category: r.category?.label, contractType: r.contract_type, contractTime: r.contract_time,
        salaryIsPredicted: r.salary_is_predicted === "1",
      },
    });
  }
  return out;
}

// SerpAPI's google_jobs endpoint — aggregates Indeed/LinkedIn/ZipRecruiter.
// Needs a paid plan but gives wide coverage.
export async function fetchSerpApiJobs(input: {
  apiKey: string;
  what: string;
  where?: string;
  resultsPerPage?: number;
  country?: string;             // 'in', 'us', ...
}): Promise<JobCandidate[]> {
  const q = input.where ? `${input.what} ${input.where}` : input.what;
  const params = new URLSearchParams({
    engine: "google_jobs",
    q,
    api_key: input.apiKey,
    hl: "en",
  });
  // Country location bias — SerpAPI uses `gl` for Google-locale.
  if (input.country) params.set("gl", input.country.toLowerCase());

  const res = await fetch(`https://serpapi.com/search.json?${params.toString()}`);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`serpapi ${res.status}: ${body.slice(0, 200)}`);
  }
  const body = (await res.json()) as {
    jobs_results?: Array<{
      job_id?: string; title?: string; company_name?: string;
      location?: string; via?: string; share_link?: string;
      related_links?: Array<{ link?: string; text?: string }>;
      description?: string; detected_extensions?: {
        salary?: string; schedule_type?: string; posted_at?: string;
      };
    }>;
  };
  const out: JobCandidate[] = [];
  const perPage = Math.min(input.resultsPerPage ?? 25, body.jobs_results?.length ?? 0);
  for (const r of (body.jobs_results ?? []).slice(0, perPage)) {
    if (!r.title) continue;
    const url = r.share_link ?? r.related_links?.find((l) => l.link)?.link;
    if (!url) continue;
    const sourceId = r.job_id ?? `${r.title}|${r.company_name ?? ""}|${r.location ?? ""}`;
    out.push({
      source: "serpapi",
      sourceId: sourceId.slice(0, 240),       // defensive — serpapi ids can be long
      title: r.title.trim(),
      company: r.company_name ?? null,
      location: r.location ?? null,
      url,
      salaryMin: null, salaryMax: null, currency: null, salaryPeriod: null,
      description: r.description ? r.description.slice(0, 1200) : null,
      postedAt: null,
      meta: { via: r.via, schedule_type: r.detected_extensions?.schedule_type, salary_str: r.detected_extensions?.salary, posted_str: r.detected_extensions?.posted_at },
    });
  }
  return out;
}

// JSearch (RapidAPI) — another aggregator over LinkedIn/Indeed/Glassdoor.
// RapidAPI auth via `X-RapidAPI-Key` + a specific `X-RapidAPI-Host`.
export async function fetchJSearchJobs(input: {
  apiKey: string;
  what: string;
  where?: string;
  resultsPerPage?: number;
  country?: string;             // 'in', 'us', ...
}): Promise<JobCandidate[]> {
  const query = input.where ? `${input.what} in ${input.where}` : input.what;
  const params = new URLSearchParams({
    query,
    page: "1",
    num_pages: "1",
  });
  if (input.country) params.set("country", input.country.toLowerCase());

  const res = await fetch(`https://jsearch.p.rapidapi.com/search?${params.toString()}`, {
    headers: {
      "X-RapidAPI-Key": input.apiKey,
      "X-RapidAPI-Host": "jsearch.p.rapidapi.com",
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`jsearch ${res.status}: ${body.slice(0, 200)}`);
  }
  const body = (await res.json()) as {
    data?: Array<{
      job_id?: string; job_title?: string; employer_name?: string;
      job_city?: string; job_country?: string;
      job_apply_link?: string; job_description?: string;
      job_min_salary?: number; job_max_salary?: number;
      job_salary_currency?: string; job_salary_period?: string;
      job_posted_at_datetime_utc?: string;
    }>;
  };
  const out: JobCandidate[] = [];
  for (const r of (body.data ?? []).slice(0, input.resultsPerPage ?? 25)) {
    if (!r.job_id || !r.job_title || !r.job_apply_link) continue;
    const loc = [r.job_city, r.job_country].filter(Boolean).join(", ");
    out.push({
      source: "jsearch",
      sourceId: r.job_id,
      title: r.job_title.trim(),
      company: r.employer_name ?? null,
      location: loc || null,
      url: r.job_apply_link,
      salaryMin: typeof r.job_min_salary === "number" ? r.job_min_salary : null,
      salaryMax: typeof r.job_max_salary === "number" ? r.job_max_salary : null,
      currency: r.job_salary_currency ?? null,
      salaryPeriod: r.job_salary_period ? r.job_salary_period.toLowerCase() : null,
      description: r.job_description ? r.job_description.slice(0, 1200) : null,
      postedAt: r.job_posted_at_datetime_utc ?? null,
      meta: {},
    });
  }
  return out;
}
