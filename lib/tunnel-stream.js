'use strict';

const { Duplex } = require('stream');
const { encodeFrame, FrameReader, Type } = require('./tunnel-protocol');

/**
 * Duplex stream bridging ssh2 ↔ AWS Secure Tunneling WebSocket (source mode).
 * Replaces the TCP leg that localproxy exposes on localhost:2222.
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
    this.reader = new FrameReader();
    this._serviceIdsReady = false;

    /** @type {Promise<void>} */
    this.ready = new Promise((resolve, reject) => {
      this._resolveReady = resolve;
      this._rejectReady = reject;
    });

    ws.on('message', (data) => this._onMessage(data));
    ws.on('close', () => this.destroy(new Error('tunnel WebSocket closed')));
    ws.on('error', (err) => this.destroy(err));
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
        this.push(null);
      }
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
}

module.exports = { TunnelStream };
