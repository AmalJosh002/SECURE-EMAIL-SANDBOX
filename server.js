require('dotenv').config();
const express = require('express');
const { google } = require('googleapis');
const Docker = require('dockerode');

const app = express();
const docker = new Docker({ socketPath: '//./pipe/docker_engine' });
const PORT = process.env.PORT || 3000;

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
    const subjectHeader = payload.headers.find(h => h.name.toLowerCase() === 'subject');
    const fromHeader = payload.headers.find(h => h.name.toLowerCase() === 'from');
    
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
    // D. DOCKER ORCHESTRATION PIPELINE
    // Spin up an ephemeral, network-isolated container, pass data, and get safe HTML
    // ==========================================================
    // ==========================================================
    // D. DOCKER ORCHESTRATION PIPELINE (Stream-Optimized)
    // ==========================================================
    console.log("Creating sandboxed container instance...");
    
    const container = await docker.createContainer({
      Image: 'email-sanitizer',
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      OpenStdin: true,
      StdinOnce: true,
      HostConfig: {
        NetworkMode: 'none',
        Memory: 50 * 1024 * 1024,
        CpuQuota: 50000
      }
    });

    // 1. Attach to the streams BEFORE starting the container so we don't miss the window
    const stream = await container.attach({
      stream: true,
      stdin: true,
      stdout: true,
      stderr: true
    });

    let sanitizedOutput = '';
    
    // 2. Set up data listeners to capture output strings
    stream.on('data', (chunk) => {
      let offset = 0;
      while (offset < chunk.length) {
        // Docker stream format prefixes chunks with an 8-byte header:
        // [1 byte stream type][3 bytes padded][4 bytes big-endian length]
        if (chunk.length - offset < 8) break; // Incomplete header chunk fallback

        const frameLength = chunk.readUInt32BE(offset + 4);
        offset += 8; // Advance past the 8-byte header block

        if (offset + frameLength <= chunk.length) {
          // Extract the exact payload text safely without messing up text characters
          sanitizedOutput += chunk.toString('utf8', offset, offset + frameLength);
          offset += frameLength;
        } else {
          // Fallback if buffer cuts off early
          sanitizedOutput += chunk.toString('utf8', offset);
          break;
        }
      }
    });

    // 3. Fire up the container engine
    await container.start();

    // 4. Immediately push your email JSON string into the container's mouth and close the door
    stream.write(JSON.stringify(containerInputData));
    stream.end();

    // 5. Enforce a strict 5-second maximum processing timeout so it never hangs your server again
    const containerWaitPromise = container.wait();
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Sandbox processing timeout exceeded')), 5000)
    );

    try {
      await Promise.race([containerWaitPromise, timeoutPromise]);
    } catch (timeoutError) {
      console.log("⚠️ Container timed out or hung. Forcing termination...");
    }
    
    // 6. Automatically stop and kill the container to free system resources
    try {
      await container.stop();
    } catch (e) { /* Already stopped */ }
    
    await container.remove();
    console.log("Container safely dismantled.");

    // E. Send the safe processed data directly to the user's view frame
    res.send(`
      <html>
        <head><title>Secure Sandboxed Email Viewer</title></head>
        <body style="background:#f4f6f9; margin:0; padding:40px; font-family:sans-serif;">
          <h2 style="color:#1a73e8;">🛡️ Secure Email Sandbox Sandbox System</h2>
          <p style="color:#5f6368;">This email has been rendered in a localized, air-gapped container with zero network capability.</p>
          <div style="background:white; border:1px solid #dadce0; border-radius:8px; padding:30px; box-shadow: 0 4px 6px rgba(0,0,0,0.05);">
            ${sanitizedOutput}
          </div>
        </body>
      </html>
    `);

  } catch (error) {
    console.error('Pipeline system failure occurred:', error);
    res.status(500).send('The isolation orchestration room hit an error rendering the document.');
  }
});

app.listen(PORT, () => {
  console.log(`\n🚀 Orchestration Server running at http://localhost:${PORT}`);
  console.log(`👉 Go to http://localhost:${PORT}/login to start the full system test!\n`);
});