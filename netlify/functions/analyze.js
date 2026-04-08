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
    `${i+1}. ${(c.summary||'').substring(0,90)}${c.undeflected==='True'?' [ESC]':''}${c.customerFeedback?' | "'+c.customerFeedback.substring(0,50)+'"':''}`
  ).join('\n');

  const prompt = `Perpay support analyst. ${total} convos this week, ${undPct}% undeflected. Top issues:
${lines}

Return JSON only: {"narrative":"2-3 sentences. Start: This week's dominant theme is [topic]...","themes":[{"theme":"name","area":"Card|Marketplace|Perpay+|Core","severity":"Critical|High|Medium|Low","summary":"1-2 sentences","signal":"customer quote from above"}]}
Give exactly 3 themes sorted by severity. JSON only, no fences.`;

  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), 8000);

  try {
    const resp = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 350,
      messages: [
        { role: 'user', content: prompt },
        { role: 'assistant', content: '{' }
      ]
    });

    clearTimeout(tid);

    let raw = '{' + (resp.content[0]?.text || '');
    // Ensure valid JSON by finding last complete }
    const lb = raw.lastIndexOf('}');
    if (lb > 0) raw = raw.substring(0, lb + 1);

    let result;
    try { result = JSON.parse(raw); } catch(e) {
      // Try to salvage - find outermost braces
      const m = raw.match(/\{[\s\S]*\}/);
      if (m) result = JSON.parse(m[0]);
      else throw new Error('Could not parse AI response');
    }

    return new Response(JSON.stringify(result), { status: 200, headers: h });
  } catch(err) {
    clearTimeout(tid);
    const msg = err.name === 'AbortError' || err.message === 'timeout'
      ? 'Analysis timed out - please try again'
      : (err.message || 'Internal error');
    return new Response(JSON.stringify({ error: msg }), { status: err.name === 'AbortError' ? 504 : 500, headers: h });
  }
}
