// Fetches the latest significant wave height (Hm0) from a small set of
// Rijkswaterstaat wave buoys and writes the result to buoys.json at the
// repo root. Run on a schedule by .github/workflows/update-buoys.yml —
// this is what turns an hourly server-side fetch into a file the browser
// can read with normal CORS (raw.githubusercontent.com allows it; the
// Rijkswaterstaat API itself does not).
//
// Rijkswaterstaat migrated to a new API in Dec 2025 (the old
// waterwebservices.rijkswaterstaat.nl host was retired end of April
// 2026) and location codes appear to have changed shape along with it
// (old style: "EURPFM"; new examples use lowercase names like
// "hoekvanholland"). Rather than guess new codes station by station,
// we look them up by name against Rijkswaterstaat's own catalog first.

const SEARCH_TERMS = [
  { key: 'europlatform', name: 'Europlatform', lat: 51.999, lon: 3.276 },
  { key: 'ijmuiden', name: 'IJmuiden (munitiestort / buitenhaven)', lat: 52.86, lon: 4.01 },
  // Add more search terms here to find other stations — the log below
  // prints every catalog match, so you can copy the right Code from
  // there once you know what's actually available.
];

const BASE = 'https://ddapi20-waterwebservices.rijkswaterstaat.nl';
const CATALOG_ENDPOINT = `${BASE}/METADATASERVICES/OphalenCatalogus`;
const LATEST_ENDPOINT = `${BASE}/ONLINEWAARNEMINGENSERVICES/OphalenLaatsteWaarnemingen`;

const HEADERS = {
  'Content-Type': 'application/json',
  'Accept': 'application/json',
  // Some public-sector APIs sit behind bot-protection that silently
  // returns an empty body to non-browser-looking clients. Identifying
  // as a real browser is a common, legitimate workaround for calling
  // an otherwise-public open-data endpoint from a server-side script.
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
};

async function postJson(url, body) {
  const res = await fetch(url, { method: 'POST', headers: HEADERS, body: JSON.stringify(body) });
  const rawText = await res.text();
  const diag = `status=${res.status} length=${rawText.length}`;
  if (!res.ok) throw new Error(`HTTP error (${diag}): ${rawText.slice(0, 300)}`);
  if (!rawText) throw new Error(`Empty response (${diag})`);
  try {
    return JSON.parse(rawText);
  } catch {
    throw new Error(`Non-JSON response (${diag}): "${rawText.slice(0, 300)}"`);
  }
}

// Ask Rijkswaterstaat's own catalog for every location whose name
// contains one of our search terms, and log every match with its real
// Code — this is how we find the correct codes instead of guessing.
async function findLocationCodes() {
  const data = await postJson(CATALOG_ENDPOINT, {
    CatalogusFilter: { Locaties: true },
  });
  const locations = data.LocatieLijst || [];
  console.log(`Catalog returned ${locations.length} total locations.`);

  const found = {};
  for (const term of SEARCH_TERMS) {
    const matches = locations.filter(
      (loc) => loc.Naam && loc.Naam.toLowerCase().includes(term.key)
    );
    if (matches.length) {
      console.log(`Matches for "${term.key}":`);
      matches.forEach((m) => console.log(`   Code=${m.Code}  Naam="${m.Naam}"  X=${m.X} Y=${m.Y}`));
      found[term.key] = matches[0].Code; // take the first match
    } else {
      console.warn(`No catalog matches for "${term.key}"`);
    }
  }
  return found;
}

async function fetchBuoy(term, code) {
  const data = await postJson(LATEST_ENDPOINT, {
    LocatieLijst: [{ Code: code }],
    AquoPlusWaarnemingMetadataLijst: [
      {
        AquoMetadata: {
          Compartiment: { Code: 'OW' },
          Eenheid: { Code: 'cm' },
          Grootheid: { Code: 'Hm0' },
        },
      },
    ],
  });

  const list = data.WaarnemingenLijst;
  if (!list || !list.length) throw new Error(`No WaarnemingenLijst for ${code}`);
  const metingen = list[0].MetingenLijst;
  if (!metingen || !metingen.length) throw new Error(`No MetingenLijst for ${code}`);
  const latest = metingen[metingen.length - 1];
  const cm = latest.Meetwaarde && latest.Meetwaarde.Waarde_Numeriek;
  if (cm == null || Number.isNaN(cm)) throw new Error(`No numeric Hm0 value for ${code}`);

  return {
    code,
    name: term.name,
    lat: term.lat,
    lon: term.lon,
    hm0: cm / 100, // stored as cm, convert to metres
    time: latest.Tijdstip,
  };
}

async function main() {
  const results = [];

  let codes = {};
  try {
    codes = await findLocationCodes();
  } catch (err) {
    console.error(`Catalog lookup failed: ${err.message}`);
  }

  for (const term of SEARCH_TERMS) {
    const code = codes[term.key];
    if (!code) {
      console.warn(`FAIL ${term.key}: no catalog code found, skipping`);
      continue;
    }
    try {
      const reading = await fetchBuoy(term, code);
      results.push(reading);
      console.log(`OK   ${term.key} (${code}): Hm0=${reading.hm0}m @ ${reading.time}`);
    } catch (err) {
      console.warn(`FAIL ${term.key} (${code}): ${err.message}`);
    }
  }

  const out = {
    generatedAt: new Date().toISOString(),
    buoys: results,
  };

  const fs = await import('node:fs/promises');
  await fs.writeFile('buoys.json', JSON.stringify(out, null, 2));
  console.log(`Wrote buoys.json with ${results.length} reading(s).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
