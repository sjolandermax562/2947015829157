/**
 * Config API Endpoint
 * Serves Supabase credentials to licensed extension users
 *
 * SECURITY: The anon key is safe to expose - it only grants access to RLS-protected data.
 * This endpoint allows credential rotation without requiring extension updates.
 */

import { jwtVerify } from 'jose';

// SECURITY: No fallback - JWT_SECRET must be set in environment
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('[Config API] FATAL: JWT_SECRET environment variable is not set');
}
const secretKey = new TextEncoder().encode(JWT_SECRET || '');

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
  // CORS headers for extension access
  const origin = req.headers.origin;
  if (origin && (origin.startsWith('chrome-extension://') || origin.startsWith('moz-extension://'))) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Cache-Control', 'public, max-age=3600'); // Cache for 1 hour

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Validate JWT token
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const token = authHeader.substring(7);
  const payload = await verifyToken(token);
  if (!payload) {
    return res.status(401).json({ error: 'Invalid token' });
  }

  // Return Supabase credentials (anon key is safe to expose)
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    console.error('[Config API] Missing SUPABASE_URL or SUPABASE_ANON_KEY');
    return res.status(500).json({ error: 'Server configuration error' });
  }

  return res.status(200).json({
    supabaseUrl,
    supabaseAnonKey,
    // Include version for cache invalidation if credentials change
    version: process.env.CREDENTIALS_VERSION || '1'
  });
}
