// api/ddi.js
// Robust Vercel function with:
// - Works in both Node and Edge-like request shapes
// - Accepts POST (JSON) and GET (query) for easy debugging
// - More tolerant DailyMed lookup (pagesize=5 + title match)
// - Clear logging to Vercel Functions logs

const DAILYMED_SPL = (q) =>
  `https://dailymed.nlm.nih.gov/dailymed/services/v2/spls.json?drug_name=${encodeURIComponent(q)}&pagesize=5&page=1`;

const DAILYMED_INFO = (setid) =>
  `https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=${setid}`;

function extractSection7(html) {
  const lower = html.toLowerCase();
  const idx = lower.indexOf("drug interactions");
  if (idx < 0) return html.slice(0, 10000); // fallback
  const tail = html.slice(idx);
  const nextH2 = tail.toLowerCase().indexOf("<h2");
  return nextH2 > 0 ? tail.slice(0, nextH2) : tail;
}

async function fetchLabel(drug) {
  const listURL = DAILYMED_SPL(drug);
  console.log("DailyMed list URL:", listURL);
  const r = await fetch(listURL);
  if (!r.ok) throw new Error(`DailyMed list failed: ${r.status}`);
  const j = await r.json();
  const candidates = j?.data?.spls || [];
  console.log("Candidates found:", candidates.length);

  if (!candidates.length) return null;

  // Prefer a title that includes the query; otherwise first result
  const qLower = drug.toLowerCase();
  let chosen = candidates.find(c => (c.title || "").toLowerCase().includes(qLower));
  if (!chosen) chosen = candidates[0];

  const setid = chosen.setid;
  console.log("Chosen setid:", setid, "title:", chosen.title);
  if (!setid) return null;

  const infoURL = DAILYMED_INFO(setid);
  const htmlResp = await fetch(infoURL);
  if (!htmlResp.ok) throw new Error(`DailyMed info failed: ${htmlResp.status}`);
  const html = await htmlResp.text();

  return { name: drug, setid, html: extractSection7(html), link: infoURL };
}

// Optional: normalize brand/typo to a preferred term via RxNorm
async function rxnormNormalize(term) {
  try {
    const url = `https://rxnav.nlm.nih.gov/REST/approximateTerm?term=${encodeURIComponent(term)}&maxEntries=1`;
    const r = await fetch(url, { headers: { 'Accept': 'application/json' }});
    if (!r.ok) return term;
    const j = await r.json();
    const cand = j?.approximateGroup?.candidate?.[0]?.candidatePreferred || null;
    return cand || term;
  } catch {
    return term;
  }
}

function jsonResponse(status, obj) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" }
  });
}

export default async function handler(req, res) {
  try {
    // Support both Node-style (req,res) and Edge-style (req only)
    let method = req.method || (req instanceof Request ? req.method : "GET");
    let drugA, drugB;

    if (method === "GET") {
      // Allow GET /api/ddi?drugA=amiodarone&drugB=simvastatin for debugging
      const url = new URL(req.url || (req.headers && req.headers.get && req.headers.get("x-invoke-path")) || "http://local");
      drugA = url.searchParams.get("drugA");
      drugB = url.searchParams.get("drugB");
    } else if (method === "POST") {
      // Try Edge-style first (await req.json()), then Node-style (req.body)
      try {
        const body = req.json ? await req.json() : req.body;
        drugA = body?.drugA;
        drugB = body?.drugB;
      } catch {
        // Some runtimes attach parsed JSON to req.body already
        drugA = req.body?.drugA;
        drugB = req.body?.drugB;
      }
    } else {
      const msg = "Use POST with JSON body {drugA, drugB} or GET with ?drugA=&drugB=";
      return res ? res.status(405).json({ error: msg }) : jsonResponse(405, { error: msg });
    }

    console.log("Incoming:", { method, drugA, drugB });
    if (!drugA || !drugB) {
      const msg = "Missing drug names (need both drugA and drugB).";
      return res ? res.status(400).json({ error: msg }) : jsonResponse(400, { error: msg });
    }

    // Normalize with RxNorm to improve matches
    const [drugANorm, drugBNorm] = await Promise.all([
      rxnormNormalize(drugA),
      rxnormNormalize(drugB)
    ]);
    console.log("Normalized:", { drugANorm, drugBNorm });

    const [a, b] = await Promise.all([fetchLabel(drugANorm), fetchLabel(drugBNorm)]);
    console.log("Label fetched A?", !!a, "B?", !!b);

    if (!a && !b) {
      const msg = `Could not fetch labels for "${drugA}" and "${drugB}". Try generic names or alternate spellings.`;
      return res ? res.status(404).json({ error: msg }) : jsonResponse(404, { error: msg });
    }
    if (!a) {
      const msg = `Could not fetch label for Drug A: "${drugA}". Try the generic/active ingredient name.`;
      return res ? res.status(404).json({ error: msg }) : jsonResponse(404, { error: msg });
    }
    if (!b) {
      const msg = `Could not fetch label for Drug B: "${drugB}". Try the generic/active ingredient name.`;
      return res ? res.status(404).json({ error: msg }) : jsonResponse(404, { error: msg });
    }

    // Build OpenAI prompt
    const system = `You are a clinical pharmacist assistant.
Use ONLY the FDA label excerpts (Section 7: Drug Interactions) provided.
If there is no evidence, say so clearly.
Output JSON with fields: summary, mechanism, severity. Include any label-stated dose caps or avoid/monitor instructions.`;

    const user = `Drug A: ${a.name}
Drug B: ${b.name}

Label (A) excerpt:
${a.html.slice(0, 8000)}

Label (B) excerpt:
${b.html.slice(0, 8000)}`;

    const oaKey = process.env.OPENAI_API_KEY;
    if (!oaKey) {
      const msg = "Server missing OPENAI_API_KEY.";
      console.error(msg);
      return res ? res.status(500).json({ error: msg }) : jsonResponse(500, { error: msg });
    }

    const openaiResp = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${oaKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-5.5-mini",
        input: [
          { role: "system", content: system },
          { role: "user", content: user }
        ],
        temperature: 0.2,
        max_output_tokens: 700,
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "ddi_schema",
            schema: {
              type: "object",
              properties: {
                summary: { type: "string" },
                mechanism: { type: "string" },
                severity: { type: "string" }
              },
              required: ["summary"]
            }
          }
        }
      })
    });

    if (!openaiResp.ok) {
      const t = await openaiResp.text();
      console.error("OpenAI error:", openaiResp.status, t);
      const msg = `OpenAI request failed: ${openaiResp.status}`;
      return res ? res.status(500).json({ error: msg }) : jsonResponse(500, { error: msg });
    }

    const data = await openaiResp.json();
    const content = data?.output_text || data?.choices?.[0]?.message?.content || "{}";

    let summary = "No clear interaction evidence in provided labels.";
    let mechanism = null, severity = null;
    try {
      const parsed = JSON.parse(content);
      summary = parsed.summary || summary;
      mechanism = parsed.mechanism || null;
      severity = parsed.severity || null;
    } catch (e) {
      console.warn("JSON parse fallback:", e);
    }

    const payload = { summary, mechanism, severity, sources: [a.link, b.link] };
    return res ? res.status(200).json(payload) : jsonResponse(200, payload);

  } catch (e) {
    console.error("Handler error:", e);
    return res ? res.status(500).json({ error: String(e) }) : jsonResponse(500, { error: String(e) });
  }
}
