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

  const { conversations = [], totalConversations = 0, undeflectedCount = 0 } = body;

  if (!conversations.length) {
    return new Response(JSON.stringify({ error: 'No conversations provided' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }

  // Sample top 2 per area (8 total max) for speed
  const byArea = { Card: [], 'Perpay+': [], Marketplace: [], General: [] };
  for (const conv of conversations) {
    const area = classifyArea(conv.tags);
    (byArea[area] || byArea.General).push(conv);
  }
  const sampled = [];
  for (const convs of Object.values(byArea)) {
    const sorted = [...convs].sort((a, b) => scoreConversation(b) - scoreConversation(a));
    sampled.push(...sorted.slice(0, 2));
  }

  const total = totalConversations || conversations.length;
  const undeflectedPct = total > 0 ? Math.round((undeflectedCount / total) * 100) : 0;

  const convText = sampled.map((c, i) =>
    `[${i+1}] ${classifyArea(c.tags)} | undeflected:${c.undeflected} | ${(c.summary||'').substring(0,120)} | feedback:${(c.customerFeedback||'none').substring(0,80)}`
  ).join('\n');

  const prompt = `Perpay product analyst. ${sampled.length} sample convos from ${total} total (${undeflectedPct}% undeflected):

${convText}

Return JSON only:
{"executiveSummary":{"topIssues":[{"title":"string","pct":0.0,"convos":0,"description":"string"}],"narrative":"Start: The dominant story this week is **Theme** â X convos (Y%). Include undeflection rate and key areas."},"themes":[{"theme":"string","productArea":"Card|Marketplace|Perpay+|Core","conversationCount":0,"volumePct":0.0,"severity":"Critical|High|Medium|Low","summary":"2-3 sentences","customerSignals":["quote from data"],"recommendations":["fix"]}]}

Rules: 3-4 topIssues, 4-6 themes sorted CriticalâLow. Counts realistic vs ${total} total. Pull customer quotes from summaries above. JSON only.`;

  let isTimeout = false;
  const timeoutId = setTimeout(() => { isTimeout = true; }, 8500);

  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 800,
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
