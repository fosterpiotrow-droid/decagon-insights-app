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
  const sample = conversations.slice(0, 8);

  const lines = sample.map((c, i) =>
    (i+1) + '. ' + (c.summary || '').substring(0, 80) + (c.undeflected === 'True' ? ' [ESC]' : '') + (c.customerFeedback ? ' | "' + c.customerFeedback.substring(0, 40) + '"' : '')
  ).join('\n');

  const prompt = 'Perpay support analyst. ' + total + ' convos this week, ' + undPct + '% undeflected. Top issues:\n' + lines + '\nReturn JSON: {"narrative":"2 sentences max","themes":[{"theme":"short name","area":"Card|Marketplace|Perpay+|Core","severity":"Critical|High|Medium|Low","summary":"1 sentence","signal":"short quote"}]}\nExactly 3 themes. Keep every value under 80 chars. JSON only, no markdown fences.';

  try {
    const resp = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 500,
      messages: [
        { role: 'user', content: prompt },
        { role: 'assistant', content: '{' }
      ]
    });

    let raw = '{' + (resp.content[0]?.text || '');

    // Robust JSON salvage: try parse as-is, then progressively fix
    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch(e1) {
      // Try closing truncated JSON
      // Remove any trailing incomplete string value
      let fixed = raw.replace(/,"[^"]*$/, '').replace(/,"?$/, '');
      // Try adding closing brackets
      const closers = [']}', '}]}', '"}]}', '"}]}'];
      for (const closer of closers) {
        try {
          parsed = JSON.parse(fixed + closer);
          break;
        } catch(e2) {}
      }
      if (!parsed) {
        // Last resort: find last complete theme object
        const lastGood = fixed.lastIndexOf('}');
        if (lastGood > 0) {
          const trimmed = fixed.substring(0, lastGood + 1);
          for (const closer of [']}', ']}']) {
            try {
              parsed = JSON.parse(trimmed + closer);
              break;
            } catch(e3) {}
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
