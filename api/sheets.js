import { google } from 'googleapis';
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
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
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

  try {
    const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);

    const auth = new google.auth.GoogleAuth({
      credentials: credentials,
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });

    const sheets = google.sheets({ version: 'v4', auth });
    const range = req.query.range;

    if (range) {
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId: process.env.SPREADSHEET_ID,
        range: range
      });
      res.json({ success: true, values: response.data.values || [] });
    } else {
      const [adminResponse, tokensResponse, failedTokensResponse, commentsResponse, dailyStatsResponse] = await Promise.all([
        sheets.spreadsheets.values.get({ spreadsheetId: process.env.SPREADSHEET_ID, range: "'Admins'!A1:N" }),
        sheets.spreadsheets.values.get({ spreadsheetId: process.env.SPREADSHEET_ID, range: "'Tokens - Sorted by Admin'!A1:I" }),
        sheets.spreadsheets.values.get({ spreadsheetId: process.env.SPREADSHEET_ID, range: "'Tokens - Failed (Under 10k)'!A1:I" }),
        sheets.spreadsheets.values.get({ spreadsheetId: process.env.SPREADSHEET_ID, range: "'Comments'!A1:F" }).catch(() => ({ data: { values: null } })),
        sheets.spreadsheets.values.get({ spreadsheetId: process.env.SPREADSHEET_ID, range: "'Daily Stats'!A1:Q" }).catch(() => ({ data: { values: null } }))
      ]);

      res.json({
        success: true,
        admins: adminResponse.data.values || [],
        tokens: tokensResponse.data.values || [],
        failedTokens: failedTokensResponse.data.values || [],
        comments: commentsResponse.data.values || [],
        dailyStats: dailyStatsResponse.data.values || []
      });
    }
  } catch (error) {
    console.error('API Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
}
