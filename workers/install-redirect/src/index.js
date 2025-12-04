/**
 * Teleportation Install Redirect Worker
 * 
 * Routes:
 *   GET /         → Install script (curl -fsSL https://get.teleportation.dev | bash)
 *   GET /install  → Same as above
 *   GET /version  → Returns latest version
 *   GET /docs     → Redirects to documentation
 */

const INSTALL_SCRIPT_URL = 'https://raw.githubusercontent.com/dundas/teleportation-cli/main/scripts/install.sh';
const DOCS_URL = 'https://github.com/dundas/teleportation-cli#readme';
const VERSION = '0.2.0';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Handle different routes
    switch (path) {
      case '/':
      case '/install':
      case '/install.sh':
        return handleInstallScript(request);
      
      case '/version':
        return new Response(VERSION, {
          headers: { 'Content-Type': 'text/plain' }
        });
      
      case '/docs':
        return Response.redirect(DOCS_URL, 302);
      
      case '/health':
        return new Response('OK', { status: 200 });
      
      default:
        return new Response('Not Found\n\nUsage: curl -fsSL https://get.teleportation.dev | bash', {
          status: 404,
          headers: { 'Content-Type': 'text/plain' }
        });
    }
  }
};

async function handleInstallScript(request) {
  // Fetch the install script from GitHub
  const response = await fetch(INSTALL_SCRIPT_URL, {
    headers: {
      'User-Agent': 'Teleportation-Install-Worker'
    }
  });

  if (!response.ok) {
    return new Response('Failed to fetch install script', { status: 502 });
  }

  const script = await response.text();

  // Return the script with appropriate headers
  return new Response(script, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=300', // Cache for 5 minutes
      'X-Teleportation-Version': VERSION
    }
  });
}

