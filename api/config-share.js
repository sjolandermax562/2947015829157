// Combined Config Share API
// Routes to different handlers based on method and query params
//
// Routes:
// GET    /api/config-share?action=browse&page=1&limit=20&own=false  - Browse configs
// GET    /api/config-share?action=preview&id={configId}              - Preview config
// POST   /api/config-share?action=upload                             - Upload config (requires auth)
// POST   /api/config-share?action=copy&id={configId}                 - Copy config
// PATCH  /api/config-share?action=visibility                          - Toggle visibility (requires auth + ownership)
// DELETE /api/config-share?id={configId}                              - Delete config (requires auth + ownership)
//
// SECURITY: Uses anon key with RLS policies. Write operations require JWT authentication.

import { jwtVerify } from 'jose';

// SECURITY: No fallback - JWT_SECRET must be set in environment
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('[Config Share API] FATAL: JWT_SECRET environment variable is not set');
}
const secretKey = new TextEncoder().encode(JWT_SECRET || '');

/**
 * Verify JWT token and extract payload
 * @param {string} token - JWT token from Authorization header
 * @returns {Object|null} Token payload or null if invalid
 */
async function verifyToken(token) {
  try {
    const { payload } = await jwtVerify(token, secretKey);
    if (payload.purpose !== 'honed-license') return null;
    return payload;
  } catch (error) {
    return null;
  }
}

/**
 * Extract and verify JWT from request headers
 * @param {Object} req - Request object
 * @returns {Object|null} Token payload or null if invalid/missing
 */
async function getAuthPayload(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return null;
  }
  const token = authHeader.substring(7);
  return await verifyToken(token);
}

