#!/usr/bin/env node
import { createServer, request as sendRequest } from 'node:http';

const targetPort = Number(process.argv[2]);
const listenPort = Number(process.argv[3]);

if (!Number.isFinite(targetPort) || !Number.isFinite(listenPort)) {
  console.error(
    `[adapter-bun][proxy] invalid ports target="${process.argv[2]}" listen="${process.argv[3]}"`
  );
  process.exit(1);
}

const server = createServer((incomingReq, outgoingRes) => {
  const chunks = [];
  incomingReq.on('data', (chunk) => {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  });

  incomingReq.on('end', () => {
    const body = Buffer.concat(chunks);
    const incomingMethod = (incomingReq.method || 'GET').toUpperCase();
    let upstreamMethod = incomingMethod;

    const headers = { ...incomingReq.headers };
    delete headers.connection;
    delete headers['transfer-encoding'];

    if (incomingMethod === 'OPTIONS' && body.length > 0) {
      upstreamMethod = 'POST';
      headers['x-adapter-original-method'] = incomingMethod;
    }

    if (body.length > 0) {
      headers['content-length'] = String(body.length);
    } else {
      delete headers['content-length'];
    }

    const upstreamReq = sendRequest(
      {
        hostname: '127.0.0.1',
        port: targetPort,
        method: upstreamMethod,
        path: incomingReq.url || '/',
        headers,
      },
      (upstreamRes) => {
        outgoingRes.writeHead(upstreamRes.statusCode || 500, upstreamRes.headers);
        upstreamRes.pipe(outgoingRes);
      }
    );

    upstreamReq.on('error', (error) => {
      console.error('[adapter-bun][proxy] upstream request error', error);
      if (!outgoingRes.headersSent) {
        outgoingRes.statusCode = 502;
      }
      if (!outgoingRes.writableEnded) {
        outgoingRes.end('Bad Gateway');
      }
    });

    if (body.length > 0) {
      upstreamReq.write(body);
    }
    upstreamReq.end();
  });

  incomingReq.on('error', (error) => {
    console.error('[adapter-bun][proxy] incoming request error', error);
    if (!outgoingRes.headersSent) {
      outgoingRes.statusCode = 400;
    }
    if (!outgoingRes.writableEnded) {
      outgoingRes.end('Bad Request');
    }
  });
});

server.listen(listenPort, '127.0.0.1', () => {
  console.error(
    `[adapter-bun][proxy] listening on 127.0.0.1:${listenPort} -> 127.0.0.1:${targetPort}`
  );
});

const shutdown = () => {
  server.close(() => process.exit(0));
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
