// Vercel serverless function for fetching admins and tokens from Supabase
// Replaces Google Sheets as the primary data source
// JWT authentication required

const { createClient } = require('@supabase/supabase-js');
const { jwtVerify } = require('jose');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;
const JWT_SECRET = process.env.JWT_SECRET;

const supabase = createClient(supabaseUrl, supabaseKey);
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

/**
 * Calculate token age from Unix timestamp
 * @param {number} unixTimestamp - Unix timestamp in seconds
 * @returns {string} Formatted age string (e.g., "24d ago")
 */
function calculateTokenAge(unixTimestamp) {
  if (!unixTimestamp) return '';

  const now = Math.floor(Date.now() / 1000);
  const diff = now - unixTimestamp;

  const days = Math.floor(diff / 86400);
  const hours = Math.floor((diff % 86400) / 3600);
  const minutes = Math.floor((diff % 3600) / 60);

  if (days > 0) {
    return `${days}d ago`;
  } else if (hours > 0) {
    return `${hours}h ago`;
  } else if (minutes > 0) {
    return `${minutes}m ago`;
  } else {
    return 'Just now';
  }
}

/**
 * Format migrate time from seconds to human readable format
 * @param {number} seconds - Average seconds to migration
 * @returns {string} Formatted time string (e.g., "1h 23m", "45m", "2h 15m")
 */
function formatMigrateTime(seconds) {
  if (!seconds || seconds === 0) return '';

  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  } else if (minutes > 0) {
    return `${minutes}m`;
  } else {
    return '< 1m';
  }
}

/**
 * Format timestamp - handles Unix timestamps (seconds as number or string) and ISO strings
 * @param {number|string} timestamp - Unix timestamp (seconds) or ISO date string
 * @returns {string} ISO date string or empty string
 */
function formatTimestamp(timestamp) {
  if (!timestamp) return '';

  // If it's already an ISO format string (contains 'T' or '-'), return it as-is
  if (typeof timestamp === 'string' && (timestamp.includes('T') || timestamp.includes('-'))) {
    return timestamp;
  }

  // Convert to number if it's a string representation of a Unix timestamp
  const numTimestamp = typeof timestamp === 'string' ? parseInt(timestamp, 10) : timestamp;

  // If we got a valid number, treat it as Unix timestamp in seconds
  if (typeof numTimestamp === 'number' && !isNaN(numTimestamp) && numTimestamp > 0) {
    return new Date(numTimestamp * 1000).toISOString();
  }

  return '';
}

/**
 * Transform Supabase admins data to Sheets format (2D array)
 * @param {Array} admins - Admins from Supabase
 * @returns {Array} 2D array matching Sheets format
 */
function transformAdminsToSheetsFormat(admins) {
  if (!admins || admins.length === 0) {
    return [['admin_username', 'total_rating', 'tokens_score_0', 'tokens_score_1', 'tokens_score_2', 'tokens_score_3', 'tokens_score_4', 'tokens_score_5', 'tokens_score_6', 'total_tokens_created', 'winrate', 'avg_migrate_time', 'last_active', 'last_updated']];
  }

  const header = ['admin_username', 'total_rating', 'tokens_score_0', 'tokens_score_1', 'tokens_score_2', 'tokens_score_3', 'tokens_score_4', 'tokens_score_5', 'tokens_score_6', 'total_tokens_created', 'winrate', 'avg_migrate_time', 'last_active', 'last_updated'];

  const rows = admins.map(admin => [
    // Convert admin_username to lowercase to match parsing logic
    (admin.admin_username || '').toLowerCase().trim(),
    admin.total_rating?.toString() || '0',
    admin.tokens_score_0?.toString() || '0',
    admin.tokens_score_1?.toString() || '0',
    admin.tokens_score_2?.toString() || '0',
    admin.tokens_score_3?.toString() || '0',
    admin.tokens_score_4?.toString() || '0',
    admin.tokens_score_5?.toString() || '0',
    admin.tokens_score_6?.toString() || '0',
    admin.total_tokens_created?.toString() || '0',
    // Convert winrate from decimal (0-1) to percentage (0-100)
    ((admin.winrate || 0) * 100).toString(),
    // avg_migrate_time is in seconds, convert to human readable format
    admin.avg_migrate_time ? formatMigrateTime(admin.avg_migrate_time) : '',
    // Handle timestamp - could be Unix timestamp (number) or ISO string
    formatTimestamp(admin.last_active),
    // Handle timestamp - could be Unix timestamp (number) or ISO string
    formatTimestamp(admin.last_updated)
  ]);

  return [header, ...rows];
}

/**
 * Transform Supabase tokens data to Sheets format (2D array)
 * @param {Array} tokens - Tokens from Supabase
 * @returns {Array} 2D array matching Sheets format
 */
function transformTokensToSheetsFormat(tokens) {
  if (!tokens || tokens.length === 0) {
    return [['admin_username', 'base_token', 'token_name', 'token_symbol', 'community_link', 'token_age', 'market_cap', 'ath_market_cap', 'token_score', 'created_at']];
  }

  const header = ['admin_username', 'base_token', 'token_name', 'token_symbol', 'community_link', 'token_age', 'market_cap', 'ath_market_cap', 'token_score', 'created_at'];

  const rows = tokens.map(token => [
    // Convert admin_username to lowercase to match parsing logic
    (token.admin_username || '').toLowerCase().trim(),
    token.base_token || '',
    token.token_name || '',
    token.token_symbol || '',
    // Map twitter_url or website_url to community_link
    token.twitter_url || token.website_url || '',
    // Calculate token_age from created_at Unix timestamp
    calculateTokenAge(token.created_at),
    // market_cap is a REAL number, convert to string
    (token.market_cap ?? 0).toString(),
    // ath_market_cap is TEXT in Supabase - return as-is (already a string)
    token.ath_market_cap || '0',
    token.token_score?.toString() || '0',
    // Include created_at timestamp for accurate daily stats calculation
    token.created_at?.toString() || ''
  ]);

  return [header, ...rows];
}

