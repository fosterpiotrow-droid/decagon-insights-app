/**
 * Netlify Serverless Function: publish-confluence
 *
 * Publishes a condensed weekly insights summary to a Confluence page.
 * Only includes the most critical cross-product issues — no per-product breakdown.
 * Target: Product & Design space, page 4451237894
 */

// Validate required environment variables
function validateEnvVars() {
  const required = ['CONFLUENCE_DOMAIN', 'CONFLUENCE_EMAIL', 'CONFLUENCE_API_TOKEN'];
  const missing = required.filter(v => !process.env[v]);

  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
}

// Encode credentials for Basic Auth
function getAuthHeader() {
  const credentials = `${process.env.CONFLUENCE_EMAIL}:${process.env.CONFLUENCE_API_TOKEN}`;
  const encoded = Buffer.from(credentials).toString('base64');
  return `Basic ${encoded}`;
}

// Escape HTML special characters
function escapeHtml(text) {
  if (!text) return '';
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
  return String(text).replace(/[&<>"']/g, char => map[char]);
}

// Severity color mapping
function severityColor(severity) {
  if (severity === 'High') return '#DC2626';
  if (severity === 'Medium') return '#D97706';
  return '#6B7280';
}

// Build a condensed Confluence page — replaces entire page body with latest insights
function buildCondensedPage(insights) {
  const { topInsights, metadata } = insights;
  const { dateRange, generatedAt, totalConversations, filteredConversations } = metadata || {};

  const publishDate = generatedAt ? new Date(generatedAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : 'N/A';

  let html = '';

  // Header with status macro
  html += `<ac:structured-macro ac:name="info">
<ac:rich-text-body>
<p><strong>Weekly Decagon Insights</strong> — ${escapeHtml(dateRange)} | Published ${publishDate}</p>
<p>${totalConversations || 0} total conversations analyzed, ${filteredConversations || 0} flagged for review</p>
</ac:rich-text-body>
</ac:structured-macro>`;

  // Top Issues — condensed table with only the most important
  if (topInsights && topInsights.length > 0) {
    // Take only top 5 most critical
    const critical = topInsights.slice(0, 5);

    html += `<h2>Top Issues This Week</h2>`;

    html += `<table>
<colgroup><col /><col /><col /><col /><col /></colgroup>
<thead><tr>
<th>Issue</th>
<th>Product Area</th>
<th>Impact</th>
<th>What Customers Are Saying</th>
<th>Recommended Action</th>
</tr></thead>
<tbody>`;

    critical.forEach((insight) => {
      const {
        theme = '',
        productArea = 'General',
        frequency = 'N/A',
        severity = 'Medium',
        summary = '',
        customerSignals = [],
        recommendations = [],
      } = insight;

      // Pick best customer quote
      const topQuote = customerSignals.length > 0
        ? (customerSignals[0].quote || customerSignals[0])
        : '';

      // Pick top recommendation
      const topRec = recommendations.length > 0 ? recommendations[0] : '';

      html += `<tr>
<td><strong>${escapeHtml(theme)}</strong><br /><span style="color: #6B7280; font-size: 12px;">${escapeHtml(summary)}</span></td>
<td>${escapeHtml(productArea)}</td>
<td><span style="color: ${severityColor(severity)}; font-weight: bold;">${escapeHtml(severity)}</span> severity<br />${escapeHtml(frequency)} frequency</td>
<td><em>"${escapeHtml(topQuote)}"</em></td>
<td>${escapeHtml(topRec)}</td>
</tr>`;
    });

    html += `</tbody></table>`;

    // Expanded details for each issue (collapsed by default)
    html += `<h2>Issue Details</h2>`;

    critical.forEach((insight, index) => {
      const {
        theme = '',
        productArea = 'General',
        summary = '',
        customerSignals = [],
        recommendations = [],
        conversationUrls = [],
      } = insight;

      html += `<ac:structured-macro ac:name="expand">
<ac:parameter ac:name="title">${index + 1}. ${escapeHtml(theme)} (${escapeHtml(productArea)})</ac:parameter>
<ac:rich-text-body>
<p>${escapeHtml(summary)}</p>`;

      if (customerSignals.length > 0) {
        html += `<p><strong>Customer Quotes:</strong></p>`;
        customerSignals.forEach(signal => {
          const quote = signal.quote || signal;
          html += `<blockquote><em>"${escapeHtml(quote)}"</em></blockquote>`;
        });
      }

      if (recommendations.length > 0) {
        html += `<p><strong>Recommendations:</strong></p><ul>`;
        recommendations.forEach(rec => {
          html += `<li>${escapeHtml(rec)}</li>`;
        });
        html += `</ul>`;
      }

      if (conversationUrls && conversationUrls.length > 0) {
        html += `<p><strong>Example Conversations:</strong> `;
        html += conversationUrls.slice(0, 3).map((url, i) =>
          `<a href="${escapeHtml(url)}">Conv ${i + 1}</a>`
        ).join(' | ');
        html += `</p>`;
      }

      html += `</ac:rich-text-body>
</ac:structured-macro>`;
    });
  } else {
    html += `<p>No significant issues detected this week.</p>`;
  }

  // Footer
  html += `<hr />
<p style="color: #9CA3AF; font-size: 12px;">Auto-generated from Decagon AI conversations by the Weekly Insights Tool. ${totalConversations || 0} conversations scanned, ${filteredConversations || 0} flagged.</p>`;

  return html;
}

// Fetch the current Confluence page
async function fetchConfluencePage(pageId) {
  const domain = process.env.CONFLUENCE_DOMAIN;
  const url = `https://${domain}/wiki/api/v2/pages/${pageId}?body-format=storage`;
  const auth = getAuthHeader();

  const response = await fetch(url, {
    method: 'GET',
    headers: { 'Authorization': auth, 'Accept': 'application/json' },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to fetch Confluence page: ${response.status} ${response.statusText} - ${errorText}`);
  }

  return await response.json();
}

// Update the Confluence page — replaces entire body with condensed insights
async function updateConfluencePage(pageId, pageData, newBody) {
  const domain = process.env.CONFLUENCE_DOMAIN;
  const url = `https://${domain}/wiki/api/v2/pages/${pageId}`;
  const auth = getAuthHeader();

  const updatePayload = {
    id: pageData.id,
    type: pageData.type,
    status: pageData.status || 'current',
    title: pageData.title,
    version: {
      number: (pageData.version?.number || 0) + 1,
    },
    body: {
      representation: 'storage',
      value: newBody,
    },
  };

  const response = await fetch(url, {
    method: 'PUT',
    headers: {
      'Authorization': auth,
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(updatePayload),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to update Confluence page: ${response.status} ${response.statusText} - ${errorText}`);
  }

  return await response.json();
}

// Main handler
export async function handler(event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed. Use POST.' }) };
  }

  try {
    validateEnvVars();

    let body;
    try {
      body = JSON.parse(event.body || '{}');
    } catch (e) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON in request body' }) };
    }

    // Default to the Product & Design page if no pageId provided
    const pageId = body.pageId || '4451237894';
    const { insights } = body;

    if (!insights) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing required field: insights' }) };
    }

    // Fetch current page
    const currentPage = await fetchConfluencePage(pageId);

    // Build condensed page content (replaces entire body)
    const newBody = buildCondensedPage(insights);

    // Update the page
    const updatedPage = await updateConfluencePage(pageId, currentPage, newBody);

    // Build response URL
    const pageUrl = `https://${process.env.CONFLUENCE_DOMAIN}/wiki/spaces/PD/pages/${updatedPage.id}`;

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        pageUrl,
        publishedAt: new Date().toISOString(),
        pageId: updatedPage.id,
        version: updatedPage.version?.number,
      }),
    };
  } catch (error) {
    console.error('Error publishing to Confluence:', error);

    if (error.message.includes('Missing required environment variables')) {
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({
          error: error.message,
          hint: 'Ensure CONFLUENCE_DOMAIN, CONFLUENCE_EMAIL, and CONFLUENCE_API_TOKEN are set in Netlify environment variables.',
        }),
      };
    }

    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Failed to publish insights to Confluence', message: error.message }),
    };
  }
}
