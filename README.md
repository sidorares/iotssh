# iotssh

CLI to SSH into an IoT edge device **without Docker or `localproxy`**. It implements the AWS IoT Secure Tunneling **source** WebSocket client in Node.js and runs a full SSH session over the tunnel with **`ssh2`**.

The edge device must run a destination-side tunnel agent — typically the Greengrass **`aws.greengrass.SecureTunneling`** component (or a custom equivalent) that starts `localproxy` in destination mode and forwards to SSH on port 22. This tool replaces only the **client-side** `localproxy`; the device-side setup is unchanged.

## How it works

End-to-end, the CLI wraps these steps:

1. **Create tunnel** — Call `OpenTunnel` via the AWS SDK, targeting the IoT thing name and requesting services (`SSH`, `HTTP`, `HTTPS`). AWS notifies the device over MQTT to start its destination `localproxy`.
2. **Get source access token** — `OpenTunnel` returns a `sourceAccessToken` (outbound connection credential for the client) and `tunnelId`.
3. **Connect WebSocket** — Open a WSS connection to `data.tunneling.iot.<region>.amazonaws.com` in **source** mode, passing the token in the `access-token` header and subprotocol `aws.iot.securetunneling-3.0`.
4. **Create duplex stream** — Wrap the WebSocket in `TunnelStream`, a Node.js `Duplex` that encodes/decodes v3 protobuf frames (`SERVICE_IDS`, `STREAM_START`, `DATA`, etc.). This replaces the TCP socket that source `localproxy` would expose on localhost.
5. **Create SSH connection** — Pass that stream to **`ssh2`** as `sock` and run a normal SSH handshake and interactive shell over the tunneled byte stream.

On exit, the CLI closes the WebSocket and calls `CloseTunnel`.

## Dependencies

| Package | Role |
|---------|------|
| `@aws-sdk/client-iotsecuretunneling` | `OpenTunnel` / `CloseTunnel` |
| `ws` | Source WebSocket to `data.tunneling.iot.<region>.amazonaws.com` |
| `protobufjs` | Tunnel v3 framing ([V3WebSocketProtocolGuide.md](https://github.com/aws-samples/aws-iot-securetunneling-localproxy/blob/main/V3WebSocketProtocolGuide.md)) |
| `ssh2` | SSH client (handshake, PTY shell) over a custom stream |

## Prerequisites

- Node.js 18+
- AWS credentials with `iot:OpenTunnel` / `iot:CloseTunnel`
- Edge device online with Greengrass healthy and **`aws.greengrass.SecureTunneling`** (or similar destination tunnel component) running

## Install

Install globally so `iotssh` is on your PATH:

```bash
npm install -g iotssh
```

From a clone:

```bash
npm install -g .
```

## Usage

```bash
iotssh <THING_NAME>

# options
iotssh my-edge-device --user root --region ap-southeast-2 --wait 6

# password auth
export IOTSSH_PASSWORD='your-password'
iotssh my-edge-device

# or
iotssh my-edge-device --password 'your-password'
```

Without a global install, use `npx` — it runs the same `iotssh` bin entry as a local install:

```bash
npx iotssh my-edge-device
npx iotssh my-edge-device --user root --region ap-southeast-2
```

When developing from a clone, `npm install` then `npx iotssh` uses the local package (no publish required).

### SSH authentication

The client only enables methods you configure:

| Method | Config |
|--------|--------|
| Password | `IOTSSH_PASSWORD` or `--password` |
| Private key file | `IOTSSH_KEY_PATH` or `--identity` |
| ssh-agent | `IOTSSH_USE_AGENT=1` or `--use-agent` |
| Keyboard-interactive | `--try-keyboard` (uses the same password for prompts) |

If none are set, `ssh2` may still try keys from your ssh-agent. Host key algorithms include legacy `ssh-rsa` for embedded SSH servers such as Dropbear.

## Protocol note

Destination `localproxy` on the device still handles the device-side WebSocket and TCP bridge to SSH. This tool reimplements **only the client-side** `localproxy` behavior (WebSocket + protobuf + stream bridge), as documented in [V3WebSocketProtocolGuide.md](https://github.com/aws-samples/aws-iot-securetunneling-localproxy/blob/main/V3WebSocketProtocolGuide.md).
