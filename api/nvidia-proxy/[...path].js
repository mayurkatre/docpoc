export default async function handler(req, res) {
  // Build target URL – keep the path after /api/nvidia-proxy
  const targetPath = req.url.replace(/^\/api\/nvidia-proxy\//, '/');
  const targetUrl = `https://integrate.api.nvidia.com${targetPath}`;

  // Forward the incoming request, injecting the Authorization header
  const response = await fetch(targetUrl, {
    method: req.method,
    headers: {
      ...req.headers,
      // Expect the key to be set as VERCEL environment variable
      Authorization: `Bearer ${process.env.NVIDIA_API_KEY}`,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: req.method !== 'GET' && req.method !== 'HEAD' ? JSON.stringify(req.body) : undefined,
  });

  const data = await response.text();

  // Mirror the response back to the client
  res.setHeader('Content-Type', response.headers.get('content-type') || 'application/json');
  res.status(response.status).send(data);
}
