export default async function handler(req, res) {
  // Capture the full path after /api/nvidia-proxy, preserving leading slash
  const targetPath = req.url.replace(/^\/api\/nvidia-proxy/, "");
  console.log('Vercel proxy: incoming path', req.url, '-> targetPath', targetPath);

  const targetUrl = `https://integrate.api.nvidia.com${targetPath}`;
  console.log('Vercel proxy: forwarding to', targetUrl);

  const response = await fetch(targetUrl, {
    method: req.method,
    headers: {
      ...req.headers,
      Authorization: `Bearer ${process.env.NVIDIA_API_KEY}`,
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    },
    body: req.method !== "GET" && req.method !== "HEAD" ? JSON.stringify(req.body) : undefined,
  });

  console.log('Vercel proxy: response status', response.status);
  const data = await response.text();

  res.setHeader("Content-Type", response.headers.get("content-type") || "application/json");
  res.status(response.status).send(data);
}
