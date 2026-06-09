#!/usr/bin/env node
'use strict';

const fs = require('fs');
const { Client } = require('ssh2');
const { openSecureTunnel } = require('./lib/tunnel-connection');

const DEFAULT_USER = process.env.IOTSSH_USER;

/** Some embedded SSH servers (e.g. Dropbear) require legacy RSA host keys. */
const SSH_ALGORITHMS = {
  serverHostKey: ['ssh-rsa', 'rsa-sha2-512', 'rsa-sha2-256', 'ssh-ed25519'],
};

/**
 * Build ssh2 connect options.
 *
 * Auth configured explicitly:
 * - password — when IOTSSH_PASSWORD / --password is set (plain password auth)
 * - privateKey — when IOTSSH_KEY_PATH / --identity is set
 * - agent — when IOTSSH_USE_AGENT=1 (ssh-agent)
 *
 * If none of the above are set, ssh2 still attempts its defaults (e.g. ssh-agent keys).
 */
function buildSshConnectOptions(opts, sock) {
  /** @type {import('ssh2').ConnectConfig} */
  const config = {
    sock,
    username: opts.user,
    algorithms: SSH_ALGORITHMS,
    readyTimeout: 30000,
  };

  if (opts.password !== undefined) {
    config.password = opts.password;
  }

  if (opts.privateKey !== undefined) {
    config.privateKey = opts.privateKey;
  }

  if (opts.useAgent) {
    config.agent = process.env.SSH_AUTH_SOCK;
  }

  if (opts.tryKeyboard) {
    config.tryKeyboard = true;
    config.keyboardInteractive = (
      _name,
      _instructions,
      _instructionsLang,
      _prompts,
      finish,
    ) => {
      const answers = _prompts.map((p) => {
        if (/password/i.test(p.prompt) && opts.password !== undefined) {
          return opts.password;
        }
        return '';
      });
      finish(answers);
    };
  }

  return config;
}

function usage() {
  console.error(`Usage: iotssh <THING_NAME> [options]

Connect to an IoT edge device shell via AWS IoT Secure Tunneling (no Docker/localproxy).

Options:
  --user <name>       SSH user (default: ${DEFAULT_USER})
  --password <pass>   SSH password (plain text; prefer IOTSSH_PASSWORD env)
  --identity <path>   SSH private key file (or IOTSSH_KEY_PATH)
  --use-agent         Use ssh-agent (SSH_AUTH_SOCK)
  --try-keyboard      Answer keyboard-interactive prompts with --password
  --region <region>   AWS region (default: AWS_REGION or ~/.aws/config via SDK)
  --wait <seconds>    Wait for destination proxy after open-tunnel (default: 4)
  -h, --help          Show this help

Environment:
  AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY (standard SDK credentials)
  IOTSSH_PASSWORD     SSH password
  IOTSSH_KEY_PATH     Path to SSH private key
  IOTSSH_USE_AGENT    Set to 1 to use ssh-agent

Example:
  iotssh my-edge-device
  npx iotssh my-edge-device --user root
`);
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = {
    thingName: null,
    user: DEFAULT_USER,
    region: process.env.AWS_REGION,
    waitSec: 4,
    password: undefined,
    privateKey: undefined,
    useAgent: false,
    tryKeyboard: false,
  };

  if (process.env.IOTSSH_PASSWORD !== undefined) {
    opts.password = process.env.IOTSSH_PASSWORD;
  }
  if (process.env.IOTSSH_KEY_PATH) {
    opts.privateKey = fs.readFileSync(process.env.IOTSSH_KEY_PATH);
  }
  if (process.env.IOTSSH_USE_AGENT === '1') {
    opts.useAgent = true;
  }

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-h' || a === '--help') {
      opts.help = true;
    } else if (a === '--user') {
      opts.user = args[++i];
    } else if (a === '--password') {
      opts.password = args[++i] ?? '';
    } else if (a === '--identity') {
      const keyPath = args[++i];
      opts.privateKey = fs.readFileSync(keyPath);
    } else if (a === '--use-agent') {
      opts.useAgent = true;
    } else if (a === '--try-keyboard') {
      opts.tryKeyboard = true;
    } else if (a === '--region') {
      opts.region = args[++i];
    } else if (a === '--wait') {
      opts.waitSec = Number(args[++i]);
    } else if (!a.startsWith('-') && !opts.thingName) {
      opts.thingName = a;
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }

  return opts;
}

function stopInteractiveShell(stdin, stdout, stream) {
  stdin.unpipe(stream);
  stream.unpipe(stdout);
  stdin.pause();
  if (stdin.isTTY) {
    stdin.setRawMode(false);
  }
}

async function runInteractiveShell(ssh, stream) {
  const stdin = process.stdin;
  const stdout = process.stdout;

  if (stdin.isTTY) {
    stdin.setRawMode(true);
  }
  stdin.resume();

  stream.pipe(stdout);
  stdin.pipe(stream);

  await new Promise((resolve, reject) => {
    const done = () => {
      stopInteractiveShell(stdin, stdout, stream);
      resolve();
    };
    stream.once('close', done);
    stream.once('exit', done);
    stream.once('error', reject);
  });
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv);
  } catch (err) {
    console.error(err.message);
    usage();
    process.exit(2);
  }

  if (opts.help || !opts.thingName) {
    usage();
    process.exit(opts.help ? 0 : 2);
  }

  let tunnel;
  let ssh;
  try {
    console.error(`Opening tunnel to ${opts.thingName}…`);
    tunnel = await openSecureTunnel({
      thingName: opts.thingName,
      region: opts.region,
      waitMs: Math.max(0, opts.waitSec) * 1000,
    });
    console.error(
      `Tunnel ${tunnel.tunnelId} ready (${tunnel.region}). Starting SSH as ${opts.user}…`,
    );

    ssh = new Client();

    ssh.on('error', (err) => {
      console.error(`SSH error: ${err.message}`);
    });

    await new Promise((resolve, reject) => {
      ssh.on('ready', () => {
        ssh.shell({ term: process.env.TERM || 'xterm-256color' }, async (err, stream) => {
          if (err) {
            reject(err);
            return;
          }
          console.error('Connected. Press Ctrl+D or exit to close.\n');
          try {
            await runInteractiveShell(ssh, stream);
          } catch (e) {
            reject(e);
            return;
          }
          resolve();
        });
      });

      ssh.connect(buildSshConnectOptions(opts, tunnel.stream));
    });
  } catch (err) {
    console.error(`Failed: ${err.message}`);
    process.exitCode = 1;
  } finally {
    if (tunnel) {
      console.error('Closing tunnel…');
      await tunnel.close({ ssh });
    }
  }
}

main();