export default async function handler(req, res) {
  // Set CORS headers
  const origin = req.headers.origin;

  if (origin && (origin.startsWith('chrome-extension://') || origin.startsWith('moz-extension://'))) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  } else {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }

  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // SECURITY: Use anon key with RLS policies instead of service key
  const { createClient } = await import('@supabase/supabase-js');
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY  // Use anon key - RLS policies will enforce access control
  );

  try {
    // Route based on method and action
    if (req.method === 'GET') {
      const action = req.query.action;

      if (action === 'preview') {
        return await handlePreview(req, res, supabase);
      } else {
        // Default to browse
        return await handleBrowse(req, res, supabase);
      }
    }

    if (req.method === 'POST') {
      const action = req.query.action || req.body?.action;

      if (action === 'copy') {
        return await handleCopy(req, res, supabase);
      } else if (action === 'upload') {
        return await handleUpload(req, res, supabase);
      } else {
        return res.status(400).json({ error: 'Invalid action' });
      }
    }

    if (req.method === 'PATCH') {
      const action = req.query.action || req.body?.action;

      if (action === 'visibility') {
        return await handleVisibility(req, res, supabase);
      } else {
        return res.status(400).json({ error: 'Invalid action' });
      }
    }

    if (req.method === 'DELETE') {
      return await handleDelete(req, res, supabase);
    }

    return res.status(405).json({ error: 'Method not allowed' });

  } catch (error) {
    console.error('Config share API error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

// Browse configs (GET /api/config-share?page=1&limit=20&own=false)
async function handleBrowse(req, res, supabase) {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 20;
  const own = req.query.own === 'true';
  const offset = (page - 1) * limit;

  let query = supabase
    .from('shared_configs')
    .select('*', { count: 'exact' });

  if (own) {
    // Show all configs (both public and private) - no auth required
    query = query;
  } else {
    // Show public configs only
    query = query.eq('is_public', true);
  }

  const { data, error, count } = await query
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) {
    console.error('Supabase error:', error);
    return res.status(500).json({ error: 'Failed to fetch configs' });
  }

  const totalPages = Math.ceil((count || 0) / limit);

  return res.status(200).json({
    success: true,
    configs: data || [],
    pagination: {
      page,
      limit,
      total: count || 0,
      totalPages
    }
  });
}

// Preview config (GET /api/config-share?action=preview&id={configId})
async function handlePreview(req, res, supabase) {
  const configId = req.query.id;
  if (!configId) {
    return res.status(400).json({ error: 'Missing config ID' });
  }

  const { data, error } = await supabase
    .from('shared_configs')
    .select('*')
    .eq('id', configId)
    .single();

  if (error || !data) {
    return res.status(404).json({ error: 'Config not found' });
  }

  // Only show public configs
  if (!data.is_public) {
    return res.status(403).json({ error: 'Config is private' });
  }

  // Increment view count
  await supabase
    .from('shared_configs')
    .update({ view_count: (data.view_count || 0) + 1 })
    .eq('id', configId);

  return res.status(200).json({
    success: true,
    config: data
  });
}

// Upload config (POST /api/config-share?action=upload)
// SECURITY: Requires authentication - uses device_id from JWT
async function handleUpload(req, res, supabase) {
  // Require authentication
  const authPayload = await getAuthPayload(req);
  if (!authPayload) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const { displayName, description, isPublic, configData } = req.body;

  if (!configData) {
    return res.status(400).json({ error: 'Missing config data' });
  }

  const adminsCount = configData.settings?.adminAlertsList?.length || 0;
  const tweetsCount = configData.settings?.trackedTweetsList?.length || 0;
  const blacklistCount = configData.settings?.adminBlacklistList?.length || 0;
  const configSizeBytes = JSON.stringify(configData).length;

  const MAX_SIZE = 5 * 1024 * 1024;
  if (configSizeBytes > MAX_SIZE) {
    return res.status(400).json({ error: 'Config size exceeds 5MB limit' });
  }

  // Use device_id from JWT for ownership tracking
  const deviceId = authPayload.deviceId;

  const { data, error } = await supabase
    .from('shared_configs')
    .insert({
      device_id: deviceId,
      display_name: displayName || null,
      description: description || null,
      is_public: isPublic || false,
      config_data: configData,
      admins_count: adminsCount,
      tweets_count: tweetsCount,
      blacklist_count: blacklistCount,
      config_size_bytes: configSizeBytes
    })
    .select()
    .single();

  if (error) {
    console.error('Supabase error:', error);
    return res.status(500).json({ error: 'Failed to upload config' });
  }

  return res.status(200).json({
    success: true,
    configId: data.id,
    message: 'Config uploaded successfully'
  });
}

// Copy config (POST /api/config-share?action=copy&id={configId})
async function handleCopy(req, res, supabase) {
  const configId = req.query.id;
  if (!configId) {
    return res.status(400).json({ error: 'Missing config ID' });
  }

  const { data, error } = await supabase
    .from('shared_configs')
    .select('*')
    .eq('id', configId)
    .single();

  if (error || !data) {
    return res.status(404).json({ error: 'Config not found' });
  }

  // Can only copy public configs
  if (!data.is_public) {
    return res.status(403).json({ error: 'Cannot copy private config' });
  }

  // Increment copy count and update last_copied_at
  await supabase
    .from('shared_configs')
    .update({
      copy_count: (data.copy_count || 0) + 1,
      last_copied_at: new Date().toISOString()
    })
    .eq('id', configId);

  return res.status(200).json({
    success: true,
    configData: data.config_data
  });
}

// Toggle visibility (PATCH /api/config-share?action=visibility)
// SECURITY: Requires authentication + ownership verification
async function handleVisibility(req, res, supabase) {
  // Require authentication
  const authPayload = await getAuthPayload(req);
  if (!authPayload) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const { configId, isPublic } = req.body;

  if (!configId || typeof isPublic !== 'boolean') {
    return res.status(400).json({ error: 'Missing configId or isPublic' });
  }

  // Verify ownership before updating
  const { data: existingConfig, error: fetchError } = await supabase
    .from('shared_configs')
    .select('device_id')
    .eq('id', configId)
    .single();

  if (fetchError || !existingConfig) {
    return res.status(404).json({ error: 'Config not found' });
  }

  // SECURITY: Only the owner can change visibility
  if (existingConfig.device_id !== authPayload.deviceId) {
    return res.status(403).json({ error: 'Access denied - you do not own this config' });
  }

  const { data, error } = await supabase
    .from('shared_configs')
    .update({ is_public: isPublic })
    .eq('id', configId)
    .select()
    .single();

  if (error || !data) {
    return res.status(500).json({ error: 'Failed to update config' });
  }

  return res.status(200).json({
    success: true,
    isPublic: data.is_public
  });
}

// Delete config (DELETE /api/config-share?id={configId})
// SECURITY: Requires authentication + ownership verification
async function handleDelete(req, res, supabase) {
  // Require authentication
  const authPayload = await getAuthPayload(req);
  if (!authPayload) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const configId = req.query.id;
  if (!configId) {
    return res.status(400).json({ error: 'Missing config ID' });
  }

  // Verify ownership before deleting
  const { data: existingConfig, error: fetchError } = await supabase
    .from('shared_configs')
    .select('device_id')
    .eq('id', configId)
    .single();

  if (fetchError || !existingConfig) {
    return res.status(404).json({ error: 'Config not found' });
  }

  // SECURITY: Only the owner can delete
  if (existingConfig.device_id !== authPayload.deviceId) {
    return res.status(403).json({ error: 'Access denied - you do not own this config' });
  }

  const { data, error } = await supabase
    .from('shared_configs')
    .delete()
    .eq('id', configId)
    .select()
    .single();

  if (error || !data) {
    return res.status(500).json({ error: 'Failed to delete config' });
  }

  return res.status(200).json({
    success: true,
    message: 'Config deleted successfully'
  });
}
