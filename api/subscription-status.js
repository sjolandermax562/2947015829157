// Vercel serverless function for subscription status
// Returns license subscription details including expiry and renewal info
// Uses the same validation pattern as validate.js for security

import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;

// Use anon key - RLS policies will enforce access control
const supabase = createClient(supabaseUrl, supabaseKey);

/**
 * Calculate days remaining until expiration
 */
function calculateDaysRemaining(expiresAt) {
  if (!expiresAt) return null;

  const now = new Date();
  const expiry = new Date(expiresAt);
  const diffMs = expiry - now;
  const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

  return diffDays;
}

/**
 * Format date for display
 */
function formatDate(dateString) {
  if (!dateString) return null;
  const date = new Date(dateString);
  return date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  });
}

/**
 * Mask license key for display (show first 8 chars only)
 */
function maskLicenseKey(key) {
  if (!key || key.length < 12) return '****-****';
  return key.substring(0, 8) + '-****';
}

export default async function handler(req, res) {
  // Set CORS headers FIRST - allow extension and web origins
  const origin = req.headers.origin;

  // Allow chrome-extension origins and approved web origins
  const isExtensionOrigin = origin && (
    origin.startsWith('chrome-extension://') ||
    origin.startsWith('moz-extension://')
  );
  const isAllowedWebOrigin = origin === 'https://trade.padre.gg' || origin === 'https://axiom.trade';

  if (isExtensionOrigin || isAllowedWebOrigin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { key, deviceId } = req.query;

  if (!key || !deviceId) {
    return res.status(400).json({
      success: false,
      error: 'INVALID_REQUEST',
      message: 'License key and device ID are required'
    });
  }

  // Validate environment
  if (!supabaseUrl || !supabaseKey) {
    console.error('[Subscription Status API] Missing environment variables');
    return res.status(500).json({
      success: false,
      error: 'SERVER_ERROR',
      message: 'Server configuration error'
    });
  }

  try {
    // Verify device binding first
    const { data: binding, error: bindingError } = await supabase
      .from('device_bindings')
      .select('device_id, license_key')
      .eq('license_key', key)
      .single();

    if (bindingError && bindingError.code !== 'PGRST116') {
      throw bindingError;
    }

    // Check if device is authorized for this license
    if (!binding || binding.device_id !== deviceId) {
      return res.status(403).json({
        success: false,
        error: 'UNAUTHORIZED',
        message: 'Device not authorized for this license'
      });
    }

    // Get license details
    const { data: license, error: licenseError } = await supabase
      .from('license_keys')
      .select('key, revoked, expires_at, created_at')
      .eq('key', key)
      .single();

    if (licenseError) {
      if (licenseError.code === 'PGRST116') {
        return res.status(404).json({
          success: false,
          error: 'NOT_FOUND',
          message: 'License key not found'
        });
      }
      throw licenseError;
    }

    // Check if revoked
    if (license.revoked) {
      return res.json({
        success: true,
        data: {
          licenseKey: maskLicenseKey(license.key),
          status: 'revoked',
          isActive: false,
          expiresAt: formatDate(license.expires_at),
          daysRemaining: 0,
          createdAt: formatDate(license.created_at),
          message: 'License has been revoked'
        }
      });
    }

    // Calculate subscription status
    const now = new Date();
    const expiresAt = license.expires_at ? new Date(license.expires_at) : null;
    const daysRemaining = calculateDaysRemaining(license.expires_at);

    let status = 'active';
    let isActive = true;
    let message = null;

    if (!expiresAt) {
      status = 'lifetime';
      message = 'Lifetime license';
    } else if (expiresAt < now) {
      status = 'expired';
      isActive = false;
      message = 'License has expired';
    } else if (daysRemaining <= 7) {
      status = 'expiring_soon';
      message = `License expires in ${daysRemaining} day${daysRemaining !== 1 ? 's' : ''}`;
    } else {
      message = `License active for ${daysRemaining} more days`;
    }

    // Get extension history (last 3) - this may fail if table doesn't exist
    let extensions = [];
    try {
      const { data: extData, error: extError } = await supabase
        .from('license_extensions')
        .select('months_added, reason, created_at')
        .eq('license_key', key)
        .order('created_at', { ascending: false })
        .limit(3);

      if (!extError && extData) {
        extensions = extData.map(ext => ({
          monthsAdded: ext.months_added,
          reason: ext.reason,
          date: formatDate(ext.created_at)
        }));
      }
    } catch (extErr) {
      // Extension history is optional, don't fail the whole request
      console.log('[Subscription Status API] Extension history not available:', extErr.message);
    }

    // Build response
    const response = {
      success: true,
      data: {
        licenseKey: maskLicenseKey(license.key),
        status: status,
        isActive: isActive,
        expiresAt: formatDate(license.expires_at),
        expiresAtRaw: license.expires_at,
        daysRemaining: daysRemaining,
        createdAt: formatDate(license.created_at),
        message: message,
        renewalUrl: 'https://discord.gg/honed', // Replace with actual Discord invite
        extensions: extensions
      }
    };

    return res.json(response);

  } catch (error) {
    console.error('[Subscription Status API] Error:', error);
    return res.status(500).json({
      success: false,
      error: 'SERVER_ERROR',
      message: 'Failed to retrieve subscription status'
    });
  }
}
