import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export default async function handler(req, context) {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405, headers: { 'Content-Type': 'application/json' },
    });
  }
  try {
    const { conversations = [], dateRange = {} } = await req.json();
    if (!conversations.length) {
      return new Response(JSON.stringify({ error: 'No conversations provided' }), {
        status: 400, headers: { 'Content-Type': 'application/json' },
      });
    }

    // Sample up to 5 conversations
    const sampled = conversations.length > 5
      ? [...conversations].sort(() => Math.random() - 0.5).slice(0, 5)
      : conversations;

    const tr = (s, n) => s && s.length > n ? s.substring(0, n) + '...' : (s || '');

    const convText = sampled.map((c, i) =>
      `[${i+1}] ${tr(c.summary,200)} | Tags:${c.tags||''} | Feedback:${tr(c.customerFeedback,100)}`
    ).join('\n');

    const prompt = `Analyze these ${sampled.length} Perpay customer support conversations and identify the top 3 issues.

${convText}

Reply ONLY with JSON:
{"topInsights":[{"title":"string","productArea":"Card|Marketplace|Perpay+|Credit|App|Other","impact":"High|Medium|Low","frequency":1,"description":"string","customerQuote":"string or null","recommendedAction":"string"}],"allInsights":{"card":[],"perpayPlus":[],"marketplace":[],"general":[]},"metadata":{"totalConversations":${conversations.length},"filteredConversations":${sampled.length},"dateRange":"${dateRange.start||''} to ${dateRange.end||''}","generatedAt":"${new Date().toISOString()}"}}`;

    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 400,
      messages: [{ role: 'user', content: prompt }],
    });

    const raw = msg.content[0].text;
    let parsed;
    try {
      const m = raw.match(/\{[\s\S]*\}/);
      parsed = JSON.parse(m ? m[0] : raw);
    } catch(e) {
      return new Response(JSON.stringify({ error: 'Parse error', raw }), {
        status: 500, headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify(parsed), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  } catch(err) {
    console.error('Analyze error:', err);
    return new Response(JSON.stringify({ error: err.message || 'Internal error' }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    });
  }
}