module.exports = async function handler(req, res) {
  // Set CORS headers FIRST - allow chrome-extension origins
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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  // Handle preflight requests - MUST return after setting headers
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

  // Update device_bindings last_seen (don't fail if logging errors)
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
        last_endpoint: 'supabase'
      })
      .eq('device_id', payload.deviceId);
  } catch (logError) {
    console.error('[Supabase API] Tracking update error:', logError);
  }

  // Get last sync timestamp for incremental updates
  const lastSync = req.query.since ? parseInt(req.query.since, 10) : null;
  const isIncremental = lastSync && !isNaN(lastSync) && lastSync > 0;

  try {
    const syncType = isIncremental ? 'INCREMENTAL' : 'FULL';
    console.log(`[Supabase API] ${syncType} sync requested`, lastSync ? `(since ${new Date(lastSync * 1000).toISOString()})` : '(all data)');

    // Build query with optional last_updated filter for incremental sync
    // Only fetch columns actually used by the extension
    const adminsQuery = supabase
      .from('admins')
      .select('admin_username, total_rating, tokens_score_0, tokens_score_1, tokens_score_2, tokens_score_3, tokens_score_4, tokens_score_5, tokens_score_6, total_tokens_created, winrate, avg_migrate_time, last_active, last_updated', { count: 'exact' })
      .order('admin_username', { ascending: true });

    // Apply incremental filter if provided (convert seconds to milliseconds for comparison)
    if (isIncremental) {
      adminsQuery.gt('last_updated', lastSync);
    }

    // Fetch ALL admins from Supabase (handle pagination)
    let adminsData = [];
    let adminsError = null;
    let adminsPage = 0;
    const adminsPageSize = 1000;

    do {
      const { data, error, count } = await adminsQuery
        .range(adminsPage * adminsPageSize, (adminsPage + 1) * adminsPageSize - 1);

      if (error) {
        adminsError = error;
        break;
      }

      if (data && data.length > 0) {
        adminsData = adminsData.concat(data);
        adminsPage++;

        // Log progress for large datasets
        console.log(`[Supabase API] Fetched ${adminsData.length} of ${count || '?'} admins...`);

        // If we got less than a full page, we're done
        if (data.length < adminsPageSize) {
          break;
        }
      } else {
        break;
      }
    } while (true);

    if (adminsError) {
      console.error('[Supabase API] Admins fetch error:', adminsError);
      throw adminsError;
    }

    // Build query with optional last_updated filter for incremental sync
    // IMPORTANT: Filter out tokens with NULL admin_username to avoid sending invalid tokens
    // Only fetch columns actually used by the extension
    const tokensQuery = supabase
      .from('tokens')
      .select('admin_username, base_token, token_name, token_symbol, twitter_url, website_url, created_at, market_cap, ath_market_cap, token_score, last_updated', { count: 'exact' })
      .not('admin_username', 'is', null)
      .order('admin_username', { ascending: true });

    // Apply incremental filter if provided
    if (isIncremental) {
      tokensQuery.gt('last_updated', lastSync);
    }

    // Fetch ALL tokens from Supabase (handle pagination)
    let tokensData = [];
    let tokensError = null;
    let tokensPage = 0;
    const tokensPageSize = 1000;

    do {
      const { data, error, count } = await tokensQuery
        .range(tokensPage * tokensPageSize, (tokensPage + 1) * tokensPageSize - 1);

      if (error) {
        tokensError = error;
        break;
      }

      if (data && data.length > 0) {
        tokensData = tokensData.concat(data);
        tokensPage++;

        // Log progress for large datasets
        console.log(`[Supabase API] Fetched ${tokensData.length} of ${count || '?'} tokens...`);

        // If we got less than a full page, we're done
        if (data.length < tokensPageSize) {
          break;
        }
      } else {
        break;
      }
    } while (true);

    if (tokensError) {
      console.error('[Supabase API] Tokens fetch error:', tokensError);
      throw tokensError;
    }

    console.log(`[Supabase API] ${syncType} sync complete:`, adminsData?.length || 0, 'admins,', tokensData?.length || 0, 'tokens');

    // Transform admins to Sheets format
    const admins = transformAdminsToSheetsFormat(adminsData || []);

    // Transform ALL tokens to Sheets format (no splitting - Supabase has one tokens table)
    const allTokens = transformTokensToSheetsFormat(tokensData || []);

    console.log('[Supabase API] Returning data:', {
      admins: admins.length,
      tokens: allTokens.length
    });

    res.json({
      success: true,
      admins: admins,
      tokens: allTokens,
      failedTokens: [],  // Empty - Supabase has one tokens table, no separate failed list
      comments: [],      // Empty - comments removed
      dailyStats: []     // Empty - daily stats removed
    });

  } catch (error) {
    console.error('[Supabase API] Error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
};
