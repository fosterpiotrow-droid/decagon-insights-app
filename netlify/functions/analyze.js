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

    const sampled = conversations.length > 5
      ? [...conversations].sort(() => Math.random() - 0.5).slice(0, 5)
      : conversations;

    const tr = (s, n) => s && s.length > n ? s.substring(0, n) + '...' : (s || '');
    const convText = sampled.map((c, i) =>
      `[${i+1}] ${tr(c.summary, 250)} | Tags:${c.tags || ''} | Feedback:${tr(c.customerFeedback, 120)}`
    ).join('\n');

    const userPrompt = `Analyze these ${sampled.length} Perpay customer support conversations and identify the top 3 issues. Output ONLY the JSON array value — no other text.

${convText}

Each insight needs: title, productArea (Card|Marketplace|Perpay+|Credit|App|Other), impact (High|Medium|Low), frequency (number), description (1-2 sentences), customerQuote (exact quote or null), recommendedAction (one concrete action)`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8500);

    let msg;
    try {
      msg = await client.messages.create(
        {
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 1200,
          messages: [
            { role: 'user', content: userPrompt },
            { role: 'assistant', content: '[' },
          ],
        },
        { signal: controller.signal }
      );
    } finally {
      clearTimeout(timeout);
    }

    const raw = '[' + msg.content[0].text;
    let insights = [];
    try {
      insights = JSON.parse(raw);
    } catch(e) {
      const m = raw.match(/\[[\s\S]*\]/);
      try { insights = JSON.parse(m ? m[0] : '[]'); } catch(e2) { insights = []; }
    }

    if (!Array.isArray(insights)) insights = [];

    // Populate allInsights by routing each insight to its category
    const allInsights = { card: [], perpayPlus: [], marketplace: [], general: [] };
    for (const insight of insights) {
      const area = (insight.productArea || '').toLowerCase();
      if (area === 'card') allInsights.card.push(insight);
      else if (area === 'perpay+' || area === 'perpaypls' || area.includes('perpay+')) allInsights.perpayPlus.push(insight);
      else if (area === 'marketplace') allInsights.marketplace.push(insight);
      else allInsights.general.push(insight);
    }

    const dateStr = dateRange.start ? `${dateRange.start} to ${dateRange.end || ''}` : '';

    return new Response(JSON.stringify({
      topInsights: insights,
      allInsights,
      metadata: {
        totalConversations: conversations.length,
        filteredConversations: sampled.length,
        dateRange: dateStr,
        generatedAt: new Date().toISOString(),
      },
    }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });

  } catch(err) {
    const isTimeout = err.name === 'AbortError' || (err.message || '').includes('abort');
    console.error('Analyze error:', err.message);
    return new Response(JSON.stringify({
      error: isTimeout ? 'Analysis timed out — please try again' : (err.message || 'Internal error'),
    }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    });
  }
}
