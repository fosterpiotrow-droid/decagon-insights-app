import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const FRUSTRATION_KEYWORDS = ['frustrated','close account','cancel','refund','not working','broken',
  'disappointed','angry','worst','scam','stolen','unauthorized',
  'never received','still waiting','ridiculous','unacceptable','misleading','confused'];

function scoreConversation(c) {
  let score = 0;
  if (c.undeflected === 'True' || c.undeflected === true) score += 10;
  const summary = (c.summary || '').toLowerCase();
  FRUSTRATION_KEYWORDS.forEach(kw => { if (summary.includes(kw)) score += 3; });
  if (c.customerFeedback && c.customerFeedback.trim().length > 10) score += 5;
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
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      }
    });
  }

  let body;
  try { body = await req.json(); }
  catch(e) {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }

  const { conversations = [], dateRange = {}, totalConversations = 0, undeflectedCount = 0 } = body;

  if (!conversations.length) {
    return new Response(JSON.stringify({ error: 'No conversations provided' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }

  // Sample top 3 per area for speed
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

  const total = totalConversations || conversations.length;
  const undeflectedPct = total > 0 ? Math.round((undeflectedCount / total) * 100) : 0;

  const convText = sampled.map((c, i) =>
    `[${i+1}] Area: ${classifyArea(c.tags)} | Undeflected: ${c.undeflected}\nSummary: ${c.summary}\nFeedback: ${c.customerFeedback || 'none'}`
  ).join('\n\n');

  const prompt = `You are a product analyst at Perpay. Analyze these ${sampled.length} representative customer support conversations (sampled from ${total} total this week, ${undeflectedPct}% undeflected rate).

${convText}

Return a JSON object with EXACTLY this structure:
{
  "executiveSummary": {
    "topIssues": [
      {
        "title": "Short Issue Name",
        "pct": 17.9,
        "convos": 1428,
        "description": "One sentence describing the customer pain point."
      }
    ],
    "narrative": "2-3 sentences. Start with: The dominant story this week is **ThemeName** â touching X conversations (Y% of volume). Mention the number of critical themes, the undeflection rate (${undeflectedPct}%), and key product areas affected."
  },
  "themes": [
    {
      "theme": "Short Friction Theme Name",
      "productArea": "Card",
      "conversationCount": 500,
      "volumePct": 6.3,
      "severity": "Critical",
      "summary": "2-3 sentences describing the friction pattern, its root cause, and customer impact.",
      "customerSignals": [
        "Verbatim or near-verbatim customer language from the conversation summaries above",
        "Another customer quote"
      ],
      "recommendations": [
        "Specific actionable product fix"
      ]
    }
  ]
}

Rules:
- topIssues: 3-5 items sorted by volume/impact, with realistic convos counts (must sum to roughly ${Math.round(total * 0.6)})
- themes: 4-8 friction patterns sorted by severity (Critical â High â Medium â Low) then by volume
- productArea values: Card | Marketplace | Perpay+ | Core (use Core for identity/account/verification issues)
- severity values: Critical | High | Medium | Low
- conversationCount integers, volumePct with 1 decimal; all counts should be realistic fractions of ${total}
- customerSignals: pull language directly from the Summary/Feedback text above â these should read like real customer words
- Use **bold** markdown ONLY inside the narrative string to highlight theme names
- Output ONLY the JSON object, no other text`;

  let isTimeout = false;
  const timeoutId = setTimeout(() => { isTimeout = true; }, 9000);

  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1500,
      messages: [
        { role: 'user', content: prompt },
        { role: 'assistant', content: '{' }
      ]
    });

    clearTimeout(timeoutId);
    if (isTimeout) throw new Error('timeout');

    let raw = '{' + (response.content[0]?.text || '');
    const lastBrace = raw.lastIndexOf('}');
    if (lastBrace !== -1) raw = raw.substring(0, lastBrace + 1);

    let result;
    try {
      result = JSON.parse(raw);
    } catch(e) {
      const match = raw.match(/\{[\s\S]*\}/);
      if (match) result = JSON.parse(match[0]);
      else throw new Error('Failed to parse AI response as JSON');
    }

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });

  } catch(err) {
    clearTimeout(timeoutId);
    return new Response(JSON.stringify({
      error: isTimeout ? 'Analysis timed out â please try again' : (err.message || 'Internal error'),
    }), {
      status: isTimeout ? 504 : 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }
}
