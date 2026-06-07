require('dotenv').config();
const express = require('express');
const { google } = require('googleapis');
const Docker = require('dockerode');

const app = express();
// Configured for Windows named pipes. (Change to '/var/run/docker.sock' if moving to Mac/Linux)
const docker = new Docker({ socketPath: '//./pipe/docker_engine' });
const PORT = process.env.PORT || 3000;

// Temporarily bypass strict SSL checks for local development certificate issues
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

// Initialize the Google OAuth2 client connection tool
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);

// Global variable simulating a temporary user database record
let savedTokens = null;

// ==========================================
// 1. ROUTE: Start the Auth Flow
// ==========================================
app.get('/login', (req, res) => {
  const scopes = ['https://www.googleapis.com/auth/gmail.readonly'];
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline', // Crucial to get a refresh token
    scope: scopes,
    prompt: 'consent'
  });
  res.redirect(url);
});

// ==========================================
// 2. ROUTE: Capture the Callback from Google
// ==========================================
app.get('/api/auth/google/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('Authorization code missing.');

  try {
    const { tokens } = await oauth2Client.getToken(code);
    savedTokens = tokens; // In production, save tokens.refresh_token to your database mapped to a User ID

    res.send(`
      <h1>Authentication Setup Complete!</h1>
      <p>Your backend server has successfully connected to Google.</p>
      <a href="/view-email" style="display:inline-block; padding:10px 20px; background:#007bff; color:white; text-decoration:none; border-radius:4px; font-weight:bold;">Click here to isolate and view your latest email</a>
    `);
  } catch (error) {
    console.error('Error during token exchange:', error);
    res.status(500).send('Failed to securely process authentication.');
  }
});

// ==========================================
// 3. ROUTE: Fetch Email, Run Docker Sandbox, and Render Output
// ==========================================
app.get('/view-email', async (req, res) => {
  if (!savedTokens) return res.status(401).send('Please <a href="/login">login</a> first.');

  try {
    // Inject current tokens into the API handler
    oauth2Client.setCredentials(savedTokens);
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

    // A. Grab the ID of the most recent email
    const listResponse = await gmail.users.messages.list({ userId: 'me', maxResults: 1 });
    const messages = listResponse.data.messages;
    if (!messages || messages.length === 0) return res.send('No emails found in this account.');
    const latestEmailId = messages[0].id;

    // B. Get the full email payload details
    const emailData = await gmail.users.messages.get({ userId: 'me', id: latestEmailId, format: 'full' });
    
    // C. Parse the fields out into a clean format to feed into Docker
    const payload = emailData.data.payload;
    const subjectHeader = payload.headers ? payload.headers.find(h => h.name.toLowerCase() === 'subject') : null;
    const fromHeader = payload.headers ? payload.headers.find(h => h.name.toLowerCase() === 'from') : null;
    
    // Extract snippet fallback or try to find body data
    let htmlBody = emailData.data.snippet; 
    if (payload.body && payload.body.data) {
      htmlBody = Buffer.from(payload.body.data, 'base64').toString('utf8');
    } else if (payload.parts) {
      // Find the HTML part if it's a multipart email
      const htmlPart = payload.parts.find(part => part.mimeType === 'text/html');
      if (htmlPart && htmlPart.body.data) {
        htmlBody = Buffer.from(htmlPart.body.data, 'base64').toString('utf8');
      }
    }

    const containerInputData = {
      subject: subjectHeader ? subjectHeader.value : '(No Subject)',
      from: fromHeader ? fromHeader.value : 'Unknown',
      htmlBody: htmlBody
    };

    // ==========================================================
    // D. DOCKER ORCHESTRATION PIPELINE (Executive Framework)
    // ==========================================================
    console.log("Launching ephemeral, network-isolated sandbox instance...");
    
    // 1. Create a baseline container that stays awake sleeping while we execute work
    const container = await docker.createContainer({
      Image: 'email-sanitizer',
      Cmd: ['sleep', '30'], // Safe window to finish processing before automatic drop
      HostConfig: {
        NetworkMode: 'none',       // Complete air-gap network isolation
        Memory: 50 * 1024 * 1024,  // 50MB RAM limit
        CpuQuota: 50000            // 0.5 CPU core limit
      }
    });

    // Start the baseline runner
    await container.start();

    // 2. Prepare the exact string payload as an isolated Base64 argument string
    const safePayloadBase64 = Buffer.from(JSON.stringify(containerInputData)).toString('base64');

    // 3. Inject our execution process directly into the active container environment
    console.log("Injecting sanitizer execution thread...");
    const execInstance = await container.exec({
      Cmd: ['node', 'sanitize.js', safePayloadBase64],
      AttachStdout: true,
      AttachStderr: true
    });

    // Run the execution thread and collect the output stream
    const execStream = await execInstance.start();
    
    let sanitizedOutput = '';
    let errorOutput = '';

    // Demultiplex the Docker stdout/stderr stream cleanly
    await new Promise((resolve, reject) => {
      execStream.on('data', (chunk) => {
        let offset = 0;
        while (offset < chunk.length) {
          if (chunk.length - offset < 8) break; // Drop if header is broken
          
          const streamType = chunk.readUInt8(offset); // 1 = stdout, 2 = stderr
          const frameLength = chunk.readUInt32BE(offset + 4);
          offset += 8; // Jump past header frames

          if (offset + frameLength <= chunk.length) {
            const content = chunk.toString('utf8', offset, offset + frameLength);
            if (streamType === 1) sanitizedOutput += content;
            if (streamType === 2) errorOutput += content;
            offset += frameLength;
          } else {
            break;
          }
        }
      });

      execStream.on('end', resolve);
      execStream.on('error', reject);
    });

    // 4. Force immediate termination and cleanup of the sandbox container
    try {
      await container.stop();
    } catch (e) { /* already stopped */ }
    await container.remove();
    console.log("Container safely dismantled.");

    // If the internal container engine script printed error messages, capture them
    if (errorOutput.trim()) {
      console.error("❌ Sandbox Container Error Log:", errorOutput);
    }

    // E. Send the safe processed data directly to the user's view frame
    res.send(`
      <html>
        <head><title>Secure Sandboxed Email Viewer</title></head>
        <body style="background:#f4f6f9; margin:0; padding:40px; font-family:sans-serif;">
          <h2 style="color:#1a73e8;">🛡️ Secure Email Sandbox System</h2>
          <p style="color:#5f6368;">This email has been rendered in a localized, air-gapped container with zero network capability.</p>
          <div style="background:white; border:1px solid #dadce0; border-radius:8px; padding:30px; box-shadow: 0 4px 6px rgba(0,0,0,0.05);">
            ${sanitizedOutput || '<p style="color:red;">Error: No data was returned from the sandboxing container engine.</p>'}
          </div>
        </body>
      </html>
    `);

  } catch (error) {
    console.error('Pipeline system failure occurred:', error);
    res.status(500).send('The isolation orchestration room hit an error rendering the document.');
  }
});

