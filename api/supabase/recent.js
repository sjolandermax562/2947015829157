// Vercel serverless function for fetching recently updated admins and tokens from Supabase
// Only returns records updated in the last hour
// JWT authentication required

const { createClient } = require('@supabase/supabase-js');
const { jwtVerify } = require('jose');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-this';

const supabase = createClient(supabaseUrl, supabaseKey);
const secretKey = new TextEncoder().encode(JWT_SECRET);

/**
 * Verify JWT token for license validation
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
 * Format timestamp - handles Unix timestamps and ISO strings
 */
function formatTimestamp(timestamp) {
  if (!timestamp) return '';

  if (typeof timestamp === 'string' && (timestamp.includes('T') || timestamp.includes('-'))) {
    return timestamp;
  }

  const numTimestamp = typeof timestamp === 'string' ? parseInt(timestamp, 10) : timestamp;

  if (typeof numTimestamp === 'number' && !isNaN(numTimestamp) && numTimestamp > 0) {
    return new Date(numTimestamp * 1000).toISOString();
  }

  return '';
}

/**
 * Transform Supabase admins data to Sheets format
 */
function transformAdminsToSheetsFormat(admins) {
  if (!admins || admins.length === 0) {
    return [['admin_username', 'total_rating', 'tokens_score_0', 'tokens_score_1', 'tokens_score_2', 'tokens_score_3', 'tokens_score_4', 'tokens_score_5', 'tokens_score_6', 'total_tokens_created', 'winrate', 'avg_migrate_time', 'last_active', 'last_updated']];
  }

  const header = ['admin_username', 'total_rating', 'tokens_score_0', 'tokens_score_1', 'tokens_score_2', 'tokens_score_3', 'tokens_score_4', 'tokens_score_5', 'tokens_score_6', 'total_tokens_created', 'winrate', 'avg_migrate_time', 'last_active', 'last_updated'];

  const rows = admins.map(admin => [
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
    ((admin.winrate || 0) * 100).toString(),
    admin.avg_migrate_time ? formatMigrateTime(admin.avg_migrate_time) : '',
    formatTimestamp(admin.last_active),
    formatTimestamp(admin.last_updated)
  ]);

  return [header, ...rows];
}

/**
 * Transform Supabase tokens data to Sheets format
 */
function transformTokensToSheetsFormat(tokens) {
  if (!tokens || tokens.length === 0) {
    return [['admin_username', 'base_token', 'token_name', 'token_symbol', 'community_link', 'token_age', 'market_cap', 'ath_market_cap', 'token_score']];
  }

  const header = ['admin_username', 'base_token', 'token_name', 'token_symbol', 'community_link', 'token_age', 'market_cap', 'ath_market_cap', 'token_score'];

  const rows = tokens.map(token => [
    (token.admin_username || '').toLowerCase().trim(),
    token.base_token || '',
    token.token_name || '',
    token.token_symbol || '',
    token.twitter_url || token.website_url || '',
    calculateTokenAge(token.created_at),
    (token.market_cap ?? 0).toString(),
    token.ath_market_cap || '0',
    token.token_score?.toString() || '0'
  ]);

  return [header, ...rows];
}

module.exports = async function handler(req, res) {
  // Set CORS headers
  const origin = req.headers.origin;

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

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Verify license token
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
        last_endpoint: 'supabase/recent'
      })
      .eq('device_id', payload.deviceId);
  } catch (logError) {
    console.error('[Supabase Recent API] Tracking update error:', logError);
  }

  try {
    console.log('[Supabase Recent API] Fetching recent updates (last 1 hour)...');

    // Calculate timestamp for 1 hour ago (in seconds, Unix format)
    const oneHourAgo = Math.floor((Date.now() - 60 * 60 * 1000) / 1000);

    // Fetch admins updated in the last hour
    const { data: adminsData, error: adminsError } = await supabase
      .from('admins')
      .select('*')
      .gt('last_updated', oneHourAgo)
      .order('last_updated', { ascending: false });

    if (adminsError) {
      console.error('[Supabase Recent API] Admins fetch error:', adminsError);
      throw adminsError;
    }

    // Fetch tokens updated in the last hour
    let tokensData = [];
    let tokensPage = 0;
    const tokensPageSize = 1000;

    do {
      const { data, error } = await supabase
        .from('tokens')
        .select('*')
        .gt('last_updated', oneHourAgo)
        .order('last_updated', { ascending: false })
        .range(tokensPage * tokensPageSize, (tokensPage + 1) * tokensPageSize - 1);

      if (error) {
        console.error('[Supabase Recent API] Tokens fetch error:', error);
        throw error;
      }

      if (data && data.length > 0) {
        tokensData = tokensData.concat(data);
        tokensPage++;

        console.log(`[Supabase Recent API] Fetched ${tokensData.length} recent tokens...`);

        if (data.length < tokensPageSize) {
          break;
        }
      } else {
        break;
      }
    } while (true);

    console.log('[Supabase Recent API] Returning:', {
      admins: adminsData?.length || 0,
      tokens: tokensData.length
    });

    res.json({
      success: true,
      admins: transformAdminsToSheetsFormat(adminsData || []),
      tokens: transformTokensToSheetsFormat(tokensData),
      failedTokens: [],
      comments: [],
      dailyStats: []
    });

  } catch (error) {
    console.error('[Supabase Recent API] Error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
};
