// Fetches the latest significant wave height (Hm0) from a small set of
// Rijkswaterstaat wave buoys and writes the result to buoys.json at the
// repo root. Run on a schedule by .github/workflows/update-buoys.yml —
// this is what turns an hourly server-side fetch into a file the browser
// can read with normal CORS (raw.githubusercontent.com allows it; the
// Rijkswaterstaat API itself does not).

const BUOYS = [
  { code: 'EURPFM', name: 'Europlatform', lat: 51.999, lon: 3.276 },
  { code: 'IJMDMNSTR', name: 'IJmuiden munitiestort', lat: 52.86, lon: 4.01 },
  // Add more stations here if you find working codes for other areas,
  // e.g. Zeeland or the Wadden coast — same shape: {code, name, lat, lon}.
];

// NOTE: Rijkswaterstaat retired the classic WaterWebservices host at the
// end of April 2026, replacing it with this one. Same underlying data,
// slightly different request shape (batched location/metadata lists
// instead of a single object each). Response JSON shape is unchanged.
const ENDPOINT = 'https://ddapi20-waterwebservices.rijkswaterstaat.nl/ONLINEWAARNEMINGENSERVICES/OphalenLaatsteWaarnemingen';

async function fetchBuoy(buoy) {
  const body = {
    LocatieLijst: [{ Code: buoy.code }],
    AquoPlusWaarnemingMetadataLijst: [
      {
        AquoMetadata: {
          Compartiment: { Code: 'OW' },
          Eenheid: { Code: 'cm' },
          Grootheid: { Code: 'Hm0' },
        },
      },
    ],
  };

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const rawText = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${buoy.code}: ${rawText.slice(0, 300)}`);

  let data;
  try {
    data = JSON.parse(rawText);
  } catch {
    throw new Error(`Non-JSON response for ${buoy.code}: ${rawText.slice(0, 300)}`);
  }

  const list = data.WaarnemingenLijst;
  if (!list || !list.length) throw new Error(`No WaarnemingenLijst for ${buoy.code}. Raw: ${rawText.slice(0, 300)}`);
  const metingen = list[0].MetingenLijst;
  if (!metingen || !metingen.length) throw new Error(`No MetingenLijst for ${buoy.code}. Raw: ${rawText.slice(0, 300)}`);
  const latest = metingen[metingen.length - 1];
  const cm = latest.Meetwaarde && latest.Meetwaarde.Waarde_Numeriek;
  if (cm == null || Number.isNaN(cm)) throw new Error(`No numeric value for ${buoy.code}. Raw: ${rawText.slice(0, 300)}`);

  return {
    code: buoy.code,
    name: buoy.name,
    lat: buoy.lat,
    lon: buoy.lon,
    hm0: cm / 100, // stored as cm, convert to metres
    time: latest.Tijdstip,
  };
}

async function main() {
  const results = [];
  for (const buoy of BUOYS) {
    try {
      const reading = await fetchBuoy(buoy);
      results.push(reading);
      console.log(`OK   ${buoy.code}: Hm0=${reading.hm0}m @ ${reading.time}`);
    } catch (err) {
      console.warn(`FAIL ${buoy.code}: ${err.message}`);
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
