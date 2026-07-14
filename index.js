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

function ptySettings() {
  return {
    term: process.env.TERM || 'xterm-256color',
    rows: process.stdout.rows || 24,
    cols: process.stdout.columns || 80,
  };
}

function usage() {
  console.error(`Usage:
  iotssh <THING_NAME> [options] [--] [command]
  iotssh put <THING_NAME> <local> <remote> [options]
  iotssh get <THING_NAME> <remote> <local> [options]

Connect to an IoT edge device via AWS IoT Secure Tunneling (no Docker/localproxy).

With no command, opens an interactive shell (or pipes stdin to the remote shell when
stdin is not a TTY, like "ssh host < script.sh").

put / get transfer a single file over SFTP (requires SFTP on the device SSH server).

Options:
  --user <name>       SSH user (default: ${DEFAULT_USER})
  --password <pass>   SSH password (plain text; prefer IOTSSH_PASSWORD env)
  --identity <path>   SSH private key file (or IOTSSH_KEY_PATH)
  --use-agent         Use ssh-agent (SSH_AUTH_SOCK)
  --try-keyboard      Answer keyboard-interactive prompts with --password
  --region <region>   AWS region (default: AWS_REGION or ~/.aws/config via SDK)
  --wait <seconds>    Wait for destination proxy after open-tunnel (default: 4)
  -t, --force-tty     Force pseudo-TTY allocation for remote commands (like ssh -t)
  -h, --help          Show this help

Environment:
  AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY (standard SDK credentials)
  IOTSSH_PASSWORD     SSH password
  IOTSSH_KEY_PATH     Path to SSH private key
  IOTSSH_USE_AGENT    Set to 1 to use ssh-agent

Examples:
  iotssh my-edge-device
  iotssh my-edge-device "hostname"
  iotssh -t my-edge-device "top"
  iotssh my-edge-device < deploy.sh
  iotssh put my-edge-device ./app.bin /tmp/app.bin
  iotssh get my-edge-device /var/log/app.log ./app.log
`);
}

/**
 * @returns {{
 *   help?: boolean,
 *   transfer: 'put' | 'get' | null,
 *   thingName: string | null,
 *   localPath?: string,
 *   remotePath?: string,
 *   command: string | undefined,
 *   user: string | undefined,
 *   region: string | undefined,
 *   waitSec: number,
 *   password: string | undefined,
 *   privateKey: Buffer | undefined,
 *   useAgent: boolean,
 *   tryKeyboard: boolean,
 *   forceTTY: boolean,
 * }}
 */
function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = {
    thingName: null,
    transfer: null,
    localPath: undefined,
    remotePath: undefined,
    command: undefined,
    user: DEFAULT_USER,
    region: process.env.AWS_REGION,
    waitSec: 4,
    password: undefined,
    privateKey: undefined,
    useAgent: false,
    tryKeyboard: false,
    forceTTY: false,
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

  /** @type {string[]} */
  const positionals = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-h' || a === '--help') {
      opts.help = true;
    } else if (a === '-t' || a === '--force-tty') {
      opts.forceTTY = true;
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
    } else if (a === '--') {
      positionals.push(...args.slice(i + 1));
      break;
    } else if (!a.startsWith('-')) {
      positionals.push(a);
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }

  if (positionals[0] === 'put' || positionals[0] === 'get') {
    opts.transfer = positionals[0];
    opts.thingName = positionals[1] ?? null;
    if (opts.transfer === 'put') {
      opts.localPath = positionals[2];
      opts.remotePath = positionals[3];
    } else {
      opts.remotePath = positionals[2];
      opts.localPath = positionals[3];
    }
    if (positionals.length > 4) {
      throw new Error(`Unexpected argument: ${positionals[4]}`);
    }
    if (opts.thingName && (!opts.localPath || !opts.remotePath)) {
      throw new Error(
        `Usage: iotssh ${opts.transfer} <THING_NAME> <${
          opts.transfer === 'put' ? 'local> <remote' : 'remote> <local'
        }>`,
      );
    }
  } else {
    opts.thingName = positionals[0] ?? null;
    if (positionals.length > 1) {
      opts.command = positionals.slice(1).join(' ');
    }
  }

  return opts;
}

/** @returns {'put' | 'get' | 'exec' | 'exec-tty' | 'shell-tty' | 'shell-pipe'} */
function resolveSessionMode(opts) {
  if (opts.transfer === 'put' || opts.transfer === 'get') {
    return opts.transfer;
  }
  if (opts.command) {
    return opts.forceTTY ? 'exec-tty' : 'exec';
  }
  if (process.stdin.isTTY) {
    return 'shell-tty';
  }
  return 'shell-pipe';
}

function stopPipedSession(stdin, stdout, stream) {
  stdin.unpipe(stream);
  stream.unpipe(stdout);
  stdin.pause();
}

function stopInteractiveShell(stdin, stdout, stream) {
  stopPipedSession(stdin, stdout, stream);
  if (stdin.isTTY) {
    stdin.setRawMode(false);
  }
}

/**
 * Wait until the channel is fully closed so piped stdout/stderr can drain.
 * Do not settle on `exit` — the remote process may exit before all output arrives.
 *
 * @param {import('ssh2').ClientChannel} stream
 * @returns {Promise<{ exitCode: number }>}
 */
function waitForStreamClose(stream, onStop) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (code, err) => {
      if (settled) {
        return;
      }
      settled = true;
      onStop();
      if (err) {
        reject(err);
        return;
      }
      resolve({ exitCode: code ?? 0 });
    };
    stream.once('close', (code) => finish(code));
    stream.once('error', (err) => finish(undefined, err));
  });
}

/**
 * @param {import('ssh2').ClientChannel} stream
 * @returns {Promise<{ exitCode: number }>}
 */
