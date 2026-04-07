/**
 * Netlify Function: publish-confluence
 * Publishes weekly insights to Perpay's Product & Design Confluence page.
 * Target: perpay.atlassian.net, space PD, page 4451237894
 */

const CONFLUENCE_DOMAIN = 'perpay.atlassian.net';
const DEFAULT_PAGE_ID = '4451237894';

function getAuthHeader() {
  const email = process.env.CONFLUENCE_EMAIL;
  const token = process.env.CONFLUENCE_API_TOKEN;
  if (!email || !token) throw new Error('Missing CONFLUENCE_EMAIL or CONFLUENCE_API_TOKEN env vars');
  return 'Basic ' + Buffer.from(email + ':' + token).toString('base64');
}

function esc(text) {
  if (!text) return '';
  return String(text).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
}

function severityColor(s) {
  if (s === 'High') return '#DC2626';
  if (s === 'Medium') return '#D97706';
  return '#6B7280';
}

function buildPageBody(insights) {
  const { topInsights = [], allInsights = {}, metadata = {} } = insights;
  const { dateRange, generatedAt, totalConversations, filteredConversations, analyzedConversations } = metadata;
  const publishDate = generatedAt
    ? new Date(generatedAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
    : new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

  let html = '';

  // Info banner
  html += `<ac:structured-macro ac:name="info">
<ac:rich-text-body>
<p><strong>Weekly Decagon AI Insights</strong> — ${esc(dateRange || 'This week')} | Published ${publishDate}</p>
<p>${totalConversations || 0} conversations scanned · ${filteredConversations || 0} matched criteria · ${analyzedConversations || (topInsights.length)} representative conversations analyzed</p>
</ac:rich-text-body>
</ac:structured-macro>`;

  // Top issues table
  if (topInsights.length > 0) {
    html += '<h2>Top Issues This Week</h2>';
    html += `<table><colgroup><col /><col /><col /><col /><col /></colgroup>
<thead><tr>
<th>Issue</th><th>Product Area</th><th>Severity / Frequency</th><th>Customer Quote</th><th>Recommended Action</th>
</tr></thead><tbody>`;

    topInsights.slice(0, 5).forEach(insight => {
      const { theme = '', productArea = 'General', frequency = '', severity = 'Medium', summary = '', customerSignals = [], recommendations = [] } = insight;
      const quote = customerSignals.length > 0 ? (customerSignals[0].quote || customerSignals[0]) : '';
      const rec = recommendations.length > 0 ? recommendations[0] : '';
      html += `<tr>
<td><strong>${esc(theme)}</strong><br/><span style="color:#6B7280;font-size:12px;">${esc(summary)}</span></td>
<td>${esc(productArea)}</td>
<td><span style="color:${severityColor(severity)};font-weight:bold;">${esc(severity)}</span><br/>Freq: ${esc(String(frequency))}</td>
<td><em>"${esc(quote)}"</em></td>
<td>${esc(rec)}</td>
</tr>`;
    });
    html += '</tbody></table>';

    // Expandable details
    html += '<h2>Issue Details</h2>';
    topInsights.slice(0, 5).forEach((insight, i) => {
      const { theme = '', productArea = 'General', summary = '', customerSignals = [], recommendations = [], conversationUrls = [] } = insight;
      html += `<ac:structured-macro ac:name="expand">
<ac:parameter ac:name="title">${i + 1}. ${esc(theme)} (${esc(productArea)})</ac:parameter>
<ac:rich-text-body>
<p>${esc(summary)}</p>`;
      if (customerSignals.length > 0) {
        html += '<p><strong>Customer Quotes:</strong></p>';
        customerSignals.forEach(s => {
          html += `<blockquote><em>"${esc(s.quote || s)}"</em></blockquote>`;
        });
      }
      if (recommendations.length > 0) {
        html += '<p><strong>Recommendations:</strong></p><ul>';
        recommendations.forEach(r => { html += `<li>${esc(r)}</li>`; });
        html += '</ul>';
      }
      if (conversationUrls.length > 0) {
        html += '<p><strong>Example Conversations:</strong> ';
        html += conversationUrls.slice(0, 3).map((u, j) => `<a href="${esc(u)}">Conv ${j + 1}</a>`).join(' | ');
        html += '</p>';
      }
      html += '</ac:rich-text-body></ac:structured-macro>';
    });

    // By product area
    const areas = [
      { key: 'card', label: 'Card' },
      { key: 'perpayPlus', label: 'Perpay+' },
      { key: 'marketplace', label: 'Marketplace' },
      { key: 'general', label: 'General / Cross-product' },
    ];
    const hasAreaInsights = areas.some(a => (allInsights[a.key] || []).length > 0);
    if (hasAreaInsights) {
      html += '<h2>Insights by Product Area</h2>';
      areas.forEach(({ key, label }) => {
        const items = allInsights[key] || [];
        if (items.length === 0) { html += `<p><strong>${label}:</strong> No significant issues flagged.</p>`; return; }
        html += `<h3>${label}</h3><ul>`;
        items.forEach(item => {
          html += `<li><strong>${esc(item.theme)}</strong> — ${esc(item.summary)}</li>`;
        });
        html += '</ul>';
      });
    }
  } else {
    html += '<p>No significant issues detected this week.</p>';
  }

  html += `<hr/><p style="color:#9CA3AF;font-size:12px;">Auto-generated by the Decagon Insights Tool · ${totalConversations || 0} conversations scanned · ${publishDate}</p>`;
  return html;
}

async function fetchPage(pageId) {
  const res = await fetch(`https://${CONFLUENCE_DOMAIN}/wiki/api/v2/pages/${pageId}?body-format=storage`, {
    headers: { 'Authorization': getAuthHeader(), 'Accept': 'application/json' },
  });
  if (!res.ok) throw new Error('Fetch page failed: ' + res.status + ' ' + await res.text());
  return res.json();
}

async function updatePage(pageId, pageData, body) {
  const res = await fetch(`https://${CONFLUENCE_DOMAIN}/wiki/api/v2/pages/${pageId}`, {
    method: 'PUT',
    headers: { 'Authorization': getAuthHeader(), 'Accept': 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: pageData.id,
      status: 'current',
      title: pageData.title,
      version: { number: (pageData.version?.number || 0) + 1 },
      body: { representation: 'storage', value: body },
    }),
  });
  if (!res.ok) throw new Error('Update page failed: ' + res.status + ' ' + await res.text());
  return res.json();
}

export default async function handler(req, context) {
  if (req.method === 'OPTIONS') {
    return new Response('', {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
    });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }

  try {
    const body = await req.json();
    const pageId = body.pageId || DEFAULT_PAGE_ID;
    const { insights } = body;

    if (!insights) {
      return new Response(JSON.stringify({ error: 'Missing field: insights' }), {
        status: 400, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }

    const pageData = await fetchPage(pageId);
    const newBody = buildPageBody(insights);
    const updated = await updatePage(pageId, pageData, newBody);

    const pageUrl = `https://${CONFLUENCE_DOMAIN}/wiki/spaces/PD/pages/${updated.id}`;

    return new Response(JSON.stringify({
      success: true,
      pageUrl,
      publishedAt: new Date().toISOString(),
      pageId: updated.id,
      version: updated.version?.number,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });

  } catch (err) {
    console.error('Confluence publish error:', err.message);
    const hint = err.message.includes('Missing CONFLUENCE')
      ? 'Set CONFLUENCE_EMAIL and CONFLUENCE_API_TOKEN in Netlify environment variables.'
      : null;
    return new Response(JSON.stringify({ error: err.message, hint }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }
}
