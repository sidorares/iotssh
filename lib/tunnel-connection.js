'use strict';

const WebSocket = require('ws');
const {
  IoTSecureTunnelingClient,
  OpenTunnelCommand,
  CloseTunnelCommand,
} = require('@aws-sdk/client-iotsecuretunneling');
const { loadMessageType } = require('./tunnel-protocol');
const { TunnelStream } = require('./tunnel-stream');

const WS_PROTOCOL = 'aws.iot.securetunneling-3.0';
const DEFAULT_SERVICES = ['SSH', 'HTTP', 'HTTPS'];
const WS_CLOSE_NORMAL = 1000;

/**
 * @param {string} region
 */
function tunnelWsUrl(region) {
  return `wss://data.tunneling.iot.${region}.amazonaws.com/tunnel?local-proxy-mode=source`;
}

/**
 * @param {import('ws')} ws
 * @param {number} code
 * @param {string} [reason]
 * @returns {Promise<void>}
 */
function closeWebSocket(ws, code = WS_CLOSE_NORMAL, reason = 'session ended') {
  if (ws.readyState === WebSocket.CLOSED) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    ws.once('close', resolve);
    try {
      if (ws.readyState === WebSocket.OPEN) {
        ws.close(code, reason);
      } else if (ws.readyState === WebSocket.CONNECTING) {
        ws.terminate();
      } else {
        resolve();
      }
    } catch {
      resolve();
    }
  });
}

/**
 * @param {import('ssh2').Client | undefined} ssh
 * @param {number} [timeoutMs]
 * @returns {Promise<void>}
 */
function endSshSession(ssh, timeoutMs = 5000) {
  if (!ssh) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);

    ssh.once('close', done);
    ssh.once('end', done);

    try {
      ssh.end();
    } catch {
      done();
    }
  });
}

/**
 * @param {object} options
 * @param {string} options.thingName - AWS IoT thing name
 * @param {string} [options.region] - omit to use AWS SDK default chain (~/.aws/config, etc.)
 * @param {number} [options.waitMs] - time for destination localproxy to start after OpenTunnel
 * @param {string[]} [options.services]
 */
async function openSecureTunnel(options) {
  const {
    thingName,
    region,
    waitMs = 4000,
    services = DEFAULT_SERVICES,
  } = options;

  await loadMessageType();

  const client = new IoTSecureTunnelingClient(region ? { region } : {});
  const resolvedRegion = region ?? (await client.config.region());
  const opened = await client.send(
    new OpenTunnelCommand({
      destinationConfig: {
        thingName,
        services,
      },
    }),
  );

  const tunnelId = opened.tunnelId;
  const sourceAccessToken = opened.sourceAccessToken;
  if (!tunnelId || !sourceAccessToken) {
    throw new Error('OpenTunnel did not return tunnelId or sourceAccessToken');
  }

  if (waitMs > 0) {
    await sleep(waitMs);
  }

  const ws = await connectSourceWebSocket(resolvedRegion, sourceAccessToken);
  const stream = new TunnelStream(ws);
  await stream.ready;

  let closePromise;

  /**
   * Tear down in protocol order:
   * 1. SSH disconnect over the tunnel byte stream
   * 2. V3 CONNECTION_RESET for the tunnel TCP connection
   * 3. WebSocket close (RFC 6455 code 1000) — before CloseTunnel API
   * 4. CloseTunnel API
   *
   * @param {{ ssh?: import('ssh2').Client }} [options]
   */
  async function close(options = {}) {
    if (closePromise) {
      return closePromise;
    }

    closePromise = (async () => {
      await endSshSession(options.ssh);

      if (stream.isActive()) {
        await stream.resetConnection();
      }

      await closeWebSocket(ws);

      try {
        await client.send(
          new CloseTunnelCommand({ tunnelId, delete: true }),
        );
      } catch (err) {
        console.error(`warn: close-tunnel failed: ${err.message}`);
      }
    })();

    return closePromise;
  }

  return { tunnelId, stream, close, ws, region: resolvedRegion };
}

/**
 * @param {string} region
 * @param {string} accessToken
 * @returns {Promise<import('ws')>}
 */
function connectSourceWebSocket(region, accessToken) {
  const url = tunnelWsUrl(region);
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, [WS_PROTOCOL], {
      headers: { 'access-token': accessToken },
      handshakeTimeout: 30000,
    });

    const fail = (err) => {
      ws.removeAllListeners();
      try {
        ws.terminate();
      } catch {
        /* ignore */
      }
      reject(err);
    };

    ws.once('error', fail);
    ws.once('close', () => fail(new Error('WebSocket closed during handshake')));

    ws.once('open', () => {
      ws.removeListener('error', fail);
      ws.removeListener('close', fail);
      ws.on('ping', () => ws.pong());
      resolve(ws);
    });
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = {
  openSecureTunnel,
  tunnelWsUrl,
  DEFAULT_SERVICES,
};
