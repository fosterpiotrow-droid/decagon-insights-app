import { getStore } from '@netlify/blobs';

// Status polling endpoint - returns job status and results
export async function handler(event) {
  // CORS headers
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const jobId = event.queryStringParameters?.jobId;
  if (!jobId) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing jobId parameter' }) };
  }

  try {
    const store = getStore('analysis-results');
    const jobData = await store.get(jobId, { type: 'json' });

    if (!jobData) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ status: 'pending', message: 'Job not yet started or ID not found' }),
      };
    }

    // If complete, return the full result and clean up after a delay
    if (jobData.status === 'complete') {
      // Schedule cleanup (delete blob after returning)
      try {
        // Don't await - let it happen async. If it fails, no big deal.
        store.delete(jobId).catch(() => {});
      } catch (e) { /* ignore cleanup errors */ }
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(jobData),
    };
  } catch (error) {
    console.error('Error checking job status:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ status: 'error', error: 'Failed to check job status' }),
    };
  }
}
