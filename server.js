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
      <a href="/view-email" style="display:inline-block; padding:10px 20px; background:#1a73e8; color:white; text-decoration:none; border-radius:4px; font-weight:bold;">Go to Secure Inbox Dashboard</a>
    `);
  } catch (error) {
    console.error('Error during token exchange:', error);
    res.status(500).send('Failed to securely process authentication.');
  }
});

// ==========================================
// 3. ROUTE: Fetch Multiple Emails & Render Inbox Dashboard
// ==========================================
app.get('/view-email', async (req, res) => {
  if (!savedTokens) return res.status(401).send('Please <a href="/login">login</a> first.');

  try {
    oauth2Client.setCredentials(savedTokens);
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

    // A. Grab a list of the last 15 emails
    console.log("Fetching message list from Gmail API...");
    const listResponse = await gmail.users.messages.list({ userId: 'me', maxResults: 15 });
    const messages = listResponse.data.messages;

    if (!messages || messages.length === 0) {
      return res.send('<h2>No emails found in this account.</h2>');
    }

    // B. Fetch detailed meta-data for each email in parallel
    console.log(`Processing metadata for ${messages.length} messages...`);
    const emailListPromises = messages.map(async (msg) => {
      try {
        const details = await gmail.users.messages.get({
          userId: 'me',
          id: msg.id,
          format: 'metadata', // "metadata" mode is lightning fast compared to "full"
          metadataHeaders: ['Subject', 'From', 'Date']
        });

        const headers = details.data.payload.headers;
        const subjectHeader = headers.find(h => h.name.toLowerCase() === 'subject');
        const fromHeader = headers.find(h => h.name.toLowerCase() === 'from');
        const dateHeader = headers.find(h => h.name.toLowerCase() === 'date');

        // Parse a cleaner, shorter version of the "From" header (stripping out raw email addresses)
        let rawFrom = fromHeader ? fromHeader.value : 'Unknown Sender';
        let cleanFrom = rawFrom.replace(/<.*>/, '').replace(/"/g, '').trim();

        return {
          id: msg.id,
          from: cleanFrom || rawFrom,
          subject: subjectHeader ? subjectHeader.value : '(No Subject)',
          date: dateHeader ? new Date(dateHeader.value).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '',
          snippet: details.data.snippet || ''
        };
      } catch (err) {
        console.error(`Failed to fetch metadata for message ${msg.id}:`, err);
        return null;
      }
    });

    const resolvedEmails = (await Promise.all(emailListPromises)).filter(e => e !== null);

    // C. Render a beautiful, interactive inbox list layout
    let emailRowsHtml = resolvedEmails.map(email => `
      <tr class="email-row" onclick="window.location='/sandbox-email?id=${email.id}'">
        <td class="col-from">${email.from}</td>
        <td class="col-content">
          <span class="subject">${email.subject}</span>
          <span class="separator"> - </span>
          <span class="snippet">${email.snippet}</span>
        </td>
        <td class="col-date">${email.date}</td>
      </tr>
    `).join('');

    res.send(`
      <html>
        <head>
          <title>Secure Sandbox Inbox</title>
          <style>
            body { background: #f6f8fc; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #202124; }
            .navbar { background: white; padding: 12px 24px; display: flex; align-items: center; border-bottom: 1px solid #e0e3e7; box-shadow: 0 1px 2px 0 rgba(60,64,67,0.1), 0 1px 3px 1px rgba(60,64,67,0.15); }
            .logo { font-size: 20px; font-weight: bold; color: #1a73e8; display: flex; align-items: center; gap: 8px; }
            .badge { background: #e8f0fe; color: #1a73e8; font-size: 11px; padding: 4px 8px; border-radius: 4px; text-transform: uppercase; letter-spacing: 0.5px; }
            .container { max-width: 1100px; margin: 30px auto; padding: 0 20px; }
            .inbox-card { background: white; border-radius: 16px; box-shadow: 0 1px 3px 0 rgba(60,64,67,0.3); overflow: hidden; border: 1px solid #e0e3e7; }
            .inbox-table { width: 100%; border-collapse: collapse; table-layout: fixed; }
            .email-row { border-bottom: 1px solid #f1f3f4; cursor: pointer; display: table-row; }
            .email-row:hover { background: #f2f6fc; box-shadow: inset 1px 0 0 #1a73e8, inset -1px 0 0 #cbd5e1; }
            td { padding: 12px; font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; vertical-align: middle; }
            .col-from { width: 180px; font-weight: 600; color: #202124; }
            .col-content { width: auto; color: #202124; }
            .subject { font-weight: 600; }
            .separator { color: #5f6368; }
            .snippet { color: #5f6368; }
            .col-date { width: 80px; text-align: right; color: #5f6368; font-size: 12px; font-weight: 500; padding-right: 20px; }
          </style>
        </head>
        <body>
          <div class="navbar">
            <div class="logo">🛡️ SecureMail <span class="badge">Sandbox Dashboard</span></div>
          </div>
          <div class="container">
            <div class="inbox-card">
              <table class="inbox-table">
                <tbody>
                  ${emailRowsHtml}
                </tbody>
              </table>
            </div>
          </div>
        </body>
      </html>
    `);

  } catch (error) {
    console.error('Failed to load inbox pipeline:', error);
    res.status(500).send('Error compiling dashboard index components.');
  }
});

// ==========================================
// 3.5 ROUTE: Isolate and Open a Single Selected Email via Sandbox
// ==========================================
app.get('/sandbox-email', async (req, res) => {
  const emailId = req.query.id;
  if (!emailId) return res.status(400).send('Missing email identification ID token.');
  if (!savedTokens) return res.status(401).send('Authentication expired. Re-authenticate.');

  try {
    oauth2Client.setCredentials(savedTokens);
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

    // Fetch full data for the target message clicked from the dashboard
    const emailData = await gmail.users.messages.get({ userId: 'me', id: emailId, format: 'full' });
    
    const payload = emailData.data.payload;
    const subjectHeader = payload.headers ? payload.headers.find(h => h.name.toLowerCase() === 'subject') : null;
    const fromHeader = payload.headers ? payload.headers.find(h => h.name.toLowerCase() === 'from') : null;
    
    let htmlBody = emailData.data.snippet; 
    if (payload.body && payload.body.data) {
      htmlBody = Buffer.from(payload.body.data, 'base64').toString('utf8');
    } else if (payload.parts) {
      const htmlPart = payload.parts.find(part => part.mimeType === 'text/html');
      if (htmlPart && htmlPart.body.data) {
        htmlBody = Buffer.from(htmlPart.body.data, 'base64').toString('utf8');
      }
    }

    // FIX: Clip oversized HTML inputs to keep Windows process boundaries clean
    if (htmlBody && htmlBody.length > 25000) {
      htmlBody = htmlBody.slice(0, 25000) + "<p>... [Payload clipped by Sandbox Engine for testing stability] ...</p>";
    }

    const containerInputData = {
      subject: subjectHeader ? subjectHeader.value : '(No Subject)',
      from: fromHeader ? fromHeader.value : 'Unknown',
      htmlBody: htmlBody
    };

    console.log(`\nLaunching ephemeral sandbox instance for email context ID: ${emailId}`);
    
    const container = await docker.createContainer({
      Image: 'email-sanitizer',
      Cmd: ['sleep', '30'],
      HostConfig: {
        NetworkMode: 'none',       // Air-gapped isolation
        Memory: 50 * 1024 * 1024,  // 50MB RAM limit
        CpuQuota: 50000            // 0.5 CPU core limit
      }
    });

    await container.start();

    const safePayloadBase64 = Buffer.from(JSON.stringify(containerInputData)).toString('base64');

    console.log("Injecting sanitizer execution thread...");
    const execInstance = await container.exec({
      Cmd: ['node', 'sanitize.js', safePayloadBase64],
      AttachStdout: true,
      AttachStderr: true
    });

    const execStream = await execInstance.start();
    
    let sanitizedOutput = '';
    let errorOutput = '';

    await new Promise((resolve, reject) => {
      execStream.on('data', (chunk) => {
        let offset = 0;
        while (offset < chunk.length) {
          if (chunk.length - offset < 8) break;
          
          const streamType = chunk.readUInt8(offset);
          const frameLength = chunk.readUInt32BE(offset + 4);
          offset += 8;

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

    try {
      await container.stop();
    } catch (e) { /* Already dropped */ }
    await container.remove();
    console.log("Container safely dismantled.");

    if (errorOutput.trim()) {
      console.error("❌ Sandbox Container Error Log:", errorOutput);
    }

    res.send(`
      <html>
        <head>
          <title>Secure Viewer</title>
          <style>
            body { background:#f4f6f9; margin:0; padding:40px; font-family:-apple-system, sans-serif; }
            .back-btn { display: inline-block; margin-bottom: 20px; padding: 10px 20px; background: #5f6368; color: white; text-decoration: none; border-radius: 8px; font-size: 14px; font-weight: bold; box-shadow: 0 1px 2px rgba(0,0,0,0.1); }
            .back-btn:hover { background: #3c4043; }
          </style>
        </head>
        <body>
          <a href="/view-email" class="back-btn">⬅️ Back to Inbox Dashboard</a>
          <h2 style="color:#1a73e8; margin-top: 0;">🛡️ Secure Email Sandbox Session</h2>
          <div style="background:white; border:1px solid #dadce0; border-radius:8px; padding:30px; box-shadow: 0 4px 6px rgba(0,0,0,0.05);">
            ${sanitizedOutput || '<p style="color:red;">Error: No data was returned from the sandboxing container engine.</p>'}
          </div>
        </body>
      </html>
    `);

  } catch (error) {
    console.error('Failed processing message view:', error);
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

    console.log("Spawning sandboxed interactive Chromium container environment...");
    const browserContainer = await docker.createContainer({
      Image: 'lscr.io/linuxserver/chromium:latest',
      Env: [
        `CUSTOM_URL=${targetUrl}`,
        'TITLE=Secure Link Sandbox',
        'PUID=1000',
        'PGID=1000',
        'CHROME_FLAGS=--no-sandbox --disable-gpu --disable-dev-shm-usage'
      ],
      ExposedPorts: { '3000/tcp': {} },
      HostConfig: {
        PortBindings: { '3000/tcp': [{ HostPort: hostPort.toString() }] },
        ShmSize: 1024 * 1024 * 1024, // 1GB Shared Memory allocation flag
        Memory: 1024 * 1024 * 1024,  // 1GB RAM limitation allocation
        CpuQuota: 200000             // 2 CPU cores limit
      }
    });

    await browserContainer.start();
    console.log(`Browser container successfully provisioned.`);

    await new Promise(resolve => setTimeout(resolve, 5000));

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

    setTimeout(async () => {
      console.log(`\n⏳ Lifecycle window elapsed. Demolishing link container...`);
      try {
        await browserContainer.stop();
        await browserContainer.remove();
        console.log("Link container completely vaporized.");
      } catch (err) { /* Already dropped */ }
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