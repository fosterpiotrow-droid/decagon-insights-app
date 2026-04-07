import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const FRUSTRATION_KEYWORDS = [
  'frustrated', 'close account', 'cancel', 'refund', 'not working', 'broken',
  'disappointed', 'angry', 'worst', 'scam', 'stolen', 'unauthorized',
  'never received', 'still waiting', 'ridiculous', 'unacceptable', 'misleading', 'confused'
];

function scoreConversation(c) {
  let score = 0;
  if (c.undeflected === 'True' || c.undeflected === true) score += 10;
  const summary = (c.summary || '').toLowerCase();
  FRUSTRATION_KEYWORDS.forEach(kw => { if (summary.includes(kw)) score += 3; });
  if (c.customerFeedback && c.customerFeedback.trim().length > 10) score += 5;
  try {
    const flags = JSON.parse(c.watchtowerFlags || '[]');
    if (Array.isArray(flags)) {
      if (flags.find(f => f.flagType === 'CX by Intent' && f.score <= 3)) score += 8;
      if (flags.find(f => f.flagType === 'Complaint' && f.flagged)) score += 6;
    }
  } catch(e) {}
  return score;
}

function classifyArea(tags) {
  if (!tags) return 'General';
  const t = tags.toLowerCase();
  if (t.includes('card')) return 'Card';
  if (t.includes('perpay+') || t.includes('subscription')) return 'Perpay+';
  if (t.includes('marketplace') || t.includes('shopping') || t.includes('order')) return 'Marketplace';
  return 'General';
}

export default async function handler(req, context) {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405, headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const body = await req.json();
    const { conversations = [], dateRange = {} } = body;

    if (!conversations.length) {
      return new Response(JSON.stringify({ error: 'No conversations provided' }), {
        status: 400, headers: { 'Content-Type': 'application/json' },
      });
    }

    // Group filtered conversations by product area, pick top 5 per area for Claude
    // This ensures coverage across all product areas from the full filtered set
    const byArea = { Card: [], 'Perpay+': [], Marketplace: [], General: [] };
    for (const conv of conversations) {
      const area = classifyArea(conv.tags);
      (byArea[area] || byArea.General).push(conv);
    }

    const sampled = [];
    for (const convs of Object.values(byArea)) {
      const sorted = [...convs].sort((a, b) => scoreConversation(b) - scoreConversation(a));
      sampled.push(...sorted.slice(0, 3));
    }

    const tr = (s, n) => s && s.length > n ? s.substring(0, n) + '...' : (s || '');

    const convText = sampled.map((c, i) => {
      const area = classifyArea(c.tags);
      return [
        `[${i + 1}] ${area}${c.undeflected === 'True' ? ' [ESCALATED]' : ''} | ${tr(c.summary, 250)}`,
        c.customerFeedback ? `Feedback: ${tr(c.customerFeedback, 120)}` : null,
      ].filter(Boolean).join('\n');
    }).join('\n\n');

    const dateInfo = dateRange.start
      ? `Date range: ${dateRange.start} to ${dateRange.end || 'present'}\n`
      : '';

    const userPrompt = `You are a product insights analyst for Perpay. Analyze these ${sampled.length} representative customer support conversations (filtered from ${conversations.length} total flagged) and identify the top issues by product area.

${dateInfo}CONVERSATIONS:
${convText}

Output ONLY a raw JSON array. Each item must have these exact fields:
- theme: short issue title (string)
- summary: 1-2 sentence description (string)
- productArea: one of Card, Marketplace, Perpay+, Credit, App, Other (string)
- severity: High, Medium, or Low (string)
- frequency: estimated number of conversations affected (number)
- customerSignals: array of verbatim customer quotes (array of strings, or empty array)
- recommendations: array of concrete product actions (array of strings, or empty array)
- conversationUrls: array of URLs (array of strings, or empty array)`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8500);
    let msg;
    try {
      msg = await client.messages.create(
        {
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 500,
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

    insights = insights.map(insight => ({
      theme: insight.theme || insight.title || 'Unknown Issue',
      summary: insight.summary || insight.description || '',
      productArea: insight.productArea || insight.product_area || 'General',
      severity: insight.severity || insight.impact || 'Medium',
      frequency: insight.frequency || 0,
      customerSignals: Array.isArray(insight.customerSignals) ? insight.customerSignals
        : insight.customerQuote ? [insight.customerQuote] : [],
      recommendations: Array.isArray(insight.recommendations) ? insight.recommendations
        : insight.recommendedAction ? [insight.recommendedAction]
        : insight.recommendation ? [insight.recommendation] : [],
      conversationUrls: Array.isArray(insight.conversationUrls) ? insight.conversationUrls : [],
    }));

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
        filteredConversations: conversations.length,
        analyzedConversations: sampled.length,
        dateRange: dateStr,
        generatedAt: new Date().toISOString(),
      },
    }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });

  } catch (err) {
    const isTimeout = err.name === 'AbortError' || (err.message || '').includes('abort');
    console.error('Analyze error:', err.message);
    return new Response(JSON.stringify({
      error: isTimeout ? 'Analysis timed out — please try again' : (err.message || 'Internal error'),
    }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    });
  }
}
