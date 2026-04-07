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

    // Sample up to 3 conversations (already pre-sampled client-side, but cap here too)
    const sampled = conversations.length > 3
      ? [...conversations].sort(() => Math.random() - 0.5).slice(0, 3)
      : conversations;

    const tr = (s, n) => s && s.length > n ? s.substring(0, n) + '...' : (s || '');

    const convText = sampled.map((c, i) =>
      `[${i+1}] ${tr(c.summary, 250)} | Tags:${c.tags || ''} | Feedback:${tr(c.customerFeedback, 120)}`
    ).join('\n');

    const prompt = `Analyze these ${sampled.length} Perpay customer support conversations. Identify top 3 issues.

${convText}

Respond ONLY with raw JSON (no markdown, no code fences):
{"topInsights":[{"title":"...","productArea":"Card|Marketplace|Perpay+|Credit|App|Other","impact":"High|Medium|Low","frequency":1,"description":"...","customerQuote":"...","recommendedAction":"..."}],"allInsights":{"card":[],"perpayPlus":[],"marketplace":[],"general":[]},"metadata":{"totalConversations":${conversations.length},"filteredConversations":${sampled.length},"dateRange":"${dateRange.start || ''} to ${dateRange.end || ''}","generatedAt":"${new Date().toISOString()}"}}`;

    // 8-second timeout to stay within Netlify's 10s limit
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    let msg;
    try {
      msg = await client.messages.create(
        {
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 600,
          messages: [{ role: 'user', content: prompt }],
        },
        { signal: controller.signal }
      );
    } finally {
      clearTimeout(timeout);
    }

    const raw = msg.content[0].text;
    const stripped = raw.replace(/^```(?:json)?\s*/,'').replace(/```\s*$/,'').trim();
    let parsed;
    try {
      const m = stripped.match(/\{[\s\S]*\}/);
      parsed = JSON.parse(m ? m[0] : stripped);
    } catch(e) {
      return new Response(JSON.stringify({ error: 'Parse error', raw }), {
        status: 500, headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify(parsed), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  } catch(err) {
    const isTimeout = err.name === 'AbortError' || err.message?.includes('abort');
    console.error('Analyze error:', err.message);
    return new Response(JSON.stringify({
      error: isTimeout ? 'Analysis timed out — try again in a moment' : (err.message || 'Internal error')
    }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    });
  }
}
