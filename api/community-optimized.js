/**
 * Optimized Community Info API
 * Returns only the fields needed by the extension to minimize payload size
 */

import { jwtVerify } from 'jose';

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-this';
const secretKey = new TextEncoder().encode(JWT_SECRET);

async function verifyToken(token) {
  try {
    const { payload } = await jwtVerify(token, secretKey);
    if (payload.purpose !== 'honed-license') return null;
    return payload;
  } catch (error) {
    return null;
  }
}

export default async function handler(req, res) {
  // CORS headers
  const origin = req.headers.origin;
  if (origin && (origin.startsWith('chrome-extension://') || origin.startsWith('moz-extension://'))) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  // Verify license
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const token = authHeader.substring(7);
  const payload = await verifyToken(token);
  if (!payload) return res.status(401).json({ error: 'Invalid token' });

  // Get request info for tracking
  const forwardedFor = req.headers['x-forwarded-for'];
  const ip = forwardedFor?.split(',')[0].trim() || 
             req.headers['x-vercel-forwarded-for'] ||
             req.headers['x-real-ip'] || null;
  const userAgent = req.headers['user-agent'] || null;

  // Track usage
  try {
    const { createClient } = await import('@supabase/supabase-js');
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

    const { data: binding } = await supabase
      .from('device_bindings')
      .select('license_key')
      .eq('device_id', payload.deviceId)
      .single();

    if (binding) {
      await supabase
        .from('device_bindings')
        .update({ last_seen: new Date().toISOString(), last_ip: ip, last_user_agent: userAgent, last_endpoint: 'community' })
        .eq('device_id', payload.deviceId);

      await supabase.from('api_requests').insert({
        license_key: binding.license_key,
        device_id: payload.deviceId,
        endpoint: 'community',
        ip_address: ip,
        user_agent: userAgent,
        credits_used: 20
      });
    }
  } catch (e) { /* Silent fail for tracking */ }

  try {
    const { communityId } = req.query;
    if (!communityId) return res.status(400).json({ error: 'Missing communityId' });

    // Call Twitter API
    const apiKey = process.env.TWITTER_API_KEY;
    const apiUrl = new URL('https://api.twitterapi.io/twitter/community/info');
    apiUrl.searchParams.set('community_id', communityId);
    const response = await fetch(apiUrl.toString(), {
      headers: { 'X-API-Key': apiKey }
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Twitter API error');

    // Extract only the fields we need
    const community = data.data || data;
    
    const optimized = {
      status: 'success',
      data: {
        // Core community info
        id: community.id || communityId,
        name: community.name,
        description: community.description,
        
        // Media
        avatar_url: community.avatar_url,
        banner_url: community.banner_url,
        
        // Stats (minimal)
        member_count: community.member_count,
        
        // Admin info (for verification)
        admin: community.admin ? {
          user_id: community.admin.user_id,
          screen_name: community.admin.screen_name
        } : null,
        
        // Creation date
        created_at: community.created_at
      }
    };

    return res.status(200).json(optimized);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