async function runInteractiveStream(stream) {
  const stdin = process.stdin;
  const stdout = process.stdout;

  if (stdin.isTTY) {
    stdin.setRawMode(true);
  }
  stdin.resume();

  stream.pipe(stdout);
  stdin.pipe(stream);

  return waitForStreamClose(stream, () => {
    stopInteractiveShell(stdin, stdout, stream);
  });
}

/**
 * @param {import('ssh2').Client} ssh
 * @param {string} command
 * @param {{ pty: boolean }} options
 * @returns {Promise<{ exitCode: number }>}
 */
function runRemoteExec(ssh, command, { pty }) {
  const execOpts = pty ? { pty: ptySettings() } : {};
  return new Promise((resolve, reject) => {
    ssh.exec(command, execOpts, (err, stream) => {
      if (err) {
        reject(err);
        return;
      }
      if (pty) {
        runInteractiveStream(stream).then(resolve, reject);
        return;
      }
      const stdout = process.stdout;
      stream.pipe(stdout, { end: false });
      stream.stderr.pipe(stdout, { end: false });
      waitForStreamClose(stream, () => {
        stream.unpipe(stdout);
        stream.stderr.unpipe(stdout);
      }).then(resolve, reject);
    });
  });
}

/**
 * @param {import('ssh2').Client} ssh
 * @returns {Promise<{ exitCode: number }>}
 */
function runPipedShell(ssh) {
  return new Promise((resolve, reject) => {
    ssh.shell(false, async (err, stream) => {
      if (err) {
        reject(err);
        return;
      }
      const stdin = process.stdin;
      const stdout = process.stdout;
      stdin.resume();
      stream.pipe(stdout);
      stdin.pipe(stream);
      try {
        resolve(await waitForStreamClose(stream, () => {
          stopPipedSession(stdin, stdout, stream);
        }));
      } catch (e) {
        reject(e);
      }
    });
  });
}

/**
 * @param {import('ssh2').Client} ssh
 * @returns {Promise<{ exitCode: number }>}
 */
function runInteractiveShell(ssh) {
  return new Promise((resolve, reject) => {
    ssh.shell(ptySettings(), async (err, stream) => {
      if (err) {
        reject(err);
        return;
      }
      try {
        resolve(await runInteractiveStream(stream));
      } catch (e) {
        reject(e);
      }
    });
  });
}

/**
 * @param {import('ssh2').Client} ssh
 * @returns {Promise<import('ssh2').SFTPWrapper>}
 */
function openSftp(ssh) {
  return new Promise((resolve, reject) => {
    ssh.sftp((err, sftp) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(sftp);
    });
  });
}

/**
 * @param {import('ssh2').Client} ssh
 * @param {string} localPath
 * @param {string} remotePath
 * @returns {Promise<{ exitCode: number }>}
 */
async function runSftpPut(ssh, localPath, remotePath) {
  const sftp = await openSftp(ssh);
  await new Promise((resolve, reject) => {
    sftp.fastPut(localPath, remotePath, (err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
  console.error(`Uploaded ${localPath} → ${remotePath}`);
  return { exitCode: 0 };
}

/**
 * @param {import('ssh2').Client} ssh
 * @param {string} remotePath
 * @param {string} localPath
 * @returns {Promise<{ exitCode: number }>}
 */
async function runSftpGet(ssh, remotePath, localPath) {
  const sftp = await openSftp(ssh);
  await new Promise((resolve, reject) => {
    sftp.fastGet(remotePath, localPath, (err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
  console.error(`Downloaded ${remotePath} → ${localPath}`);
  return { exitCode: 0 };
}

/**
 * @param {import('ssh2').Client} ssh
 * @param {ReturnType<typeof parseArgs>} opts
 * @returns {Promise<{ exitCode: number }>}
 */
async function runSshSession(ssh, opts) {
  const mode = resolveSessionMode(opts);
  switch (mode) {
    case 'put':
      return runSftpPut(ssh, opts.localPath, opts.remotePath);
    case 'get':
      return runSftpGet(ssh, opts.remotePath, opts.localPath);
    case 'exec':
      return runRemoteExec(ssh, opts.command, { pty: false });
    case 'exec-tty':
      return runRemoteExec(ssh, opts.command, { pty: true });
    case 'shell-pipe':
      return runPipedShell(ssh);
  }
  return runInteractiveShell(ssh);
}

/**
 * Fail fast before opening a tunnel when the local side is clearly wrong.
 * @param {ReturnType<typeof parseArgs>} opts
 */
function validateTransferPaths(opts) {
  if (opts.transfer === 'put') {
    if (!fs.existsSync(opts.localPath)) {
      throw new Error(`Local file not found: ${opts.localPath}`);
    }
    const st = fs.statSync(opts.localPath);
    if (!st.isFile()) {
      throw new Error(`Local path is not a file: ${opts.localPath}`);
    }
  }
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

  try {
    validateTransferPaths(opts);
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }

  const sessionMode = resolveSessionMode(opts);

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

    const { exitCode } = await new Promise((resolve, reject) => {
      ssh.on('ready', async () => {
        if (sessionMode === 'shell-tty') {
          console.error('Connected. Press Ctrl+D or exit to close.\n');
        } else if (sessionMode === 'put' || sessionMode === 'get') {
          console.error(
            sessionMode === 'put'
              ? `Uploading ${opts.localPath} → ${opts.remotePath}…`
              : `Downloading ${opts.remotePath} → ${opts.localPath}…`,
          );
        }
        try {
          resolve(await runSshSession(ssh, opts));
        } catch (e) {
          reject(e);
        }
      });

      ssh.connect(buildSshConnectOptions(opts, tunnel.stream));
    });

    process.exitCode = exitCode;
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
