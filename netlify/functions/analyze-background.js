import Anthropic from '@anthropic-ai/sdk';
import { getStore } from '@netlify/blobs';

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// Frustration keywords to detect negative conversations
const FRUSTRATION_KEYWORDS = [
  'frustrated', 'close account', 'cancel', 'refund', 'not working',
  'broken', 'disappointed', 'angry', 'worst', 'confused', 'misleading',
  'scam', 'stolen', 'unauthorized', 'never received', 'still waiting',
  'ridiculous', 'unacceptable',
];

function filterConversations(conversations) {
  return conversations.filter((conv) => {
    if (conv.undeflected === 'True' || conv.undeflected === true) return true;
    if (conv.customerFeedback && conv.customerFeedback.trim().length > 0 && isNegativeFeedback(conv.customerFeedback)) return true;
    if (conv.summary && FRUSTRATION_KEYWORDS.some((kw) => conv.summary.toLowerCase().includes(kw.toLowerCase()))) return true;
    if (conv.watchtowerFlags) {
      try {
        const flags = JSON.parse(conv.watchtowerFlags);
        if (Array.isArray(flags)) {
          if (flags.find((f) => f.flagType === 'CX by Intent' && f.score <= 3)) return true;
          if (flags.find((f) => f.flagType === 'Complaint' && f.flagged === true)) return true;
        }
      } catch (e) { /* ignore */ }
    }
    if (conv.formattedMessages && /speak\s+to\s+(human|representative|manager)|ask\s+for\s+(human|representative|manager)|want\s+to\s+speak\s+to|call\s+(human|representative|manager)/i.test(conv.formattedMessages)) return true;
    return false;
  });
}

function isNegativeFeedback(feedback) {
  const negativePhrases = ['not satisfied', 'disappointed', 'unhappy', 'poor', 'bad', 'worse', 'worst', 'frustrated', 'angry', 'issue', 'problem', 'error', 'broken', 'not working', 'fail', 'complaint'];
  return negativePhrases.some((phrase) => feedback.toLowerCase().includes(phrase.toLowerCase()));
}

function classifyProductArea(tags) {
  if (!tags) return 'general';
  const tagsLower = tags.toLowerCase();
  if (tagsLower.includes('card')) return 'card';
  if (tagsLower.includes('perpay+') || tagsLower.includes('subscription')) return 'perpayPlus';
  if (tagsLower.includes('marketplace') || tagsLower.includes('shopping') || tagsLower.includes('order')) return 'marketplace';
  return 'general';
}

function formatConversationsForClaude(conversations) {
  return conversations.map((conv, index) => {
    const productArea = classifyProductArea(conv.tags);
    return `
[Conversation ${index + 1}]
Product Area: ${productArea}
Channel: ${conv.channel || 'unknown'}
Created: ${conv.createdAt || 'unknown'}
Undeflected: ${conv.undeflected}
Tags: ${conv.tags || 'N/A'}
Summary: ${conv.summary || 'N/A'}
Resolution: ${conv.resolution || 'N/A'}
Customer Feedback: ${conv.customerFeedback || 'N/A'}
Key Messages: ${conv.formattedMessages || 'N/A'}
Conversation URL: ${conv.conversationUrl || 'N/A'}`;
  }).join('\n---\n');
}

