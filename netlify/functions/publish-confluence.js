/**
 * Netlify Serverless Function: publish-confluence
 *
 * Publishes generated insights reports to a Confluence page by appending
 * a new weekly section. Uses Confluence REST API v2 with storage format.
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

// Build the Confluence storage format section for the weekly insights
function buildWeeklySection(insights) {
  const { topInsights, allInsights, metadata } = insights;
  const { dateRange, generatedAt, totalConversations, filteredConversations } = metadata;

  // Format the generated timestamp
  const publishDate = new Date(generatedAt).toISOString();

  let html = `<h2>Week of ${escapeHtml(dateRange)} — Generated ${publishDate}</h2>
<hr />`;

  // Top Critical Insights section
  if (topInsights && topInsights.length > 0) {
    html += `<h3>Top Critical Insights</h3>`;

    topInsights.forEach((insight, index) => {
      const {
        rank = index + 1,
        theme = '',
        productArea = 'General',
        frequency = 'N/A',
        severity = 'Medium',
        summary = '',
        customerSignals = [],
        recommendations = [],
      } = insight;

      html += `
<ac:structured-macro ac:name="panel">
<ac:parameter ac:name="borderColor">#4F46E5</ac:parameter>
<ac:rich-text-body>
<h4>${escapeHtml(rank)}. ${escapeHtml(theme)}</h4>
<p><strong>Product Area:</strong> ${escapeHtml(productArea)} | <strong>Frequency:</strong> ${escapeHtml(frequency)} | <strong>Severity:</strong> ${escapeHtml(severity)}</p>
<p>${escapeHtml(summary)}</p>`;

      if (customerSignals && customerSignals.length > 0) {
        html += `<h5>Customer Signals</h5>`;
        customerSignals.forEach(signal => {
          const quote = signal.quote || signal;
          html += `<blockquote><em>"${escapeHtml(quote)}"</em></blockquote>`;
        });
      }

      if (recommendations && recommendations.length > 0) {
        html += `<h5>Recommendations</h5><ul>`;
        recommendations.forEach(rec => {
          html += `<li>${escapeHtml(rec)}</li>`;
        });
        html += `</ul>`;
      }

      html += `
</ac:rich-text-body>
</ac:structured-macro>`;
    });
  }

  // Product Area Details section
  if (allInsights) {
    html += `<h3>Product Area Details</h3>`;

    const productAreas = ['card', 'perpayPlus', 'marketplace', 'general'];
    productAreas.forEach(area => {
      const insights = allInsights[area] || [];
      if (insights.length > 0) {
        const areaLabel = area === 'perpayPlus' ? 'Perpay Plus' : area.charAt(0).toUpperCase() + area.slice(1);
        html += `<h4>${areaLabel}</h4><table><tbody>`;

        insights.forEach(insight => {
          const { theme = '', summary = '', frequency = '', severity = '' } = insight;
          html += `<tr>`;
          html += `<td><strong>${escapeHtml(theme)}</strong></td>`;
          html += `<td>${escapeHtml(summary)}</td>`;
          html += `<td>${escapeHtml(frequency)}</td>`;
          html += `<td>${escapeHtml(severity)}</td>`;
          html += `</tr>`;
        });

        html += `</tbody></table>`;
      }
    });
  }

  // Methodology section
  html += `<h3>Methodology</h3>
<p>Source: Decagon AI | Period: ${escapeHtml(dateRange)} | Total Conversations: ${totalConversations} | Filtered: ${filteredConversations}</p>
<hr />`;

  return html;
}

// Escape HTML special characters
function escapeHtml(text) {
  if (!text) return '';
  const map = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;',
  };
  return String(text).replace(/[&<>"']/g, char => map[char]);
}

// Fetch the current Confluence page
async function fetchConfluencePage(pageId) {
  const domain = process.env.CONFLUENCE_DOMAIN;
  const url = `https://${domain}/wiki/api/v2/pages/${pageId}?body-format=storage`;
  const auth = getAuthHeader();

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Authorization': auth,
      'Accept': 'application/json',
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to fetch Confluence page: ${response.status} ${response.statusText} - ${errorText}`);
  }

  return await response.json();
}

// Update the Confluence page with new body content
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

// Build the page URL from the updated page data
function buildPageUrl(domain, pageData) {
  const spaceKey = pageData._links?.base?.match(/spaces\/([^/]+)/)?.[1] || 'UNKNOWN';
  const pageTitle = pageData.title?.replace(/\s+/g, '+') || 'page';
  return `https://${process.env.CONFLUENCE_DOMAIN}/wiki/spaces/${spaceKey}/pages/${pageData.id}/${pageTitle}`;
}

// Main handler
export async function handler(event) {
  // Add CORS headers
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  // Handle preflight requests
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers,
    };
  }

  // Only accept POST requests
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: 'Method not allowed. Use POST.' }),
    };
  }

  try {
    // Validate environment variables
    validateEnvVars();

    // Parse request body
    let body;
    try {
      body = JSON.parse(event.body || '{}');
    } catch (e) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Invalid JSON in request body' }),
      };
    }

    const { pageId, insights } = body;

    // Validate required fields
    if (!pageId) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Missing required field: pageId' }),
      };
    }

    if (!insights) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Missing required field: insights' }),
      };
    }

    // Fetch current page
    const currentPage = await fetchConfluencePage(pageId);

    // Build the new weekly section
    const newSection = buildWeeklySection(insights);

    // Prepend new section to existing body (or use it if body is empty)
    const currentBody = currentPage.body?.value || '';
    const updatedBody = newSection + '\n' + currentBody;

    // Update the page
    const updatedPage = await updateConfluencePage(pageId, currentPage, updatedBody);

    // Build response URL
    const pageUrl = buildPageUrl(process.env.CONFLUENCE_DOMAIN, updatedPage);

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

    // Check for missing environment variable errors
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

    // Return generic error
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error: 'Failed to publish insights to Confluence',
        message: error.message,
      }),
    };
  }
}
