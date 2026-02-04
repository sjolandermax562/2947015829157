export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

    try {
      const { key, deviceId } = req.query;

      if (!key) return res.status(400).json({ error: 'Missing key' });
      if (!deviceId) return res.status(400).json({ error: 'Missing deviceId' });

      // Get current device bindings
      const deviceBindings = process.env.DEVICE_BINDINGS || '';
      const bindings = {};

      if (deviceBindings) {
        deviceBindings.split(',').forEach(binding => {
          const [k, d] = binding.split(':');
          if (k && d) bindings[k] = d;
        });
      }

      // Check if revoked
      const revokedKeys = process.env.REVOKED_KEYS?.split(',') || [];
      if (revokedKeys.includes(key)) {
        return res.status(200).json({
          success: false,
          registered: false,
          reason: 'REVOKED',
          message: 'This license has been revoked.'
        });
      }

      // Check kill switch
      if (process.env.MASTER_KILL_SWITCH === 'true') {
        return res.status(200).json({
          success: false,
          registered: false,
          reason: 'MAINTENANCE',
          message: 'Extension is temporarily disabled.'
        });
      }

      const boundDeviceId = bindings[key];

      // Key not bound yet - auto-register this device (first come, first served)
      if (!boundDeviceId) {
        // Log for admin to add to env vars
        console.log(`[LICENSE REGISTRATION] New device for key ${key.substring(0, 8)}... : deviceId=${deviceId}`);

        return res.status(200).json({
          success: true,
          registered: true,
          alreadyBound: false,
          message: 'License activated successfully!'
        });
      }

      // Key already bound - check if it's this device
      if (boundDeviceId === deviceId) {
        return res.status(200).json({
          success: true,
          registered: true,
          alreadyBound: true,
          message: 'License already activated on this device.'
        });
      }

      // Different device - show error with device IDs
      console.log(`[LICENSE BLOCKED] Key ${key.substring(0, 8)}... - Attempted access from device: ${deviceId}, Bound to: ${boundDeviceId}`);

      return res.status(200).json({
        success: false,
        registered: false,
        reason: 'DEVICE_MISMATCH',
        alreadyBound: true,
        boundDeviceId: boundDeviceId,
        currentDeviceId: deviceId,
        message: `This license is already activated on another device. Your device ID: ${deviceId}`
      });

    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  }
