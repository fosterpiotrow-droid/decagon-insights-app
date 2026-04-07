import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export default async function handler(req, context) {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const body = await req.json();
    const { conversations = [], dateRange = {} } = body;

    if (!conversations.length) {
      return new Response(JSON.stringify({ error: 'No conversations provided' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Sample up to 5 conversations server-side
    const maxConversations = 5;
    let sampled = conversations;
    if (conversations.length > maxConversations) {
      const shuffled = [...conversations].sort(() => Math.random() - 0.5);
      sampled = shuffled.slice(0, maxConversations);
    }

    const tr = (s, n) => s && s.length > n ? s.substring(0, n) + '...' : (s || '');

    const convText = sampled.map((c, i) => {
      const parts = [
        `[${i + 1}] Summary: ${tr(c.summary, 250)}`,
        c.tags ? `Tags: ${c.tags}` : null,
        c.customerFeedback ? `Feedback: ${tr(c.customerFeedback, 120)}` : null,
      ].filter(Boolean);
      return parts.join('\n');
    }).join('\n\n');

    const dateInfo = dateRange.start
      ? `Date range: ${dateRange.start} to ${dateRange.end || 'present'}\n`
      : '';

    const userPrompt = `You are a product insights analyst for Perpay. Analyze these ${sampled.length} customer support conversations and identify the top 3 issues.

${dateInfo}CONVERSATIONS:
${convText}

Output ONLY a raw JSON array. Each item must have these exact fields:
- theme: short issue title
- summary: 1-2 sentence description
- productArea: one of Card, Marketplace, Perpay+, Credit, App, Other
- severity: High, Medium, or Low
- frequency: number of conversations affected
- customerSignals: array of verbatim customer quotes (or empty array)
- recommendations: array of concrete product actions (or empty array)
- conversationUrls: array of URLs (or empty array)`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8500);

    let msg;
    try {
      msg = await client.messages.create(
        {
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 1500,
          messages: [
            { role: 'user', content: userPrompt },
            { role: 'assistant', content: '[{' },
          ],
        },
        { signal: controller.signal }
      );
    } finally {
      clearTimeout(timeout);
    }

    const raw = '[{' + msg.content[0].text;
    let insights = [];
    try {
      insights = JSON.parse(raw);
    } catch (e) {
      const m = raw.match(/\[[\s\S]*\]/);
      try { insights = JSON.parse(m ? m[0] : '[]'); } catch (e2) { insights = []; }
    }
    if (!Array.isArray(insights)) insights = [];

    // Normalize fields — handle any naming variations Claude might use
    insights = insights.map(insight => ({
      theme: insight.theme || insight.title || 'Unknown Issue',
      summary: insight.summary || insight.description || '',
      productArea: insight.productArea || insight.product_area || 'General',
      severity: insight.severity || insight.impact || 'Medium',
      frequency: insight.frequency || 0,
      customerSignals: Array.isArray(insight.customerSignals) ? insight.customerSignals
        : insight.customerQuote ? [insight.customerQuote]
        : insight.customer_signals ? insight.customer_signals
        : [],
      recommendations: Array.isArray(insight.recommendations) ? insight.recommendations
        : insight.recommendedAction ? [insight.recommendedAction]
        : insight.recommendation ? [insight.recommendation]
        : [],
      conversationUrls: Array.isArray(insight.conversationUrls) ? insight.conversationUrls : [],
    }));

    // Route insights into per-product allInsights buckets
    const allInsights = { card: [], perpayPlus: [], marketplace: [], general: [] };
    for (const insight of insights) {
      const area = (insight.productArea || '').toLowerCase();
      if (area === 'card') allInsights.card.push(insight);
      else if (area.includes('perpay+') || area.includes('perpay plus')) allInsights.perpayPlus.push(insight);
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
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

  } catch (err) {
    const isTimeout = err.name === 'AbortError' || (err.message || '').includes('abort');
    console.error('Analyze error:', err.message);
    return new Response(JSON.stringify({
      error: isTimeout ? 'Analysis timed out — please try again' : (err.message || 'Internal error'),
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
