/**
 * Admin API for managing extension versions
 * GET: List all versions
 * POST: Create or update a version (uses upsert to avoid conflicts)
 * DELETE: Remove a version
 */

import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY; // Use service key for admin operations

const supabase = createClient(supabaseUrl, supabaseKey);

// Simple admin auth check - in production, use proper authentication
function isAdmin(req) {
  const authHeader = req.headers.authorization;
  const adminSecret = process.env.ADMIN_API_SECRET;
  
  if (!adminSecret) {
    console.warn('[AdminVersions] No ADMIN_API_SECRET set, allowing all requests');
    return true;
  }
  
  return authHeader === `Bearer ${adminSecret}`;
}

export default async function handler(req, res) {
  // Set CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Check admin auth
  if (!isAdmin(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    switch (req.method) {
      case 'GET':
        return await listVersions(res);
      
      case 'POST':
      case 'PUT':
        return await upsertVersion(req, res);
      
      case 'DELETE':
        return await deleteVersion(req, res);
      
      default:
        return res.status(405).json({ error: 'Method not allowed' });
    }
  } catch (error) {
    console.error('[AdminVersions] Error:', error);
    return res.status(500).json({ 
      error: 'Internal server error',
      details: error.message 
    });
  }
}

async function listVersions(res) {
  const { data, error } = await supabase
    .from('extension_versions')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) {
    return res.status(500).json({ error: 'Failed to fetch versions', details: error });
  }

  // Get current active version
  const activeVersion = data?.find(v => v.is_active);

  return res.status(200).json({
    versions: data || [],
    count: data?.length || 0,
    activeVersion: activeVersion || null
  });
}

async function upsertVersion(req, res) {
  const { version, minimum_version, download_url, is_active, release_notes } = req.body;

  if (!version) {
    return res.status(400).json({ error: 'version is required' });
  }

  // Validate version format (semver)
  if (!/^\d+\.\d+(\.\d+)?$/.test(version)) {
    return res.status(400).json({ 
      error: 'Invalid version format. Use semver format: x.y or x.y.z (e.g., 1.0 or 1.1.0)' 
    });
  }

  const versionData = {
    version,
    minimum_version: minimum_version || '1.0',
    download_url: download_url || null,
    is_active: is_active !== undefined ? is_active : true,
    release_notes: release_notes || null,
    updated_at: new Date().toISOString()
  };

  // Use upsert to avoid duplicate key conflicts
  const { data, error } = await supabase
    .from('extension_versions')
    .upsert(versionData, { 
      onConflict: 'version',
      returning: 'representation'
    });

  if (error) {
    console.error('[AdminVersions] Upsert error:', error);
    return res.status(500).json({ 
      error: 'Failed to save version', 
      details: error.message 
    });
  }

  return res.status(200).json({
    success: true,
    message: `Version ${version} ${data ? 'updated' : 'created'} successfully`,
    version: data?.[0] || versionData
  });
}

async function deleteVersion(req, res) {
  const { version } = req.query;

  if (!version) {
    return res.status(400).json({ error: 'version query parameter is required' });
  }

  const { error } = await supabase
    .from('extension_versions')
    .delete()
    .eq('version', version);

  if (error) {
    return res.status(500).json({ error: 'Failed to delete version', details: error });
  }

  return res.status(200).json({
    success: true,
    message: `Version ${version} deleted successfully`
  });
}
