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
  const origin = req.headers.origin;
  if (origin && (origin.startsWith('chrome-extension://') || origin.startsWith('moz-extension://'))) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });

  const token = authHeader.substring(7);
  const payload = await verifyToken(token);
  if (!payload) return res.status(401).json({ error: 'Invalid token' });

  // Track usage
  try {
    const { createClient } = await import('@supabase/supabase-js');
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
    const { data: binding } = await supabase.from('device_bindings').select('license_key').eq('device_id', payload.deviceId).single();
    if (binding) {
      await supabase.from('device_bindings').update({ last_seen: new Date().toISOString(), last_endpoint: 'twitter' }).eq('device_id', payload.deviceId);
      await supabase.from('api_requests').insert({ license_key: binding.license_key, device_id: payload.deviceId, endpoint: 'twitter', credits_used: 20 });
    }
  } catch (e) { }

  try {
    const { userName } = req.query;
    if (!userName) return res.status(400).json({ error: 'Missing userName' });

    const apiKey = process.env.TWITTER_API_KEY;
    const response = await fetch(`https://api.twitterapi.io/twitter/user/info?userName=${userName}`, { headers: { 'X-API-Key': apiKey } });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Twitter API error');

    return res.status(200).json(data);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
