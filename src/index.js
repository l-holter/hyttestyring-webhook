import express from 'express';
import PocketBase from 'pocketbase';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const pb = new PocketBase('http://pocketbase:8095');
const port = process.env.PORT || 3038;

const PB_USERNAME = process.env.PB_USERNAME;
const PB_PASSWORD = process.env.PB_PASSWORD;

let pbAuthToken = null;

const authenticateWithPocketBase = async () => {
  try {
    const authData = await pb.collection("users").authWithPassword(PB_USERNAME, PB_PASSWORD);
    pbAuthToken = authData.token;
    console.log('Authenticated successfully with PocketBase');
  } catch (error) {
    console.error('Error authenticating with PocketBase:', error);
  }
};

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

      const tempMatch = line.match(/(Hovedenhet|"[^"]+"):\s*(PÅ|AV)\s+(\d+)C/);
      if (tempMatch) {
        response.isHeatingOn[sensorId] = tempMatch[2] === 'PÅ';
        response.temperatures[sensorId] = parseInt(tempMatch[3]);
        continue;
      }

      if (line.includes('Temp knt: PÅ')) {
        response.isFrostProtectionOn[sensorId] = true;
      }
    }
  } else {
    for (const line of lines) {
      const mainMatch = line.match(/Hovedenhet: (PÅ|AV)\s+(\d+)C\s*(T?)/);
      if (mainMatch) {
        response.isHeatingOn.main = mainMatch[1] === 'PÅ';
        response.temperatures.main = parseInt(mainMatch[2]);
        response.isFrostProtectionOn.main = mainMatch[3] === 'T';
        continue;
      }

      const roomMatch = line.match(/"(Stua1|Stua2|Sov1)": (PÅ|AV), (\d+)C\s*(T?)/);
      if (roomMatch) {
        const room = roomMatch[1];
        response.isHeatingOn[room] = roomMatch[2] === 'PÅ';
        response.temperatures[room] = parseInt(roomMatch[3]);
        response.isFrostProtectionOn[room] = roomMatch[4] === 'T';
      }
    }
  }

  return response;
}

authenticateWithPocketBase();

app.use(express.json());

app.post('/webhook/sms', async (req, res) => {
  try {
    if (!pbAuthToken) {
      return res.status(403).json({ error: 'Not authenticated with PocketBase' });
    }

    const { event, payload } = req.body;

    if (event !== 'sms:received') {
      return res.status(400).json({ error: 'Invalid event type' });
    }

    const messageRecord = await pb.collection('messages').create({
      message: payload.message,
      phoneNumber: payload.phoneNumber,
      receivedAt: payload.receivedAt,
    });

    const parsed = parseMessage(payload.message);

    console.log(parsed);

    for (const id of ['main', 'Stua1', 'Stua2', 'Sov1']) {
      if (parsed.temperatures[id] !== undefined) {
        const heatingState = {
          temperature: parsed.temperatures[id],
          isHeatingOn: parsed.isHeatingOn[id],
          isFrostProtectionOn: parsed.isFrostProtectionOn[id],
          lastCommand: payload.message,
          lastCommandSuccess: true,
        };
        await pb.collection('heating_state').update(id.toLowerCase(), heatingState);
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

app.listen(port, '0.0.0.0', () => {
  console.log(`Webhook service listening on port ${port}`);
});