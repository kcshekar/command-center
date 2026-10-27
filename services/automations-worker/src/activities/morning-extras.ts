import { cc } from "../cc-client.js";
import { ollamaText } from "../ollama.js";

// Morning brief add-ons. Both are optional: no key / no city / model down →
// the section is simply left out, the brief still goes.
//
//   N15  weather + air quality via OpenWeatherMap (the user's BYOK key,
//        service "openweather"; city from their profile's location)
//   R15  one short line for the day from the LOCAL model

const OWM = "https://api.openweathermap.org";

export interface WeatherFacts {
  place: string;
  nowC: number;
  desc: string;
  hiC: number;
  loC: number;
  rainChance: number; // 0..1, highest over the next 24h
  aqi: number | null; // OpenWeatherMap 1 (good) … 5 (very poor)
}

const AQI_LABEL = ["", "Good", "Fair", "Moderate", "Poor", "Very poor"];

/** Pure: brief lines for the weather section. */
export function formatWeather(w: WeatherFacts): string[] {
  const r = (n: number) => Math.round(n);
  const lines = [`${w.place}: ${r(w.nowC)}°C, ${w.desc} · today ${r(w.loC)}–${r(w.hiC)}°C`];
  if (w.rainChance >= 0.5) lines.push(`🌧️ Rain likely (${Math.round(w.rainChance * 100)}%) — carry an umbrella`);
  if (w.aqi !== null) lines.push(`Air quality: ${AQI_LABEL[w.aqi] ?? w.aqi} (${w.aqi}/5)${w.aqi >= 4 ? " — consider a mask outdoors" : ""}`);
  return lines;
}

async function owm<T>(path: string, key: string): Promise<T> {
  const res = await fetch(`${OWM}${path}${path.includes("?") ? "&" : "?"}appid=${encodeURIComponent(key)}`);
  if (!res.ok) throw new Error(`openweathermap ${res.status} ${path.split("?")[0]}`);
  return (await res.json()) as T;
}

/** Weather lines for the brief, or a one-line setup hint, or null (no key). */
export async function fetchWeatherBrief(userId: string): Promise<string[] | null> {
  const cred = await cc.getUserCredential(userId, "openweather");
  if (!cred) return null; // opt-in: no key, no section
  const profile = await cc.getUserProfile(userId);
  const city = profile?.location?.trim();
  if (!city) return ["Set your city in your profile (Jobs → Your profile → Location) to get weather here."];
  try {
    const [geo] = await owm<Array<{ lat: number; lon: number; name: string }>>(`/geo/1.0/direct?q=${encodeURIComponent(city)}&limit=1`, cred.key);
    if (!geo) return [`Couldn't find "${city}" for weather — check the Location in your profile.`];
    const at = `lat=${geo.lat}&lon=${geo.lon}`;
    const [now, fc, air] = await Promise.all([
      owm<{ main: { temp: number }; weather: Array<{ description: string }> }>(`/data/2.5/weather?${at}&units=metric`, cred.key),
      owm<{ list: Array<{ main: { temp_min: number; temp_max: number }; pop?: number }> }>(`/data/2.5/forecast?${at}&units=metric&cnt=8`, cred.key),
      owm<{ list: Array<{ main: { aqi: number } }> }>(`/data/2.5/air_pollution?${at}`, cred.key).catch(() => null),
    ]);
    return formatWeather({
      place: geo.name,
      nowC: now.main.temp,
      desc: now.weather[0]?.description ?? "",
      hiC: Math.max(...fc.list.map((x) => x.main.temp_max)),
      loC: Math.min(...fc.list.map((x) => x.main.temp_min)),
      rainChance: Math.max(0, ...fc.list.map((x) => x.pop ?? 0)),
      aqi: air?.list[0]?.main.aqi ?? null,
    });
  } catch (err) {
    console.warn("[n15.weather] skipped", String(err));
    return null;
  }
}

/** R15: one short line for the day from the local model; null if unavailable. */
export async function draftAffirmation(ctx: { weekday: string; eventCount: number }): Promise<string | null> {
  try {
    const busy = ctx.eventCount >= 4 ? "a packed calendar" : ctx.eventCount === 0 ? "no meetings" : `${ctx.eventCount} meeting${ctx.eventCount === 1 ? "" : "s"}`;
    const out = await ollamaText(
      `Write ONE short, grounded line of encouragement (max 14 words) for someone starting their ${ctx.weekday} with ${busy}. ` +
      `No quotes, no emojis, no clichés like "you've got this", no mention of numbers.`,
      { temperature: 0.8 },
    );
    const line = out.replace(/^["'\s]+|["'\s]+$/g, "").split("\n")[0];
    return line && line.length <= 140 ? line : null;
  } catch {
    return null;
  }
}
