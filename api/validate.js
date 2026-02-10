// Vercel serverless function for license validation with device binding
// Uses Supabase for automatic device registration and license key management
// Returns signed JWT token for server-side API enforcement

import { createClient } from '@supabase/supabase-js';
import { SignJWT, jwtVerify } from 'jose';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;
const masterKillSwitch = process.env.MASTER_KILL_SWITCH === 'true';
const JWT_SECRET = process.env.JWT_SECRET;

const supabase = createClient(supabaseUrl, supabaseKey);

const secretKey = new TextEncoder().encode(JWT_SECRET);

// Compare two semantic versions (e.g., "1.2.3" vs "1.3.0")
// Returns: -1 if v1 < v2, 0 if equal, 1 if v1 > v2
function compareVersions(v1, v2) {
  if (!v1 || !v2) return 0;
  
  const parts1 = v1.split('.').map(Number);
  const parts2 = v2.split('.').map(Number);
  
  for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
    const part1 = parts1[i] || 0;
    const part2 = parts2[i] || 0;
    
    if (part1 < part2) return -1;
    if (part1 > part2) return 1;
  }
  
  return 0;
}

async function generateToken(licenseKey, deviceId) {
  const token = await new SignJWT({
    licenseKey: licenseKey.substring(0, 8) + '...',
    deviceId: deviceId,
    purpose: 'honed-license'
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(secretKey);

  return token;
}

export default async function handler(req, res) {
  // Set CORS headers FIRST - allow extension and web origins
  const origin = req.headers.origin;

  // Allow chrome-extension origins and approved web origins
  const allowedOrigins = [
    origin && (origin.startsWith('chrome-extension://') || origin.startsWith('moz-extension://')),
    origin === 'https://trade.padre.gg',
    origin === 'https://axiom.trade'
  ];

  if (allowedOrigins.some(Boolean)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { key, deviceId, version } = req.query;

  if (masterKillSwitch) {
    return res.json({
      valid: false,
      reason: 'MAINTENANCE',
      message: 'Extension is temporarily disabled for maintenance.'
    });
  }

  if (!key || !deviceId) {
    return res.status(400).json({
      valid: false,
      reason: 'INVALID_REQUEST',
      message: 'License key and device ID are required'
    });
  }

  // Check for version update requirements
  let versionUpdateRequired = false;
  let versionUpdateInfo = null;
  
  console.log(`[Validate API] Version check - Received version: ${version}`);
  
  try {
    const { data: versionData, error: versionError } = await supabase
      .from('extension_versions')
      .select('minimum_version, version, download_url')
      .eq('is_active', true)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    console.log(`[Validate API] Database version data:`, versionData, 'Error:', versionError);

    if (!versionError && versionData) {
      const currentVersion = version || '1.0';
      const minimumVersion = versionData.minimum_version || '1.0';
      const compareResult = compareVersions(currentVersion, minimumVersion);
      
      console.log(`[Validate API] Comparing versions: current=${currentVersion}, minimum=${minimumVersion}, result=${compareResult} (-1=needs update, 0=same, 1=ok)`);
      
      // Simple version comparison (assumes semver format: x.y.z)
      if (compareResult < 0) {
        versionUpdateRequired = true;
        versionUpdateInfo = {
          active: true,
          message: `Update required. Your version (${currentVersion}) is outdated. Please update to version ${versionData.version} or later.`,
          downloadUrl: versionData.download_url,
          currentVersion: currentVersion,
          minimumVersion: minimumVersion,
          latestVersion: versionData.version
        };
        console.log(`[Validate API] ❌ Version update REQUIRED: ${currentVersion} < ${minimumVersion}`);
      } else {
        console.log(`[Validate API] ✅ Version OK: ${currentVersion} >= ${minimumVersion}`);
      }
    } else {
      console.log(`[Validate API] No active version found in database`);
    }
  } catch (versionCheckError) {
    console.error('[Validate API] Version check error:', versionCheckError);
    // Continue with validation even if version check fails
  }

  try {
    // Check if license key exists and is not revoked in Supabase
    const { data: licenseData, error: licenseError } = await supabase
      .from('license_keys')
      .select('key, revoked')
      .eq('key', key)
      .single();

    if (licenseError && licenseError.code !== 'PGRST116') {
      throw licenseError;
    }

    // Check if key exists
    if (!licenseData) {
      return res.json({
        valid: false,
        reason: 'INVALID',
        message: 'Invalid license key.'
      });
    }

    // Check if key is revoked
    if (licenseData.revoked) {
      return res.json({
        valid: false,
        reason: 'REVOKED',
        message: 'License key has been revoked.'
      });
    }

    // Check device binding
    const { data: existingBinding, error: fetchError } = await supabase
      .from('device_bindings')
      .select('device_id, license_key')
      .eq('license_key', key)
      .single();

    if (fetchError && fetchError.code !== 'PGRST116') {
      throw fetchError;
    }

    // Helper function to build response with version update notification
    function buildResponse(baseResponse) {
      if (versionUpdateRequired && versionUpdateInfo) {
        return {
          ...baseResponse,
          valid: false, // Force invalid if update required
          reason: 'UPDATE_REQUIRED',
          updateNotification: versionUpdateInfo
        };
      }
      return baseResponse;
    }

    if (existingBinding) {
      if (existingBinding.device_id === deviceId) {
        const token = await generateToken(key, deviceId);

        // Update last_seen tracking (don't fail if logging errors)
        try {
          // Get IP from Vercel headers
          const forwardedFor = req.headers['x-forwarded-for'];
          const ip = forwardedFor ? forwardedFor.split(',')[0].trim() :
                     req.headers['x-vercel-forwarded-for'] ||
                     req.headers['x-real-ip'] ||
                     req.socket?.remoteAddress ||
                     null;

          await supabase
            .from('device_bindings')
            .update({
              last_seen: new Date().toISOString(),
              last_ip: ip,
              last_user_agent: req.headers['user-agent'] || null,
              last_endpoint: 'validate'
            })
            .eq('license_key', key);
        } catch (logError) {
          console.error('[Validate API] Tracking update error:', logError);
        }

        return res.json(buildResponse({
          valid: true,
          reason: 'VALID',
          message: 'License validated successfully.',
          deviceId: deviceId,
          token: token
        }));
      } else {
        return res.json({
          valid: false,
          reason: 'DEVICE_MISMATCH',
          message: 'This license key is already bound to another device. Each key can only be used on one device.'
        });
      }
    } else {
      const { error: insertError } = await supabase
        .from('device_bindings')
        .insert({
          license_key: key,
          device_id: deviceId,
          bound_at: new Date().toISOString(),
          last_seen: new Date().toISOString(),
          last_ip: req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.socket?.remoteAddress || null,
          last_user_agent: req.headers['user-agent'] || null,
          last_endpoint: 'validate'
        });

      if (insertError) {
        throw insertError;
      }

      const token = await generateToken(key, deviceId);

      return res.json(buildResponse({
        valid: true,
        reason: 'VALID',
        message: 'License validated successfully. Device registered.',
        deviceId: deviceId,
        newDevice: true,
        token: token
      }));
    }

  } catch (error) {
    console.error('[Validate API] Error:', error);
    return res.status(500).json({
      valid: false,
      reason: 'ERROR',
      message: 'Validation error. Please try again later.'
    });
  }
}
