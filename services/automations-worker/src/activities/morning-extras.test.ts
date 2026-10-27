import { test } from "node:test";
import assert from "node:assert/strict";
import { formatWeather } from "./morning-extras.js";

test("N15: weather lines; rain and poor-air warnings only past their thresholds", () => {
  const base = { place: "Hyderabad", nowC: 26.6, desc: "haze", hiC: 31.2, loC: 21.8, rainChance: 0.2, aqi: 2 };
  assert.deepEqual(formatWeather(base), ["Hyderabad: 27°C, haze · today 22–31°C", "Air quality: Fair (2/5)"]);
  const bad = formatWeather({ ...base, rainChance: 0.7, aqi: 4 });
  assert.equal(bad[1], "🌧️ Rain likely (70%) — carry an umbrella");
  assert.equal(bad[2], "Air quality: Poor (4/5) — consider a mask outdoors");
  assert.equal(formatWeather({ ...base, aqi: null }).length, 1);
});
