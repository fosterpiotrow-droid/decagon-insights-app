import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export default async function handler(req, context) {
  const h = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: { ...h, 'Access-Control-Allow-Origin': '*' } });
  }

  let body;
  try { body = await req.json(); } catch(e) {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400, headers: h });
  }

  const { conversations = [], totalConversations = 0, undeflectedCount = 0, dateRange = {} } = body;
  if (!conversations.length) {
    return new Response(JSON.stringify({ error: 'No conversations' }), { status: 400, headers: h });
  }

  const total = totalConversations || conversations.length;
  const undPct = total > 0 ? Math.round((undeflectedCount / total) * 100) : 0;
  const weekStr = dateRange.start && dateRange.end ? dateRange.start + ' to ' + dateRange.end : 'this week';

  // Group by area if provided, otherwise list all
  const lines = conversations.slice(0, 30).map((c, i) =>
    (i+1) + '. [' + (c.area || 'General') + '] ' + (c.summary || '').substring(0, 200) + (c.undeflected === 'True' ? ' [ESCALATED]' : '') + (c.customerFeedback ? ' Feedback: ' + (c.customerFeedback || '').substring(0, 100) : '')
  ).join('\n');

  const prompt = `Perpay product insights analyst. ${total} support conversations this week (${weekStr}), ${undPct}% escalated to human agents. Conversations labeled by product area:
${lines}

Analyze these conversations and generate actionable product themes. For EACH product area that has conversations (Card, Marketplace, Perpay+, General), identify the top 2-3 most important issues.

Return JSON only: {"narrative":"2-3 sentence executive summary with **bold key phrases**","themes":[{"theme":"specific descriptive title like Credit Limit Increase Requests or Payment Not Received To Account","area":"Card|Marketplace|Perpay+|General","severity":"Critical|High|Medium|Low","conversationCount":0,"summary":"detailed 2-3 sentence description of the specific customer problem","impact":"why this matters for product/retention in 1-2 sentences","rootCause":"specific hypothesis about what is causing this issue","opportunity":"specific product improvement recommendation","recommendations":["specific actionable recommendation 1","specific actionable recommendation 2","specific actionable recommendation 3"]}]}

IMPORTANT:
- Theme titles must be SPECIFIC and DESCRIPTIVE (e.g. "Credit Limit Increase Requests", "Payment Not Received To Account", "Accidental Perpay+ Enrollment") - NOT generic (e.g. "Card Issues", "Payment Problems")
- Each theme MUST include "area" matching one of: Card, Marketplace, Perpay+, General
- Generate 8-12 themes total, covering all product areas with conversations
- Summaries should describe the actual customer pain point, not just restate the title
- Recommendations should be specific product changes, not generic advice
- Keep each string value under 200 chars. Keep recommendations under 100 chars each.`;

  try {
    const resp = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 3000,
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
      if (!parsed) {
        return new Response(JSON.stringify({ error: e1.message }), { status: 500, headers: h });
      }
    }

    return new Response(JSON.stringify(parsed), { status: 200, headers: h });
  } catch (err) {
    const msg = err.message || 'Unknown error';
    if (msg.includes('timeout') || msg.includes('FUNCTION_INVOCATION_TIMEOUT')) {
      return new Response(JSON.stringify({ error: 'Analysis timed out. Try again.' }), { status: 500, headers: h });
    }
    return new Response(JSON.stringify({ error: msg }), { status: 500, headers: h });
  }
}
