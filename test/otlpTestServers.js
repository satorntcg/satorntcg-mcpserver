// Fake OTLP/HTTP endpoints for the shutdown tests in agentMetrics.test.js and
// tracing.test.js. Not a test file itself (no .test.js suffix).

import http from 'node:http';
import net from 'node:net';

// Accepts connections and never responds: a hung or still-starting
// Collector or Jaeger.
export async function startHungServer() {
  const sockets = new Set();
  let connections = 0;
  const server = net.createServer((socket) => {
    connections++;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    connections: () => connections,
    close: () => {
      for (const socket of sockets) socket.destroy();
      server.close();
    },
  };
}

// Answers every request with the given status, recording each request.
export async function startStatusServer(status) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      requests.push({ path: req.url, body });
      res.writeHead(status, { 'content-type': 'application/json' }).end('{}');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { origin: `http://127.0.0.1:${server.address().port}`, requests, close: () => server.close() };
}
