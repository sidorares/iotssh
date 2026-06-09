'use strict';

const { Duplex } = require('stream');
const { encodeFrame, FrameReader, Type } = require('./tunnel-protocol');

/**
 * Duplex stream bridging ssh2 ↔ AWS Secure Tunneling WebSocket (source mode).
 * Replaces the TCP leg that localproxy exposes on localhost:2222.
 *
 * Lifecycle: this stream mirrors a single tunnel TCP connection. When the
 * connection ends, send CONNECTION_RESET (V3). The WebSocket is owned by
 * tunnel-connection.js — this class must not close it from _final/_destroy.
 */
class TunnelStream extends Duplex {
  /**
   * @param {import('ws')} ws - connected WebSocket
   * @param {string} [serviceId]
   */
  constructor(ws, serviceId = 'SSH') {
    super();
    this.ws = ws;
    this.serviceId = serviceId;
    this.streamId = 1;
    this.connectionId = 1;
    this.streamStarted = false;
    this.connectionOpen = false;
    this.reader = new FrameReader();
    this._serviceIdsReady = false;

    /** @type {Promise<void>} */
    this.ready = new Promise((resolve, reject) => {
      this._resolveReady = resolve;
      this._rejectReady = reject;
    });

    ws.on('message', (data) => this._onMessage(data));
    ws.on('close', () => this._onWebSocketClose());
    ws.on('error', (err) => this._onWebSocketError(err));
  }

  isActive() {
    return this.streamStarted && this.connectionOpen;
  }

  /**
   * Orderly tunnel connection teardown (V3 CONNECTION_RESET).
   * @returns {Promise<void>}
   */
  resetConnection() {
    if (!this.connectionOpen) {
      return Promise.resolve();
    }
    this.connectionOpen = false;

    return new Promise((resolve) => {
      const finish = () => {
        if (!this.readableEnded) {
          this.push(null);
        }
        resolve();
      };

      try {
        if (this.ws.readyState === this.ws.OPEN) {
          this._send({
            type: Type.CONNECTION_RESET,
            streamId: this.streamId,
            serviceId: this.serviceId,
            connectionId: this.connectionId,
          });
        }
      } catch {
        finish();
        return;
      }

      // Allow peer reset/control frames to arrive; localproxy does not ack.
      setTimeout(finish, 50);
    });
  }

  _onWebSocketClose() {
    this.connectionOpen = false;
    if (!this.readableEnded) {
      this.push(null);
    }
    if (!this.destroyed) {
      this.destroy();
    }
  }

  /** @param {Error} err */
  _onWebSocketError(err) {
    if (!this.destroyed) {
      this.destroy(err);
    }
  }

  _onMessage(data) {
    const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
    for (const msg of this.reader.push(chunk)) {
      this._handleMessage(msg);
    }
  }

  _handleMessage(msg) {
    const type = typeof msg.type === 'string' ? msg.type : Type[msg.type];

    if (type === 'SERVICE_IDS' || msg.type === Type.SERVICE_IDS) {
      this._serviceIdsReady = true;
      this._resolveReady();
      return;
    }

    if (type === 'DATA' || msg.type === Type.DATA) {
      if (msg.serviceId && msg.serviceId !== this.serviceId) return;
      if (msg.streamId && msg.streamId !== this.streamId) return;
      if (msg.payload && msg.payload.length) {
        this.push(msg.payload);
      }
      return;
    }

    if (type === 'STREAM_RESET' || msg.type === Type.STREAM_RESET) {
      if (!msg.streamId || msg.streamId === this.streamId) {
        this.connectionOpen = false;
        this.push(null);
      }
      return;
    }

    if (type === 'CONNECTION_RESET' || msg.type === Type.CONNECTION_RESET) {
      if (msg.serviceId && msg.serviceId !== this.serviceId) return;
      if (msg.streamId && msg.streamId !== this.streamId) return;
      if (msg.connectionId && msg.connectionId !== this.connectionId) return;
      this.connectionOpen = false;
      this.push(null);
    }
  }

  _send(fields) {
    if (this.ws.readyState !== this.ws.OPEN) {
      throw new Error('tunnel WebSocket is not open');
    }
    this.ws.send(encodeFrame(fields));
  }

  _startStream() {
    if (this.streamStarted) return;
    this.streamStarted = true;
    this.connectionOpen = true;
    this._send({
      type: Type.STREAM_START,
      streamId: this.streamId,
      serviceId: this.serviceId,
      connectionId: this.connectionId,
    });
  }

  _write(chunk, _encoding, callback) {
    try {
      if (!this._serviceIdsReady) {
        callback(new Error('tunnel not ready (SERVICE_IDS not received)'));
        return;
      }
      this._startStream();
      this._send({
        type: Type.DATA,
        streamId: this.streamId,
        serviceId: this.serviceId,
        connectionId: this.connectionId,
        payload: chunk,
      });
      callback();
    } catch (err) {
      callback(err);
    }
  }

  _read() {
    // DATA is pushed from WebSocket handler.
  }

  _final(callback) {
    // ssh2 ends the writable side when sending SSH disconnect — mirror TCP FIN.
    if (this.connectionOpen) {
      try {
        if (this.ws.readyState === this.ws.OPEN) {
          this._send({
            type: Type.CONNECTION_RESET,
            streamId: this.streamId,
            serviceId: this.serviceId,
            connectionId: this.connectionId,
          });
        }
      } catch {
        /* ignore */
      }
      this.connectionOpen = false;
    }
    callback();
  }

  _destroy(err, callback) {
    this.connectionOpen = false;
    if (err) {
      try {
        if (this.ws.readyState === this.ws.OPEN
            || this.ws.readyState === this.ws.CONNECTING) {
          this.ws.terminate();
        }
      } catch {
        /* ignore */
      }
    }
    callback(err);
  }
}

module.exports = { TunnelStream };
