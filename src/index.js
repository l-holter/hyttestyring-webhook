import express from 'express';
import PocketBase from 'pocketbase';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import https from 'https';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

dotenv.config();

const app = express();
const port = process.env.PORT || 3038;

const PB_USERNAME = process.env.PB_USERNAME;
const PB_PASSWORD = process.env.PB_PASSWORD;

const PHONE_NUMBER = process.env.TARGET_PHONE_NUMBER;

const pb = new PocketBase('http://pocketbase:8095');
let pbAuthToken = null;

async function withRetry(operation, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      if (!pb.authStore.isValid) {
        await authenticateWithPocketBase();
      }
      return await operation();
    } catch (error) {
      console.error(`Operation failed (attempt ${i + 1}):`, error);
      if (i < maxRetries - 1) {
        pb.authStore.clear();
        await new Promise(res => setTimeout(res, 5000));
      } else {
        throw error;
      }
    }
  }
}

const authenticateWithPocketBase = async (retries = 3, delay = 5000) => {
  for (let i = 0; i < retries; i++) {
    try {
      const authData = await pb.collection("users").authWithPassword(PB_USERNAME, PB_PASSWORD);
      pbAuthToken = authData.token;
      console.log('Authenticated successfully with PocketBase');
      return;
    } catch (error) {
      console.error(`Error authenticating with PocketBase (attempt ${i + 1}):`, error);
      if (i < retries - 1) {
        await new Promise(res => setTimeout(res, delay));
      }
    }
  }
  console.error('Failed to authenticate with PocketBase after multiple attempts');
};

authenticateWithPocketBase();

function parseMessage(message) {
  const response = {
    text: message,
    temperatures: {},
    isHeatingOn: {},
    isFrostProtectionOn: {}
  };

  const lines = message.split('\n');

  const isFrostProtectionMessage = lines.some(line => line.includes('Temp knt: PÅ'));

  if (isFrostProtectionMessage) {
    let sensorId = 'main';

    for (const line of lines) {
      if (line.includes('"Stua1"')) sensorId = 'Stua1';
      else if (line.includes('"Stua2"')) sensorId = 'Stua2';
      else if (line.includes('"Sov1"')) sensorId = 'Sov1';

      const tempMatch = line.match(/(Hovedenhet|"[^"]+"):\s*(PÅ|AV)\s+(-?\d+|--)?C/);
      if (tempMatch) {
        response.isHeatingOn[sensorId] = tempMatch[2] === 'PÅ';
        response.temperatures[sensorId] = tempMatch[3] === '--' ? null : parseInt(tempMatch[3]);
        continue;
      }

      if (line.includes('Temp knt: PÅ')) {
        response.isFrostProtectionOn[sensorId] = true;
      }
    }
  } else {
    for (const line of lines) {
      const mainMatch = line.match(/Hovedenhet: (PÅ|AV)\s+(-?\d+|--)?C\s*(T?)/);
      if (mainMatch) {
        response.isHeatingOn.main = mainMatch[1] === 'PÅ';
        response.temperatures.main = mainMatch[2] === '--' ? null : parseInt(mainMatch[2]);
        response.isFrostProtectionOn.main = mainMatch[3] === 'T';
        continue;
      }

      const roomMatch = line.match(/"(Stua1|Stua2|Sov1)": (PÅ|AV), (-?\d+|--)?C\s*(T?)/);
      if (roomMatch) {
        const room = roomMatch[1];
        response.isHeatingOn[room] = roomMatch[2] === 'PÅ';
        response.temperatures[room] = roomMatch[3] === '--' ? null : parseInt(roomMatch[3]);
        response.isFrostProtectionOn[room] = roomMatch[4] === 'T';
      }
    }
  }

  return response;
}

app.use(express.json());

app.post('/webhook/sms', async (req, res) => {
  try {
    const { event, payload } = req.body;

    if (event !== 'sms:received') {
      return res.status(400).json({ error: 'Invalid event type' });
    }

    if (payload.phoneNumber !== PHONE_NUMBER) {
      return res.status(400).json({ error: 'Invalid payload' });
    }

    const messageRecord = await withRetry(async () => {
      return await pb.collection('messages').create({
        message: payload.message,
        phoneNumber: payload.phoneNumber,
        receivedAt: payload.receivedAt,
      });
    });

    const parsed = parseMessage(payload.message);

    for (const id of ['main', 'Stua1', 'Stua2', 'Sov1']) {
      if (parsed.temperatures[id] !== undefined) {
        const heatingState = {
          temperature: parsed.temperatures[id],
          isHeatingOn: parsed.isHeatingOn[id],
          isFrostProtectionOn: parsed.isFrostProtectionOn[id],
          lastCommand: payload.message,
          lastCommandSuccess: true,
        };
        await withRetry(async () => {
          await pb.collection('heating_state').update(id.toLowerCase(), heatingState);
        });
      }
    }

    res.status(200).json({
      success: true,
      messageId: messageRecord.id,
    });
  } catch (error) {
    console.error('Error processing webhook:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

const key = process.env.SSL_KEY;
const cert = process.env.SSL_CERT;

if (!key || !cert) {
  console.error('SSL_KEY and SSL_CERT environment variables must be set.');
  process.exit(1);
}

const sslOptions = {
  key: Buffer.from(key, 'base64').toString('utf8'),
  cert: Buffer.from(cert, 'base64').toString('utf8'),
};

const server = https.createServer(sslOptions, app);
server.listen(port, '0.0.0.0', () => {
  console.log(`Webhook service listening on port ${port} (HTTPS)`);
});