// Background function handler - Netlify returns 202 immediately, this runs async up to 15 min
export async function handler(event) {
  try {
    const requestBody = JSON.parse(event.body);
    const { jobId, conversations, dateRange } = requestBody;

    if (!jobId || !conversations || !Array.isArray(conversations)) {
      console.error('Invalid request: missing jobId or conversations');
      return { statusCode: 400 };
    }

    const store = getStore('analysis-results');

    // Mark job as processing
    await store.setJSON(jobId, {
      status: 'processing',
      startedAt: new Date().toISOString(),
    });

    // Check for API key
    if (!process.env.ANTHROPIC_API_KEY) {
      await store.setJSON(jobId, {
        status: 'error',
        error: 'ANTHROPIC_API_KEY environment variable is not set',
      });
      return { statusCode: 200 };
    }

    // Filter conversations
    const filteredConversations = filterConversations(conversations);

    if (filteredConversations.length === 0) {
      await store.setJSON(jobId, {
        status: 'complete',
        result: {
          topInsights: [],
          allInsights: { card: [], perpayPlus: [], marketplace: [], general: [] },
          metadata: {
            totalConversations: conversations.length,
            filteredConversations: 0,
            dateRange: dateRange ? `${dateRange.start} to ${dateRange.end}` : 'N/A',
            note: 'No conversations met the filtering criteria',
            generatedAt: new Date().toISOString(),
          },
        },
      });
      return { statusCode: 200 };
    }

    // Sample conversations if too many (limit to 75 for background function - we have more time)
    let conversationsToAnalyze = filteredConversations;
    if (filteredConversations.length > 75) {
      conversationsToAnalyze = filteredConversations.slice(0, 75);
    }

    const formattedConversations = formatConversationsForClaude(conversationsToAnalyze);

    const userMessage = `Please analyze the following customer support conversations from Perpay and extract actionable product insights:

Total conversations analyzed: ${conversationsToAnalyze.length}
Date range: ${dateRange ? `${dateRange.start} to ${dateRange.end}` : 'N/A'}

${formattedConversations}`;

    console.log(`Starting Claude API call for job ${jobId} with ${conversationsToAnalyze.length} conversations`);

    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      system: `You are a senior product analyst at Perpay, a fintech company. You analyze customer support conversations to extract actionable product insights for the product team.

Given the following customer support conversations (pre-filtered for product relevance), identify recurring themes and generate structured insights.

For each theme, provide:
- theme: A clear, specific title
- productArea: One of "Card", "Perpay+", "Marketplace", "General/Cross-product"
- summary: 2-3 sentence explanation of the issue
- customerSignals: Array of 1-3 direct verbatim customer quotes (most impactful)
- recommendations: Array of 2-4 specific, actionable product/UX improvements
- frequency: "High", "Medium", or "Low" based on how often this appears
- severity: "High", "Medium", or "Low" based on frustration level and retention risk
- conversationUrls: Array of relevant Decagon conversation URLs

Return a JSON object with:
{
  "topInsights": [top 5 insights ranked by severity * frequency, each with all fields above],
  "allInsights": {
    "card": [insights for Card product],
    "perpayPlus": [insights for Perpay+],
    "marketplace": [insights for Marketplace],
    "general": [insights for General/Cross-product]
  },
  "metadata": {
    "totalConversations": number,
    "filteredConversations": number,
    "dateRange": "date range string",
    "generatedAt": ISO timestamp
  }
}

Rules:
- Do NOT include operational metrics like escalation rates
- Every insight must tie to a specific product experience
- Quotes must be VERBATIM from the conversations
- Recommendations must be specific enough for a PM to act on
- Group similar issues into single themes rather than listing each conversation separately
- If fewer than 5 distinct themes exist, only return as many as are meaningful`,
      messages: [{ role: 'user', content: userMessage }],
    });

    // Extract text content
    const textContent = response.content.find((block) => block.type === 'text');
    if (!textContent || textContent.type !== 'text') {
      throw new Error('No text content in Claude response');
    }

    // Parse JSON from response
    const jsonMatch = textContent.text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('No JSON found in Claude response');
    }
    const insights = JSON.parse(jsonMatch[0]);

    // Add metadata
    insights.metadata = {
      ...insights.metadata,
      totalConversations: conversations.length,
      filteredConversations: filteredConversations.length,
      dateRange: dateRange ? `${dateRange.start} to ${dateRange.end}` : 'N/A',
      generatedAt: new Date().toISOString(),
    };

    console.log(`Job ${jobId} completed successfully`);

    // Store completed result
    await store.setJSON(jobId, {
      status: 'complete',
      result: insights,
      completedAt: new Date().toISOString(),
    });

  } catch (error) {
    console.error('Background analysis error:', error);

    try {
      const requestBody = JSON.parse(event.body);
      const store = getStore('analysis-results');

      let errorMessage = error.message || 'Unknown error';
      if (error.status === 401) errorMessage = 'Invalid Anthropic API key. Check your ANTHROPIC_API_KEY environment variable.';
      else if (error.status === 429) errorMessage = 'Anthropic API rate limit reached. Please wait a moment and try again.';

      await store.setJSON(requestBody.jobId, {
        status: 'error',
        error: errorMessage,
      });
    } catch (storeError) {
      console.error('Failed to store error status:', storeError);
    }
  }

  return { statusCode: 200 };
}
