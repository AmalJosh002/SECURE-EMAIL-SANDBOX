const { JSDOM } = require('jsdom');
const createDOMPurify = require('dompurify');

// 1. Initialize a virtual browser window using JSDOM
const window = new JSDOM('').window;
const DOMPurify = createDOMPurify(window);

// 2. Configure DOMPurify settings to be highly restrictive
const PURIFY_CONFIG = {
  ALLOWED_TAGS: ['p', 'b', 'i', 'em', 'strong', 'a', 'br', 'div', 'span', 'h1', 'h2', 'h3', 'img', 'table', 'tr', 'td', 'th', 'tbody'],
  ALLOWED_ATTR: ['href', 'src', 'target', 'style', 'alt'],
  FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form'], // Block executable elements completely
  FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onmouseover'] // Prevent sneaky inline JS attacks
};

// 3. Read raw email data from standard input (passed from our main API)
let inputBuffer = '';

process.stdin.on('data', (chunk) => {
  inputBuffer += chunk;
});

process.stdin.on('end', () => {
  try {
    // Parse the input data (Expecting JSON from our main app)
    const emailData = JSON.parse(inputBuffer);
    const rawHtml = emailData.htmlBody || `<p>${emailData.snippet}</p>`;

    // Execute the sanitization process inside the sandbox
    const cleanHtml = DOMPurify.sanitize(rawHtml, PURIFY_CONFIG);

    // Wrap it in a clean layout and output it via stdout
    const finalizedOutput = `
      <div class="secure-email-container" style="font-family: sans-serif; color: #333; line-height: 1.5;">
        <div class="email-metadata" style="background: #f1f3f4; padding: 10px; border-radius: 4px; margin-bottom: 15px;">
          <strong>From:</strong> ${emailData.from || 'Unknown'}<br/>
          <strong>Subject:</strong> ${emailData.subject || '(No Subject)'}
        </div>
        <div class="email-body">
          ${cleanHtml}
        </div>
      </div>
    `;

    // Output the safe content back to our main server
    process.stdout.write(finalizedOutput);
    process.exit(0); // Exit successfully

  } catch (error) {
    process.stderr.write(`Sanitizer Error: ${error.message}`);
    process.exit(1); // Exit with error code
  }
});