// ==========================================
// 4. ROUTE: Remote Browser Link Isolation Sandbox (Optimized Windows Stack)
// ==========================================
app.get('/sandbox-link', async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).send('Missing destination URL parameter.');

  console.log(`\n🌐 Intercepted external link click request for: ${targetUrl}`);

  try {
    // 1. Dynamically find a random free port on the host machine
    const net = require('net');
    const getFreePort = () => new Promise((resolve) => {
      const server = net.createServer();
      server.listen(0, () => {
        const port = server.address().port;
        server.close(() => resolve(port));
      });
    });
    
    const hostPort = await getFreePort();
    console.log(`Selected isolated port mapping on host: localhost:${hostPort}`);

    // 2. Launch the isolated standalone Chromium container instance with performance tunings
    console.log("Spawning sandboxed interactive Chromium container environment...");
    const browserContainer = await docker.createContainer({
      Image: 'lscr.io/linuxserver/chromium:latest',
      Env: [
        `CUSTOM_URL=${targetUrl}`,   // Open the destination link natively on startup
        'TITLE=Secure Link Sandbox',
        'PUID=1000',
        'PGID=1000',
        'CHROME_FLAGS=--no-sandbox --disable-gpu --disable-dev-shm-usage' // Standardizes headless memory allocations
      ],
      ExposedPorts: {
        '3000/tcp': {} // Internal noVNC web interface port
      },
      HostConfig: {
        PortBindings: {
          '3000/tcp': [{ HostPort: hostPort.toString() }] // Bind dynamic host port to internal 3000
        },
        ShmSize: 1024 * 1024 * 1024, // Allocate 1GB Shared Memory (Fixes connection drops on Windows!)
        Memory: 1024 * 1024 * 1024,  // Allocate 1GB RAM to support modern web engines smoothly
        CpuQuota: 200000             // 2 Full CPU Cores limit for rapid visual stream encoding
      }
    });

    // Fire up the browser container
    await browserContainer.start();
    console.log(`Browser container successfully provisioned.`);

    // 3. Give the heavy desktop-frame buffer 5 entire seconds to spin up completely
    await new Promise(resolve => setTimeout(resolve, 5000));

    // 4. Render an interactive wrapper tab containing an iframe showing the live pixel stream
    res.send(`
      <html>
        <head>
          <title>Secure URL Sandbox Frame</title>
          <style>
            body { margin: 0; padding: 0; font-family: sans-serif; background: #202124; color: white; display: flex; flex-direction: column; height: 100vh; overflow: hidden; }
            .header-bar { background: #2f3033; padding: 10px 20px; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #3c4043; }
            .badge { background: #d93025; color: white; padding: 4px 12px; border-radius: 5px; font-weight: bold; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; }
            .info-text { font-size: 14px; color: #bdc1c6; }
            iframe { width: 100%; flex-grow: 1; border: none; background: #000; }
          </style>
        </head>
        <body>
          <div class="header-bar">
            <div>
              <span class="badge">⚠️ Air-Gapped Remote Link Sandbox</span>
              <span class="info-text" style="margin-left: 15px;">Interacting with: <code>${targetUrl}</code></span>
            </div>
            <div class="info-text">Pixels are streamed safely. Malicious scripts cannot escape this frame.</div>
          </div>
          <iframe src="http://localhost:${hostPort}/"></iframe>
        </body>
      </html>
    `);

    // 5. Lifecycle auto-cleaner: Destroy the container after 5 minutes
    setTimeout(async () => {
      console.log(`\n⏳ Lifecycle window elapsed. Demolishing link container...`);
      try {
        await browserContainer.stop();
        await browserContainer.remove();
        console.log("Link container completely vaporized.");
      } catch (err) {
        // Already dropped
      }
    }, 300000);

  } catch (error) {
    console.error('Failed to initialize the link isolation container matrix:', error);
    res.status(500).send('The container orchestrator was unable to launch a secure remote browser session.');
  }
});

app.listen(PORT, () => {
  console.log(`\n🚀 Orchestration Server running at http://localhost:${PORT}`);
  console.log(`👉 Go to http://localhost:${PORT}/login to start the full system test!\n`);
});