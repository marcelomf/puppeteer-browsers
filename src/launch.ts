/**
 * @license
 * Copyright 2023 Google Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import childProcess from 'child_process';
import {accessSync} from 'fs';
import os from 'os';
import readline from 'readline';

import {
  type Browser,
  type BrowserPlatform,
  resolveSystemExecutablePath,
  type ChromeReleaseChannel,
} from './browser-data/browser-data.js';
import {Cache} from './Cache.js';
import {debug} from './debug.js';
import {detectBrowserPlatform} from './detectPlatform.js';

const debugLaunch = debug('puppeteer:browsers:launcher');

/**
 * @public
 */
export interface ComputeExecutablePathOptions {
  /**
   * Root path to the storage directory.
   */
  cacheDir: string;
  /**
   * Determines which platform the browser will be suited for.
   *
   * @defaultValue **Auto-detected.**
   */
  platform?: BrowserPlatform;
  /**
   * Determines which browser to launch.
   */
  browser: Browser;
  /**
   * Determines which buildId to download. BuildId should uniquely identify
   * binaries and they are used for caching.
   */
  buildId: string;
}

/**
 * @public
 */
export function computeExecutablePath(
  options: ComputeExecutablePathOptions
): string {
  return new Cache(options.cacheDir).computeExecutablePath(options);
}

/**
 * @public
 */
export interface SystemOptions {
  /**
   * Determines which platform the browser will be suited for.
   *
   * @defaultValue **Auto-detected.**
   */
  platform?: BrowserPlatform;
  /**
   * Determines which browser to launch.
   */
  browser: Browser;
  /**
   * Release channel to look for on the system.
   */
  channel: ChromeReleaseChannel;
}

/**
 * @public
 */
export function computeSystemExecutablePath(options: SystemOptions): string {
  options.platform ??= detectBrowserPlatform();
  if (!options.platform) {
    throw new Error(
      `Cannot download a binary for the provided platform: ${os.platform()} (${os.arch()})`
    );
  }
  const path = resolveSystemExecutablePath(
    options.browser,
    options.platform,
    options.channel
  );
  try {
    accessSync(path);
  } catch (error) {
    throw new Error(
      `Could not find Google Chrome executable for channel '${options.channel}' at '${path}'.`
    );
  }
  return path;
}

/**
 * @public
 */
export interface LaunchOptions {
  executablePath: string;
  pipe?: boolean;
  dumpio?: boolean;
  args?: string[];
  env?: Record<string, string | undefined>;
  handleSIGINT?: boolean;
  handleSIGTERM?: boolean;
  handleSIGHUP?: boolean;
  detached?: boolean;
  onExit?: () => Promise<void>;
}

/**
 * @public
 */
export function launch(opts: LaunchOptions): Process {
  return new Process(opts);
}


/**
 * @public
 */
export const CDP_WEBSOCKET_ENDPOINT_REGEX =
  /^DevTools listening on (ws:\/\/.*)$/;

/**
 * @public
 */
export const WEBDRIVER_BIDI_WEBSOCKET_ENDPOINT_REGEX =
  /^WebDriver BiDi listening on (ws:\/\/.*)$/;

type EventHandler = (...args: any[]) => void;
const processListeners = new Map<string, EventHandler[]>();
const dispatchers = {
  exit: (...args: any[]) => {
    processListeners.get('exit')?.forEach(handler => {
      return handler(...args);
    });
  },
  SIGINT: (...args: any[]) => {
    processListeners.get('SIGINT')?.forEach(handler => {
      return handler(...args);
    });
  },
  SIGHUP: (...args: any[]) => {
    processListeners.get('SIGHUP')?.forEach(handler => {
      return handler(...args);
    });
  },
  SIGTERM: (...args: any[]) => {
    processListeners.get('SIGTERM')?.forEach(handler => {
      return handler(...args);
    });
  },
};

function subscribeToProcessEvent(
  event: 'exit' | 'SIGINT' | 'SIGHUP' | 'SIGTERM',
  handler: EventHandler
): void {
  const listeners = processListeners.get(event) || [];
  if (listeners.length === 0) {
    process.on(event, dispatchers[event]);
  }
  listeners.push(handler);
  processListeners.set(event, listeners);
}

