// Haalt AZ's actuele Eredivisie-wedstrijd op bij football-data.org en zet de
// stand in een eigen rijtje (key "live_score") in de kv_store-tabel van
// Supabase. Draait via .github/workflows/live-score.yml elke 5 minuten.
//
// Belangrijk: dit schrijft NOOIT naar de "app_state"-rij (waar alle
// bier-/afreken-data van de app in zit) — dat blijft alleen door de app zelf
// (via gebruikersacties) bijgewerkt. Zo kan dit script nooit per ongeluk een
// wijziging van een gebruiker overschrijven.
//
// Gebruikt altijd de 90-minuten-stand (regularTime), nooit de stand na
// verlenging/strafschoppen — verlenging komt bij de Eredivisie sowieso niet
// voor, maar mocht dit script ooit ook voor bekerwedstrijden gebruikt worden,
// dan telt die verlenging dus bewust niet mee.

const FOOTBALL_DATA_API_KEY = process.env.FOOTBALL_DATA_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL || "https://pyvpihcfysqkwsqamdlt.supabase.co";
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || "sb_publishable_bCubIC_VlhsKXOXBq7msDQ_sNn-fQE2";
const AZ_NAME_MATCH = /\bAZ\b/; // "AZ" of "AZ Alkmaar" — \b voorkomt toevalstreffers op andere clubnamen

if (!FOOTBALL_DATA_API_KEY) {
  console.error("FOOTBALL_DATA_API_KEY ontbreekt (zet 'm als GitHub Actions secret).");
  process.exit(1);
}

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

async function main() {
  const now = new Date();
  const dateFrom = new Date(now.getTime() - 24 * 3600 * 1000);
  const dateTo = new Date(now.getTime() + 24 * 3600 * 1000);

  const url =
    "https://api.football-data.org/v4/competitions/DED/matches?dateFrom=" +
    isoDate(dateFrom) + "&dateTo=" + isoDate(dateTo);
  const res = await fetch(url, { headers: { "X-Auth-Token": FOOTBALL_DATA_API_KEY } });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error("football-data.org gaf status " + res.status + ": " + body.slice(0, 300));
  }
  const data = await res.json();
  const matches = (data.matches || []).filter(
    (m) => AZ_NAME_MATCH.test(m.homeTeam?.name || "") || AZ_NAME_MATCH.test(m.awayTeam?.name || "")
  );

  let picked = matches.find((m) => m.status === "IN_PLAY" || m.status === "PAUSED");
  if (!picked) {
    // Geen wedstrijd nu bezig: pak de dichtstbijzijnde (aankomend of net
    // afgelopen) binnen een venster van 3 uur, zodat we niet een wedstrijd
    // van gisteren of morgen laten zien.
    const THREE_HOURS = 3 * 3600 * 1000;
    let best = null, bestDist = Infinity;
    matches.forEach((m) => {
      const dist = Math.abs(new Date(m.utcDate).getTime() - now.getTime());
      if (dist < THREE_HOURS && dist < bestDist) { best = m; bestDist = dist; }
    });
    picked = best;
  }

  let payloadValue;
  if (!picked) {
    payloadValue = { date: null, status: "NONE", updatedAt: now.toISOString() };
    console.log("Geen AZ-Eredivisiewedstrijd binnen het tijdvenster — live_score leeggemaakt.");
  } else {
    const score = picked.score || {};
    // Altijd de 90-minuten-stand: regularTime indien aanwezig (bv. na
    // verlenging), anders gewoon fullTime (dat IS de 90-minuten-stand als de
    // wedstrijd binnen reguliere speeltijd is beslist of nog bezig is).
    const regular = score.regularTime || score.fullTime || { home: null, away: null };
    const azIsHome = AZ_NAME_MATCH.test(picked.homeTeam?.name || "");
    payloadValue = {
      date: picked.utcDate.slice(0, 10),
      opponent: azIsHome ? picked.awayTeam?.name : picked.homeTeam?.name,
      azIsHome: azIsHome,
      home: regular.home,
      away: regular.away,
      status: picked.status, // SCHEDULED | IN_PLAY | PAUSED | FINISHED | ...
      updatedAt: now.toISOString(),
    };
    console.log("Gevonden:", JSON.stringify(payloadValue));
  }

  const upsertRes = await fetch(SUPABASE_URL + "/rest/v1/kv_store", {
    method: "POST",
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: "Bearer " + SUPABASE_ANON_KEY,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates",
    },
    body: JSON.stringify([{ key: "live_score", value: payloadValue, updated_at: now.toISOString() }]),
  });
  if (!upsertRes.ok) {
    const body = await upsertRes.text().catch(() => "");
    throw new Error("Wegschrijven naar Supabase mislukt, status " + upsertRes.status + ": " + body.slice(0, 300));
  }
  console.log("live_score bijgewerkt in Supabase.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
