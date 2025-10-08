// POST {drugA, drugB} -> JSON {summary,severity,mechanism,sources[]}
// Runs on Vercel's server. Your OpenAI key never touches the browser.

const DAILYMED_SPL = (q) =>
  `https://dailymed.nlm.nih.gov/dailymed/services/v2/spls.json?drug_name=${encodeURIComponent(q)}&page=1&pagesize=1`;

const DAILYMED_INFO = (setid) =>
  `https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=${setid}`;

function extractSection7(html) {
  const lower = html.toLowerCase();
  const idx = lower.indexOf("drug interactions");
  if (idx < 0) return html.slice(0, 10000); // fallback if section not found
  const tail = html.slice(idx);
  const nextH2 = tail.toLowerCase().indexOf("<h2");
  return nextH2 > 0 ? tail.slice(0, nextH2) : tail;
}

async function fetchLabel(drug) {
  const r = await fetch(DAILYMED_SPL(drug));
  const j = await r.json();
  const first = j?.data?.spls?.[0];
  if (!first?.setid) return null;
  const infoURL = DAILYMED_INFO(first.setid);
  const html = await (await fetch(infoURL)).text();
  return { name: drug, setid: first.setid, html: extractSection7(html), link: infoURL };
}

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
    const { drugA, drugB } = req.body || {};
    if (!drugA || !drugB) return res.status(400).json({ error: 'Missing drug names' });

    const [a, b] = await Promise.all([fetchLabel(drugA), fetchLabel(drugB)]);
    if (!a || !b) return res.status(404).json({ error: 'Could not fetch labels' });

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

    const openaiResp = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
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
        response_format: { type: "json_schema", json_schema: {
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
        }}
      })
    });

    const data = await openaiResp.json();
    const content = data?.output_text || data?.choices?.[0]?.message?.content || "{}";

    let summary = "No clear interaction evidence in provided labels.";
    let mechanism = null, severity = null;
    try {
      const parsed = JSON.parse(content);
      summary = parsed.summary || summary;
      mechanism = parsed.mechanism || null;
      severity = parsed.severity || null;
    } catch (_) {}

    res.status(200).json({
      summary, mechanism, severity,
      sources: [a.link, b.link]
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e) });
  }
}
