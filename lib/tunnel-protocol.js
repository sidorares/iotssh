'use strict';

const path = require('path');
const protobuf = require('protobufjs');

const PROTO_PATH = path.join(__dirname, '..', 'proto', 'tunnel.proto');

/** @type {protobuf.Type} */
let MessageType;

async function loadMessageType() {
  if (MessageType) return MessageType;
  const root = await protobuf.load(PROTO_PATH);
  MessageType = root.lookupType('com.amazonaws.iot.securedtunneling.Message');
  return MessageType;
}

const Type = {
  UNKNOWN: 0,
  DATA: 1,
  STREAM_START: 2,
  STREAM_RESET: 3,
  SESSION_RESET: 4,
  SERVICE_IDS: 5,
  CONNECTION_START: 6,
  CONNECTION_RESET: 7,
};

/**
 * @param {object} fields
 * @returns {Buffer}
 */
function encodeFrame(fields) {
  const msg = MessageType.create(fields);
  const body = MessageType.encode(msg).finish();
  const frame = Buffer.alloc(2 + body.length);
  frame.writeUInt16BE(body.length, 0);
  body.copy(frame, 2);
  return frame;
}

function decodeFrameBody(body) {
  const decoded = MessageType.decode(body);
  return MessageType.toObject(decoded, {
    longs: Number,
    enums: String,
    bytes: Buffer,
  });
}

class FrameReader {
  constructor() {
    /** @type {Buffer} */
    this.buffer = Buffer.alloc(0);
  }

  /**
   * @param {Buffer} chunk
   * @returns {ReturnType<decodeFrameBody>[]}
   */
  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const messages = [];

    while (this.buffer.length >= 2) {
      const length = this.buffer.readUInt16BE(0);
      if (this.buffer.length < 2 + length) break;
      const body = this.buffer.subarray(2, 2 + length);
      this.buffer = this.buffer.subarray(2 + length);
      messages.push(decodeFrameBody(body));
    }

    return messages;
  }
}

module.exports = {
  loadMessageType,
  encodeFrame,
  FrameReader,
  Type,
};
