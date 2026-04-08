import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export default async function handler(req, context) {
  const h = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: { ...h, 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' } });
  }

  let body;
  try { body = await req.json(); } catch(e) {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400, headers: h });
  }

  const { conversations = [], totalConversations = 0, undeflectedCount = 0 } = body;
  if (!conversations.length) {
    return new Response(JSON.stringify({ error: 'No conversations' }), { status: 400, headers: h });
  }

  const total = totalConversations || conversations.length;
  const undPct = total > 0 ? Math.round((undeflectedCount / total) * 100) : 0;
  const sample = conversations.slice(0, 12);

  const lines = sample.map((c, i) =>
    (i+1) + '. ' + (c.summary || '').substring(0, 100) + (c.undeflected === 'True' ? ' [ESC]' : '') + (c.customerFeedback ? ' | FB: "' + c.customerFeedback.substring(0, 50) + '"' : '')
  ).join('\n');

  const prompt = `Perpay support analyst. ${total} convos this week, ${undPct}% undeflected. Samples:
${lines}
Return JSON only: {"narrative":"2-3 sentence executive summary with bold **key phrases**","themes":[{"theme":"short name","area":"Card|Marketplace|Perpay+|Core","severity":"Critical|High|Medium|Low","summary":"2-3 sentence description of the pattern","impact":"why this matters to business/retention, 1 sentence","rootCause":"likely technical or process root cause, 1 sentence","opportunity":"specific actionable fix, 1 sentence","keywords":"3 comma-separated search terms for matching"}]}
Give exactly 5 themes sorted by severity then volume. Keep each string value under 120 chars. JSON only, no markdown fences.`;

  try {
    const resp = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 900,
      messages: [
        { role: 'user', content: prompt },
        { role: 'assistant', content: '{' }
      ]
    });

    let raw = '{' + (resp.content[0]?.text || '');

    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch(e1) {
      let fixed = raw.replace(/,"[^"]*$/, '').replace(/,"?$/, '');
      const closers = [']}', '}]}', '"}]}'];
      for (const closer of closers) {
        try { parsed = JSON.parse(fixed + closer); break; } catch(e2) {}
      }
      if (!parsed) {
        const lastGood = fixed.lastIndexOf('}');
        if (lastGood > 0) {
          const trimmed = fixed.substring(0, lastGood + 1);
          for (const closer of [']}', ']}']) {
            try { parsed = JSON.parse(trimmed + closer); break; } catch(e3) {}
          }
        }
      }
      if (!parsed) {
        return new Response(JSON.stringify({ error: e1.message }), { status: 500, headers: h });
      }
    }

    return new Response(JSON.stringify(parsed), { status: 200, headers: h });
  } catch (err) {
    const msg = err.message || 'Unknown error';
    if (msg.includes('timeout') || msg.includes('FUNCTION_INVOCATION_TIMEOUT')) {
      return new Response(JSON.stringify({ error: 'Analysis timed out. Try again.' }), { status: 504, headers: h });
    }
    return new Response(JSON.stringify({ error: msg }), { status: 500, headers: h });
  }
}
