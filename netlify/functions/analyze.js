import Anthropic from '@anthropic-ai/sdk';
 
const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});
 
// Frustration keywords to detect negative conversations
const FRUSTRATION_KEYWORDS = [
  'frustrated',
  'close account',
  'cancel',
  'refund',
  'not working',
  'broken',
  'disappointed',
  'angry',
  'worst',
  'confused',
  'misleading',
  'scam',
  'stolen',
  'unauthorized',
  'never received',
  'still waiting',
  'ridiculous',
  'unacceptable',
];
 
// Filter conversations based on multiple criteria
function filterConversations(conversations) {
  return conversations.filter((conv) => {
    // Check for undeflected
    if (conv.undeflected === 'True' || conv.undeflected === true) {
      return true;
    }
 
    // Check for negative/non-empty customer feedback
    if (
      conv.customerFeedback &&
      conv.customerFeedback.trim().length > 0 &&
      isNegativeFeedback(conv.customerFeedback)
    ) {
      return true;
    }
 
    // Check for frustration keywords in summary
    if (
      conv.summary &&
      FRUSTRATION_KEYWORDS.some((keyword) =>
        conv.summary.toLowerCase().includes(keyword.toLowerCase())
      )
    ) {
      return true;
    }
 
    // Check for watchtower flags
    if (conv.watchtowerFlags) {
      try {
        const flags = JSON.parse(conv.watchtowerFlags);
        if (Array.isArray(flags)) {
          // Check for CX by Intent score <= 3
          const cxByIntentFlag = flags.find(
            (f) => f.flagType === 'CX by Intent' && f.score <= 3
          );
          if (cxByIntentFlag) {
            return true;
          }
 
          // Check for any Complaint flag with flagged=true
          const complaintFlag = flags.find(
            (f) => f.flagType === 'Complaint' && f.flagged === true
          );
          if (complaintFlag) {
            return true;
          }
        }
      } catch (e) {
        // If parsing fails, continue to next check
      }
    }
 
    // Check for explicit requests to speak with human/representative/manager
    if (
      conv.formattedMessages &&
      /speak\s+to\s+(human|representative|manager)|ask\s+for\s+(human|representative|manager)|want\s+to\s+speak\s+to|call\s+(human|representative|manager)/i.test(
        conv.formattedMessages
      )
    ) {
      return true;
    }
 
    return false;
  });
}
 
// Check if customer feedback is negative
function isNegativeFeedback(feedback) {
  const negativePhrases = [
    'not satisfied',
    'disappointed',
    'unhappy',
    'poor',
    'bad',
    'worse',
    'worst',
    'frustrated',
    'angry',
    'issue',
    'problem',
    'error',
    'broken',
    'not working',
    'fail',
    'complaint',
  ];
 
  return negativePhrases.some((phrase) =>
    feedback.toLowerCase().includes(phrase.toLowerCase())
  );
}
 
// Classify conversation by product area
function classifyProductArea(tags) {
  if (!tags) return 'general';
 
  const tagsLower = tags.toLowerCase();
 
  if (tagsLower.includes('card')) {
    return 'card';
  }
  if (
    tagsLower.includes('perpay+') ||
    tagsLower.includes('subscription')
  ) {
    return 'perpayPlus';
  }
  if (
    tagsLower.includes('marketplace') ||
    tagsLower.includes('shopping') ||
    tagsLower.includes('order')
  ) {
    return 'marketplace';
  }
 
  return 'general';
}
 
// Format conversations for Claude API
function formatConversationsForClaude(conversations) {
  return conversations
    .map((conv, index) => {
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
 
Key Messages:
${conv.formattedMessages || 'N/A'}
 
Conversation URL: ${conv.conversationUrl || 'N/A'}
`;
    })
    .join('\n---\n');
}
 
// Main handler
export async function handler(event) {
  // Handle CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
      },
      body: '',
    };
  }
 
  // Only accept POST requests
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: {
        'Access-Control-Allow-Origin': '*',
      },
      body: JSON.stringify({ error: 'Method not allowed' }),
    };
  }
 
  // Check for API key
  if (!process.env.ANTHROPIC_API_KEY) {
    return {
      statusCode: 500,
      headers: {
        'Access-Control-Allow-Origin': '*',
      },
      body: JSON.stringify({
        error:
          'ANTHROPIC_API_KEY environment variable is not set',
      }),
    };
  }
 
  try {
    // Parse request body
    const requestBody = JSON.parse(event.body);
    const { conversations, dateRange } = requestBody;
 
    if (
      !conversations ||
      !Array.isArray(conversations) ||
      conversations.length === 0
    ) {
      return {
        statusCode: 400,
        headers: {
          'Access-Control-Allow-Origin': '*',
        },
        body: JSON.stringify({
          error: 'Invalid request: conversations array is required',
        }),
      };
    }
 
    // Filter conversations
    const filteredConversations = filterConversations(conversations);
 
    // If no conversations pass filter, return early
    if (filteredConversations.length === 0) {
      return {
        statusCode: 200,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          topInsights: [],
          allInsights: {
            card: [],
            perpayPlus: [],
            marketplace: [],
            general: [],
          },
          metadata: {
            totalConversations: conversations.length,
            filteredConversations: 0,
            dateRange: dateRange
              ? `${dateRange.start} to ${dateRange.end}`
              : 'N/A',
            note: 'No conversations met the filtering criteria',
            generatedAt: new Date().toISOString(),
          },
        }),
      };
    }
 
    // Sample conversations if too many
    let conversationsToAnalyze = filteredConversations;
    if (filteredConversations.length > 100) {
      conversationsToAnalyze = filteredConversations.slice(0, 100);
    }
 
    // Format conversations for Claude
    const formattedConversations =
      formatConversationsForClaude(conversationsToAnalyze);
 
    // Prepare user message
    const userMessage = `Please analyze the following customer support conversations from Perpay and extract actionable product insights:
 
Total conversations analyzed: ${conversationsToAnalyze.length}
Date range: ${dateRange ? `${dateRange.start} to ${dateRange.end}` : 'N/A'}
 
${formattedConversations}`;
 
    // Call Claude API with timeout
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error('Claude API call timeout (30 seconds)')),
        30000
      )
    );
 
    const claudePromise = client.messages.create({
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
    "dateRange": "March 24-30, 2026",
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
      messages: [
        {
          role: 'user',
          content: userMessage,
        },
      ],
    });
 
    const response = await Promise.race([claudePromise, timeoutPromise]);
 
    // Extract text content from response
    const textContent = response.content.find((block) => block.type === 'text');
    if (!textContent || textContent.type !== 'text') {
      throw new Error('No text content in Claude response');
    }
 
    // Parse JSON from Claude response
    let insights;
    try {
      // Extract JSON from the response (Claude might include markdown formatting)
      const jsonMatch = textContent.text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('No JSON found in Claude response');
      }
      insights = JSON.parse(jsonMatch[0]);
    } catch (parseError) {
      console.error('Failed to parse Claude response as JSON:', textContent.text);
      throw new Error(
        `Failed to parse Claude response: ${parseError.message}`
      );
    }
 
    // Add metadata
    insights.metadata = {
      ...insights.metadata,
      totalConversations: conversations.length,
      filteredConversations: filteredConversations.length,
      dateRange: dateRange
        ? `${dateRange.start} to ${dateRange.end}`
        : 'N/A',
      generatedAt: new Date().toISOString(),
    };
 
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(insights),
    };
  } catch (error) {
    console.error('Error processing request:', error);
 
    return {
      statusCode: 500,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        error: 'Failed to analyze conversations',
        details: error.message,
      }),
    };
  }
}
