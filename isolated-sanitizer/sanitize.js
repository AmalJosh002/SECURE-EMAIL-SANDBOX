const { JSDOM } = require('jsdom');
const createDOMPurify = require('dompurify');

const window = new JSDOM('').window;
const DOMPurify = createDOMPurify(window);

const PURIFY_CONFIG = {
  ALLOWED_TAGS: ['p', 'b', 'i', 'em', 'strong', 'a', 'br', 'div', 'span', 'h1', 'h2', 'h3', 'img', 'table', 'tr', 'td', 'th', 'tbody'],
  ALLOWED_ATTR: ['href', 'src', 'target', 'style', 'alt'],
  FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form'],
  FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onmouseover']
};

try {
  const base64Data = process.argv[2];
  if (!base64Data) {
    throw new Error("No data arguments passed to execution vector.");
  }

  const decodedJson = Buffer.from(base64Data, 'base64').toString('utf8');
  const emailData = JSON.parse(decodedJson);
  
  let rawHtml = emailData.htmlBody;
  if (!rawHtml || rawHtml.trim() === '') {
    const bodyContent = emailData.snippet || '(No text content available in this message)';
    rawHtml = `<p style="white-space: pre-wrap;">${bodyContent}</p>`;
  }

  // 1. Sanitize the HTML payload using DOMPurify
  let cleanHtml = DOMPurify.sanitize(rawHtml, PURIFY_CONFIG);

  // 2. NEW: Intercept and rewrite hyperlinks to point to our secure URL sandbox
  const dom = new JSDOM(cleanHtml);
  const document = dom.window.document;
  const links = document.querySelectorAll('a');

  links.forEach(link => {
    const originalUrl = link.getAttribute('href');
    // Ensure it's a valid web link
    if (originalUrl && (originalUrl.startsWith('http://') || originalUrl.startsWith('https://'))) {
      // Route through our host interceptor endpoint
      link.setAttribute('href', `/sandbox-link?url=${encodeURIComponent(originalUrl)}`);
      link.setAttribute('target', '_blank'); // Force open in a secure new tab
      link.setAttribute('style', 'color: #1a73e8; text-decoration: underline;');
    }
  });

  cleanHtml = document.body.innerHTML;

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

  process.stdout.write(finalizedOutput);
  process.exit(0);

} catch (error) {
  process.stderr.write(`Sanitizer Internal Exception: ${error.message}\n`);
  process.exit(1);
}