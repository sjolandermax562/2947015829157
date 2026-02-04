import { jwtVerify } from 'jose';

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-this';
const secretKey = new TextEncoder().encode(JWT_SECRET);

/**
 * Verify JWT token for license validation
 * @param {string} token - JWT token to verify
 * @returns {Promise<object|null>} Decoded payload if valid, null if invalid
 */
async function verifyToken(token) {
  try {
    const { payload } = await jwtVerify(token, secretKey);
    if (payload.purpose !== 'honed-license') {
      return null;
    }
    return payload;
  } catch (error) {
    return null;
  }
}

export default async function handler(req, res) {
  // Set CORS headers FIRST - allow any chrome-extension origin
  const origin = req.headers.origin;

  // Allow chrome-extension origins
  if (origin && (origin.startsWith('chrome-extension://') || origin.startsWith('moz-extension://'))) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  // Handle preflight requests
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Verify license token (this is the real security check)
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized - No token provided' });
  }

  const token = authHeader.substring(7);
  const payload = await verifyToken(token);

  if (!payload) {
    return res.status(401).json({ error: 'Unauthorized - Invalid or expired token' });
  }

  // Get request info for tracking
  const forwardedFor = req.headers['x-forwarded-for'];
  const ip = forwardedFor ? forwardedFor.split(',')[0].trim() :
             req.headers['x-vercel-forwarded-for'] ||
             req.headers['x-real-ip'] ||
             req.socket?.remoteAddress ||
             null;
  const userAgent = req.headers['user-agent'] || null;

  // Update device_bindings last_seen and log API request
  try {
    const { createClient } = await import('@supabase/supabase-js');
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

    // First, get the device binding to find the full license key
    const { data: binding, error: bindingError } = await supabase
      .from('device_bindings')
      .select('license_key')
      .eq('device_id', payload.deviceId)
      .single();

    if (bindingError || !binding) {
      console.error('[Community API] Could not find device binding:', bindingError);
    } else {
      const fullLicenseKey = binding.license_key;

      // Update device_bindings last_seen
      await supabase
        .from('device_bindings')
        .update({
          last_seen: new Date().toISOString(),
          last_ip: ip,
          last_user_agent: userAgent,
          last_endpoint: 'community'
        })
        .eq('device_id', payload.deviceId);

      // Log API request with credits (20 credits per request)
      await supabase
        .from('api_requests')
        .insert({
          license_key: fullLicenseKey,
          device_id: payload.deviceId,
          endpoint: 'community',
          ip_address: ip,
          user_agent: userAgent,
          credits_used: 20
        });
    }
  } catch (logError) {
    console.error('[Community API] Tracking error:', logError);
  }

  try {
    const { communityId } = req.query;
    if (!communityId) return res.status(400).json({ error: 'Missing communityId' });

    const apiKey = process.env.TWITTER_API_KEY;
    const response = await fetch(`https://api.twitterapi.io/twitter/community/info?community_id=${communityId}`, {
      headers: { 'X-API-Key': apiKey }
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Twitter API error');

    return res.status(200).json(data);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
