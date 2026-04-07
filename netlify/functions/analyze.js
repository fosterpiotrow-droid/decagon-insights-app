import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const FRUSTRATION_KEYWORDS = [
  'frustrated', 'close account', 'cancel', 'refund', 'not working',
  'broken', 'disappointed', 'angry', 'worst', 'confused', 'misleading',
  'scam', 'stolen', 'unauthorized', 'never received', 'still waiting',
  'ridiculous', 'unacceptable',
];

function filterConversations(conversations) {
  return conversations.filter((conv) => {
    if (conv.undeflected === 'True' || conv.undeflected === true) return true;
    if (conv.summary && FRUSTRATION_KEYWORDS.some((kw) =>
      conv.summary.toLowerCase().includes(kw.toLowerCase())
    )) return true;
    if (conv.watchtowerFlags) {
      try {
        const flags = JSON.parse(conv.watchtowerFlags);
        if (Array.isArray(flags)) {
          if (flags.find((f) => f.flagType === 'CX by Intent' && f.score <= 3)) return true;
          if (flags.find((f) => f.flagType === 'Complaint' && f.flagged === true)) return true;
        }
      } catch (e) { /* ignore */ }
    }
    if (conv.customerFeedback && conv.customerFeedback.trim().length > 10) return true;
    return false;
  });
}

function classifyProductArea(tags) {
  if (!tags) return 'General';
  const t = tags.toLowerCase();
  if (t.includes('card')) return 'Card';
  if (t.includes('perpay+') || t.includes('subscription')) return 'Perpay+';
  if (t.includes('marketplace') || t.includes('shopping') || t.includes('order')) return 'Marketplace';
  return 'General';
}

export async function handler(event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  if (!process.env.ANTHROPIC_API_KEY) return { statusCode: 500, headers, body: JSON.stringify({ error: 'ANTHROPIC_API_KEY not set' }) };

  try {
    const { conversations, dateRange } = JSON.parse(event.body);

    if (!conversations || !Array.isArray(conversations) || conversations.length === 0) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'conversations array required' }) };
    }

    // Filter to relevant conversations
    const filtered = filterConversations(conversations);

    if (filtered.length === 0) {
      return {
        statusCode: 200, headers,
        body: JSON.stringify({
          topInsights: [], allInsights: { card: [], perpayPlus: [], marketplace: [], general: [] },
          metadata: { totalConversations: conversations.length, filteredConversations: 0, dateRange: dateRange ? `${dateRange.start} to ${dateRange.end}` : 'N/A', generatedAt: new Date().toISOString() }
        })
      };
    }

    // Randomly sample up to 20 conversations to keep payload small and fast
    const shuffled = filtered.sort(() => Math.random() - 0.5);
    const sample = shuffled.slice(0, 20);

    // Build a lean conversation list — just the essentials
    const convText = sample.map((conv, i) => {
      const area = classifyProductArea(conv.tags);
      const summary = (conv.summary || '').substring(0, 200);
      const feedback = (conv.customerFeedback || '').substring(0, 100);
      const url = conv.conversationUrl || '';
      return `[${i + 1}] ${area} | ${conv.undeflected === 'True' ? 'ESCALATED' : ''}\nSummary: ${summary}${feedback ? `\nFeedback: ${feedback}` : ''}${url ? `\nURL: ${url}` : ''}`;
    }).join('\n\n');

    const dr = dateRange ? `${dateRange.start} to ${dateRange.end}` : 'this week';

    const response = await client.messages.create({
      model: 'claude-3-haiku-20240307',
      max_tokens: 2048,
      system: `You are a product analyst at Perpay (fintech). Analyze customer support conversations and return a JSON object only — no other text.

Return exactly this structure:
{
  "topInsights": [
    {
      "theme": "Short issue title",
      "productArea": "Card|Perpay+|Marketplace|General/Cross-product",
      "summary": "2 sentence description of the issue",
      "customerSignals": ["verbatim quote from conversation"],
      "recommendations": ["specific PM action"],
      "frequency": "High|Medium|Low",
      "severity": "High|Medium|Low",
      "conversationUrls": ["url if available"]
    }
  ],
  "allInsights": {
    "card": [],
    "perpayPlus": [],
    "marketplace": [],
    "general": []
  },
  "metadata": {
    "totalConversations": 0,
    "filteredConversations": 0,
    "dateRange": "",
    "generatedAt": ""
  }
}

Rules: Return 3-5 topInsights max. Group similar issues. Each insight in allInsights uses same structure. Return valid JSON only.`,
      messages: [{
        role: 'user',
        content: `Analyze these ${sample.length} customer support conversations from ${dr}. Total uploaded: ${conversations.length}, flagged: ${filtered.length}.\n\n${convText}`
      }]
    });

    const textContent = response.content.find(b => b.type === 'text');
    if (!textContent) throw new Error('No response from AI');

    const jsonMatch = textContent.text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('Could not parse AI response');

    const insights = JSON.parse(jsonMatch[0]);

    // Stamp metadata
    insights.metadata = {
      ...insights.metadata,
      totalConversations: conversations.length,
      filteredConversations: filtered.length,
      dateRange: dr,
      generatedAt: new Date().toISOString(),
    };

    return { statusCode: 200, headers, body: JSON.stringify(insights) };

  } catch (error) {
    console.error('analyze error:', error);
    let msg = error.message || 'Unknown error';
    if (error.status === 401) msg = 'Invalid Anthropic API key.';
    else if (error.status === 429) msg = 'Rate limit hit — wait a moment and retry.';
    return { statusCode: 500, headers, body: JSON.stringify({ error: msg }) };
  }
}
