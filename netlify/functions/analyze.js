import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function classifyArea(tags) {
  if (!tags) return 'General';
  const t = tags.toLowerCase();
  if (t.includes('card')) return 'Card';
  if (t.includes('perpay+') || t.includes('subscription')) return 'Perpay+';
  if (t.includes('marketplace') || t.includes('shopping') || t.includes('order')) return 'Marketplace';
  return 'General';
}

export default async function handler(req, context) {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' }
    });
  }

  let body;
  try { body = await req.json(); }
  catch(e) {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }

  const { conversations = [], totalConversations = 0, undeflectedCount = 0 } = body;
  if (!conversations.length) {
    return new Response(JSON.stringify({ error: 'No conversations provided' }), {
      status: 400, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }

  // Client already scored & sorted - just take first 10
  const sampled = conversations.slice(0, 10);
  const total = totalConversations || conversations.length;
  const undPct = total > 0 ? Math.round((undeflectedCount / total) * 100) : 0;

  const lines = sampled.map((c, i) =>
    `${i+1}. [${classifyArea(c.tags)}] ${(c.summary||'').substring(0,100)}${c.undeflected==='True'?' [ESCALATED]':''}${c.customerFeedback?' | "'+c.customerFeedback.substring(0,60)+'"':''}`
  ).join('\n');

  const prompt = `Perpay product analyst. Analyze ${sampled.length} top-priority support convos (from ${total} total, ${undPct}% undeflected):
${lines}

JSON only. 2 topIssues, 3 themes max:
{"executiveSummary":{"topIssues":[{"title":"str","pct":0,"convos":0,"description":"str"}],"narrative":"The dominant story this week is **X** - N convos (P%). ${undPct}% undeflected..."},"themes":[{"theme":"str","productArea":"Card|Marketplace|Perpay+|Core","conversationCount":0,"volumePct":0,"severity":"Critical|High|Medium|Low","summary":"str","customerSignals":["quote"],"recommendations":["fix"]}]}
Counts must be realistic fractions of ${total}. customerSignals from data above. JSON only, no markdown fences.`;

  let isTimeout = false;
  const tid = setTimeout(() => { isTimeout = true; }, 8000);

  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 700,
      messages: [
        { role: 'user', content: prompt },
        { role: 'assistant', content: '{' }
      ]
    });

    clearTimeout(tid);
    if (isTimeout) throw new Error('timeout');

    let raw = '{' + (response.content[0]?.text || '');
    const lb = raw.lastIndexOf('}');
    if (lb !== -1) raw = raw.substring(0, lb + 1);

    let result;
    try { result = JSON.parse(raw); }
    catch(e) {
      const m = raw.match(/\{[\s\S]*\}/);
      if (m) result = JSON.parse(m[0]);
      else throw new Error('Failed to parse AI response');
    }

    return new Response(JSON.stringify(result), {
      status: 200, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });

  } catch(err) {
    clearTimeout(tid);
    return new Response(JSON.stringify({
      error: isTimeout ? 'Analysis timed out - please try again' : (err.message || 'Internal error'),
    }), {
      status: isTimeout ? 504 : 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }
}