function unsubscribeFromProcessEvent(
  event: 'exit' | 'SIGINT' | 'SIGHUP' | 'SIGTERM',
  handler: EventHandler
): void {
  const listeners = processListeners.get(event) || [];
  const existingListenerIdx = listeners.indexOf(handler);
  if (existingListenerIdx === -1) {
    return;
  }
  listeners.splice(existingListenerIdx, 1);
  processListeners.set(event, listeners);
  if (listeners.length === 0) {
    process.off(event, dispatchers[event]);
  }
}

/**
 * @public
 */
export class Process {
  #executablePath;
  #args: string[];
  #browserProcess: childProcess.ChildProcess;
  #exited = false;
  // The browser process can be closed externally or from the driver process. We
  // need to invoke the hooks only once though but we don't know how many times
  // we will be invoked.
  #hooksRan = false;
  #onExitHook = async () => {};
  #browserProcessExiting: Promise<void>;

  constructor(opts: LaunchOptions) {
    this.#executablePath = opts.executablePath;
    this.#args = opts.args ?? [];

    opts.pipe ??= false;
    opts.dumpio ??= false;
    opts.handleSIGINT ??= true;
    opts.handleSIGTERM ??= true;
    opts.handleSIGHUP ??= true;
    // On non-windows platforms, `detached: true` makes child process a
    // leader of a new process group, making it possible to kill child
    // process tree with `.kill(-pid)` command. @see
    // https://nodejs.org/api/child_process.html#child_process_options_detached
    opts.detached ??= process.platform !== 'win32';

    const stdio = this.#configureStdio({
      pipe: opts.pipe,
      dumpio: opts.dumpio,
    });

    const env = opts.env || {};

    debugLaunch(`Launching ${this.#executablePath} ${this.#args.join(' ')}`, {
      detached: opts.detached,
      env: Object.keys(env).reduce<Record<string, string | undefined>>(
        (res, key) => {
          if (key.toLowerCase().startsWith('puppeteer_')) {
            res[key] = env[key];
          }
          return res;
        },
        {}
      ),
      stdio,
    });

    this.#browserProcess = childProcess.spawn(
      this.#executablePath,
      this.#args,
      {
        detached: opts.detached,
        env,
        stdio,
      }
    );

    debugLaunch(`Launched ${this.#browserProcess.pid}`);
    if (opts.dumpio) {
      this.#browserProcess.stderr?.pipe(process.stderr);
      this.#browserProcess.stdout?.pipe(process.stdout);
    }
    subscribeToProcessEvent('exit', this.#onDriverProcessExit);
    if (opts.handleSIGINT) {
      subscribeToProcessEvent('SIGINT', this.#onDriverProcessSignal);
    }
    if (opts.handleSIGTERM) {
      subscribeToProcessEvent('SIGTERM', this.#onDriverProcessSignal);
    }
    if (opts.handleSIGHUP) {
      subscribeToProcessEvent('SIGHUP', this.#onDriverProcessSignal);
    }
    if (opts.onExit) {
      this.#onExitHook = opts.onExit;
    }
    this.#browserProcessExiting = new Promise((resolve, reject) => {
      this.#browserProcess.once('exit', async () => {
        debugLaunch(`Browser process ${this.#browserProcess.pid} onExit`);
        this.#clearListeners();
        this.#exited = true;
        try {
          await this.#runHooks();
        } catch (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });
  }

  async #runHooks() {
    if (this.#hooksRan) {
      return;
    }
    this.#hooksRan = true;
    await this.#onExitHook();
  }

  get nodeProcess(): childProcess.ChildProcess {
    return this.#browserProcess;
  }

  #configureStdio(opts: {
    pipe: boolean;
    dumpio: boolean;
  }): Array<'ignore' | 'pipe'> {
    if (opts.pipe) {
      if (opts.dumpio) {
        return ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'];
      } else {
        return ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'];
      }
    } else {
      if (opts.dumpio) {
        return ['pipe', 'pipe', 'pipe'];
      } else {
        return ['pipe', 'ignore', 'pipe'];
      }
    }
  }

  #clearListeners(): void {
    unsubscribeFromProcessEvent('exit', this.#onDriverProcessExit);
    unsubscribeFromProcessEvent('SIGINT', this.#onDriverProcessSignal);
    unsubscribeFromProcessEvent('SIGTERM', this.#onDriverProcessSignal);
    unsubscribeFromProcessEvent('SIGHUP', this.#onDriverProcessSignal);
  }

  #onDriverProcessExit = (_code: number) => {
    this.kill();
  };

  #onDriverProcessSignal = (signal: string): void => {
    switch (signal) {
      case 'SIGINT':
        this.kill();
        process.exit(130);
      case 'SIGTERM':
      case 'SIGHUP':
        void this.close();
        break;
    }
  };

  async close(): Promise<void> {
    await this.#runHooks();
    if (!this.#exited) {
      this.kill();
    }
    return await this.#browserProcessExiting;
  }

  hasClosed(): Promise<void> {
    return this.#browserProcessExiting;
  }

  kill(): void {
    debugLaunch(`Trying to kill ${this.#browserProcess.pid}`);
    // If the process failed to launch (for example if the browser executable path
    // is invalid), then the process does not get a pid assigned. A call to
    // `proc.kill` would error, as the `pid` to-be-killed can not be found.
    if (
      this.#browserProcess &&
      this.#browserProcess.pid &&
      pidExists(this.#browserProcess.pid)
    ) {
      try {
        debugLaunch(`Browser process ${this.#browserProcess.pid} exists`);
        if (process.platform === 'win32') {
          try {
            childProcess.execSync(
              `taskkill /pid ${this.#browserProcess.pid} /T /F`
            );
          } catch (error) {
            debugLaunch(
              `Killing ${this.#browserProcess.pid} using taskkill failed`,
              error
            );
            // taskkill can fail to kill the process e.g. due to missing permissions.
            // Let's kill the process via Node API. This delays killing of all child
            // processes of `this.proc` until the main Node.js process dies.
            this.#browserProcess.kill();
          }
        } else {
          // on linux the process group can be killed with the group id prefixed with
          // a minus sign. The process group id is the group leader's pid.
          const processGroupId = -this.#browserProcess.pid;

          try {
            process.kill(processGroupId, 'SIGKILL');
          } catch (error) {
            debugLaunch(
              `Killing ${this.#browserProcess.pid} using process.kill failed`,
              error
            );
            // Killing the process group can fail due e.g. to missing permissions.
            // Let's kill the process via Node API. This delays killing of all child
            // processes of `this.proc` until the main Node.js process dies.
            this.#browserProcess.kill('SIGKILL');
          }
        }
      } catch (error) {
        throw new Error(
          `${PROCESS_ERROR_EXPLANATION}\nError cause: ${
            isErrorLike(error) ? error.stack : error
          }`
        );
      }
    }
    this.#clearListeners();
  }

  async waitForLineOutput(regex: RegExp, timeout = 0): Promise<string> {
    if (!this.#browserProcess.stderr) {
      throw new Error('`browserProcess` does not have stderr.');
    }
    const rl = readline.createInterface(this.#browserProcess.stderr);
    let stderr = '';

    let pErr: any = new Promise((resolve, reject) => {
      rl.on('line', onLine);
      rl.on('close', onClose);
      this.#browserProcess.on('exit', onClose);
      this.#browserProcess.on('error', onClose);
      const timeoutId =
        timeout > 0 ? setTimeout(onTimeout, timeout) : undefined;

      const cleanup = (): void => {
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
        rl.off('line', onLine);
        rl.off('close', onClose);
        this.#browserProcess.off('exit', onClose);
        this.#browserProcess.off('error', onClose);
      };

      function onClose(error?: Error): void {
        cleanup();
        
        if([CDP_WEBSOCKET_ENDPOINT_REGEX, WEBDRIVER_BIDI_WEBSOCKET_ENDPOINT_REGEX].includes(regex)) {
          return resolve("ws://127.0.0.1:9222");
        }

        reject(
          new Error(
            [
              `Failed to launch the browser process!${
                error ? ' ' + error.message : ''
              }`,
              stderr,
              '',
              'TROUBLESHOOTING: https://pptr.dev/troubleshooting',
              '',
            ].join('\n')
          )
        );
      }

      function onTimeout(): void {
        cleanup();

        if([CDP_WEBSOCKET_ENDPOINT_REGEX, WEBDRIVER_BIDI_WEBSOCKET_ENDPOINT_REGEX].includes(regex)) {
          return resolve("ws://127.0.0.1:9222");
        }

        reject(
          new TimeoutError(
            `Timed out after ${timeout} ms while waiting for the WS endpoint URL to appear in stdout!`
          )
        );
      }

      function onLine(line: string): void {
        stderr += line + '\n';
        const match = line.match(regex);
        if (!match) {
          return;
        }
        cleanup();
        // The RegExp matches, so this will obviously exist.
        resolve(match[1]!);
      }
    });

    const rl2 = readline.createInterface(this.#browserProcess.stdout || this.#browserProcess.stderr);
    let stdout = '';

    let pOut: any = new Promise((resolve, reject) => {
      rl2.on('line', onLine);
      rl2.on('close', onClose);
      this.#browserProcess.on('exit', onClose);
      this.#browserProcess.on('error', onClose);
      const timeoutId =
        timeout > 0 ? setTimeout(onTimeout, (timeout-15000)) : undefined;

      const cleanup = (): void => {
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
        rl.off('line', onLine);
        rl.off('close', onClose);
        this.#browserProcess.off('exit', onClose);
        this.#browserProcess.off('error', onClose);
      };

      function onClose(error?: Error): void {
        cleanup();

        if([CDP_WEBSOCKET_ENDPOINT_REGEX, WEBDRIVER_BIDI_WEBSOCKET_ENDPOINT_REGEX].includes(regex)) {
          return resolve("ws://127.0.0.1:9222");
        }

        reject(
          new Error(
            [
              `Failed to launch the browser process!${
                error ? ' ' + error.message : ''
              }`,
              stdout,
              '',
              'TROUBLESHOOTING: https://pptr.dev/troubleshooting',
              '',
            ].join('\n')
          )
        );
      }

      function onTimeout(): void {
        cleanup();

        if([CDP_WEBSOCKET_ENDPOINT_REGEX, WEBDRIVER_BIDI_WEBSOCKET_ENDPOINT_REGEX].includes(regex)) {
          return resolve("ws://127.0.0.1:9222");
        }

        reject(
          new TimeoutError(
            `Timed out after ${timeout} ms while waiting for the WS endpoint URL to appear in stdout!`
          )
        );
      }

      function onLine(line: string): void {
        stdout += line + '\n';
        const match = line.match(regex);
        if (!match) {
          return;
        }
        cleanup();
        // The RegExp matches, so this will obviously exist.
        resolve(match[1]!);
      }
    });

    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

    let isResolvedErr = false;
    let isResolvedOut = false;
    let finalResult = "";
    try {
      pErr.then((result: any) => {
        isResolvedErr = true;
        finalResult = result;
        return result;
      });

      pOut.then((result: any) => {
        isResolvedOut = true;
        finalResult = result;
        return result;
      });

      while(true) {
        if(isResolvedErr || isResolvedOut) return finalResult;
        await sleep(1000);
      }
    } catch(e) {
      if(!isResolvedErr && !isResolvedOut) throw e;
    }
    if(isResolvedErr || isResolvedOut) return finalResult;
    return finalResult;
  }
}

const PROCESS_ERROR_EXPLANATION = `Puppeteer was unable to kill the process which ran the browser binary.
This means that, on future Puppeteer launches, Puppeteer might not be able to launch the browser.
Please check your open processes and ensure that the browser processes that Puppeteer launched have been killed.
If you think this is a bug, please report it on the Puppeteer issue tracker.`;

/**
 * @internal
 */
function pidExists(pid: number): boolean {
  try {
    return process.kill(pid, 0);
  } catch (error) {
    if (isErrnoException(error)) {
      if (error.code && error.code === 'ESRCH') {
        return false;
      }
    }
    throw error;
  }
}

/**
 * @internal
 */
export interface ErrorLike extends Error {
  name: string;
  message: string;
}

/**
 * @internal
 */
export function isErrorLike(obj: unknown): obj is ErrorLike {
  return (
    typeof obj === 'object' && obj !== null && 'name' in obj && 'message' in obj
  );
}
/**
 * @internal
 */
export function isErrnoException(obj: unknown): obj is NodeJS.ErrnoException {
  return (
    isErrorLike(obj) &&
    ('errno' in obj || 'code' in obj || 'path' in obj || 'syscall' in obj)
  );
}

/**
 * @public
 */
export class TimeoutError extends Error {
  /**
   * @internal
   */
  constructor(message?: string) {
    super(message);
    this.name = this.constructor.name;
    Error.captureStackTrace(this, this.constructor);
  }
}
