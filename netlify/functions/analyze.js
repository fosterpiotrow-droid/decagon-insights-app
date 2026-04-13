import Anthropic from '@anthropic-ai/sdk';
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export default async function handler(req, context) {
  const h = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: h });

  let body;
  try { body = await req.json(); } catch(e) { return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400, headers: h }); }

  const { conversations = [], totalConversations = 0, undeflectedCount = 0, dateRange = {} } = body;
  if (!conversations.length) return new Response(JSON.stringify({ error: 'No conversations' }), { status: 400, headers: h });

  const total = totalConversations || conversations.length;
  const undPct = total > 0 ? Math.round((undeflectedCount / total) * 100) : 0;
  const weekStr = dateRange.start && dateRange.end ? dateRange.start + ' to ' + dateRange.end : 'this week';

  const lines = conversations.slice(0, 15).map((c, i) =>
    (i+1) + '. [' + (c.area || 'General') + '] ' + (c.summary || '').substring(0, 150) +
    (c.undeflected === 'True' ? ' [ESC]' : '') +
    (c.customerFeedback ? ' CX:' + (c.customerFeedback || '').substring(0, 80) : '')
  ).join('\n');

  const prompt = `Perpay product analyst. ${total} support convos (${weekStr}), ${undPct}% escalated.

${lines}

Return JSON with themes per product area. For each area with conversations (Card, Marketplace, Perpay+, General), identify top 2-3 issues.

{"narrative":"2-3 sentence exec summary with **bold** key phrases","themes":[{"theme":"specific title e.g. Credit Limit Increase Requests","area":"Card|Marketplace|Perpay+|General","severity":"Critical|High|Medium|Low","conversationCount":N,"summary":"2 sentence problem description","impact":"why it matters","rootCause":"hypothesis","opportunity":"product improvement","recommendations":["rec1","rec2","rec3"]}]}

Rules: theme titles must be SPECIFIC (e.g. "Payment Not Received To Account" not "Payment Problems"). Generate 6-8 themes total. Keep values concise (<150 chars). JSON only.`;

  try {
    const resp = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1500,
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
      const closers = [']}', '}]}', '"}]}', '"]},]}', '""]}]}'];
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
      if (!parsed) return new Response(JSON.stringify({ error: 'Parse error: ' + e1.message }), { status: 500, headers: h });
    }

    return new Response(JSON.stringify(parsed), { status: 200, headers: h });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message || 'Unknown error' }), { status: 500, headers: h });
  }
}
